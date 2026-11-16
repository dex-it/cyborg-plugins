import { cleanMessage } from './args.ts';
import type { McpBackend, McpTool } from './mcp.ts';

// Инструменты сессий для агента по MCP (фича 15): open_session, list_sessions, send_to_session, close_session и report_done у дочерней.
// Перенос src/main/session-tools.ts ai-cyborg. Номера сессий у инструментов - целые (`CC<n>`), как в ai-cyborg: модель видит их в list_sessions;
// плагин сопоставляет номер с id сессии (delegation.ts). Удалённые сессии (spawn_agent, close_agent, хосты) - задача M-05, здесь их нет.

export const OPEN_SESSION_TOOL = 'open_session';
export const LIST_SESSIONS_TOOL = 'list_sessions';
export const SEND_TO_SESSION_TOOL = 'send_to_session';
export const CLOSE_SESSION_TOOL = 'close_session';
export const REPORT_DONE_TOOL = 'report_done';

/** Имена своих инструментов: чужой поставщик `cyborg.agent-tool` их не перекроет. */
export const OWN_TOOLS: readonly string[] = [OPEN_SESSION_TOOL, LIST_SESSIONS_TOOL, SEND_TO_SESSION_TOOL, CLOSE_SESSION_TOOL, REPORT_DONE_TOOL];

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

export interface ToolContext {
  /** Вызывающую открыла другая сессия: локальной дочерней отдаётся report_done. */
  child?: boolean;
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
  return context.child ? [...all, reportDoneTool()] : all;
}

function reportDoneTool(): McpTool {
  return {
    name: REPORT_DONE_TOOL,
    description:
      'Сдаёт итог работы: Cyborg пересылает его сессии, которая тебя запустила, либо показывает человеку уведомлением. ' +
      'Вызывай, когда закончил, упёрся в препятствие или не справился; работу закоммить в свою ветку до вызова. ' +
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
}

export interface SessionsPort {
  dirsOf(id: number): readonly string[] | null;
  peers(id: number): PeerInfo[] | null;
  say(id: number, text: string): Promise<SayResult>;
  /** Сессию открыла другая сессия (open_session): ей отдаётся report_done. */
  isChild(id: number): boolean;
  /** Итог локальной дочерней; текст ответа модели. */
  reportLocal(id: number, report: ReportArgs): string;
}

/** Поручение другой вкладке (`Handoffs.request` из handoff.ts): номер новой сессии, когда она открыта. */
export interface HandoffPort {
  request(from: number, repo: string, prompt: string): Promise<number>;
}

export function createSessionTools(
  sessions: SessionsPort,
  handoffs: HandoffPort,
  /** Закрывает вкладку сессии и завершает её процесс. */
  close: (id: number) => void | Promise<void>,
  closeSelfDelayMs = CLOSE_SELF_DELAY_MS,
): McpBackend {
  const contextOf = (caller: number): ToolContext => ({ child: sessions.isChild(caller) });
  return {
    tools: (caller) => {
      const dirs = sessions.dirsOf(caller);
      return dirs ? sessionTools(dirs, contextOf(caller)) : [];
    },
    call: async (caller, name, value) => {
      const dirs = sessions.dirsOf(caller);
      const peers = sessions.peers(caller);
      if (!dirs || !peers) throw new Error('сессия завершена');
      // tools/call не обязан следовать tools/list: набор инструментов контекста - и есть право вызова.
      if (!sessionTools(dirs, contextOf(caller)).some((t) => t.name === name)) throw new Error(`инструмент ${name} недоступен этой сессии`);
      if (name === LIST_SESSIONS_TOOL) return describePeers(peers, caller);
      if (name === SEND_TO_SESSION_TOOL) {
        const valid = validateSend(value, peers, caller);
        if (typeof valid === 'string') throw new Error(valid);
        const result = await sessions.say(valid.id, valid.message);
        return result === 'queued' ? `Сессия ${valid.id} работает: сообщение в очереди Cyborg и уйдёт, когда она закончит ход.` : `Сообщение отправлено сессии ${valid.id}.`;
      }
      if (name === CLOSE_SESSION_TOOL) {
        const valid = validateClose(value, peers, caller);
        if (typeof valid === 'string') throw new Error(valid);
        if (valid.id !== caller) {
          await close(valid.id);
          return `Вкладка сессии ${valid.id} закрыта.`;
        }
        setTimeout(() => void Promise.resolve(close(caller)).catch(() => undefined), closeSelfDelayMs);
        return 'Эта вкладка закроется через секунду.';
      }
      if (name === REPORT_DONE_TOOL) {
        const valid = validateReport(value);
        if (typeof valid === 'string') throw new Error(valid);
        return sessions.reportLocal(caller, valid);
      }
      if (name !== OPEN_SESSION_TOOL) throw new Error(`неизвестный инструмент ${name}`);
      const valid = validateOpenSession(value, dirs);
      if (typeof valid === 'string') throw new Error(valid);
      const id = await handoffs.request(caller, valid.repo, valid.prompt);
      return `Открыта вкладка сессии ${id} в ${valid.repo}.`;
    },
  };
}
