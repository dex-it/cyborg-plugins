// Связь с демоном на одном хосте. В ai-cyborg (host-link.ts) это один долгоживущий `ssh` со строчным протоколом JSON; на ядре процесс со стримингом
// плагину не дан (cyborg-harness#260), поэтому каждый запрос или пачка запросов - отдельный короткий `ssh host sh .cyborg/agentd/<версия>/client.sh rpc`:
// строки JSON уходят в stdin, ответы (строки с rid) читаются из stdout. Протокол сообщений демона тот же (PROTO 2); состояния и переподключения нет:
// обрыв связи - ошибка вызова, а сессия на хосте живёт сама и подхватывается новым attach.
import { PROTO } from './limits.ts';
import type { AgentdBundle } from './install.ts';
import { installScript } from './install.ts';
import { parsePreflight, PREFLIGHT_SCRIPT, type HostTools } from './preflight.ts';
import { classifySshError, type Ssh } from './ssh.ts';

export type Msg = { type: string; rid?: number } & Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 15_000;
const RESTART_ATTEMPTS = 4;
/** Проверка и установка свежи столько, потом хост проверяется заново: так «История» не гоняет preflight на каждый вызов. */
const READY_TTL_MS = 60_000;

export interface HostDeps {
  host: string;
  ssh: Ssh;
  bundle: AgentdBundle;
  /** Идентификатор экземпляра Cyborg: то же окно после обрыва забирает свои сессии у демона. */
  instance: string;
  /** Задан токен Claude: вход claude на хосте не требуется. */
  claudeToken?: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Хост, демон на нём и запросы к демону. */
export class Host {
  home = '';
  tools: HostTools = { gh: false, glab: false };
  /** Хэш зеркала настройки Claude, лежащего на хосте; null - зеркала нет. */
  config: string | null = null;
  /** Место на диске ~/.cyborg хоста по ответу на hello. */
  disk: { free: number; total: number } | null = null;
  private readyAt = 0;
  private ensuring: Promise<void> | null = null;
  private readonly deps: HostDeps;

  constructor(deps: HostDeps) {
    this.deps = deps;
  }

  get host(): string {
    return this.deps.host;
  }

  /** Хост в порядке и демон нужной версии стоит; отказ - Error с причиной для человека. */
  ensure(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    if (this.readyAt && now - this.readyAt < READY_TTL_MS) return Promise.resolve();
    this.ensuring ??= this.prepare().finally(() => (this.ensuring = null));
    return this.ensuring;
  }

  /** Забыть проверку: следующий вызов проверит хост заново (после отказа связи). */
  reset(): void {
    this.readyAt = 0;
  }

  private async prepare(): Promise<void> {
    const { host, ssh, bundle } = this.deps;
    const pre = await ssh.run(host, PREFLIGHT_SCRIPT);
    if (pre.code !== 0) throw new Error(classifySshError(pre.stderr));
    const checked = parsePreflight(pre.stdout, (await this.deps.claudeToken?.()) ?? false);
    if ('missing' in checked) throw new Error(checked.missing.join('; '));
    this.home = checked.home;
    this.tools = checked.tools;
    if (!checked.installed.includes(bundle.version)) {
      const done = await ssh.run(host, installScript(bundle));
      if (done.code !== 0) throw new Error(`установка агента на хосте: ${classifySshError(done.stderr)}`);
    }
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < RESTART_ATTEMPTS; attempt++) {
      const hello = (await this.rpc([{ type: 'hello', proto: PROTO, instance: this.deps.instance }]))[0] as Msg;
      this.config = typeof hello.config === 'string' ? hello.config : null;
      const disk = hello.disk as { free?: unknown; total?: unknown } | null | undefined;
      this.disk = disk && Number.isFinite(disk.free) && Number.isFinite(disk.total) ? { free: Number(disk.free), total: Number(disk.total) } : null;
      const sessions = Number(hello.sessions ?? 0);
      const compatible = hello.proto === PROTO;
      if ((hello.version === bundle.version && compatible) || (sessions > 0 && compatible)) {
        this.readyAt = (this.deps.now ?? Date.now)();
        return;
      }
      if (sessions > 0) throw new Error(`на хосте работает демон несовместимой версии с ${String(sessions)} сессиями`);
      // Старый демон без сессий: просим выйти, следующий клиент поднимет демон из нового каталога.
      await this.rpc([{ type: 'shutdown' }]).catch(() => undefined);
      await sleep(300);
    }
    throw new Error('демон на хосте не обновился');
  }

  /**
   * Пачка сообщений одним вызовом ssh: ответы по порядку сообщений. Сообщение `error` демона - отказ вызова с его текстом.
   * Перед пачкой идёт `hello` с экземпляром Cyborg (демон по нему различает «своё» окно), если пачка сама не начинается с него.
   */
  async rpc(messages: Record<string, unknown>[], timeoutMs = REQUEST_TIMEOUT_MS): Promise<Msg[]> {
    const { host, ssh, bundle } = this.deps;
    const batch = messages[0]?.type === 'hello' ? messages : [{ type: 'hello', proto: PROTO, instance: this.deps.instance }, ...messages];
    const lines = batch.map((m, i) => JSON.stringify({ ...m, rid: i + 1 }));
    const res = await ssh.exec(host, `sh .cyborg/agentd/${bundle.version}/client.sh rpc`, { input: lines.join('\n') + '\n', timeoutMs, limitMs: timeoutMs });
    const replies = new Map<number, Msg>();
    for (const line of res.stdout.split('\n')) {
      try {
        const msg = JSON.parse(line) as Msg;
        if (typeof msg.rid === 'number') replies.set(msg.rid, msg);
      } catch {
        // шум профиля оболочки или пустая строка
      }
    }
    const out: Msg[] = [];
    for (let i = 0; i < batch.length; i++) {
      const reply = replies.get(i + 1);
      if (!reply) {
        this.reset();
        throw new Error(res.code !== 0 ? classifySshError(res.stderr) : `хост ${host} не ответил за ${String(timeoutMs / 1000)} с`);
      }
      if (reply.type === 'error') throw new Error(String(reply.message ?? 'ошибка демона'));
      out.push(reply);
    }
    return messages[0]?.type === 'hello' ? out : out.slice(1);
  }

  /** Один запрос демону (после ensure). */
  async request(msg: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Msg> {
    return (await this.rpc([msg], timeoutMs))[0] as Msg;
  }
}
