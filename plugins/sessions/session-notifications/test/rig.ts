import path from 'node:path';
import type { PluginContext, SessionEvent } from '@cyborg-harness/contracts';
import type { LayerStore, OsEnvironment } from '@cyborg-harness/core';
import { startKernel, type InlinePlugin, type TestKernel } from '@cyborg-harness/testing';

export const HOME = path.resolve(import.meta.dirname, '..');

/** Ждёт условие опросом: события проходят границу хостов и очередь плагина, поэтому «сразу» их не увидеть. */
export async function waitFor(what: string, condition: () => boolean, timeout = 5000): Promise<void> {
  const until = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Пауза «ничего не должно произойти»: даёт очереди плагина дойти до конца, прежде чем утверждать отсутствие. */
export const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Shown {
  readonly title: string;
  readonly body: string | undefined;
  readonly events: { click(): void; closed(): void };
  closed: boolean;
}

/** Подставная среда уведомлений ядра: что показано, что закрыто, сколько раз просили поднять окно. Баннер ОС в тесте нажать нечем: клик - `events.click()`. */
export function fakeNotify(): { readonly shown: Shown[]; readonly raised: () => number; readonly os: Pick<OsEnvironment, 'notify' | 'raiseWindow'> } {
  const shown: Shown[] = [];
  let raised = 0;
  return {
    shown,
    raised: () => raised,
    os: {
      notify: (title, body, events) => {
        const n: Shown = { title, body, events, closed: false };
        shown.push(n);
        return {
          close: () => {
            n.closed = true;
          },
        };
      },
      raiseWindow: () => {
        raised++;
      },
    },
  };
}

export interface FakeSessions {
  readonly plugin: InlinePlugin;
  /** Событие поставщика всем подписчикам `cyborg.sessions.onChange`. */
  emit(event: SessionEvent): void;
  /** Сколько подписчиков сейчас у поставщика. */
  listeners(): number;
  /** Вызовы `reveal` поставщика. */
  readonly revealed: string[];
}

/** Подставной поставщик `cyborg.sessions` (настоящего в репозитории ещё нет): шлёт события, какие скажет тест. `reveal: false` - поставщик 1.0 без члена `reveal`. */
export function fakeSessions(options: { readonly reveal?: boolean; readonly id?: string } = {}): FakeSessions {
  const heard = new Set<(event: SessionEvent) => void>();
  const revealed: string[] = [];
  const withReveal = options.reveal !== false;
  const plugin: InlinePlugin = {
    manifest: { id: options.id ?? 'fake-sessions', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.sessions': withReveal ? '1.1' : '1.0' } },
    module: {
      activate(ctx: PluginContext) {
        ctx.contracts.provide('cyborg.sessions', withReveal ? '1.1' : '1.0', {
          onChange: (listener) => {
            heard.add(listener);
            return { dispose: () => void heard.delete(listener) };
          },
          ...(withReveal
            ? {
                reveal: (sessionId: string) => {
                  revealed.push(sessionId);
                  return Promise.resolve();
                },
              }
            : {}),
        });
        return undefined;
      },
    },
  };
  return {
    plugin,
    emit: (event) => {
      for (const listener of [...heard]) listener(event);
    },
    listeners: () => heard.size,
    revealed,
  };
}

export const waiting = (sessionId: string, reason = 'Просит разрешение', title = `Claude Code ${sessionId} · проект`): SessionEvent => ({ sessionId, title, change: { type: 'waiting', reason } });
export const activity = (sessionId: string, title = `Claude Code ${sessionId} · проект`): SessionEvent => ({ sessionId, title, change: { type: 'activity' } });
export const exited = (sessionId: string, code = 0, title = `Claude Code ${sessionId} · проект`): SessionEvent => ({ sessionId, title, change: { type: 'exit', code } });

export interface Rig {
  readonly k: TestKernel;
  readonly sessions: FakeSessions;
  readonly notices: ReturnType<typeof fakeNotify>;
  /** Строки `ctx.log` плагина. */
  readonly logs: string[];
  [Symbol.asyncDispose](): Promise<void>;
}

export interface RigOptions {
  /** Манифест плагина с поправкой (например, без права `notify`). */
  readonly manifest?: (manifest: Record<string, unknown>) => Record<string, unknown>;
  readonly sessions?: FakeSessions;
  /** Плагины теста рядом: например, потребитель контракта плагина. */
  readonly extra?: readonly InlinePlugin[];
  readonly state?: LayerStore;
  /** Что приложение отвечает про фокус окна до первого события; без него окно активно. */
  readonly windowFocused?: () => boolean;
  /** `true` - окно без фокуса с первого кадра (событие `focus` до запуска). */
  readonly unfocused?: boolean;
}

/** Плагин на настоящем ядре тест-кита с подставным поставщиком сессий и подставной средой уведомлений. По умолчанию окно без фокуса: иначе уведомлять не о чем. */
export async function rig(options: RigOptions = {}): Promise<Rig> {
  const notices = fakeNotify();
  const sessions = options.sessions ?? fakeSessions();
  const logs: string[] = [];
  const plugin = options.manifest ? await tweaked(options.manifest) : HOME;
  const k = await startKernel({
    plugins: [sessions.plugin, plugin, ...(options.extra ?? [])],
    os: notices.os,
    ...(options.state ? { state: options.state } : {}),
    load: {
      windowFocused: options.windowFocused ?? (() => false),
      onLog: (pluginId, message) => {
        if (pluginId === 'session-notifications') logs.push(message);
      },
    },
  });
  await k.waitForJournal({ kind: 'activated', pluginId: 'session-notifications' });
  await waitFor('подписка на cyborg.sessions встала', () => sessions.listeners() > 0);
  return { k, sessions, notices, logs, [Symbol.asyncDispose]: () => k[Symbol.asyncDispose]() };
}

async function tweaked(change: (manifest: Record<string, unknown>) => Record<string, unknown>): Promise<InlinePlugin> {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(path.join(HOME, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const module = (await import('../index.ts')) as { default: InlinePlugin['module'] };
  return { manifest: change(manifest), module: module.default };
}
