// Общее для тестов плагина sessions: ядро на тест-ките с настоящими `agent-claude-code` и `session-isolation`, подставным поставщиком `cyborg.projects`
// и потребителем `probe`, который берёт `cyborg.sessions` как чужой плагин. Терминал - `fakePty()` тест-кита: процессов нет, вывод и выход пишет тест.
// Хуки Claude Code изображает запись строки JSON в файл событий сессии (`CYBORG_EVENTS` из запуска), как это делает хук настоящего claude.

import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext, Remote, SessionEvent } from '@cyborg-harness/contracts';
import type { SessionsV12 } from '@cyborg-plugins/contracts';
import type { LayerStore } from '@cyborg-harness/core';
import { startKernel, type FakePty, type InlinePlugin, type StartKernelOptions, type TestKernel } from '@cyborg-harness/testing';
import { claudeHome, toolbox, type Toolbox } from '@cyborg-plugins/fixtures';
import { projectDirName } from '../../../agents/agent-claude-code/history.ts';

export const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
const PLUGINS = path.resolve(PLUGIN_DIR, '..', '..');
export const AGENT_DIR = path.join(PLUGINS, 'agents', 'agent-claude-code');
export const ISOLATION_DIR = path.join(PLUGINS, 'sessions', 'session-isolation');

export const line = (record: object): string => `${JSON.stringify(record)}\n`;
export const UUID_A = '11111111-1111-1111-1111-111111111111';
export const UUID_B = '22222222-2222-2222-2222-222222222222';

/** Ждёт условие опросом: события приходят от ОС и проходят границу хостов, поэтому «сразу» их не увидеть. */
export async function until(what: string, cond: () => boolean | Promise<boolean>, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`не дождались: ${what}`);
}

/** Пауза «ничего не должно произойти». */
export const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type Proc = FakePty['procs'][number];

/** Аргументы claude после имени скрипта без дополнений делегирования (`--plugin-dir=`, `--mcp-config=`): их проверяют тесты MCP. */
export const claudeArgs = (proc: Proc): string[] => proc.args.slice(3).filter((a) => !a.startsWith('--plugin-dir=') && !a.startsWith('--mcp-config='));

export interface ProjectsFake {
  readonly plugin: InlinePlugin;
  /** Репозитории, которые отдаёт `list`; тест меняет их по ходу. */
  repos: string[];
}

/** Подставной поставщик `cyborg.projects` (настоящий - плагин `projects`, его проверяет отдельный тест): один проект с заданными репозиториями. */
export function fakeProjects(initial: readonly string[]): ProjectsFake {
  const state: ProjectsFake = {
    repos: [...initial],
    plugin: {
      manifest: { id: 'fake-projects', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.projects': '1.0' }, permissions: { 'security.roots': true } },
      module: {
        async activate(ctx: PluginContext) {
          // Как настоящий `projects`: репозитории проектов - область workspace для остальных плагинов (рабочий каталог pty проверяется как чтение).
          await ctx.os.security?.setRoots(state.repos);
          ctx.contracts.provide('cyborg.projects', '1.0', {
            list: async () => [{ id: 'p1', name: 'Проект', description: '', repos: [...state.repos] }],
            selected: async () => null,
            hasSelected: async () => false,
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

/** Поставщик `cyborg.session-prompt` с заданным id и текстом (как `next-actions`). */
export function promptProvider(id: string, text: string | (() => string)): InlinePlugin {
  return {
    manifest: { id, version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.session-prompt': '1.0' } },
    module: {
      activate(ctx: PluginContext) {
        ctx.contracts.provide('cyborg.session-prompt', '1.0', { fragment: () => (typeof text === 'function' ? text() : text) });
        return undefined;
      },
    },
  };
}

export interface Rig extends AsyncDisposable {
  readonly kernel: TestKernel;
  readonly box: Toolbox;
  /** Подставной каталог настроек Claude: он же `home` ядра. */
  readonly home: string;
  /** Каталог данных плагинов (`<dataRoot>/<id плагина>`). */
  readonly dataRoot: string;
  /** Репозитории проекта: настоящие пути. */
  readonly repoA: string;
  readonly repoB: string;
  readonly projects: ProjectsFake;
  /** Контракт `cyborg.sessions`, как его видит чужой плагин. */
  readonly sessions: Remote<SessionsV12>;
  readonly probe: PluginContext;
  /** Все события `onChange` по порядку. */
  readonly events: SessionEvent[];
  /** `fakePty()` ядра теста. */
  readonly pty: FakePty;
  /** Последний запущенный процесс. */
  last(): Proc;
  /** Дописывает событие хука в файл событий процесса. */
  hook(proc: Proc, record: object): Promise<void>;
  /** Ждёт, пока агент начал слушать файл событий процесса, и прочитал всё записанное до сих пор; события теста после этого не смешиваются с пробными. */
  armed(proc: Proc): Promise<void>;
  /** Запросы к ядру через команды плагина `sessions` (как делает его вид). */
  run(command: string, ...args: unknown[]): Promise<unknown>;
  /** Журнал ядра без записей об отказах и сбоях (иначе падает). */
  clean(): void;
  /** Запись журнала плагина `sessions` (`ctx.log`). */
  readonly logs: string[];
  /** Журналы Claude Code: `<home>/.claude/projects`. */
  journalDir(repo: string): string;
}

export interface RigOptions {
  /** Дополнительные переменные окружения приложения (в запуск сессии они попасть не должны). */
  readonly env?: Record<string, string>;
  /** Среда ядра поверх умолчаний теста. */
  readonly os?: StartKernelOptions['os'];
  /** Плагины рядом: поставщики промпта, чужие агенты и прочее. */
  readonly extra?: readonly (string | InlinePlugin)[];
  /** Состояние ядра (документы вкладок) для проверки перезапуска. */
  readonly state?: LayerStore;
  /** Без `session-isolation`. */
  readonly noIsolation?: boolean;
  /** Подставной `claude` не найден: пустой PATH. */
  readonly noClaude?: boolean;
  /** Готовый каталог дома и набор программ (второй запуск того же приложения). */
  readonly shared?: Shared;
  readonly load?: StartKernelOptions['load'];
  /** Каталог плагина `sessions`, если тест запускает его копию (с видом в манифесте). */
  readonly pluginDir?: string;
}

export interface Shared {
  readonly box: Toolbox;
  readonly claude: { dir: string };
  readonly dataRoot: string;
  readonly repoA: string;
  readonly repoB: string;
}

/** Подготовка каталогов: дом, два репозитория проекта, данные плагинов. Их удаляет `rig`, который их создал. */
export async function prepare(): Promise<Shared & Disposable & { dispose(): Promise<void> }> {
  const box = toolbox();
  const claude = claudeHome();
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'cyborg-sessions-data-'));
  const repoA = path.join(claude.dir, 'work', 'repo-a');
  const repoB = path.join(claude.dir, 'work', 'repo-b');
  await mkdir(repoA, { recursive: true });
  await mkdir(repoB, { recursive: true });
  return {
    box,
    claude,
    dataRoot,
    repoA: await realpath(repoA),
    repoB: await realpath(repoB),
    dispose: async () => {
      box[Symbol.dispose]();
      claude[Symbol.dispose]();
      await rm(dataRoot, { recursive: true, force: true });
    },
    [Symbol.dispose]: () => void 0,
  };
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const own = options.shared === undefined ? await prepare() : undefined;
  const shared = options.shared ?? own!;
  const { box, claude, dataRoot, repoA, repoB } = shared;
  const home = claude.dir;
  const projects = fakeProjects([repoA, repoB]);
  const events: SessionEvent[] = [];
  const logs: string[] = [];
  let probe: PluginContext | undefined;
  const probePlugin: InlinePlugin = {
    manifest: { id: 'probe', version: '1.0.0', engines: { cyborg: '^1' }, requires: { 'cyborg.sessions': '^1' } },
    module: {
      activate(ctx) {
        probe = ctx;
        const sessions = ctx.contracts.get('cyborg.sessions', 1);
        sessions?.onChange((event) => void events.push(event));
        return undefined;
      },
    },
  };
  const kernel = await startKernel({
    plugins: [AGENT_DIR, ...(options.noIsolation ? [] : [ISOLATION_DIR]), options.pluginDir ?? PLUGIN_DIR, projects.plugin, probePlugin, ...(options.extra ?? [])],
    os: {
      home,
      dataDir: dataRoot,
      env: { ...options.env, PATH: options.noClaude ? '/usr/bin:/bin' : (box.env.PATH ?? ''), HOME: home, SHELL: options.noClaude ? '/bin/sh' : path.join(box.bin, 'shell') },
      ...options.os,
    },
    ...(options.state && { state: options.state }),
    load: { onLog: (pluginId, message) => void (pluginId === 'sessions' && logs.push(message)), ...options.load },
  });
  const failed = (): unknown[] => kernel.journal.filter((e) => e.kind === 'failed' || e.kind === 'invalid' || e.kind === 'rejected' || e.kind === 'denied');
  await kernel.waitForJournal({ kind: 'activated', pluginId: 'sessions' });
  assert.ok(probe, 'probe не активирован');
  const sessions = probe.contracts.get('cyborg.sessions', 1) as Remote<SessionsV12> | undefined;
  assert.ok(sessions, 'sessions не отдаёт cyborg.sessions');
  const last = (): Proc => {
    const proc = kernel.pty.procs.at(-1);
    assert.ok(proc, 'процесс не запущен');
    return proc;
  };
  const hook = (proc: Proc, record: object): Promise<void> => {
    const file = proc.options.env.CYBORG_EVENTS;
    assert.ok(file, 'у запуска нет CYBORG_EVENTS');
    return appendFile(file, line(record));
  };
  return {
    kernel,
    box,
    home,
    dataRoot,
    repoA,
    repoB,
    projects,
    sessions,
    probe,
    events,
    pty: kernel.pty,
    last,
    hook,
    async armed(proc) {
      const seen = events.length;
      // Слежение за файлом начинается не в тот миг, когда `watch` вернулся (macOS, FSEvents): пробная строка дописывается, пока слежение не отзовётся.
      await until('агент слушает файл событий', async () => {
        if (events.length > seen) return true;
        await hook(proc, { hook_event_name: 'PostToolUse', tool_name: 'probe' });
        return false;
      });
      // Хвост пробных строк вычитывается меткой: после неё в событиях только то, что запишет тест.
      await hook(proc, { hook_event_name: 'PostToolUse', tool_name: 'marker' });
      await until('метка прочитана', () => events.some((e) => e.change.type === 'activity' && e.change.tool === 'marker'));
      events.length = 0;
    },
    run: (command, ...args) => kernel.run(command, ...args),
    clean() {
      assert.deepEqual(failed(), []);
    },
    logs,
    journalDir: (repo) => path.join(home, '.claude', 'projects', projectDirName(repo)),
    [Symbol.asyncDispose]: async () => {
      await kernel[Symbol.asyncDispose]();
      await own?.dispose();
    },
  };
}

/** Пишет журнал Claude Code для `history`: годится как прошлая сессия каталога. */
export async function writeJournal(rig: Rig, repo: string, id: string, title = 'почини тесты'): Promise<void> {
  const dir = rig.journalDir(repo);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.jsonl`), line({ entrypoint: 'cli' }) + line({ type: 'user', message: { content: title } }));
}
