import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Agent, PluginContext, Provider, Remote } from '@cyborg-harness/contracts';
import { memoryStore, startKernel, type InlinePlugin, type MemoryStore, type TestKernel } from '@cyborg-harness/testing';
import { fixtureRepo, toolbox, type FixtureRepo, type Toolbox } from '@cyborg-plugins/fixtures';
import { ASSETS } from '../assets.generated.ts';
import { bundleOf, type AgentdBundle } from '../install.ts';

export const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
export const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8')) as {
  permissions: { launch: { program: string; args: string[] }[]; process: { program: string; args: string[]; env?: string[] }[] };
  commands: Record<string, { args?: string[]; callers?: string }>;
};

/** Токен claude setup-token годной формы: с ним вход claude на подставном хосте не нужен (подставной claude на `auth status` не отвечает JSON). */
export const CLAUDE_TOKEN = 'sk-ant-oat01-' + 'a'.repeat(30);

/** Ждёт условие опросом: события приходят от ОС, а не от вызова. */
export async function until(what: string, cond: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`не дождались: ${what}`);
}

export const bundle = (): Promise<AgentdBundle> => bundleOf(ASSETS['agentd/agentd.js'] ?? '', ASSETS['agentd/client.js'] ?? '');

export interface RigOptions {
  /** Хосты проекта `p1` (алиасы). */
  hosts?: string[];
  /** Задать токен Claude до первого вызова: хост проходит проверку входа (по умолчанию да). */
  token?: boolean;
  /** Хост, который отказывает «Permission denied». */
  sshFail?: string;
  /** Нужны ли репозитории проекта: настоящие git-репозитории, origin второго указывает на первый. */
  repos?: boolean;
  env?: Record<string, string>;
  /** Период опроса событий, мс. */
  extraPlugins?: InlinePlugin[];
}

export interface Rig extends AsyncDisposable {
  readonly kernel: TestKernel;
  readonly box: Toolbox;
  /** Домашний каталог «SSH-хоста»: короткий путь, чтобы сокет демона влез в предел unix-сокета. */
  readonly sshHome: string;
  readonly agent: Remote<Agent>;
  readonly consumer: PluginContext;
  readonly config: MemoryStore;
  readonly state: MemoryStore;
  /** Репозитории проекта: `origin` указывает на `server`. */
  readonly repos: { work: FixtureRepo; server: FixtureRepo } | undefined;
  /** Команда плагина от имени другого плагина (команды с `callers: "plugins"`) либо от человека. */
  call(name: string, ...args: unknown[]): Promise<unknown>;
  /** Каталог `.cyborg` на хосте. */
  cyborg(...parts: string[]): string;
  /** Журнал вызовов `ssh` (аргументы без stdin). */
  sshLog(): string[];
}

/** Убирает демон и процессы сессий на подставном хосте: демон переживает ssh, поэтому конец теста добивает его сам. */
export function killHost(sshHome: string): void {
  const kill = (pid: number, signal: NodeJS.Signals): void => {
    try {
      process.kill(pid, signal);
    } catch {
      // уже завершён
    }
  };
  const sessions = path.join(sshHome, '.cyborg', 'sessions');
  try {
    for (const sid of readdirSync(sessions)) {
      try {
        const meta = JSON.parse(readFileSync(path.join(sessions, sid, 'meta.json'), 'utf8')) as { pgid?: number };
        if (meta.pgid) kill(-meta.pgid, 'SIGKILL');
      } catch {
        // записи нет
      }
    }
  } catch {
    // сессий нет
  }
  try {
    const pid = Number(readFileSync(path.join(sshHome, '.cyborg', 'run', 'agentd.lock'), 'utf8'));
    if (pid > 1) kill(pid, 'SIGKILL');
  } catch {
    // демон не запускался
  }
}

/**
 * Настоящий плагин на ядре теста: подставной `ssh` из фикстур исполняет команды локально («хост» - каталог `sshHome`), демон - настоящий собранный `agentd.js`.
 * `uname` подставной: хост обязан быть Linux, а тест идёт и на macOS. Потребитель `probe` называет те же права `pty`, что плагин в `launch`.
 */
export async function rig(options: RigOptions = {}): Promise<Rig> {
  const sshHome = mkdtempSync('/tmp/cyh-');
  const shim = mkdtempSync('/tmp/cyu-');
  writeFileSync(path.join(shim, 'uname'), '#!/bin/sh\necho Linux\n');
  // Подставной `script` из util-linux (`script -qfec <команда> /dev/null`): на macOS у script другие ключи, а демон зовёт его как на Linux.
  writeFileSync(path.join(shim, 'script'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -*c*) shift; exec sh -c "$1";; *) shift;; esac; done\n');
  for (const name of ['uname', 'script']) chmodSync(path.join(shim, name), 0o755);
  const box = toolbox({ env: { FAKE_SSH_HOME: sshHome }, ...(options.sshFail !== undefined && { sshFail: options.sshFail }) });
  mkdirSync(sshHome, { recursive: true });
  const repos = options.repos ? { server: fixtureRepo(), work: undefined as unknown as FixtureRepo } : undefined;
  if (repos) repos.work = fixtureRepo({ remote: repos.server.dir });

  const hosts = options.hosts ?? ['dev1'];
  const config = memoryStore({ workspace: { 'remote-sessions': { hosts: { p1: hosts } } } });
  const state = memoryStore();
  const repoPaths = repos ? [repos.work.dir] : ['/r/a', '/r/b'];

  // Подставной поставщик cyborg.projects (настоящий - плагин projects) и задатчик корней: `process.run` с `cwd` идёт только в области workspace.
  const projects: InlinePlugin = {
    manifest: { id: 'fake-projects', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.projects': '1.0' }, permissions: { 'security.roots': true } },
    module: {
      async activate(ctx) {
        ctx.contracts.provide('cyborg.projects', '1.0', {
          list: async () => [{ id: 'p1', name: 'Проект', description: '', repos: repoPaths }],
          selected: async () => null,
          hasSelected: async () => false,
          roots: async () => [],
          onChange: () => ({ dispose() {} }),
        });
        if (repos) await ctx.os.security?.setRoots(repoPaths);
        return undefined;
      },
    },
  };
  let consumer: PluginContext | undefined;
  const probe: InlinePlugin = {
    manifest: {
      id: 'probe',
      version: '1.0.0',
      engines: { cyborg: '^1' },
      consumes: { 'cyborg.agent': '^1' },
      permissions: { pty: manifest.permissions.launch, 'fs.read': ['workspace'] },
    },
    module: {
      activate(ctx) {
        consumer = ctx;
      },
    },
  };
  const PATH = `${shim}${path.delimiter}${box.env.PATH ?? ''}`;
  const cleanup = (): void => {
    killHost(sshHome);
    box[Symbol.dispose]();
    repos?.work[Symbol.dispose]();
    repos?.server[Symbol.dispose]();
    // Демон и процессы сессий добиты SIGKILL, но могут дописать файл в момент удаления.
    rmSync(sshHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(shim, { recursive: true, force: true });
  };
  const kernel = await startKernel({
    plugins: [PLUGIN_DIR, projects, probe, ...(options.extraPlugins ?? [])],
    config: config.store,
    state: state.store,
    os: { env: { PATH, HOME: process.env.HOME ?? sshHome, SHELL: path.join(box.bin, 'shell'), ...options.env } },
  }).catch((error: unknown) => {
    cleanup();
    throw error;
  });
  let entry: Provider<Remote<Agent>> | undefined;
  try {
    const failed = kernel.journal.filter((e) => e.kind === 'failed' || e.kind === 'invalid' || e.kind === 'rejected');
    assert.deepEqual(failed, [], 'плагины не активированы');
    assert.ok(consumer, 'потребитель не активирован');
    entry = consumer.contracts.all('cyborg.agent', 1).find((x) => x.pluginId === 'remote-sessions');
    assert.ok(entry, 'remote-sessions не отдаёт cyborg.agent');
  } catch (error) {
    await kernel[Symbol.asyncDispose]();
    cleanup();
    throw error;
  }
  const ctx = consumer as PluginContext;
  const call = async (name: string, ...args: unknown[]): Promise<unknown> => (manifest.commands[name]?.callers === 'plugins' ? ctx.commands.run(name, ...args) : kernel.run(name, ...args));
  if (options.token !== false) await call('remote-sessions.claude-token.set', CLAUDE_TOKEN);
  return {
    kernel,
    box,
    sshHome,
    agent: entry.impl,
    consumer: ctx,
    config,
    state,
    repos,
    call,
    cyborg: (...parts) => path.join(sshHome, '.cyborg', ...parts),
    sshLog: () => box.log('ssh'),
    [Symbol.asyncDispose]: async () => {
      killHost(sshHome);
      await kernel[Symbol.asyncDispose]();
      cleanup();
    },
  };
}
