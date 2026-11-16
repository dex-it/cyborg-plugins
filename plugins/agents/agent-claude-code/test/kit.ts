import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { appendFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Agent, DirEntry, FileSlice, FileStat, LaunchSpec, OsFs, PluginContext, Remote } from '@cyborg-harness/contracts';
import { startKernel, type InlinePlugin, type StartKernelOptions, type TestKernel } from '@cyborg-harness/testing';
import { claudeHome, toolbox, type Toolbox } from '@cyborg-plugins/fixtures';
import { projectDirName } from '../history.ts';

export const PLUGIN_DIR = path.resolve(import.meta.dirname, '..');
export const manifest = JSON.parse(await readFile(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8')) as {
  permissions: { launch: unknown[]; process: unknown[]; 'fs.read': string[]; 'fs.write': string[] };
  commands: Record<string, unknown>;
};

/** Флаги, которые права `pty` потребителя (`sessions`, M-03) запрещают в хвосте argv: поставщик их не выдаёт, потребитель не пропускает. */
export const DENIED_FLAGS = ['--dangerously-skip-permissions', '--permission-mode', '--allowedTools', '--allowed-tools', '--disallowedTools', '--tools'];

export const line = (record: object): string => `${JSON.stringify(record)}\n`;
export const ID_A = '11111111-1111-1111-1111-111111111111';
export const ID_B = '22222222-2222-2222-2222-222222222222';
export const ID_C = '33333333-3333-3333-3333-333333333333';

/** Ждёт условие опросом: события приходят от ОС, а не от вызова. */
export async function until(what: string, cond: () => boolean | Promise<boolean>, timeout = 8000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`не дождались: ${what}`);
}

/**
 * Слежение за файлом начинается не в тот миг, когда `watch` вернулся (macOS, FSEvents): пробная строка дописывается, пока слежение не отзовётся.
 * Повтор пробной строки итога не меняет: настоящие строки идут после неё.
 */
export async function armed(file: string, probe: string, heard: () => boolean): Promise<void> {
  await until('слежение за файлом событий отозвалось на пробную строку', async () => {
    if (heard()) return true;
    await appendFile(file, probe);
    return false;
  });
}

/** Минимальный `OsFs` поверх настоящей файловой системы для проверки модулей без ядра: только то, что читает и удаляет история. */
export function nodeFs(log: string[] = []): OsFs {
  const unsupported = (name: string) => () => Promise.reject(new Error(`nodeFs.${name}: не нужен истории`));
  return {
    readText: (p) => readFile(p, 'utf8'),
    async list(dir): Promise<DirEntry[]> {
      return (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, kind: e.isFile() ? 'file' : e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'other' }));
    },
    async stat(p): Promise<FileStat> {
      const s = await stat(p);
      return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs };
    },
    realpath: unsupported('realpath'),
    async readSlice(p, offset, maxBytes): Promise<FileSlice> {
      const buf = await readFile(p);
      const part = buf.subarray(offset, offset + maxBytes);
      return { text: part.toString('utf8'), bytes: part.length, size: buf.length };
    },
    watch: unsupported('watch'),
    writeText: unsupported('writeText'),
    mkdir: unsupported('mkdir'),
    async remove(p) {
      log.push(p);
      await rm(p, { recursive: true, force: true });
    },
  } as OsFs;
}

/** Временный каталог журналов: `<root>/<каталог проекта>/<id>.jsonl` с заданным временем правки. */
export function journals(): { readonly root: string; write(dir: string, name: string, content: string, mtimeSec?: number): string; [Symbol.dispose](): void } {
  const root = mkdtempSync(path.join(tmpdir(), 'cyborg-history-'));
  return {
    root,
    write(dir, name, content, mtimeSec) {
      mkdirSync(path.join(root, dir), { recursive: true });
      const file = path.join(root, dir, name);
      writeFileSync(file, content);
      if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
      return file;
    },
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface Rig extends AsyncDisposable {
  readonly kernel: TestKernel;
  readonly agent: Remote<Agent>;
  readonly consumer: PluginContext;
  readonly box: Toolbox;
  /** Подставной каталог настроек Claude: он же `home` ядра, журналы лежат в `<home>/.claude/projects`. */
  readonly home: string;
  readonly projects: string;
  readonly data: string;
  /** Каталог запуска: настоящий путь (на macOS `/var` - ссылка на `/private/var`, а `$PWD` процесса настоящий). */
  readonly cwd: string;
  /** Записать журнал сессии каталога `repo`. */
  journal(repo: string, id: string, content: string, mtimeSec?: number, dirSuffix?: string): string;
  /** Исполнить описание запуска так, как его исполнит pty: `$SHELL` - подставная оболочка входа, claude - подставной. */
  run(spec: LaunchSpec, input: string): { status: number; stdout: string };
}

/**
 * Настоящий плагин в ядре теста: подставной claude и `$SHELL` из `@cyborg-plugins/fixtures`, подставной каталог настроек как домашний.
 * Потребитель `probe` называет те же права `pty`, что плагин в `launch`: так проверяется и запуск через ядро.
 */
export async function rig(options: { os?: StartKernelOptions['os']; beforeStart?: (paths: { data: string; home: string }) => void } = {}): Promise<Rig> {
  const box = toolbox();
  const claude = claudeHome();
  const home = claude.dir;
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'cyborg-agent-data-'));
  const cwd = path.join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const realCwd = realpathSync(cwd);
  let consumer: PluginContext | undefined;
  const probe: InlinePlugin = {
    manifest: { id: 'probe', version: '1.0.0', engines: { cyborg: '^1' }, consumes: { 'cyborg.agent': '^1' }, permissions: { pty: (manifest.permissions.launch as object[]).map((rule) => ({ ...rule, deny: DENIED_FLAGS })) } },
    module: {
      activate(ctx) {
        consumer = ctx;
      },
    },
  };
  mkdirSync(path.join(dataRoot, 'probe'), { recursive: true });
  options.beforeStart?.({ data: path.join(dataRoot, 'agent-claude-code'), home });
  const kernel = await startKernel({
    plugins: [PLUGIN_DIR, probe],
    os: { home, dataDir: dataRoot, env: { PATH: box.env.PATH ?? '', HOME: home, SHELL: path.join(box.bin, 'shell') }, ...options.os },
  });
  assert.deepEqual(
    kernel.journal.filter((e) => e.kind === 'failed' || e.kind === 'invalid' || e.kind === 'rejected'),
    [],
  );
  assert.ok(consumer, 'потребитель не активирован');
  const entry = consumer.contracts.all('cyborg.agent', 1).find((x) => x.pluginId === 'agent-claude-code');
  assert.ok(entry, 'agent-claude-code не отдаёт cyborg.agent');
  const projects = path.join(home, '.claude', 'projects');
  return {
    kernel,
    agent: entry.impl,
    consumer,
    box,
    home,
    projects,
    data: path.join(dataRoot, 'agent-claude-code'),
    cwd: realCwd,
    journal(repo, id, content, mtimeSec, dirSuffix = '') {
      const dir = path.join(projects, projectDirName(repo) + dirSuffix);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.jsonl`);
      writeFileSync(file, content);
      if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
      return file;
    },
    run(spec, input) {
      const env = { ...spec.env, HOME: home };
      const result = box.run('shell', spec.args, { input, cwd: spec.cwd, env });
      return { status: result.status, stdout: result.stdout };
    },
    [Symbol.asyncDispose]: async () => {
      await kernel[Symbol.asyncDispose]();
      box[Symbol.dispose]();
      claude[Symbol.dispose]();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
