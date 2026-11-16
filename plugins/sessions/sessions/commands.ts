import type { PluginContext } from '@cyborg-harness/contracts';
import { validateCreateInput } from './args.ts';
import type { Input } from './input.ts';
import type { Launcher } from './launcher.ts';
import type { Registry } from './registry.ts';

/**
 * Соответствие каналов владельца ai-cyborg командам плагина; тест сверяет его с манифестом.
 * `session:input` и `session:resize` решает pty-хост ядра (вид пишет в терминал по билету), `sessions.write` и `sessions.resize` - для плагинов и видов без терминала ядра.
 * `history:list` и `history:delete` отдаёт вид «Сессии проекта» (команды заведены в view-bridge.ts). `session:handoffFailed` - часть передачи задачи другой сессии (`Handoffs`), её переносит M-04.
 */
export const CHANNELS = {
  'session:create': 'sessions.create',
  'session:resume': 'sessions.resume',
  'session:kill': 'sessions.kill',
  'history:list': 'sessions.history.list',
  'history:delete': 'sessions.history.delete',
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Команды плагина: их зовёт вид (человек) и сам плагин через `ctx.commands`. Остальным плагинам открыт контракт `cyborg.sessions`, команды у них не нужны. */
export function registerCommands(ctx: PluginContext, registry: Registry, launcher: Launcher, input: Input, opened: (sessionId: string) => void = () => undefined): void {
  const parse = (raw: unknown, resume: boolean) => {
    const parsed = validateCreateInput(raw);
    if (typeof parsed === 'string') throw new Error(parsed);
    if (resume && parsed.resumeId === undefined) throw new Error('resumeId: нужен id прошлой сессии');
    return parsed;
  };
  ctx.commands.register('sessions.agents', () => Promise.all(launcher.agents().map(async (p) => ({ pluginId: p.pluginId, ...(await p.impl.facts()) }))));
  ctx.commands.register('sessions.create', (raw) => {
    // Продолжение прошлой сессии - отдельная команда (session:resume): `create` не принимает resumeId, чтобы запрос «новая сессия» не продолжил старую.
    if (isRecord(raw) && raw.resumeId !== undefined) throw new Error('resumeId: продолжение - команда sessions.resume');
    return launcher.open(parse(raw, false)).then((result) => (opened(result.sessionId), result));
  });
  ctx.commands.register('sessions.resume', (raw) => launcher.open(parse(raw, true)).then((result) => (opened(result.sessionId), result)));
  ctx.commands.register('sessions.kill', (id) => input.kill(id));
  ctx.commands.register('sessions.write', (id, data) => input.write(id, data));
  ctx.commands.register('sessions.resize', (id, cols, rows) => input.resize(id, cols, rows));
  ctx.commands.register('sessions.previous', async () =>
    (await ctx.documents.list())
      .filter((d) => !registry.byDoc(d.id)?.handle)
      .map((d) => ({ id: d.id, title: d.title, agent: isRecord(d.data) ? d.data.agent : undefined, resumable: isRecord(d.data) && typeof d.data.resumeId === 'string' })),
  );
  // Идущие сессии: окно после перезагрузки (и подхваченные при активации) открывает их заново по новому билету.
  ctx.commands.register('sessions.running', () => registry.liveTabs().map((t) => ({ id: t.doc, sessionId: t.sessionId, title: t.title, pid: t.handle?.pid })));
  ctx.commands.register('sessions.reopen', async (doc) => {
    const tab = typeof doc === 'string' ? registry.byDoc(doc) : undefined;
    if (!tab?.handle) throw new Error(`сессии ${String(doc)} нет`);
    return { sessionId: tab.sessionId, title: tab.title, ticket: await launcher.present(tab.sessionId) };
  });
  ctx.commands.register('sessions.restore', (doc) => launcher.restore(String(doc)).then((result) => (opened(result.sessionId), result)));
}
