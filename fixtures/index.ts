// Фикстуры тестов плагинов. Подставные программы - POSIX-скрипты в fake-bin/ (перенесены из ai-cyborg и дополнены `glab` и `ssh`),
// набор `toolbox` ставит их в PATH процесса и даёт журналы вызовов, `fixtureRepo` строит настоящий git-репозиторий во временном каталоге.
// Подробно - docs/guide/authors/testing.md.

import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const FIXTURES_DIR: string = import.meta.dirname;

/** Путь внутри fixtures/. */
export const fixturePath = (...parts: string[]): string => path.join(FIXTURES_DIR, ...parts);
/** Каталог с подставными `claude`, `gh`, `glab`, `jira`, `ssh`, `shell`. */
export const FAKE_BIN: string = fixturePath('fake-bin');
/** Каталог с медленным `git` (после него в PATH идёт настоящий). */
export const SLOW_GIT: string = fixturePath('slow-git');
/** Магазин плагинов Claude Code для подставного `claude plugin ...` (только чтение). */
export const MARKET: string = fixturePath('market');

const temp = (prefix: string): string => mkdtempSync(path.join(tmpdir(), prefix));

/** Значение переменной в fake.env: внешняя переменная главнее (`FAKE_X=${FAKE_X:-значение}`). */
const envLine = (name: string, value: string): string => `${name}=\${${name}:-'${value.replaceAll("'", "'\\''")}'}`;

export type ToolName = 'gh' | 'glab' | 'jira' | 'claude' | 'ssh' | 'shell' | 'git';
export type LogName = 'gh' | 'glab' | 'jira' | 'ssh' | 'claudePlugin' | 'claudeArgs';

export interface ToolboxOptions {
  /** gh: вход выполнен (`FAKE_GH=data`), пользователь fake-user; по умолчанию да. `items` - число задач и MR в списках. */
  gh?: boolean | { items?: number };
  /** glab: вход выполнен; `host` - хост GitLab. */
  glab?: boolean | { items?: number; host?: string };
  /** Задержка `git rev-parse --show-toplevel` в секундах (медленный git); без поля настоящий git идёт без задержки. */
  slowGit?: number;
  /** Алиас SSH-хоста, который отказывает «Permission denied». */
  sshFail?: string;
  /** Эхо-вывод подставного claude при старте: N строк до чтения ввода. */
  floodOnStart?: number;
  /** Дополнительные переменные окружения: поверх всего остального. */
  env?: Record<string, string>;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Toolbox extends Disposable {
  /** Временный каталог набора; журналы, события и «дом хоста» лежат в нём. */
  readonly root: string;
  /** Копия подставных программ внутри набора (`<root>/bin`) с файлом настроек `fake.env`: настройки доходят до программы, даже если её запустил плагин на ядре. */
  readonly bin: string;
  /** Окружение для процессов и для `os.env` теста: PATH с подставными программами впереди, FAKE_* и CYBORG_EVENTS. */
  readonly env: Record<string, string>;
  /** Файл событий хуков подставного claude (`CYBORG_EVENTS`): строки JSON. */
  readonly events: string;
  /** Домашний каталог «SSH-хоста» (`FAKE_SSH_HOME`). */
  readonly sshHome: string;
  /** Строки журнала вызовов (пусто, если вызовов не было). */
  log(name: LogName): string[];
  /** События хуков, записанные подставным claude. */
  eventList(): Record<string, unknown>[];
  /** Запускает подставную программу с окружением набора. */
  run(tool: ToolName, args: readonly string[], options?: { input?: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }): RunResult;
}

const logFiles: Record<LogName, string> = { gh: 'gh.log', glab: 'glab.log', jira: 'jira.log', ssh: 'ssh.log', claudePlugin: 'claude-plugin.log', claudeArgs: 'claude-args.log' };

/** Набор подставных программ: `using box = toolbox({ glab: true })`. Каталог удаляется при выходе из блока. */
export function toolbox(options: ToolboxOptions = {}): Toolbox {
  const root = temp('cyborg-fixtures-');
  const file = (name: string): string => path.join(root, name);
  const bin = file('bin');
  const slowGit = file('slow-git');
  cpSync(FAKE_BIN, bin, { recursive: true });
  cpSync(SLOW_GIT, slowGit, { recursive: true });
  for (const dir of [bin, slowGit]) {
    for (const name of ['claude', 'gh', 'glab', 'jira', 'shell', 'ssh', 'git']) {
      try {
        chmodSync(path.join(dir, name), 0o755);
      } catch {
        // в этом каталоге такой программы нет
      }
    }
  }
  const sshHome = file('ssh-home');
  const events = file('events.jsonl');
  for (const name of Object.values(logFiles)) writeFileSync(file(name), '');
  writeFileSync(events, '');

  const env: Record<string, string> = {
    PATH: [bin, ...(options.slowGit !== undefined ? [slowGit] : []), process.env.PATH ?? '/usr/bin:/bin'].join(path.delimiter),
    HOME: process.env.HOME ?? root,
    CYBORG_EVENTS: events,
    FAKE_SUGGEST: path.join(bin, 'suggest.json'),
    FAKE_MARKET: MARKET,
    FAKE_GH_LOG: file(logFiles.gh),
    FAKE_GLAB_LOG: file(logFiles.glab),
    FAKE_JIRA_LOG: file(logFiles.jira),
    FAKE_SSH_LOG: file(logFiles.ssh),
    FAKE_PLUGIN_LOG: file(logFiles.claudePlugin),
    FAKE_ARGS_LOG: file(logFiles.claudeArgs),
    FAKE_SSH_HOME: sshHome,
  };
  const on = (v: boolean | object | undefined, dflt: boolean): boolean => (v === undefined ? dflt : v !== false);
  if (on(options.gh, true)) env.FAKE_GH = 'data';
  if (typeof options.gh === 'object' && options.gh.items !== undefined) env.FAKE_GH_ITEMS = String(options.gh.items);
  if (on(options.glab, false)) env.FAKE_GLAB = 'data';
  if (typeof options.glab === 'object') {
    if (options.glab.items !== undefined) env.FAKE_GLAB_ITEMS = String(options.glab.items);
    if (options.glab.host !== undefined) env.FAKE_GLAB_HOST = options.glab.host;
  }
  if (options.slowGit !== undefined) env.FAKE_GIT_DELAY = String(options.slowGit);
  if (options.sshFail !== undefined) env.FAKE_SSH_FAIL = options.sshFail;
  if (options.floodOnStart !== undefined) env.FAKE_FLOOD_ON_START = String(options.floodOnStart);
  Object.assign(env, options.env);

  // Те же настройки - в fake.env рядом со скриптами: ядро передаёт процессу плагина только PATH, HOME и локаль.
  const settings = Object.entries(env).filter(([name]) => name.startsWith('FAKE_') || name === 'CYBORG_EVENTS');
  const envFile = `${settings.map(([name, value]) => envLine(name, value)).join('\n')}\n`;
  writeFileSync(path.join(bin, 'fake.env'), envFile);
  writeFileSync(path.join(slowGit, 'fake.env'), envFile);

  const read = (name: string): string[] => readFileSync(file(name), 'utf8').split('\n').filter((l) => l !== '');
  return {
    root,
    bin,
    env,
    events,
    sshHome,
    log: (name) => read(logFiles[name]),
    eventList: () => readFileSync(events, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>),
    run(tool, args, run = {}) {
      const r = spawnSync(tool, [...args], { env: { ...env, ...run.env }, input: run.input, cwd: run.cwd, encoding: 'utf8', timeout: run.timeoutMs ?? 15_000 });
      return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
    },
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface RepoOptions {
  /** Ветки сверх основной `main` (создаются на том же коммите). */
  branches?: readonly string[];
  /** Файлы первого коммита: путь -> текст; по умолчанию `README.md`. */
  files?: Readonly<Record<string, string>>;
  /** Оставить изменения в рабочем дереве: изменённый отслеживаемый файл и неотслеживаемый. */
  dirty?: boolean;
  /** Адрес `origin` (без обращения к сети). */
  remote?: string;
}

export interface FixtureRepo extends Disposable {
  readonly dir: string;
  /** Настоящий git в этом репозитории без хуков и пользовательского конфига; возвращает stdout. */
  git(...args: string[]): string;
}

/** Настоящий git-репозиторий во временном каталоге (нужен `git` в PATH): коммит, ветки, изменения, remote. */
export function fixtureRepo(options: RepoOptions = {}): FixtureRepo {
  const dir = temp('cyborg-repo-');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
  };
  const git = (...args: string[]): string => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.error?.message || r.status}`);
    return r.stdout;
  };
  git('init', '-q', '-b', 'main');
  const files = options.files ?? { 'README.md': '# Фикстура\n' };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'Первый коммит');
  for (const branch of options.branches ?? []) git('branch', branch);
  if (options.remote) git('remote', 'add', 'origin', options.remote);
  if (options.dirty) {
    const tracked = Object.keys(files)[0] ?? 'README.md';
    writeFileSync(path.join(dir, tracked), `${files[tracked] ?? ''}правка\n`);
    writeFileSync(path.join(dir, 'untracked.txt'), 'новый файл\n');
  }
  return { dir, git, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface ClaudeHome extends Disposable {
  /** Копия fixtures/claude-home (`.claude.json` с сервером MCP, личный скилл): тест может её менять. */
  readonly dir: string;
}

export function claudeHome(): ClaudeHome {
  const dir = temp('cyborg-claude-home-');
  cpSync(fixturePath('claude-home'), dir, { recursive: true });
  return { dir, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}
