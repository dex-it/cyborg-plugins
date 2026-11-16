import { cleanMessage } from './args.ts';
import type { McpBackend, McpTool } from './mcp.ts';

// Инструменты сессий для агента по MCP (фича 15): open_session, list_sessions, send_to_session, close_session и report_done у дочерней.
// Перенос src/main/session-tools.ts ai-cyborg. Номера сессий у инструментов - целые (`CC<n>`), как в ai-cyborg: модель видит их в list_sessions;
// плагин сопоставляет номер с id сессии (delegation.ts). Удалённые агенты (фича 17, M-05): spawn_agent и close_agent у локальной сессии проекта с хостами,
// у удалённой сессии - только список, сообщение и итог (open_session и close_session ей не отдаются: удалённый агент не должен открывать сессии на этой машине).
// Саму работу с хостом ведёт плагин remote-sessions (`RemoteToolsPort`).

export const OPEN_SESSION_TOOL = 'open_session';
export const LIST_SESSIONS_TOOL = 'list_sessions';
export const SEND_TO_SESSION_TOOL = 'send_to_session';
export const CLOSE_SESSION_TOOL = 'close_session';
export const REPORT_DONE_TOOL = 'report_done';
export const SPAWN_AGENT_TOOL = 'spawn_agent';
export const CLOSE_AGENT_TOOL = 'close_agent';

/** Имена своих инструментов: чужой поставщик `cyborg.agent-tool` их не перекроет. */
export const OWN_TOOLS: readonly string[] = [OPEN_SESSION_TOOL, LIST_SESSIONS_TOOL, SEND_TO_SESSION_TOOL, CLOSE_SESSION_TOOL, REPORT_DONE_TOOL, SPAWN_AGENT_TOOL, CLOSE_AGENT_TOOL];

export type SessionState = 'starting' | 'working' | 'waiting' | 'asking';

/** Вкладка проекта глазами инструментов. */
export interface PeerInfo {
  id: number;
  dirs: readonly string[];
  cwd: string;
  state: SessionState;
  reason?: string;
  lastAnswer?: string;
  /** Сообщений в очереди сессии. */
  queued: number;
  /** Только у удалённой вкладки (remote-sessions). */
  host?: string;
  link?: 'offline';
  /** Номер сессии, открывшей эту инструментом. */
  parent?: number;
}

export type SayResult = 'sent' | 'queued';

export type SessionKind = 'local' | 'remote';

export interface ToolContext {
  /** Вызывающую открыла другая сессия: локальной дочерней отдаётся report_done. */
  child?: boolean;
  /** Вызывающая идёт на SSH-хосте: у неё свой набор инструментов. */
  kind?: SessionKind;
  /** Хосты проекта вызывающей: без них spawn_agent и close_agent не отдаются. */
  hosts?: readonly string[];
}

/** Промпт новой сессии уходит позиционным аргументом claude, а Linux ограничивает один аргумент 128 КиБ (MAX_ARG_STRLEN). */
export const MAX_TEXT_BYTES = 100_000;

export const HANDOFF_TIMEOUT_MS = 20_000;

/** Хвост ответа в list_sessions: итог работы обычно в конце ответа. */
export const ANSWER_TAIL = 1500;

/** Своя вкладка закрывается после ответа: иначе результат вызова не дошёл бы до её диалога и пропал бы из возобновлённой сессии. */
export const CLOSE_SELF_DELAY_MS = 1000;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const MAX_BRANCH_BYTES = 255;

/** Причина отказа по правилам `git check-ref-format --branch` плюс запрет ведущего «-»; null - имя допустимо. Перенос src/main/branch-name.ts. */
export function branchNameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !name) return 'ветка - непустая строка';
  if (byteLength(name) > MAX_BRANCH_BYTES) return `ветка длиннее ${MAX_BRANCH_BYTES} байт`;
  if (name.startsWith('-')) return 'ветка не может начинаться с «-»: git примет её за ключ';
  if (name === '@') return 'ветка не может называться «@»';
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'ветка содержит пробел, управляющий символ или один из ~ ^ : ? * [ \\';
  if (name.includes('..')) return 'ветка не может содержать «..»';
  if (name.includes('@{')) return 'ветка не может содержать «@{»';
  if (name.includes('//')) return 'ветка не может содержать «//»';
  if (name.startsWith('/') || name.endsWith('/')) return 'ветка не может начинаться или кончаться на «/»';
  if (name.endsWith('.')) return 'ветка не может кончаться на «.»';
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'компонент ветки не может начинаться с «.»';
    if (part.endsWith('.lock')) return 'компонент ветки не может кончаться на «.lock»';
  }
  return null;
}

/** Каталоги вызывающей сессии - перечень в схеме: модель видит, из чего выбирать активный каталог новой. */
export function sessionTools(dirs: readonly string[], context: ToolContext = {}): McpTool[] {
  const all = localTools(dirs);
  const byName = (...names: string[]): McpTool[] => all.filter((t) => names.includes(t.name));
  if (context.kind === 'remote') return [...byName(LIST_SESSIONS_TOOL, SEND_TO_SESSION_TOOL), reportDoneTool('remote')];
  const local = context.child ? [...all, reportDoneTool('local')] : all;
  return context.hosts?.length ? [...local, spawnAgentTool(dirs, context.hosts), closeAgentTool()] : local;
}

function spawnAgentTool(dirs: readonly string[], hosts: readonly string[]): McpTool {
  return {
    name: SPAWN_AGENT_TOOL,
    description:
      'Запускает агента - сессию Claude Code на сервере разработчика по SSH - и отправляет ему prompt первым сообщением. ' +
      'На хосте у агента свои клоны origin всех репозиториев проекта: repo - рабочий и стоит на ветке branch (нет такой ветки в origin - создаётся от ветки по умолчанию), ' +
      'остальные подключены как дополнительные и остаются на ветке по умолчанию origin. Вкладка открывается в фоне, возвращается её номер. ' +
      'Агент этого диалога не видит: prompt - самодостаточное задание. Закончив, агент вызывает report_done, и его итог приходит тебе сообщением; ' +
      'после итога агент остаётся открытым: send_to_session продолжает его работу новым кругом, close_agent завершает и убирает клоны. ' +
      'Агент, 2 ч ждущий ввода, засыпает: вкладка закрывается, клоны и разговор остаются на хосте, и человек может продолжить его из «Истории». ' +
      'Лимиты по умолчанию: 4 агента на хост, 4 ч на круг работы, 30 мин простоя в работе; превышение закрывает агента с итогом failed. Вызов подтверждает человек.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', enum: [...hosts], description: 'Алиас хоста из ~/.ssh/config, заданный в проекте.' },
        repo: { type: 'string', enum: [...dirs], description: 'Рабочий репозиторий агента - один из каталогов проекта.' },
        branch: { type: 'string', description: 'Ветка, на которой агент работает; не начинается с «-».' },
        prompt: { type: 'string', minLength: 1, description: 'Первое сообщение агента: задание целиком. Не начинается с «-».' },
        limits: {
          type: 'object',
          properties: {
            max_agents_per_host: { type: 'integer', minimum: 1, maximum: 16 },
            task_timeout_min: { type: 'integer', minimum: 1, maximum: 1440 },
            idle_timeout_min: { type: 'integer', minimum: 1, maximum: 1440 },
          },
          additionalProperties: false,
        },
        keep: { type: 'boolean', description: 'Не удалять клоны, если сессия завершится сама, без close_agent.' },
      },
      required: ['host', 'repo', 'branch', 'prompt'],
      additionalProperties: false,
    },
  };
}

function closeAgentTool(): McpTool {
  return {
    name: CLOSE_AGENT_TOOL,
    description:
      'Завершает удалённого агента (вкладку проекта) в любом состоянии и удаляет его клоны на хосте. ' +
      'Клон с незапушенными коммитами, изменениями, stash остаётся: в ответе его путь на хосте. keep: true завершает сессию и оставляет клоны. Вызов подтверждает человек.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Номер удалённой сессии из list_sessions.' },
        keep: { type: 'boolean', description: 'Клоны не удалять.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  };
}

function reportDoneTool(kind: SessionKind): McpTool {
  return {
    name: REPORT_DONE_TOOL,
    description:
      'Сдаёт итог работы: Cyborg пересылает его сессии, которая тебя запустила, либо показывает человеку уведомлением. ' +
      `Вызывай, когда закончил, упёрся в препятствие или не справился; ${kind === 'remote' ? 'ветку запушь и PR открой до вызова' : 'работу закоммить в свою ветку до вызова'}. ` +
      'Сессия после итога остаётся: следующее сообщение начинает новый круг работы, и итог круга сдаётся снова. ' +
      'Если ответ - ошибка связи с Cyborg, вызов не состоялся: повтори его позже.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'failed', 'blocked'], description: 'ok - задача выполнена; failed - не вышло; blocked - нужен человек или чужое решение.' },
        summary: { type: 'string', minLength: 1, description: 'Итог: что сделано, что осталось, на что обратить внимание.' },
        branch: { type: 'string', description: 'Ветка с работой, запушенная в origin.' },
        pr: { type: 'string', description: 'Ссылка https на PR.' },
      },
      required: ['status', 'summary'],
      additionalProperties: false,
    },
  };
}

function localTools(dirs: readonly string[]): McpTool[] {
  return [
    {
      name: OPEN_SESSION_TOOL,
      description:
        'Открывает в Cyborg новую вкладку - сессию Claude Code в том же проекте - и отправляет ей prompt первым сообщением. ' +
        'Новая сессия работает параллельно и этого диалога не видит, поэтому prompt - самодостаточное задание: цель, контекст, пути, ветки, критерий готовности. ' +
        'Можно начать его слэш-командой. repo - рабочий (активный) каталог новой сессии; остальные каталоги проекта подключаются к ней через --add-dir. ' +
        'Вкладка открывается в фоне, текущая остаётся активной. Состояние и ответ новой сессии - в list_sessions, дописать ей - send_to_session.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1, description: 'Первое сообщение новой сессии: задание целиком. Не начинается с «-».' },
          repo: { type: 'string', enum: [...dirs], description: 'Рабочий каталог новой сессии - один из каталогов проекта.' },
        },
        required: ['prompt', 'repo'],
        additionalProperties: false,
      },
    },
    {
      name: LIST_SESSIONS_TOOL,
      description:
        'Открытые вкладки Cyborg в проекте этой сессии, включая её саму (self: true): номер, подпись вкладки, каталог запуска и текущий, состояние и хвост последнего ответа. ' +
        'state: starting - запускается или ждёт подтверждения доверия к каталогу; working - работает, в том числе ждёт своих фоновых задач; ' +
        'waiting - ход завершён, ждёт сообщения; asking - стоит на вопросе, разрешении или лимите и ждёт человека (причина в reason). ' +
        'queued - сколько сообщений send_to_session ждут конца её хода. У удалённой сессии есть host, а cwd - путь на хосте. ' +
        'parent - номер сессии, открывшей эту инструментом; child: true - твоя дочерняя, её закрываешь ты.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: SEND_TO_SESSION_TOOL,
      description:
        'Отправляет сообщение в другую открытую вкладку проекта - как если бы человек набрал его там и нажал Enter. ' +
        'Работающей сессии (working) Cyborg отдаст его, когда она закончит ход; сессиям в starting и asking не отправляет, иначе текст ушёл бы в её диалог. ' +
        'Сообщение - обычный текст: слэш-команды и ввод с «!» или «#» не принимаются. ' +
        'Получатель не знает отправителя: если нужен ответ, назови в сообщении свой номер из list_sessions и попроси ответить через send_to_session. ' +
        'Если человек в этот момент набирает текст в той вкладке, сообщение допишется к его вводу.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Номер сессии из list_sessions.' },
          message: { type: 'string', minLength: 1, description: 'Текст сообщения, может быть многострочным; не начинается с «/», «!» или «#».' },
        },
        required: ['id', 'message'],
        additionalProperties: false,
      },
    },
    {
      name: CLOSE_SESSION_TOOL,
      description:
        'Закрывает вкладку Cyborg с сессией проекта - как крестик на вкладке: процесс Claude Code завершается, вкладка убирается, очередь её сообщений пропадает. ' +
        'Диалог остаётся в истории сессий проекта, его можно возобновить. ' +
        'Своя вкладка (номер с self: true в list_sessions) закрывается через секунду после ответа. ' +
        'Свою дочернюю (child: true в list_sessions) закрывает в любом состоянии. ' +
        'Чужую вкладку в состоянии working, asking или starting инструмент не закрывает - её работа или вопрос человеку пропали бы; закрыть её всё же - force: true. ' +
        'Прежде чем закрыть соседку, прочитай её итог в list_sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Номер сессии из list_sessions.' },
          force: { type: 'boolean', description: 'Закрыть и работающую, и ждущую человека сессию.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

const args = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

const tooLong = (text: string): boolean => byteLength(text) > MAX_TEXT_BYTES;

const SHELL_REFUSAL = 'текст не может начинаться с «!»: Claude Code выполнил бы его как команду оболочки без запроса разрешения';

/** Общие проверки промпта старта (ADR-0017 п.3, ADR-0019 п.8): ведущие «-» и «!», предел длины; null - годится. */
export function promptProblem(text: string, name: string, limitHint = ''): string | null {
  // Проверяется очищенный текст: ведущий управляющий символ вычищается позже и иначе открыл бы «!» или «-».
  const head = cleanMessage(text);
  if (head.startsWith('-')) return `${name} не может начинаться с «-»: claude примет его за ключ командной строки`;
  if (head.startsWith('!')) return name === 'prompt' ? SHELL_REFUSAL : `${name} не может начинаться с «!»: Claude Code выполнил бы его как команду оболочки`;
  if (tooLong(text)) return `${name} длиннее ${MAX_TEXT_BYTES} байт${limitHint}`;
  return null;
}

export interface OpenSessionArgs {
  prompt: string;
  repo: string;
}

/** Аргументы от модели; ошибка - строка, её текст вернётся модели. */
export function validateOpenSession(value: unknown, dirs: readonly string[]): OpenSessionArgs | string {
  const { prompt, repo } = args(value);
  if (typeof prompt !== 'string' || !prompt.trim()) return 'prompt - непустая строка';
  const problem = promptProblem(prompt, 'prompt', ': сократи задание или передай его файлом');
  if (problem) return problem;
  if (typeof repo !== 'string' || !dirs.includes(repo)) return `repo - один из каталогов проекта: ${dirs.join(', ')}`;
  return { prompt: prompt.trim(), repo };
}

export function validateSend(value: unknown, peers: readonly PeerInfo[], caller: number): { id: number; message: string } | string {
  const { id, message } = args(value);
  if (typeof message !== 'string' || !cleanMessage(message)) return 'message - непустая строка';
  if (cleanMessage(message).startsWith('!')) return SHELL_REFUSAL;
  // «/permissions», «/config» и «#» правят настройки и память получателя в обход его разрешений.
  if (/^[/#]/.test(cleanMessage(message))) return 'message не может начинаться с «/» или «#»: это команда Claude Code, а не сообщение сессии';
  if (tooLong(message)) return `message длиннее ${MAX_TEXT_BYTES} байт: передай содержимое файлом`;
  if (id === caller) return 'это номер этой же сессии';
  const target = peers.find((p) => p.id === id);
  if (!target) return `сессии ${String(id)} нет среди открытых вкладок проекта: номера - в list_sessions`;
  if (target.state === 'starting') return `сессия ${target.id} ещё запускается: повтори позже`;
  if (target.state === 'asking') return `сессия ${target.id} ждёт человека (${target.reason ?? 'вопрос'}): текст ушёл бы в её диалог, повтори после его ответа`;
  return { id: target.id, message: cleanMessage(message) };
}

export function validateClose(value: unknown, peers: readonly PeerInfo[], caller: number): { id: number } | string {
  const { id, force } = args(value);
  if (force !== undefined && typeof force !== 'boolean') return 'force - true или false';
  const target = peers.find((p) => p.id === id);
  if (!target) return `сессии ${String(id)} нет среди открытых вкладок проекта: номера - в list_sessions`;
  // Вызывающая сессия в своём ходу всегда working: правило о работающих к ней не относится; свою дочернюю родитель закрывает сам.
  if (force || target.id === caller || target.parent === caller || target.state === 'waiting') return { id: target.id };
  const busy = target.state === 'asking' ? `ждёт человека (${target.reason ?? 'вопрос'})` : target.state === 'starting' ? 'ещё запускается' : 'работает';
  return `сессия ${target.id} ${busy}: закрытие оборвёт её, закрыть всё же - force: true`;
}

export interface Limits {
  max_agents_per_host?: number;
  task_timeout_min?: number;
  idle_timeout_min?: number;
}

export interface SpawnArgs {
  host: string;
  repo: string;
  branch: string;
  prompt: string;
  limits?: Limits;
  keep: boolean;
}

const LIMIT_RANGES: Record<keyof Limits, [number, number]> = {
  max_agents_per_host: [1, 16],
  task_timeout_min: [1, 1440],
  idle_timeout_min: [1, 1440],
};

/** Аргументы spawn_agent от модели; ошибка - строка, её текст вернётся модели. */
export function validateSpawn(value: unknown, dirs: readonly string[], hosts: readonly string[]): SpawnArgs | string {
  const { host, repo, branch, prompt, limits, keep } = args(value);
  if (typeof host !== 'string' || !hosts.includes(host)) return `host - один из хостов проекта: ${hosts.join(', ')}`;
  if (typeof repo !== 'string' || !dirs.includes(repo)) return `repo - один из каталогов проекта: ${dirs.join(', ')}`;
  const bad = branchNameProblem(branch);
  if (bad) return bad;
  if (typeof prompt !== 'string' || !prompt.trim()) return 'prompt - непустая строка';
  const problem = promptProblem(prompt, 'prompt', ': сократи задание или передай его файлом');
  if (problem) return problem;
  if (keep !== undefined && typeof keep !== 'boolean') return 'keep - true или false';
  const out: SpawnArgs = { host, repo, branch: branch as string, prompt: prompt.trim(), keep: keep === true };
  if (limits === undefined) return out;
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) return 'limits - объект';
  const parsed: Limits = {};
  for (const [key, val] of Object.entries(limits)) {
    const range = LIMIT_RANGES[key as keyof Limits];
    if (!range) return `limits: неизвестное поле ${key}`;
    if (typeof val !== 'number' || !Number.isInteger(val) || val < range[0] || val > range[1]) return `limits.${key} - целое от ${String(range[0])} до ${String(range[1])}`;
    parsed[key as keyof Limits] = val;
  }
  return { ...out, limits: parsed };
}

/** close_agent: цель - удалённая вкладка проекта вызывающей, в любом состоянии. */
export function validateCloseAgent(value: unknown, peers: readonly PeerInfo[]): { id: number; keep: boolean } | string {
  const { id, keep } = args(value);
  if (keep !== undefined && typeof keep !== 'boolean') return 'keep - true или false';
  const target = peers.find((p) => p.id === id);
  if (!target) return `сессии ${String(id)} нет среди вкладок проекта: номера - в list_sessions`;
  if (!target.host) return `сессия ${String(target.id)} локальная: закрывается close_session`;
  return { id: target.id, keep: keep === true };
}

export type ReportStatus = 'ok' | 'failed' | 'blocked';

export interface ReportArgs {
  status: ReportStatus;
  summary: string;
  branch?: string;
  pr?: string;
}

/** Аргументы report_done: итог чистится как сообщение, ветка - имя ref, PR - https-ссылка. */
export function validateReport(value: unknown): ReportArgs | string {
  const { status, summary, branch, pr } = args(value);
  if (status !== 'ok' && status !== 'failed' && status !== 'blocked') return 'status - ok, failed или blocked';
  if (typeof summary !== 'string' || !cleanMessage(summary)) return 'summary - непустая строка';
  if (tooLong(summary)) return `summary длиннее ${MAX_TEXT_BYTES} байт`;
  const out: ReportArgs = { status, summary: cleanMessage(summary) };
  if (branch !== undefined) {
    const bad = branchNameProblem(branch);
    if (bad) return bad;
    out.branch = branch as string;
  }
  if (pr !== undefined) {
    if (typeof pr !== 'string' || pr.length > 2000 || !/^https:\/\/[^\s\x00-\x1f]+$/.test(pr)) return 'pr - ссылка https до 2000 знаков';
    out.pr = pr;
  }
  return out;
}

const tail = (text: string): string => (text.length > ANSWER_TAIL ? `…${text.slice(-ANSWER_TAIL)}` : text);

export function describePeers(peers: readonly PeerInfo[], caller: number): string {
  return JSON.stringify(
    peers.map((p) => ({
      id: p.id,
      tab: `CC${p.id}`,
      ...(p.id === caller ? { self: true } : {}),
      ...(p.host ? { host: p.host, ...(p.link ? { link: p.link } : {}) } : {}),
      ...(p.parent !== undefined ? { parent: p.parent, ...(p.parent === caller ? { child: true } : {}) } : {}),
      repo: p.dirs[0],
      cwd: p.cwd,
      state: p.state,
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.queued ? { queued: p.queued } : {}),
      ...(p.lastAnswer ? { last_answer: tail(p.lastAnswer) } : {}),
    })),
    null,
    2,
  );
}

export interface HandoffRequest {
  hid: string;
  /** Номер сессии, поручившей работу. */
  from: number;
  repo: string;
  /** Есть у spawn_agent: вкладка удалённая. */
  host?: string;
}

/** Что нужно знать о передаче, чтобы открыть удалённую вкладку. */
export interface RemoteHandoff {
  host: string;
  branch: string;
  limits?: Limits;
  keep: boolean;
}

export interface SessionsPort {
  dirsOf(id: number): readonly string[] | null;
  peers(id: number): PeerInfo[] | null;
  say(id: number, text: string): Promise<SayResult>;
  /** Сессию открыла другая сессия (open_session): ей отдаётся report_done. */
  isChild(id: number): boolean;
  /** Итог дочерней или удалённой сессии; текст ответа модели. */
  reportLocal(id: number, report: ReportArgs): string;
  /** Вид вызывающей: у удалённой другой набор инструментов. */
  kindOf?(id: number): SessionKind;
  /** Хосты проекта, у которого каталоги запуска - dirs (спрашивается у remote-sessions). */
  hostsOf?(dirs: readonly string[]): Promise<readonly string[]>;
}

/** Удалённая часть (её ведёт плагин remote-sessions): проверка хоста и лимитов, итог на хосте, завершение. Тексты результатов формирует она. */
export interface RemoteToolsPort {
  prepare(dirs: readonly string[], host: string, limits?: Limits): Promise<void>;
  /** Итог круга отмечен на хосте (демон не закроет сессию по лимиту задачи). */
  report(id: number): Promise<void>;
  /** Завершает сессию на хосте и убирает клоны (keep - оставляет) и закрывает вкладку (она к этому времени могла выйти сама: ssh завершился вместе с сессией); ответ - текст итога для модели. */
  close(id: number, keep: boolean): Promise<string>;
}

/** Поручение другой вкладке (`Handoffs.request` из handoff.ts): номер новой сессии, когда она открыта. */
export interface HandoffPort {
  request(from: number, repo: string, prompt: string, remote?: RemoteHandoff): Promise<number>;
}

export function createSessionTools(
  sessions: SessionsPort,
  handoffs: HandoffPort,
  /** Закрывает вкладку сессии и завершает её процесс. */
  close: (id: number) => void | Promise<void>,
  closeSelfDelayMs = CLOSE_SELF_DELAY_MS,
  remote?: RemoteToolsPort,
): McpBackend {
  const contextOf = async (caller: number, dirs: readonly string[]): Promise<ToolContext> => {
    const kind = sessions.kindOf?.(caller) ?? 'local';
    // Хосты спрашиваются у remote-sessions только когда есть кому ими распорядиться и вызывающая локальная.
    const hosts = remote && kind === 'local' ? ((await sessions.hostsOf?.(dirs).catch(() => [])) ?? []) : [];
    return { child: sessions.isChild(caller), kind, hosts };
  };
  return {
    tools: async (caller) => {
      const dirs = sessions.dirsOf(caller);
      return dirs ? sessionTools(dirs, await contextOf(caller, dirs)) : [];
    },
    call: async (caller, name, value) => {
      const dirs = sessions.dirsOf(caller);
      const peers = sessions.peers(caller);
      if (!dirs || !peers) throw new Error('сессия завершена');
      const context = await contextOf(caller, dirs);
      // tools/call не обязан следовать tools/list: набор инструментов контекста - и есть право вызова.
      if (!sessionTools(dirs, context).some((t) => t.name === name)) throw new Error(`инструмент ${name} недоступен этой сессии`);
      if (name === LIST_SESSIONS_TOOL) return describePeers(peers, caller);
      if (name === SEND_TO_SESSION_TOOL) {
        const valid = validateSend(value, peers, caller);
        if (typeof valid === 'string') throw new Error(valid);
        const result = await sessions.say(valid.id, valid.message);
        return result === 'queued' ? `Сессия ${String(valid.id)} работает: сообщение в очереди Cyborg и уйдёт, когда она закончит ход.` : `Сообщение отправлено сессии ${String(valid.id)}.`;
      }
      if (name === CLOSE_SESSION_TOOL) {
        const valid = validateClose(value, peers, caller);
        if (typeof valid === 'string') throw new Error(valid);
        if (valid.id !== caller) {
          const target = peers.find((p) => p.id === valid.id);
          // Чужую удалённую вкладку закрывают так же, как close_agent: на хосте убираются клоны.
          if (target?.host && remote) return closeRemote(valid.id, false);
          await close(valid.id);
          return `Вкладка сессии ${String(valid.id)} закрыта.`;
        }
        setTimeout(() => void Promise.resolve(close(caller)).catch(() => undefined), closeSelfDelayMs);
        return 'Эта вкладка закроется через секунду.';
      }
      if (name === REPORT_DONE_TOOL) {
        const valid = validateReport(value);
        if (typeof valid === 'string') throw new Error(valid);
        if (context.kind === 'remote') {
          if (!remote) throw new Error(`инструмент ${name} недоступен этой сессии`);
          // Сначала проверка локального состояния (повторный итог за круг - отказ), затем отметка на хосте.
          const text = sessions.reportLocal(caller, valid);
          await remote.report(caller).catch(() => undefined);
          return text;
        }
        return sessions.reportLocal(caller, valid);
      }
      if (name === CLOSE_AGENT_TOOL && remote) {
        const valid = validateCloseAgent(value, peers);
        if (typeof valid === 'string') throw new Error(valid);
        return closeRemote(valid.id, valid.keep);
      }
      if (name === SPAWN_AGENT_TOOL && remote) {
        const valid = validateSpawn(value, dirs, context.hosts ?? []);
        if (typeof valid === 'string') throw new Error(valid);
        await remote.prepare(dirs, valid.host, valid.limits);
        const id = await handoffs.request(caller, valid.repo, valid.prompt, { host: valid.host, branch: valid.branch, keep: valid.keep, ...(valid.limits && { limits: valid.limits }) });
        return `Открыта вкладка удалённой сессии ${String(id)} на ${valid.host}: клоны готовятся, итог придёт сообщением после report_done.`;
      }
      if (name !== OPEN_SESSION_TOOL) throw new Error(`неизвестный инструмент ${name}`);
      const valid = validateOpenSession(value, dirs);
      if (typeof valid === 'string') throw new Error(valid);
      const id = await handoffs.request(caller, valid.repo, valid.prompt);
      return `Открыта вкладка сессии ${String(id)} в ${valid.repo}.`;
    },
  };

  /** Завершение удалённой сессии: на хосте процесс останавливается и клоны убираются, затем вкладка закрывается (это делает удалённая часть). */
  async function closeRemote(id: number, keep: boolean): Promise<string> {
    if (!remote) throw new Error('удалённые сессии недоступны');
    return remote.close(id, keep);
  }
}
