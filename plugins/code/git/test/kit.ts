// Общее для тестов плагина git: ядро на тест-ките с настоящим `git` и репозиториями `fixtureRepo()`, подставными поставщиками `cyborg.projects` и `cyborg.sessions`
// и потребителем `probe`, который берёт `cyborg.git` как чужой плагин (права probe - те, что у вида или плагина-потребителя).
// Программа git в PATH - обёртка: пишет аргументы каждого запуска в журнал (по нему тесты считают запуски) и передаёт настоящему git (или медленному из `toolbox({ slowGit })`).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, watch as watchFs, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { GitStatus, PluginContext, Remote, TreeDecoration } from '@cyborg-harness/contracts';
import type { GitV11, SessionsV12 } from '@cyborg-plugins/contracts';
import type { OsEnvironment } from '@cyborg-harness/core';
import { startKernel, type InlinePlugin, type StartKernelOptions, type TestKernel } from '@cyborg-harness/testing';
import { fixtureRepo, toolbox, type FixtureRepo, type Toolbox } from '@cyborg-plugins/fixtures';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

export const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');

/** Ждёт условие опросом: события приходят от ОС и проходят границу хостов, поэтому «сразу» их не увидеть. */
export async function until(what: string, cond: () => boolean | Promise<boolean>, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`не дождались: ${what}`);
}

/** Пауза «ничего не должно произойти». */
export const pause = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Репозиторий из `fixtureRepo()` с настоящим путём (на macOS `tmpdir()` - ссылка, а git называет корень физическим путём). */
export interface Repo extends Disposable {
  readonly dir: string;
  git(...args: string[]): string;
  /** Пишет файл относительно корня (каталоги создаются). */
  write(file: string, text: string | Uint8Array): void;
}

export function repo(options: Parameters<typeof fixtureRepo>[0] = {}): Repo {
  const inner: FixtureRepo = fixtureRepo(options);
  const dir = realpathSync(inner.dir);
  return {
    dir,
    git: (...args) => inner.git(...args),
    write(file, text) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    },
    [Symbol.dispose]: () => inner[Symbol.dispose](),
  };
}

/** Одна буква на путь, как отдавал `gitStatus` ai-cyborg: рабочее дерево главнее индекса, `?` - неотслеживаемый, `U` - конфликт. */
export function letters(status: GitStatus): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of status.changes) {
    if (c.index === '?') out[c.path] = '?';
    else if (c.index === 'U' || c.worktree === 'U') out[c.path] = 'U';
    else out[c.path] = c.worktree !== ' ' ? c.worktree : c.index;
  }
  return out;
}
export interface ProjectsFake
 {
  readonly plugin: InlinePlugin;
  repos: string[];
}

/** Подставной поставщик `cyborg.projects`: один проект с заданными репозиториями; они же - область `workspace` для остальных плагинов. */
export function fakeProjects(initial: readonly string[], extraRoots: readonly string[] = [], provide = true): ProjectsFake {
  const state: ProjectsFake = {
    repos: [...initial],
    plugin: {
      manifest: { id: 'fake-projects', version: '1.0.0', engines: { cyborg: '^1' }, ...(provide && { provides: { 'cyborg.projects': '1.0' } }), permissions: { 'security.roots': true } },
      module: {
        async activate(ctx: PluginContext) {
          await ctx.os.security?.setRoots([...state.repos, ...extraRoots]);
          if (!provide) return undefined;
          ctx.contracts.provide('cyborg.projects', '1.0', {
            list: async () => [{ id: 'p1', name: 'Проект', description: '', repos: [...state.repos] }],
            selected: async () => ({ id: 'p1', name: 'Проект', description: '', repos: [...state.repos] }),
            hasSelected: async () => true,
            roots: async () => [],
            onChange: () => ({ dispose() {} }),
          });
          return undefined;
        },
      },
    },
  };
  return state;
}

export interface SessionsFake {
  readonly plugin: InlinePlugin;
  /** Каталоги, с которыми «идёт» живая сессия. */
  readonly live: Set<string>;
  /** Сколько раз спросили `uses` и о каких каталогах. */
  readonly asked: string[];
}

/** Подставной поставщик `cyborg.sessions`: версия 1.2 с `uses` или 1.1 без него (поставщик до `cyborg-harness#257`). */
export function fakeSessions(version: '1.1' | '1.2' = '1.2'): SessionsFake {
  const state: SessionsFake = {
    live: new Set(),
    asked: [],
    plugin: {
      manifest: { id: 'fake-sessions', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.sessions': version } },
      module: {
        activate(ctx: PluginContext) {
          const base = { onChange: () => ({ dispose() {} }), reveal: async () => undefined };
          const impl = version === '1.2' ? { ...base, uses: async (root: string) => (state.asked.push(root), state.live.has(root)) } : base;
          ctx.contracts.provide('cyborg.sessions', version, impl as unknown as SessionsV12);
          return undefined;
        },
      },
    },
  };
  return state;
}

/** Запуск git, как его видит обёртка в PATH. */
export interface GitCall {
  readonly cwd: string;
  readonly args: string;
}

/**
 * Обёртка над git в PATH: каталог и строка аргументов каждого запуска - в журнал; запуск с аргументом из `fail.txt` (по строке на аргумент) завершается кодом 2;
 * дальше - следующий после неё git из PATH (настоящий).
 */
function wrapGit(dir: string): { bin: string; calls(): GitCall[]; failOn(...args: string[]): void } {
  const bin = path.join(dir, 'wrap-bin');
  const log = path.join(dir, 'git-runs.log');
  const fail = path.join(bin, 'fail.txt');
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, '');
  writeFileSync(fail, '');
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh
printf '%s\t%s\n' "$PWD" "$*" >> '${log}'
self=$(cd "$(dirname "$0")" && pwd)
while IFS= read -r pat; do
  [ -z "$pat" ] && continue
  case " $* " in *" $pat "*) exit 2;; esac
done < "$self/fail.txt"
IFS=:
seen=0
for dir in $PATH; do
  [ -z "$dir" ] && continue
  if [ "$(cd "$dir" 2>/dev/null && pwd)" = "$self" ]; then seen=1; continue; fi
  [ "$seen" = 1 ] && [ -x "$dir/git" ] && exec "$dir/git" "$@"
done
exit 127
`,
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  return {
    bin,
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf('\t');
          return { cwd: line.slice(0, tab), args: line.slice(tab + 1) };
        }),
    failOn: (...args) => writeFileSync(fail, args.map((a) => `${a}\n`).join('')),
  };
}

/** Слежения шлюза: открытые за всё время и закрытые; их считает обёртка над `fs.watch` среды ядра. */
export interface Watches {
  readonly opened: string[];
  closed: number;
  live(): number;
}

function countedWatch(): { watches: Watches; watch: NonNullable<OsEnvironment['watch']> } {
  const watches: Watches = { opened: [], closed: 0, live: () => watches.opened.length - watches.closed };
  type Listener = (event: string, name: string | null) => void;
  type Watch = (target: string, ...rest: [Listener] | [object, Listener]) => FSWatcher;
  const inner = watchFs as unknown as Watch;
  // Шлюз зовёт `watch(путь, слушатель)` или, с рекурсией, `watch(путь, { recursive: true }, слушатель)`.
  const counted = ((target: string, ...rest: [Listener] | [object, Listener]) => {
    watches.opened.push(target);
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
  /** Репозитории проекта (область `workspace`). */
  readonly repos?: readonly string[];
  /** Задержка `rev-parse --show-toplevel` в секундах: медленный git из фикстур. */
  readonly slowGit?: number;
  /** Подставной поставщик сессий; не передан - сессий в приложении нет совсем. */
  readonly sessions?: SessionsFake;
  /** Каталоги в области `workspace`, которых нет в проекте (рабочий каталог живой сессии, worktree). */
  readonly extraRoots?: readonly string[];
  /** Поставщика `cyborg.projects` нет: области `workspace` задаёт плагин, который проектов не отдаёт. */
  readonly noProjects?: boolean;
  /** Права probe: по умолчанию читает `workspace`. */
  readonly probePermissions?: Record<string, unknown>;
  readonly os?: StartKernelOptions['os'];
  /** Без обёртки git в PATH (замеры: обёртка - лишний `sh` на каждый запуск); `runs()` и `calls()` тогда пусты. */
  readonly noWrap?: boolean;
  /** Считать слежения шлюза (`rig.watches`). */
  readonly countWatches?: boolean;
  readonly extra?: readonly (string | InlinePlugin)[];
}

export interface Rig extends AsyncDisposable {
  readonly kernel: TestKernel;
  readonly box: Toolbox;
  readonly projects: ProjectsFake;
  /** Каталог не репозиторий (лежит в `workspace`): временный каталог набора. */
  readonly plain: string;
  /** `cyborg.git`, как его видит чужой плагин. */
  readonly git: Remote<GitV11>;
  readonly tree: Remote<TreeDecoration>;
  readonly probe: PluginContext;
  readonly watches: Watches;
  /** Запуски git за всё время: каталог и аргументы, как их видит обёртка в PATH. */
  calls(): GitCall[];
  /** Строки аргументов запусков за всё время (начало - закреплённые `SAFE_ARGS`). */
  runs(): string[];
  /** Запуск git с любым из этих аргументов завершается кодом 2 (обёртка в PATH). */
  failOn(...args: string[]): void;
  /** Запуски, начатые после последнего вызова `mark()`. */
  since(): string[];
  mark(): void;
  /** Записи журнала плагина `git` (`ctx.log`). */
  readonly logs: string[];
  /** Журнал ядра без отказов и сбоев (иначе падает). */
  clean(): void;
  /**
   * Подписывается на `onChange` как потребитель и копит события. Слежение ядра начинает доставку позже возврата `watch` (FSEvents, inotify на нагруженном раннере),
   * поэтому пока событие не пришло, головной файл переписывается заново (`symbolic-ref HEAD`, состояние репозитория не меняется); после первого события счётчик обнуляется.
   * `arm: false` - без этого (слежение, которое событий не даст).
   */
  watch(repoDir: string, options?: { readonly arm?: boolean }): Promise<{ count(): number; dispose(): void }>;
}

/**
 * PATH плагина. Обёртка стоит после медленного git (иначе медленный, ища «следующий git», нашёл бы обёртку, а та его - и так по кругу):
 * медленный -> обёртка -> настоящий.
 */
function gitPath(box: Toolbox, wrapBin: string, options: RigOptions): string[] {
  const rest = process.env.PATH ?? '/usr/bin:/bin';
  const slow = options.slowGit === undefined ? [] : [path.join(box.root, 'slow-git')];
  if (options.noWrap) return [box.bin, ...slow, rest];
  return options.slowGit === undefined ? [wrapBin, box.bin, rest] : [box.bin, ...slow, wrapBin, rest];
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const box = toolbox(options.slowGit === undefined ? {} : { slowGit: options.slowGit });
  const wrapped = wrapGit(box.root);
  const plain = realpathSync(box.root);
  const projects = fakeProjects([...(options.repos ?? []), plain], options.extraRoots, !options.noProjects);
  const logs: string[] = [];
  let probe: PluginContext | undefined;
  const probePlugin: InlinePlugin = {
    manifest: {
      id: 'probe',
      version: '1.0.0',
      engines: { cyborg: '^1' },
      requires: { 'cyborg.git': '^1' },
      consumes: { 'cyborg.tree-decoration': '^1' },
      permissions: options.probePermissions ?? { 'fs.read': ['workspace'] },
    },
    module: {
      activate(ctx) {
        probe = ctx;
        return undefined;
      },
    },
  };
  const counted = countedWatch();
  const kernel = await startKernel({
    plugins: [PLUGIN_DIR, projects.plugin, ...(options.sessions ? [options.sessions.plugin] : []), probePlugin, ...(options.extra ?? [])],
    os: { env: { PATH: gitPath(box, wrapped.bin, options).join(path.delimiter), HOME: box.root }, ...(options.countWatches && { watch: counted.watch }), ...options.os },
    load: { onLog: (pluginId, message) => void (pluginId === 'git' && logs.push(message)) },
  });
  await kernel.waitForJournal({ kind: 'activated', pluginId: 'git' });
  await kernel.waitForJournal({ kind: 'activated', pluginId: 'probe' });
  assert.ok(probe, 'probe не активирован');
  const git = probe.contracts.get('cyborg.git', 1) as Remote<GitV11> | undefined;
  assert.ok(git, 'git не отдаёт cyborg.git');
  const tree = probe.contracts.all('cyborg.tree-decoration', 1).find((p) => p.pluginId === 'git')?.impl;
  assert.ok(tree, 'git не отдаёт cyborg.tree-decoration');
  let marked = 0;
  const subscriptions: { dispose(): void }[] = [];
  return {
    kernel,
    box,
    projects,
    plain,
    git,
    tree,
    probe,
    watches: counted.watches,
    calls: wrapped.calls,
    failOn: wrapped.failOn,
    runs: () => wrapped.calls().map((c) => c.args),
    since: () => wrapped.calls().slice(marked).map((c) => c.args),
    mark: () => void (marked = wrapped.calls().length),
    logs,
    clean() {
      const bad = kernel.journal.filter((e) => e.kind === 'failed' || e.kind === 'invalid' || e.kind === 'rejected' || e.kind === 'denied');
      assert.deepEqual(bad, []);
    },
    async watch(repoDir, options = {}) {
      let n = 0;
      const sub = await git.onChange(repoDir, () => void n++);
      subscriptions.push(sub);
      if (options.arm !== false) {
        const end = Date.now() + 10_000;
        const head = execFileSync('git', ['-C', repoDir, 'symbolic-ref', 'HEAD'], { encoding: 'utf8', env: GIT_ENV }).trim();
        while (n === 0) {
          if (Date.now() > end) assert.fail(`слежение за ${repoDir} не отозвалось за 10 с`);
          execFileSync('git', ['-C', repoDir, 'symbolic-ref', 'HEAD', head], { env: GIT_ENV });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // Хвост пачки событий пробы дожидается паузой: после неё считается только то, что сделает тест.
        await new Promise((resolve) => setTimeout(resolve, 400));
        n = 0;
      }
      return { count: () => n, dispose: () => sub.dispose() };
    },
    [Symbol.asyncDispose]: async () => {
      for (const s of subscriptions) s.dispose();
      await kernel[Symbol.asyncDispose]();
      box[Symbol.dispose]();
    },
  };
}
