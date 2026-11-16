// Удалённые сессии проекта: создание, подхват, пробуждение, «История», место на хосте, уборка. Порт RemoteSessions (src/main/remote/remote-sessions.ts ai-cyborg)
// без того, что требует долгоживущего канала: вкладки, маршрутизация вывода и событий демона, обратные туннели. Сессию называет `resumeId` вида `<sid>@<хост>`:
// `sid` - идентификатор сессии на хосте (UUID), хост - алиас из списка проекта; так её открывает `launch({ resumeId })` и показывает `history`.
import {
  hostCloneUrl,
  validateHumanRemoteCreate,
  validateRemoteCreate,
  validateRemoteFs,
  validateRemotePath,
  readSearchReply,
  type ProjectView,
  type RemoteCreateArgs,
  type RemoteFsOp,
  type SearchReply,
} from './args.ts';
import { parseRemote } from './auth.ts';
import { readHostDisk, readPurge, type HostDisk, type PurgeResult } from './host-disk.ts';
import type { Host, Msg } from './host.ts';
import { DEFAULT_LIMITS, START_SIZE } from './limits.ts';
import type { Limits } from './protocol.ts';
import type { Auth, CleanupResult, GitCred, RepoSpec } from './protocol.ts';

/** Идентификатор сессии на хосте: UUID, как у isSessionId в ai-cyborg. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Сессию называет `resumeId` = её идентификатор на хосте (UUID; он же номер разговора claude: демон запускает его с `--session-id`).
 * Такая форма проходит проверку `sessions` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) и совпадает с `session_id` события `SessionStart`.
 * Хост по идентификатору находит `locate`: по запомненной связи, иначе опросом хостов проектов.
 */
export const resumeIdOf = (sid: string): string => sid;

/** Пределы spawn_agent в минутах и штуках (как в инструменте); пусто - прежние по умолчанию. */
export interface ToolLimits {
  max_agents_per_host?: number;
  task_timeout_min?: number;
  idle_timeout_min?: number;
}

const LIMIT_RANGES: Record<keyof ToolLimits, [number, number]> = { max_agents_per_host: [1, 16], task_timeout_min: [1, 1440], idle_timeout_min: [1, 1440] };

/** Пределы от человека или инструмента: целые в диапазоне; негодное - отказ (демон получает только проверенное). */
export function readToolLimits(value: unknown): ToolLimits {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('limits - объект');
  const out: ToolLimits = {};
  for (const [key, val] of Object.entries(value)) {
    const range = LIMIT_RANGES[key as keyof ToolLimits];
    if (!range) throw new Error(`limits: неизвестное поле ${key}`);
    if (typeof val !== 'number' || !Number.isInteger(val) || val < range[0] || val > range[1]) throw new Error(`limits.${key} - целое от ${String(range[0])} до ${String(range[1])}`);
    out[key as keyof ToolLimits] = val;
  }
  return out;
}

const minutes = (value: number | undefined, fallback: number): number => (value === undefined ? fallback : value * 60_000);

/** Пределы для демона: те же числа, что DEFAULT_LIMITS, с заменой названного. */
export function daemonLimits(limits: ToolLimits): Limits {
  return {
    maxPerHost: limits.max_agents_per_host ?? DEFAULT_LIMITS.maxPerHost,
    taskMs: minutes(limits.task_timeout_min, DEFAULT_LIMITS.taskMs),
    idleMs: minutes(limits.idle_timeout_min, DEFAULT_LIMITS.idleMs),
  };
}

export interface HistoryEntryOut {
  id: string;
  cwd: string;
  title: string;
  updated: number;
}

export interface RemoteInfo {
  resumeId: string;
  sid: string;
  host: string;
  /** Локальные репозитории проекта, выбранный первым. */
  dirs: string[];
  /** Клон выбранного репозитория на хосте. */
  cwd: string;
  /** Клоны на хосте, выбранный первым: корни дерева. */
  roots: string[];
  reported?: boolean;
  /** Чего агенту не хватает на хосте: человек видит это в сообщении о создании. */
  notes?: string[];
}

/** Спящие сессии хостов для «Истории» и хосты, которые не ответили. */
export interface RemoteHistory {
  entries: (HistoryEntryOut & { host: string })[];
  unreachable: { host: string; reason: string }[];
}

export interface ServiceDeps {
  /** Хост по алиасу: один объект на алиас. */
  host(alias: string): Host;
  /** Проект с репозиториями и хостами; нет проекта - undefined. */
  project(projectId: string): Promise<ProjectView | undefined>;
  /** Адрес origin локального репозитория; нет origin - null. */
  originUrl(dir: string): Promise<string | null>;
  gitAuth(urls: string[]): Promise<GitCred[]>;
  claudeToken(): Promise<string | null>;
  uuid(): string;
  /** Случайная строка для токена сессии (в ai-cyborg - токен MCP; туннеля нет, демон требует непустой). */
  secret(): string;
  /** Хост, на котором сессия видна в последний раз: запоминается при создании, пробуждении и опросе; нет - undefined. */
  hostOf(sid: string): string | undefined;
  remember(sid: string, host: string): void;
  /** Хосты всех проектов: сюда можно ходить по ssh. */
  aliases(): string[];
  /** Предел ожидания хоста для «Истории», мс. */
  historyTimeoutMs?: number;
}

const CONFIG_TIMEOUT_MS = 180_000;
const DISK_TIMEOUT_MS = 120_000;
const SEARCH_TIMEOUT_MS = 40_000;
const CLOSE_LATE_MS = 15 * 60_000;
const HISTORY_TIMEOUT_MS = 8_000;
const HOST_TEXT_MAX = 2000;

/** Текст с хоста недоверен (в stderr клона - ответ сервера origin): без управляющих символов и ограничен. */
export const hostText = (value: unknown): string =>
  Array.from((typeof value === 'string' ? value : '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim()).slice(0, HOST_TEXT_MAX).join('');

function hostCleanup(value: unknown): CleanupResult {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const field = (x: unknown, key: string): string => hostText(typeof x === 'object' && x !== null ? (x as Record<string, unknown>)[key] : undefined);
  return { removed: list(v.removed).map(hostText), kept: list(v.kept).map((k) => ({ path: field(k, 'path'), reason: field(k, 'reason') })) };
}

/** Текст итога завершения: одна форма для close_agent и итога лимита. */
export function closeText(id: string, host: string, result: CleanupResult): string {
  const parts = [`Сессия ${id} завершена.`];
  if (result.removed.length) parts.push(`Клоны удалены: ${result.removed.join(', ')}.`);
  if (result.kept.length) parts.push(`Уборка отказана - оставлены ${result.kept.map((k) => `${host}:${k.path} (${k.reason})`).join(', ')}.`);
  return parts.join(' ');
}

const sameDirs = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');
const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? '';

export class RemoteService {
  private readonly deps: ServiceDeps;

  constructor(deps: ServiceDeps) {
    this.deps = deps;
  }

  /** Проект и его хост: хост должен быть из списка проекта (FR-17001). */
  private async scope(projectId: unknown, host: unknown): Promise<{ project: ProjectView; host: Host }> {
    if (typeof projectId !== 'string') throw new Error('Некорректные аргументы: нужен id проекта');
    const project = await this.deps.project(projectId);
    if (!project) throw new Error('проект не найден');
    if (typeof host !== 'string' || !project.hosts.includes(host)) throw new Error('хост не из списка проекта');
    return { project, host: this.deps.host(host) };
  }

  /** Доступы агента собираются заново на каждый запуск: Cyborg их не хранит, отозванный токен не переживает перезапуск. */
  private async auth(urls: string[], primaryUrl: string | undefined): Promise<Auth> {
    const git = await this.deps.gitAuth(urls).catch(() => []);
    const primary = primaryUrl ? parseRemote(primaryUrl)?.host : undefined;
    const claude = await this.deps.claudeToken();
    return { git, ...(primary ? { primary } : {}), ...(claude ? { claude } : {}) };
  }

  private notes(host: Host, urls: string[], auth: Auth): string[] {
    const notes: string[] = [];
    const hosts = new Set(urls.map((u) => parseRemote(u)?.host).filter((h): h is string => !!h));
    for (const h of hosts) if (!auth.git.some((c) => c.host === h)) notes.push(`для ${h} нет токена gh или glab на этой машине: клон и push идут ключами хоста`);
    if (auth.git.some((c) => c.kind === 'github') && !host.tools.gh) notes.push('на хосте нет gh: агент не откроет PR');
    if (auth.git.some((c) => c.kind === 'gitlab') && !host.tools.glab) notes.push('на хосте нет glab: агент не откроет MR');
    return notes;
  }

  /** remote:create. Клонирует репозитории проекта на хост и запускает claude под демоном; терминал открывает `launch({ resumeId })`. */
  async create(projectId: unknown, value: unknown): Promise<RemoteInfo> {
    const project = typeof projectId === 'string' ? await this.deps.project(projectId) : undefined;
    const args: RemoteCreateArgs | string = validateHumanRemoteCreate(value, project);
    if (typeof args === 'string') throw new Error(args);
    return this.spawn(project as ProjectView, args);
  }

  /** Создание с заданием для инструмента `spawn_agent` (M-04/M-05): origin `tool`, пределы и `keep` из аргументов, номер открывшей вкладки - в запись сессии на хосте. */
  async createWithPrompt(projectId: unknown, value: unknown): Promise<RemoteInfo> {
    const project = typeof projectId === 'string' ? await this.deps.project(projectId) : undefined;
    const args = validateRemoteCreate(value, project);
    if (typeof args === 'string') throw new Error(args);
    const extra = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    if (extra.keep !== undefined && typeof extra.keep !== 'boolean') throw new Error('keep - true или false');
    const spawnedBy = extra.spawnedBy;
    if (spawnedBy !== undefined && (typeof spawnedBy !== 'number' || !Number.isInteger(spawnedBy) || spawnedBy < 1)) throw new Error('spawnedBy - номер вкладки');
    return this.spawn(project as ProjectView, args, { origin: 'tool', keep: extra.keep === true, limits: readToolLimits(extra.limits), ...(typeof spawnedBy === 'number' && { spawnedBy }) });
  }

  /** Хосты проекта: их спрашивает `sessions`, чтобы отдать агенту spawn_agent и close_agent. */
  async hosts(projectId: unknown): Promise<string[]> {
    const project = typeof projectId === 'string' ? await this.deps.project(projectId) : undefined;
    return project ? [...project.hosts] : [];
  }

  /** Хост в порядке (проверка, демон) и под пределом числа сессий: до открытия вкладки spawn_agent (`prepare` в ai-cyborg). */
  async prepare(projectId: unknown, host: unknown, limits: unknown): Promise<void> {
    const scope = await this.scope(projectId, host);
    const max = daemonLimits(readToolLimits(limits)).maxPerHost;
    const live = (await this.listOf(scope.host)).filter((s) => s.exited !== true && s.asleep !== true).length;
    if (live >= max) throw new Error(`на хосте ${String(host)} уже ${String(live)} удалённых сессий (предел ${String(max)})`);
  }

  /** Итог круга отмечен на хосте: демон не закроет сессию по лимиту задачи, пока не начался следующий круг. */
  async report(resumeId: unknown): Promise<void> {
    const id = await this.locate(resumeId);
    if (!id) throw new Error('Некорректный номер сессии');
    await id.host.ensure();
    await id.host.request({ type: 'report', sid: id.sid });
  }

  /** Токен MCP новой удалённой сессии: 32 случайных байта base64url (43 знака), как у токенов `sessions`. */
  token(): string {
    return this.deps.secret();
  }

  private async spawn(project: ProjectView, args: RemoteCreateArgs, extra: { origin: 'human' | 'tool'; keep: boolean; limits: ToolLimits; spawnedBy?: number } = { origin: 'human', keep: false, limits: {} }): Promise<RemoteInfo> {
    const repos: RepoSpec[] = [];
    const withCredentials: string[] = [];
    for (const dir of project.repos) {
      const origin = await this.deps.originUrl(dir);
      if (!origin) throw new Error(`у репозитория ${dir} нет origin: удалённой сессии нечего клонировать`);
      if (origin.startsWith('-')) throw new Error(`адрес origin репозитория ${dir} начинается с «-»`);
      const { url, stripped } = hostCloneUrl(origin);
      if (stripped) withCredentials.push(dir);
      repos.push({ local: dir, url, name: basename(dir) || 'repo' });
    }
    const selected = project.repos.indexOf(args.repo);
    const host = this.deps.host(args.host);
    await host.ensure();
    const sid = this.deps.uuid();
    const dirs = [args.repo, ...project.repos.filter((d) => d !== args.repo)];
    const auth = await this.auth(repos.map((r) => r.url), repos[selected]?.url);
    const reply = await host.request({
      type: 'spawn',
      sid,
      token: this.deps.secret(),
      repos,
      selected,
      branch: args.branch,
      ...(args.prompt ? { prompt: args.prompt } : {}),
      origin: extra.origin,
      keep: extra.keep,
      ...(extra.spawnedBy !== undefined && { spawnedBy: extra.spawnedBy }),
      limits: daemonLimits(extra.limits),
      ...START_SIZE,
      auth,
      memory: [],
    });
    const roots = Array.isArray(reply.clones) ? (reply.clones as string[]) : [];
    const cwd = String(reply.cwd ?? args.repo);
    this.deps.remember(sid, args.host);
    return {
      resumeId: resumeIdOf(sid),
      sid,
      host: args.host,
      dirs,
      cwd,
      roots: [cwd, ...roots.filter((r) => r !== cwd)],
      notes: [...withCredentials.map((dir) => `адрес origin ${dir} содержит учётные данные: на хост они не переданы, клон идёт токеном gh или glab`), ...this.notes(host, repos.map((r) => r.url), auth)],
    };
  }

  private async listOf(host: Host): Promise<Record<string, unknown>[]> {
    await host.ensure();
    const list = await host.request({ type: 'list' });
    return Array.isArray(list.sessions) ? (list.sessions as Record<string, unknown>[]) : [];
  }

  /** remote:discover. Живые сессии проекта на его хостах, не занятые другим окном; хост, не ответивший, назван в `unreachable`. */
  async discover(projectId: unknown): Promise<{ sessions: RemoteInfo[]; unreachable: { host: string; reason: string }[] }> {
    const project = typeof projectId === 'string' ? await this.deps.project(projectId) : undefined;
    if (!project) throw new Error('проект не найден');
    const sessions: RemoteInfo[] = [];
    const unreachable: { host: string; reason: string }[] = [];
    for (const alias of project.hosts) {
      try {
        for (const item of await this.listOf(this.deps.host(alias))) {
          const sid = String(item.sid);
          const dirs = item.dirs;
          if (item.busy === true || item.asleep === true || item.exited === true || !SESSION_ID.test(sid) || !Array.isArray(dirs) || !sameDirs(dirs as string[], project.repos)) continue;
          const clones = Array.isArray(item.clones) ? (item.clones as string[]) : [];
          const cwd = String(item.cwd);
          this.deps.remember(sid, alias);
          sessions.push({ resumeId: resumeIdOf(sid), sid, host: alias, dirs: dirs as string[], cwd, roots: [cwd, ...clones.filter((r) => r !== cwd)], reported: item.reported === true });
        }
      } catch (error) {
        unreachable.push({ host: alias, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { sessions, unreachable };
  }

  /** history:remote. Спящие сессии проекта на его хостах: хосты опрашиваются вместе, не ответивший за предел назван, а не ждётся. */
  async history(projectId: unknown): Promise<RemoteHistory> {
    const project = typeof projectId === 'string' ? await this.deps.project(projectId) : undefined;
    if (!project) throw new Error('проект не найден');
    return this.historyOf(project);
  }

  /** `live` - и живые сессии проекта, не занятые другим окном: контракт `cyborg.agent` продолжает сессию только из `history`, а подхват живой - тоже продолжение. */
  async historyOf(project: ProjectView, live = false): Promise<RemoteHistory> {
    const limit = this.deps.historyTimeoutMs ?? HISTORY_TIMEOUT_MS;
    const out: RemoteHistory = { entries: [], unreachable: [] };
    await Promise.all(
      project.hosts.map(async (alias) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`хост не ответил за ${String(Math.round(limit / 1000))} с`)), limit);
        });
        try {
          const found = this.entriesOn(project, alias, live);
          // Опоздавший ответ не должен падать необработанным отказом.
          found.catch(() => undefined);
          out.entries.push(...(await Promise.race([found, late])));
        } catch (error) {
          out.unreachable.push({ host: alias, reason: error instanceof Error ? error.message : String(error) });
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return out;
  }

  private async entriesOn(project: ProjectView, alias: string, live: boolean): Promise<(HistoryEntryOut & { host: string })[]> {
    const found: (HistoryEntryOut & { host: string })[] = [];
    for (const item of await this.listOf(this.deps.host(alias))) {
      const dirs = item.dirs;
      const sid = String(item.sid);
      const sleeping = item.asleep === true;
      const open = live && !sleeping && item.exited !== true && item.busy !== true;
      if ((!sleeping && !open) || !SESSION_ID.test(sid) || !Array.isArray(dirs) || !sameDirs(dirs as string[], project.repos)) continue;
      const title = (open ? 'работает: ' : '') + (hostText(item.title) || hostText(item.branch) || sid.slice(0, 8));
      this.deps.remember(sid, alias);
      found.push({ id: resumeIdOf(sid), cwd: String((dirs as string[])[0]), title, updated: Number(item.lastActive) || 0, host: alias });
    }
    return found;
  }

  /** remote:wake. Пробуждает спящую сессию (`claude --resume` в тех же клонах); терминал открывает `launch({ resumeId })`. */
  async wake(projectId: unknown, host: unknown, sid: unknown): Promise<RemoteInfo> {
    const scope = await this.scope(projectId, host);
    if (typeof sid !== 'string' || !SESSION_ID.test(sid)) throw new Error('Некорректное пробуждение сессии');
    const item = (await this.listOf(scope.host)).find((s) => s.sid === sid);
    const dirs = item?.dirs;
    if (!item || item.asleep !== true || !Array.isArray(dirs) || !sameDirs(dirs as string[], scope.project.repos)) throw new Error(`спящая сессия не найдена на ${String(host)}`);
    return this.wakeSession(scope.host, sid, dirs as string[], String(item.cwd));
  }

  /** Пробуждение без повторного `list`: его делает `launch`, который уже знает, что сессия спит. */
  async wakeSession(host: Host, sid: string, dirs: string[], cwd0: string, token: string = this.deps.secret()): Promise<RemoteInfo> {
    const urls: string[] = [];
    for (const dir of dirs) {
      const url = await this.deps.originUrl(dir);
      if (url) urls.push(url);
    }
    const auth = await this.auth(urls, urls[0]);
    // Номер вызвавшей из прошлого сна указывал бы на чужую вкладку: разбуженную ведёт человек.
    const reply = await host.request({ type: 'wake', sid, token, ...START_SIZE, auth });
    const roots = Array.isArray(reply.clones) ? (reply.clones as string[]) : [];
    const cwd = String(reply.cwd ?? cwd0);
    this.deps.remember(sid, host.host);
    return { resumeId: resumeIdOf(sid), sid, host: host.host, dirs, cwd, roots: [cwd, ...roots.filter((r) => r !== cwd)], reported: false, notes: this.notes(host, urls, auth) };
  }

  /** remote:disk. Место на хосте и его сессии. */
  async disk(projectId: unknown, host: unknown): Promise<HostDisk> {
    const scope = await this.scope(projectId, host);
    await scope.host.ensure();
    return readHostDisk(scope.host.host, await scope.host.request({ type: 'disk' }, DISK_TIMEOUT_MS));
  }

  /** remote:purge. Удаление отмеченных сессий на хосте; force - и клонов с незапушенной работой. */
  async purge(projectId: unknown, host: unknown, sids: unknown, force: unknown): Promise<PurgeResult[]> {
    const scope = await this.scope(projectId, host);
    if (!Array.isArray(sids) || !sids.every((s) => typeof s === 'string' && SESSION_ID.test(s))) throw new Error('Некорректное удаление сессий');
    await scope.host.ensure();
    return readPurge(await scope.host.request({ type: 'purge', sids, force: force === true }, CLOSE_LATE_MS));
  }

  /** remote:remove-asleep. Удаление спящей сессии из «Истории»: уборка клонов по правилам close_agent; текст с отказом уборки - для окна. */
  async removeAsleep(projectId: unknown, host: unknown, sid: unknown): Promise<string> {
    const scope = await this.scope(projectId, host);
    if (typeof sid !== 'string' || !SESSION_ID.test(sid)) throw new Error('Некорректное удаление сессии');
    await scope.host.ensure();
    const result = hostCleanup(await scope.host.request({ type: 'close', sid, keep: false }, CLOSE_LATE_MS));
    return result.kept.length ? closeText(sid.slice(0, 8), scope.host.host, result) : '';
  }

  /**
   * Хост сессии по `resumeId`: запомненный, если он ещё в списке хостов проектов, иначе опросом этих хостов (первый, где сессия есть).
   * Негодная форма - null; сессии нет ни на одном хосте - отказ.
   */
  async locate(resumeId: unknown): Promise<{ sid: string; alias: string; host: Host } | null> {
    if (typeof resumeId !== 'string' || !SESSION_ID.test(resumeId)) return null;
    const aliases = this.deps.aliases();
    const known = this.deps.hostOf(resumeId);
    if (known !== undefined && aliases.includes(known)) return { sid: resumeId, alias: known, host: this.deps.host(known) };
    const found = await Promise.all(
      aliases.map(async (alias) => {
        try {
          return (await this.listOf(this.deps.host(alias))).some((s) => s.sid === resumeId) ? alias : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    const alias = found.find((a): a is string => a !== undefined);
    if (alias === undefined) throw new Error(`сессия ${resumeId.slice(0, 8)} не найдена на хостах проектов`);
    this.deps.remember(resumeId, alias);
    return { sid: resumeId, alias, host: this.deps.host(alias) };
  }

  /** Завершение живой сессии по правилам close_agent: процесс останавливается, клоны без keep убираются. */
  async close(resumeId: unknown, keep: unknown): Promise<string> {
    const id = await this.locate(resumeId);
    if (!id) throw new Error('Некорректный номер сессии');
    const host = id.host;
    await host.ensure();
    const result = hostCleanup(await host.request({ type: 'close', sid: id.sid, keep: keep === true }, CLOSE_LATE_MS));
    // В ai-cyborg закрытую сессию снимал с демона выход, доставленный владельцу канала. Канала нет, поэтому запись снимает этот attach:
    // иначе завершённая сессия оставалась бы у демона «живой» (и `purge` отказывал бы ей как работающей).
    await host.request({ type: 'attach', sid: id.sid, outFrom: Number.MAX_SAFE_INTEGER, evFrom: Number.MAX_SAFE_INTEGER }).catch(() => undefined);
    return closeText(id.sid.slice(0, 8), id.alias, result);
  }

  /** remote:fs. Файловая операция над клонами сессии (только чтение): границу клонов проверяет демон. */
  async fs(resumeId: unknown, op: unknown, target: unknown): Promise<unknown> {
    const checked = typeof resumeId === 'string' ? validateRemoteFs(resumeId, op) : null;
    const path = validateRemotePath(target);
    if (!checked) throw new Error('Некорректная файловая операция удалённой сессии');
    if (path === null) throw new Error('Путь вне каталогов удалённой сессии');
    const id = await this.locate(resumeId);
    if (!id) throw new Error('Некорректная файловая операция удалённой сессии');
    const host = id.host;
    await host.ensure();
    const reply = await host.request({ type: 'fs', sid: id.sid, op: checked.op satisfies RemoteFsOp, path });
    if (typeof reply.error === 'string') throw new Error(reply.error);
    return reply.value;
  }

  /** remote:search. Поиск по содержимому или изменениям клона: корень - каталог клона на хосте. */
  async search(resumeId: unknown, mode: unknown, request: unknown): Promise<SearchReply> {
    if (typeof resumeId !== 'string' || !SESSION_ID.test(resumeId) || (mode !== 'text' && mode !== 'changes') || typeof request !== 'object' || request === null) throw new Error('Некорректный поиск по удалённой сессии');
    const root = validateRemotePath((request as { root?: unknown }).root);
    if (root === null) throw new Error('Корень поиска вне каталогов удалённой сессии');
    const id = await this.locate(resumeId);
    if (!id) throw new Error('Некорректный поиск по удалённой сессии');
    const host = id.host;
    await host.ensure();
    const reply: Msg = await host.request({ type: 'search', sid: id.sid, mode, request }, SEARCH_TIMEOUT_MS);
    if (typeof reply.error === 'string') throw new Error(reply.error);
    return readSearchReply(reply.value);
  }
}
