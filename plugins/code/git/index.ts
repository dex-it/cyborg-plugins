import type { GitStatus, PluginContext, PluginModule, Remote, Subscription, TreeMark } from '@cyborg-harness/contracts';
import type { GitV11, SessionsV12 } from '@cyborg-plugins/contracts';
import { SAFE_ARGS, STATUS_ARGS } from './args.ts';
import { createFollower } from './follow.ts';
import { filterOverrides, NOT_A_REPOSITORY, type FilterHost } from './filters.ts';
import { gitBranch, gitBranches, gitFiles, gitHeadContent, gitRemotes, gitRoot, BIG_OUTPUT, type Run } from './queries.ts';
import { marksOf, parseStatus } from './status.ts';
import { gitSwitch } from './switch.ts';

// Владелец git по SAD ядра (раздел 4, правило 11): единственный плагин с правом `process` на программу git. Остальным - контракт `cyborg.git` и отметки дерева.
// Основа - пилот PL-04 ядра (`playground/plugins/git`), поведение запросов - `src/main/git.ts` ai-cyborg.

/** Соответствие каналов владельца в ai-cyborg и членов контракта `cyborg.git`; проверяется тестом. */
export const CHANNELS = {
  'git:root': 'root',
  'git:branch': 'branch',
  'git:status': 'status',
  'git:branches': 'branches',
  'git:switch': 'switch',
  'git:headContent': 'headContent',
} as const;

/** Срок читающей команды: `git status` в большом репозитории идёт секунды, но не минуты. */
const READ_TIMEOUT_MS = 30_000;
const SESSION_BUSY = 'в репозитории работает сессия Claude: веткой управляет она';

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    const proc = ctx.os.process;
    if (!proc) throw new Error('нет ctx.os.process: в манифесте git нет права process');
    const { fs } = ctx.os;

    const run: Run = (args, cwd, options = {}) =>
      proc.run('git', [...SAFE_ARGS, ...args], {
        cwd,
        timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
        ...(options.maxOutputBytes !== undefined && { maxOutputBytes: options.maxOutputBytes }),
        ...(options.env && { env: options.env }),
      });
    const host: FilterHost = {
      git: (args, cwd, env) => run(args, cwd, env && { env }),
      async populated(dir) {
        const [self, dotGit] = await Promise.all([fs.stat(dir).catch(() => undefined), fs.stat(`${dir}/.git`).catch(() => undefined)]);
        return self?.kind === 'dir' && dotGit !== undefined;
      },
    };
    const follower = createFollower(fs, (message, level) => ctx.log(message, level));

    // Один git status на репозиторий одновременно: вызовы, пришедшие во время работы, получают один следующий прогон - он начат после их запроса и не отстаёт от изменений.
    const flights = new Map<string, { running: Promise<GitStatus | null>; next?: Promise<GitStatus | null> }>();
    async function spawn(repo: string): Promise<GitStatus | null> {
      const env = await filterOverrides(host, repo);
      if (env === null) return null;
      const result = await run(STATUS_ARGS, repo, { env, maxOutputBytes: BIG_OUTPUT });
      if (result.code !== 0) {
        if (NOT_A_REPOSITORY.test(result.stderr)) return null;
        throw new Error(`git status: код ${String(result.code ?? result.signal)}: ${result.stderr.trim().slice(0, 200)}`);
      }
      if (result.truncated) throw new Error('git status: вывод длиннее предела, изменений слишком много');
      return parseStatus(result.stdout);
    }
    function start(repo: string): Promise<GitStatus | null> {
      const running = spawn(repo).finally(() => settle(repo));
      flights.set(repo, { running });
      return running;
    }
    function settle(repo: string): void {
      const flight = flights.get(repo);
      if (flight?.next === undefined) flights.delete(repo);
    }
    function status(repo: string): Promise<GitStatus | null> {
      const flight = flights.get(repo);
      if (flight === undefined) return start(repo);
      flight.next ??= flight.running.then(
        () => start(repo),
        () => start(repo),
      );
      return flight.next;
    }

    // Что приходит от чужого плагина, проверяется: типы через границу плагинов не гарантированы.
    const text = (value: unknown, what: string): string => {
      if (typeof value !== 'string' || value === '') throw new Error(`${what}: нужна непустая строка`);
      return value;
    };

    /** Только репозитории сохранённых проектов (`cyborg.projects`): рабочие каталоги живых сессий и worktree меняет сама сессия. Проектов нет - отказ. */
    async function projectRepo(root: string): Promise<boolean> {
      const projects = ctx.contracts.get('cyborg.projects', 1);
      if (typeof projects?.list !== 'function') return false;
      return (await projects.list()).some((p) => p.repos.includes(root));
    }

    /** Работает ли в репозитории сессия. Поставщика сессий нет - работать некому; поставщик без `uses` (до 1.2) - ответить нечем, смена отказывает. */
    async function sessionUses(root: string): Promise<boolean> {
      const sessions = ctx.contracts.get('cyborg.sessions', 1) as Remote<SessionsV12> | undefined;
      if (sessions === undefined) return false;
      if (typeof sessions.uses !== 'function') throw new Error('не удалось проверить, работает ли в репозитории сессия: cyborg.sessions без uses (нужна версия 1.2)');
      return sessions.uses(root);
    }

    const contract: GitV11 = {
      root: (dir) => gitRoot(run, text(dir, 'root')),
      branch: (root) => gitBranch(run, text(root, 'branch')),
      status: (repo) => status(text(repo, 'status')),
      headContent: (file) => gitHeadContent(run, text(file, 'headContent')),
      async branches(root) {
        if (!(await projectRepo(text(root, 'branches')))) throw new Error('Некорректные аргументы git.branches: репозиторий не входит в проект');
        return gitBranches(run, root);
      },
      async switch(root, branch) {
        if (typeof branch !== 'string' || !(await projectRepo(text(root, 'switch')))) throw new Error('Некорректные аргументы git.switch');
        try {
          if (await sessionUses(root)) return { error: SESSION_BUSY };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
        return gitSwitch(run, root, branch);
      },
      remotes: (root) => gitRemotes(run, text(root, 'remotes')),
      files: (root) => gitFiles(run, text(root, 'files')),
      // onChange обязан вернуть Subscription сразу (контракт синхронный по форме), а слежение заводится асинхронно: dispose до готовности снимает его по готовности.
      onChange(repo, listener): Subscription {
        const pending = follower.follow(text(repo, 'onChange'), listener);
        pending.catch((error: unknown) => ctx.log(`onChange ${repo}: ${error instanceof Error ? error.message : String(error)}`, 'warn'));
        return { dispose: () => void pending.then((s) => s.dispose(), () => undefined) };
      },
    };
    ctx.contracts.provide('cyborg.git', '1.1', contract);

    // Оповещение дерева идёт о тех корнях, о которых оно уже спрашивало отметки: слежение за .git встаёт при первом marks(root) и живёт до выгрузки плагина.
    const decoration = new Set<(root: string) => void>();
    const followed = new Map<string, Promise<unknown>>();
    function followForDecoration(root: string): Promise<unknown> {
      let pending = followed.get(root);
      if (pending === undefined) {
        pending = follower
          .follow(root, () => {
            for (const listener of decoration) listener(root);
          })
          .catch((error: unknown) => ctx.log(`слежение за ${root}: ${error instanceof Error ? error.message : String(error)}`, 'warn'));
        followed.set(root, pending);
      }
      return pending;
    }
    ctx.contracts.provide('cyborg.tree-decoration', '1.0', {
      async marks(root): Promise<TreeMark[]> {
        await followForDecoration(text(root, 'marks'));
        const s = await status(root);
        return s === null ? [] : marksOf(s);
      },
      onChange(listener) {
        decoration.add(listener);
        return { dispose: () => void decoration.delete(listener) };
      },
    });

    ctx.subscriptions.add({ dispose: () => follower.close() });
    return undefined;
  },
};

export default plugin;
