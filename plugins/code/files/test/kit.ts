// Общее для тестов плагина files: ядро на тест-ките с настоящими `files`, `git` и `projects` (поставщики отметок, веток и корней - не подделки), подставным поставщиком `cyborg.sessions`
// (настоящий требует агента и pty; здесь нужны только события `onChange` и `uses`), заглушкой `viewer.open` и репозиториями `fixtureRepo()`.
// Вид строится на `UiContext` поверх настоящего ядра: команды - `kernel.runOwn`, диалоги - слой ядра, канал - сообщения главной части.

import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync, watch as watchFs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { DialogSpec, Disposable as Sub, PluginContext, SessionChange, SessionEvent, UiContext } from '@cyborg-harness/contracts';
import type { OsEnvironment } from '@cyborg-harness/core';
import { memoryStore, startKernel, type InlinePlugin, type StartKernelOptions, type TestKernel } from '@cyborg-harness/testing';
import { fixtureRepo, toolbox, type FixtureRepo, type Toolbox } from '@cyborg-plugins/fixtures';
import type { ViewReply } from '../protocol.ts';
import type { FakeElement } from './dom.ts';

export const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
export const PLUGINS = path.resolve(PLUGIN_DIR, '..', '..');
export const GIT_DIR = path.join(PLUGINS, 'code', 'git');
export const PROJECTS_DIR = path.join(PLUGINS, 'code', 'projects');

/** Ждёт условие опросом: события приходят от ОС и проходят границу хостов, поэтому «сразу» их не увидеть. */
export async function until<T>(what: string, cond: () => T | Promise<T>, timeout = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await cond();
    if (value) return value as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`не дождались: ${what}`);
}

/** Пауза «ничего не должно произойти». */
export const pause = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export { GIT_ENV };

export interface Repo extends Disposable {
  readonly dir: string;
  git(...args: string[]): string;
  /** Пишет файл относительно корня (каталоги создаются). */
  write(file: string, text?: string): void;
}

/** Репозиторий из `fixtureRepo()` с настоящим путём (на macOS `tmpdir()` - ссылка, а git называет корень физическим путём). */
export function repo(options: Parameters<typeof fixtureRepo>[0] = {}): Repo {
  const inner: FixtureRepo = fixtureRepo(options);
  const dir = realpathSync(inner.dir);
  return {
    dir,
    git: (...args) => inner.git(...args),
    write(file, text = 'x\n') {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    },
    [Symbol.dispose]: () => inner[Symbol.dispose](),
  };
}

export interface SessionsFake {
  readonly plugin: InlinePlugin;
  /** Каталоги, с которыми «идёт» живая сессия (`uses`). */
  readonly live: Set<string>;
  /** Событие сессии всем подписчикам. */
  emit(sessionId: string, change: SessionChange, title?: string): void;
}

/** Подставной поставщик `cyborg.sessions` 1.2: события и `uses`; настоящий (`sessions`) требует агента и pty. */
export function fakeSessions(version: '1.1' | '1.2' = '1.2'): SessionsFake {
  const listeners = new Set<(event: SessionEvent) => void>();
  const state: SessionsFake = {
    live: new Set(),
    emit(sessionId, change, title = `CC-${sessionId}`) {
      for (const l of [...listeners]) l({ sessionId, title, change });
    },
    plugin: {
      manifest: { id: 'fake-sessions', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.sessions': version } },
      module: {
        activate(ctx: PluginContext) {
          const base = {
            onChange: (listener: (event: SessionEvent) => void) => {
              listeners.add(listener);
              return { dispose: () => void listeners.delete(listener) };
            },
            reveal: async () => undefined,
          };
          const impl = version === '1.2' ? { ...base, uses: async (root: string) => state.live.has(root) } : base;
          ctx.contracts.provide('cyborg.sessions', version, impl as never);
          return undefined;
        },
      },
    },
  };
  return state;
}

/** Просмотр файла: заглушка `viewer.open`, которой нужна открытая команда плагинам и право читать `workspace`. */
export function fakeViewer(): { plugin: InlinePlugin; opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    plugin: {
      manifest: { id: 'viewer', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'viewer.open': { args: ['record'], callers: 'plugins', guard: { 'fs.read': '0.path' } } }, permissions: { 'fs.read': ['workspace'] } },
      module: {
        activate(ctx: PluginContext) {
          ctx.commands.register('viewer.open', (request) => void opened.push(String((request as { path: unknown }).path)));
          return undefined;
        },
      },
    },
  };
}

/** Слежения шлюза: открытые за всё время и закрытые; их считает обёртка над `fs.watch` среды ядра. */
export interface Watches {
  readonly opened: { path: string; recursive: boolean }[];
  closed: number;
  live(): number;
}

function countedWatch(): { watches: Watches; watch: NonNullable<OsEnvironment['watch']> } {
  const watches: Watches = { opened: [], closed: 0, live: () => watches.opened.length - watches.closed };
  type Listener = (event: string, name: string | null) => void;
  type Watch = (target: string, ...rest: [Listener] | [object, Listener]) => FSWatcher;
  const inner = watchFs as unknown as Watch;
  const counted = ((target: string, ...rest: [Listener] | [object, Listener]) => {
    watches.opened.push({ path: target, recursive: rest.length === 2 && (rest[0] as { recursive?: boolean }).recursive === true });
    const w = rest.length === 1 ? inner(target, rest[0]) : inner(target, rest[0], rest[1]);
    const close = w.close.bind(w);
    let closed = false;
    w.close = () => {
      if (!closed) watches.closed++;
      closed = true;
      close();
    };
    return w;
  }) as unknown as NonNullable<OsEnvironment['watch']>;
  return { watches, watch: counted };
}

export interface RigOptions {
  /** Репозитории проекта: проект сохраняется и становится областью `workspace`. */
  readonly repos?: readonly string[];
  readonly sessions?: SessionsFake | undefined;
  /** Без плагина git: дерево без отметок и веток. */
  readonly noGit?: boolean;
  /** Без `viewer`. */
  readonly noViewer?: boolean;
  readonly countWatches?: boolean;
  readonly os?: StartKernelOptions['os'];
  readonly extra?: readonly (string | InlinePlugin)[];
  /** Права probe, который читает `workspace` независимо от плагина files (голое слежение в замерах). */
  readonly toolbox?: Toolbox;
}

export interface Rig extends AsyncDisposable {
  readonly kernel: TestKernel;
  readonly watches: Watches;
  readonly viewer: { opened: string[] };
  readonly logs: string[];
  /** Журнал ядра без отказов и сбоев (иначе падает). */
  clean(): void;
  /** Проект с этими репозиториями (`projects.save`), выбранный. */
  setProject(repos: readonly string[], name?: string): Promise<void>;
  /** Ответ `files.view`. */
  view(scope?: string, refresh?: boolean): Promise<ViewReply>;
  run(command: string, ...args: unknown[]): Promise<unknown>;
  /** Сообщения главной части виду `tree`. */
  readonly sent: unknown[];
  onView(listener: (message: unknown) => void): Sub;
  /** Сообщение виду, как если бы его прислала главная часть. */
  emitView(message: unknown): void;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const box = options.toolbox ?? toolbox({});
  const viewer = fakeViewer();
  const logs: string[] = [];
  const sent: unknown[] = [];
  const listeners = new Set<(message: unknown) => void>();
  const counted = countedWatch();
  const config = memoryStore();
  const state = memoryStore();
  const kernel = await startKernel({
    config: config.store,
    state: state.store,
    plugins: [
      PLUGIN_DIR,
      PROJECTS_DIR,
      ...(options.noGit ? [] : [GIT_DIR]),
      ...(options.sessions ? [options.sessions.plugin] : []),
      ...(options.noViewer ? [] : [viewer.plugin]),
      ...(options.extra ?? []),
    ],
    os: { env: { PATH: box.env.PATH ?? '', HOME: box.root }, ...(options.countWatches && { watch: counted.watch }), ...options.os },
    load: {
      bundled: ['files', 'projects', 'git'],
      onLog: (pluginId, message) => void (pluginId === 'files' && logs.push(message)),
      onViewMessage: (pluginId, view, message) => {
        if (pluginId !== 'files' || view !== 'tree') return;
        sent.push(message);
        for (const l of [...listeners]) l(message);
      },
    },
  });
  try {
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'files' });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
  } catch (error) {
    throw new Error(`${String(error)}\n${JSON.stringify(kernel.journal.filter((e) => e.kind !== 'activated'))}`);
  }
  const run = (command: string, ...args: unknown[]): Promise<unknown> => kernel.run(command, ...args);
  return {
    kernel,
    watches: counted.watches,
    viewer,
    logs,
    sent,
    clean() {
      // projects проверяет путь до того, как ядро приняло его корнем (realpath до setRoots): отказ ожидаем, сохранённый проект его не повторяет.
      const bad = kernel.journal.filter((e) => !(e.pluginId === 'projects' && e.kind === 'denied') && (e.kind === 'failed' || e.kind === 'invalid' || e.kind === 'rejected' || e.kind === 'denied'));
      assert.deepEqual(bad, []);
    },
    async setProject(repos, name = 'Проект') {
      await run('projects.save', { projects: [{ id: 'p1', name, description: '', repos: [...repos] }], lastProjectId: 'p1' });
    },
    view: async (scope = '', refresh = false) => (await run('files.view', scope, refresh)) as ViewReply,
    run,
    onView: (listener) => (listeners.add(listener), { dispose: () => void listeners.delete(listener) }),
    emitView: (message) => void [...listeners].forEach((l) => l(message)),
    [Symbol.asyncDispose]: async () => {
      await kernel[Symbol.asyncDispose]();
      box[Symbol.dispose]();
    },
  };
}

// ---------- вид ----------


export interface UiRig {
  readonly ctx: UiContext;
  readonly drag: { started: string[]; drop: { from: string; path: string } | null };
  readonly commands: { name: string; args: unknown[] }[];
  /** Ответить на диалог ядра. */
  dispose(): void;
}

/** `UiContext` вида `tree` поверх настоящего ядра. */
export function uiRig(r: Rig): UiRig {
  const drag: UiRig['drag'] = { started: [], drop: null };
  const commands: UiRig['commands'] = [];
  const subs: Sub[] = [];
  const ctx = {
    pluginId: 'files',
    view: 'tree',
    commands: {
      run: (command: string, ...args: unknown[]) => {
        commands.push({ name: command, args });
        return r.kernel.runOwn('files', command, ...args);
      },
    },
    contracts: { get: async () => undefined },
    theme: { tokens: {}, onChange: () => ({ dispose() {} }) },
    visible: true,
    onVisibilityChange: () => ({ dispose() {} }),
    state: { value: undefined, set: async () => undefined },
    dialogs: { show: (spec: DialogSpec) => r.kernel.showDialog('files', 'tree', spec) },
    channel: {
      post: async () => undefined,
      onMessage: (listener: (m: unknown) => void) => {
        const sub = r.onView(listener);
        subs.push(sub);
        return sub;
      },
    },
    drag: { start: (p: string) => void drag.started.push(p), drop: async () => drag.drop },
    modal: undefined,
  } as unknown as UiContext;
  return { ctx, drag, commands, dispose: () => subs.forEach((s) => s.dispose()) };
}

export const asRoot = (e: FakeElement): HTMLElement => e as unknown as HTMLElement;

/** Подкаталог и файлы для тестов дерева: `tree({ 'a/x.txt': '1' })`. */
export function files(base: string, spec: Record<string, string>): void {
  for (const [file, text] of Object.entries(spec)) {
    mkdirSync(path.dirname(path.join(base, file)), { recursive: true });
    writeFileSync(path.join(base, file), text);
  }
}

export function link(target: string, at: string): void {
  symlinkSync(target, at);
}
