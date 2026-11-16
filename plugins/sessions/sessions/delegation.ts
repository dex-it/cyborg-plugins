import type { AgentEvent, SessionAction } from '@cyborg-harness/contracts';
import { cleanMessage } from './args.ts';
import { SUBMIT_DELAY_MS } from './input.ts';
import type { ChildSessions } from './child-sessions.ts';
import type { Registry, Tab } from './registry.ts';
import { REPORT_ACCEPTED, REPORTED_ERROR, reportNote, reportText } from './report.ts';
import type { PeerInfo, ReportArgs, SayResult, SessionKind, SessionState } from './tools.ts';

// Сведения о сессиях, нужные инструментам делегирования: номер `CC<n>`, состояние по событиям агента (FR-15005), очередь сообщений работающей вкладке (FR-15008),
// родитель и «семья», итог дочерней (FR-15010). Перенос части src/main/sessions.ts и session-state.ts ai-cyborg. Состояние только в памяти плагина;
// в документ вкладки уходят лишь родитель и семья (метка и цвет вкладки: рисует вид).

/** Тишина, которую сессия должна выдержать после события, прежде чем ей отдадут сообщение из очереди: чужой Stop-хук мог продолжить ход. */
export const OUTBOX_QUIET_MS = 2000;

/** Откуда сессия: открыта человеком (пусто) или другой сессией. Хранится в документе вкладки, поэтому переживает перезапуск. */
export interface Lineage {
  /** id сессии-родителя. */
  readonly parent?: string;
  /** Номер родителя на момент открытия: подпись `↳N` остаётся и после закрытия родителя. */
  readonly parentNumber?: number;
  /** id корня семьи: цвет у всей семьи один, у самостоятельной сессии своя семья. */
  readonly family?: string;
}

interface Meta {
  readonly sessionId: string;
  readonly number: number;
  readonly dirs: readonly string[];
  cwd: string;
  state: SessionState;
  reason?: string | undefined;
  lastAnswer?: string;
  /** Сообщения других сессий, ждущие конца хода: в работающую сессию не пишем, Enter мог бы попасть в её запрос разрешения. */
  outbox: string[];
  outboxTimer?: ReturnType<typeof setTimeout>;
  lastEventAt: number;
  delivering: boolean;
  lineage: Lineage;
  /** Итог этого круга работы сдан report_done; круг открывает следующий запрос. */
  reported: boolean;
  /** Последнее событие - конец хода: следующее «ждёт» от агента не вопрос человеку, а тот же конец хода. */
  turnOver: boolean;
  /** Номер разговора агента: первое событие и новый после /clear попадают в перечень дочерних. */
  resumeId?: string;
  /** Кнопки, предложенные инструментом поставщика; следующий запрос человека их снимает. */
  actions: readonly SessionAction[];
}

export interface DelegationDeps {
  registry: Registry;
  children: ChildSessions;
  log(message: string, level?: 'warn'): void;
  /** Сообщение виду плагина; ошибка доставки (вида нет) - не сбой. */
  announce(message: Record<string, unknown>): void;
  /** Закрывает вкладку так же, как крестик: документ, процесс, метки, токен. */
  closeTab(tab: Tab): Promise<void>;
  /** Уведомление рабочего стола, когда итогу дочерней некому прийти (открывшей сессии нет). */
  notify(title: string, body: string): void;
  /** Токен сессии больше не нужен. */
  revoke(sessionId: string): void;
  quietMs?: number;
}

const sameDirs = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');

/** Номер из заголовка вкладки («Claude Code 3» - 3). */
const numberInTitle = (title: string): number | undefined => {
  const digits = /(\d+)$/.exec(title)?.[1];
  return digits === undefined ? undefined : Number(digits);
};

/** Удалённая сессия за вкладкой: хост и идентификатор на нём (привязывает remote-sessions). */
export interface RemoteInfo {
  readonly host: string;
  readonly sid: string;
}

export class Delegation {
  private readonly metas = new Map<string, Meta>();
  private readonly remotes = new Map<string, RemoteInfo>();
  private readonly deps: DelegationDeps;
  private readonly quietMs: number;

  constructor(deps: DelegationDeps) {
    this.deps = deps;
    this.quietMs = deps.quietMs ?? OUTBOX_QUIET_MS;
  }

  /** Номер, под которым вкладку знает модель: из заголовка, если свободен, иначе следующий за наибольшим. */
  private allocate(title: string): number {
    const taken = new Set([...this.metas.values()].map((m) => m.number));
    const wanted = numberInTitle(title);
    if (wanted !== undefined && wanted > 0 && !taken.has(wanted)) return wanted;
    return Math.max(0, ...taken) + 1;
  }

  /** Вкладка появилась (новый запуск, восстановление или подхват оставленного pty). */
  attach(tab: Tab, lineage: Lineage = {}, adopted = false): number {
    const old = this.metas.get(tab.sessionId);
    if (old) this.stop(old);
    const meta: Meta = {
      sessionId: tab.sessionId,
      number: this.allocate(tab.title),
      dirs: tab.dirs,
      cwd: tab.dirs[0] ?? '',
      // Подхваченная сессия: о её состоянии известно лишь то, что придёт дальше. Пока событий нет, ей не пишут (starting - отказ).
      state: 'starting',
      outbox: [],
      lastEventAt: Date.now(),
      delivering: false,
      lineage: lineage.family === undefined ? { ...lineage, family: lineage.parent === undefined ? tab.sessionId : (this.metas.get(lineage.parent)?.lineage.family ?? lineage.parent) } : lineage,
      reported: false,
      turnOver: false,
      actions: [],
    };
    this.metas.set(tab.sessionId, meta);
    if (adopted) this.deps.log(`${tab.title}: подхвачена как CC${String(meta.number)}, состояние станет известно по первому событию`);
    return meta.number;
  }

  /** Родитель и семья для новой вкладки; родителя уже нет - его id остаётся (метка), семья берётся как у него. */
  lineageOf(parent: string | undefined): Lineage {
    if (parent === undefined) return {};
    const meta = this.metas.get(parent);
    return { parent, ...(meta !== undefined && { parentNumber: meta.number }), family: meta?.lineage.family ?? parent };
  }

  private stop(meta: Meta): void {
    clearTimeout(meta.outboxTimer);
    meta.outbox.length = 0;
  }

  /** Вкладка закрыта или процесс вышел: очередь пропадает, токен отозван. Номер освобождается. */
  forget(sessionId: string): void {
    const meta = this.metas.get(sessionId);
    if (meta) this.stop(meta);
    this.metas.delete(sessionId);
    this.remotes.delete(sessionId);
    this.deps.revoke(sessionId);
  }

  /** Вкладка - удалённая сессия: набор инструментов, хост в list_sessions, итог с хостом. Привязка живёт до `forget`. */
  setRemote(sessionId: string, remote: RemoteInfo): void {
    this.remotes.set(sessionId, remote);
  }

  remoteOf(sessionId: string): RemoteInfo | undefined {
    return this.remotes.get(sessionId);
  }

  /** Удалённая сессия по номеру вкладки. */
  remoteByNumber(number: number): { sessionId: string; remote: RemoteInfo } | undefined {
    const sessionId = this.sessionOf(number);
    const remote = sessionId === undefined ? undefined : this.remotes.get(sessionId);
    return sessionId === undefined || remote === undefined ? undefined : { sessionId, remote };
  }

  kindOf(number: number): SessionKind {
    return this.remoteByNumber(number) ? 'remote' : 'local';
  }

  numberOf(sessionId: string): number | undefined {
    return this.metas.get(sessionId)?.number;
  }

  sessionOf(number: number): string | undefined {
    for (const meta of this.metas.values()) if (meta.number === number) return meta.sessionId;
    return undefined;
  }

  private byNumber(number: number): Meta | undefined {
    const id = this.sessionOf(number);
    return id === undefined ? undefined : this.metas.get(id);
  }

  dirsOf(number: number): readonly string[] | null {
    return this.byNumber(number)?.dirs ?? null;
  }

  /** Открыта другой сессией (родитель мог уже закрыться: итог тогда уйдёт уведомлением). */
  isChild(number: number): boolean {
    return this.byNumber(number)?.lineage.parent !== undefined;
  }

  /** Данные для вида: номер, подпись, родитель и семья живых вкладок. */
  family(): { sessionId: string; doc: string; number: number; label: string; parent?: string; parentNumber?: number; family: string }[] {
    return [...this.metas.values()].flatMap((m) => {
      const tab = this.deps.registry.live(m.sessionId);
      if (!tab) return [];
      return [
        {
          sessionId: m.sessionId,
          doc: tab.doc,
          number: m.number,
          label: `CC${String(m.number)}${m.lineage.parentNumber !== undefined ? ` ↳${String(m.lineage.parentNumber)}` : ''}`,
          ...(m.lineage.parent !== undefined && { parent: m.lineage.parent }),
          ...(m.lineage.parentNumber !== undefined && { parentNumber: m.lineage.parentNumber }),
          family: m.lineage.family ?? m.sessionId,
        },
      ];
    });
  }

  /** Работающие сессии проекта вызывающей, она сама тоже: проект сессии - набор её каталогов запуска. null - сессии нет. */
  peers(number: number): PeerInfo[] | null {
    const own = this.byNumber(number);
    if (!own || !this.deps.registry.live(own.sessionId)) return null;
    return [...this.metas.values()]
      .filter((m) => sameDirs(m.dirs, own.dirs) && this.deps.registry.live(m.sessionId))
      .map((m) => ({
        id: m.number,
        dirs: m.dirs,
        cwd: m.cwd,
        state: m.state,
        ...(m.reason !== undefined && { reason: m.reason }),
        ...(m.lastAnswer !== undefined && { lastAnswer: m.lastAnswer }),
        queued: m.outbox.length,
        ...(this.remotes.has(m.sessionId) && { host: this.remotes.get(m.sessionId)?.host ?? '' }),
        ...(m.lineage.parentNumber !== undefined && { parent: m.lineage.parentNumber }),
      }));
  }

  /** Событие агента: состояние для list_sessions по тем же правилам, что у хуков в ai-cyborg (session-state.ts, `track`). */
  event(tab: Tab, e: AgentEvent): void {
    const meta = this.metas.get(tab.sessionId);
    if (!meta) return;
    meta.lastEventAt = Date.now();
    const turnOver = meta.turnOver;
    meta.turnOver = false;
    switch (e.type) {
      case 'cwd':
        meta.cwd = e.cwd;
        break;
      case 'session':
        if (meta.state === 'starting') meta.state = 'waiting';
        // Разговор дочерней: первый и новый после /clear. Журнал Claude Code не знает, кто её открыл, «История» узнаёт из этого перечня.
        if (meta.lineage.parent !== undefined && e.resumeId !== meta.resumeId) void this.deps.children.add(e.resumeId, (error) => this.deps.log(`перечень дочерних сессий: ${String(error)}`, 'warn'));
        meta.resumeId = e.resumeId;
        break;
      case 'prompt':
        meta.state = 'working';
        meta.reason = undefined;
        meta.reported = false;
        this.setActions(meta, []);
        break;
      case 'activity':
        meta.state = 'working';
        meta.reason = undefined;
        break;
      case 'turnEnd':
        meta.state = e.background ? 'working' : 'waiting';
        meta.reason = undefined;
        meta.turnOver = !e.background;
        if (typeof e.text === 'string') meta.lastAnswer = e.text;
        break;
      case 'waiting':
        // Тот же конец хода, объявленный после тишины (agent-claude-code): человека никто не ждёт с вопросом.
        if (turnOver) {
          meta.turnOver = true;
          break;
        }
        meta.state = 'asking';
        meta.reason = e.reason;
        break;
    }
    this.schedule(meta);
  }

  /** Кнопки инструмента поставщика: хранятся до следующего запроса человека и уходят виду. */
  setActions(meta: Meta | string, actions: readonly SessionAction[]): void {
    const target = typeof meta === 'string' ? this.metas.get(meta) : meta;
    if (!target || (target.actions.length === 0 && actions.length === 0)) return;
    target.actions = actions;
    this.deps.announce({ type: 'actions', sessionId: target.sessionId, actions });
  }

  actionsOf(sessionId: string): readonly SessionAction[] {
    return this.metas.get(sessionId)?.actions ?? [];
  }

  /** Очередь отдаёт по сообщению, когда сессия ждёт и молчит `quietMs`: чужой Stop-хук мог продолжить ход. */
  private schedule(meta: Meta): void {
    clearTimeout(meta.outboxTimer);
    if (meta.state !== 'waiting' || meta.outbox.length === 0 || meta.delivering) return;
    meta.outboxTimer = setTimeout(
      () => {
        const text = meta.outbox.shift();
        if (text !== undefined) this.deliver(meta, text).catch(() => undefined);
      },
      Math.max(0, meta.lastEventAt + this.quietMs - Date.now()),
    );
  }

  /** Сообщение от другой сессии: ждущей - сразу, работающей - в очередь до конца её хода; на вопросе и при запуске - отказ. */
  async say(number: number, text: string): Promise<SayResult> {
    const meta = this.byNumber(number);
    if (!meta || !this.deps.registry.live(meta.sessionId)) throw new Error(`сессия ${String(number)} завершилась`);
    const quiet = Date.now() - meta.lastEventAt >= this.quietMs;
    if (meta.state === 'working' || (meta.state === 'waiting' && (!quiet || meta.outbox.length > 0 || meta.delivering))) {
      meta.outbox.push(text);
      this.schedule(meta);
      return 'queued';
    }
    if (meta.state !== 'waiting') throw new Error(`сессия ${String(number)} ${meta.state === 'asking' ? `ждёт человека (${meta.reason ?? 'вопрос'})` : 'ещё запускается'}`);
    await this.deliver(meta, text);
    return 'sent';
  }

  private async deliver(meta: Meta, text: string): Promise<void> {
    const registry = this.deps.registry;
    // Перед каждой записью: открытый запрос разрешения принял бы Enter за «Да».
    const write = async (data: string): Promise<void> => {
      const handle = registry.live(meta.sessionId)?.handle;
      if (!handle || this.metas.get(meta.sessionId) !== meta) throw new Error(`сессия ${String(meta.number)} завершилась`);
      if (meta.state !== 'waiting') throw new Error(`сессия ${String(meta.number)} начала ход: текст вставлен в её ввод, Enter не отправлен`);
      try {
        await handle.write(data);
      } catch {
        throw new Error(`сессия ${String(meta.number)} завершилась`);
      }
    };
    meta.delivering = true;
    try {
      // Вставкой: перевод строки в тексте TUI мог бы принять за Enter и отправить сообщение по кускам.
      // Чистка у записи: в очередь попадает и текст итога, минуя validateSend.
      await write(`\x1b[200~${cleanMessage(text)}\x1b[201~`);
      await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
      await write('\r');
    } finally {
      meta.delivering = false;
      // Хук UserPromptSubmit приходит позже Enter: тишина отсчитывается заново.
      meta.lastEventAt = Date.now();
      if (this.metas.get(meta.sessionId) === meta) this.schedule(meta);
    }
  }

  /** Сообщение в очередь сессии без отказа: уйдёт, когда она будет ждать. false - сессии нет. */
  enqueue(sessionId: string, text: string): boolean {
    const meta = this.metas.get(sessionId);
    if (!meta || !this.deps.registry.live(sessionId)) return false;
    meta.outbox.push(text);
    this.schedule(meta);
    return true;
  }

  /**
   * Итог локальной дочерней (report_done): один за круг работы, в очередь открывшей сессии;
   * её уже нет - уведомлением рабочего стола.
   */
  reportLocal(number: number, report: ReportArgs): string {
    const meta = this.byNumber(number);
    const remote = meta === undefined ? undefined : this.remotes.get(meta.sessionId);
    // У удалённой сессии итог есть и без открывшей: тогда он показывается человеку уведомлением, как в ai-cyborg.
    if (!meta || (meta.lineage.parent === undefined && remote === undefined)) throw new Error('report_done есть только у сессии, открытой другой сессией');
    if (meta.reported) throw new Error(REPORTED_ERROR);
    meta.reported = true;
    const text = reportText(number, remote?.host, report);
    if (meta.lineage.parent === undefined || !this.enqueue(meta.lineage.parent, text)) this.deps.notify(remote ? `CC${String(number)} · ${remote.host}` : `CC${String(number)}`, reportNote(report));
    return REPORT_ACCEPTED;
  }

  /** Закрыть вкладку по номеру, как крестик. */
  async close(number: number): Promise<void> {
    const id = this.sessionOf(number);
    const tab = id === undefined ? undefined : this.deps.registry.get(id);
    if (!tab) throw new Error(`сессии ${String(number)} нет`);
    this.deps.announce({ type: 'session:close', sessionId: tab.sessionId, number });
    await this.deps.closeTab(tab);
  }

  /** Сессии, которым ещё идёт очередь: для остановки в `deactivate`. */
  dispose(): void {
    for (const meta of this.metas.values()) this.stop(meta);
  }
}
