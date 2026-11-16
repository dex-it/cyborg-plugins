import type { PluginContext, PluginModule, Remote } from '@cyborg-harness/contracts';
import type { GitV11 } from '@cyborg-plugins/contracts';
import { createLive } from './live.ts';
import { cleanPath, listDir } from './listing.ts';
import type { BranchList, ChangedMessage, ScopeInfo, ViewReply } from './protocol.ts';
import { createScopes, PROJECT } from './scopes.ts';

// Дерево файлов сессии: владелец `cyborg.tree-decoration` (рисует то, что отдают `git` и другие), корни - из `cyborg.projects` и каталогов сессий (`cyborg.sessions`).
// Основа - пилот PL-04 ядра (`playground/plugins/files`), поведение - `src/main/files.ts`, `src/renderer/tree.ts`, `roots.ts` ai-cyborg.

/** Соответствие каналов владельца в ai-cyborg и команд плагина; проверяется тестом. */
export const CHANNELS = {
  'fs:list': 'files.list',
} as const;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const plugin: PluginModule = {
  activate(ctx: PluginContext) {
    const { fs } = ctx.os;
    const channel = ctx.views.channel('tree');
    const epoch = Date.now();
    let version = 0;
    let posting = false;

    /** Сообщение виду одно на всё, что накопилось за этот ход цикла событий: вид просит `files.view` сам. */
    const touch = (): void => {
      version++;
      if (posting) return;
      posting = true;
      queueMicrotask(() => {
        posting = false;
        const message: ChangedMessage = { changed: version };
        channel.post(message).catch(() => undefined);
      });
    };

    const scopes = createScopes(ctx, touch);
    const git = (): Remote<GitV11> | undefined => ctx.contracts.get('cyborg.git', 1) as Remote<GitV11> | undefined;
    const live = createLive({
      fs,
      log: (text, level) => ctx.log(text, level),
      providers: () => ctx.contracts.all('cyborg.tree-decoration', 1),
      async branch(root) {
        const g = git();
        return typeof g?.branch === 'function' ? await g.branch(root) : null;
      },
      switchable: (root) => scopes.projectRepos.has(root),
      changed: touch,
    });

    // Область, чьё дерево сейчас живое, и что о ней сказали виду. Вызовы `files.view` идут по очереди: открытие области не перемешивается с другим.
    const current: { id: string; auto: string; key: string; infos: ScopeInfo[]; hint: string | null } = { id: PROJECT, auto: PROJECT, key: '', infos: [], hint: null };
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(job: () => Promise<T>): Promise<T> => {
      const next = chain.then(job, job);
      chain = next.catch(() => undefined);
      return next;
    };

    const reply = (): ViewReply => ({ epoch, version, scope: current.id, auto: current.auto, scopes: current.infos, hint: current.hint, roots: live.views() });

    async function ensure(requested: string | undefined): Promise<void> {
      const { infos, auto } = await scopes.list();
      const id = requested !== undefined && requested !== '' && infos.some((i) => i.id === requested) ? requested : auto;
      const { specs, hint } = await scopes.rootsOf(id);
      const key = `${id}\0${JSON.stringify(specs)}`;
      current.id = id;
      current.auto = auto;
      current.infos = infos;
      current.hint = hint;
      if (key !== current.key) {
        current.key = key;
        await live.open(specs, scopes.state(id));
      }
    }

    const path = (value: unknown, what: string): string => cleanPath(value, what);
    /** Путь должен лежать под одним из корней показанного дерева; остальное закрывает шлюз (`workspace`). */
    const underRoot = (value: unknown, what: string): string => {
      const p = path(value, what);
      if (live.rootOf(p) === undefined) throw new Error(`${what}: путь вне корней дерева`);
      return p;
    };

    ctx.commands.register('files.view', (requested, refresh) =>
      serial(async () => {
        await ensure(typeof requested === 'string' ? requested : undefined);
        if (refresh === true) await live.refresh();
        return reply();
      }),
    );
    // Канал `fs:list`: каталог без `.git`, каталоги раньше файлов. Любой каталог в `workspace`, а не только показанный: границу держит шлюз.
    ctx.commands.register('files.list', (dir) => listDir(fs, path(dir, 'files.list')));
    ctx.commands.register('files.expand', async (dir) => {
      await live.expand(underRoot(dir, 'files.expand'));
      return reply();
    });
    ctx.commands.register('files.collapse', async (dir) => {
      await live.collapse(underRoot(dir, 'files.collapse'));
      return reply();
    });
    ctx.commands.register('files.toggle-root', async (root) => {
      await live.toggleRoot(underRoot(root, 'files.toggle-root'));
      return reply();
    });
    // Открытие файла - дело просмотра (`viewer`, M-10): команда `viewer.open` открыта плагинам, права на путь у вызывающего проверяет она.
    ctx.commands.register('files.open', async (file) => {
      const target = underRoot(file, 'files.open');
      try {
        return await ctx.commands.run('viewer.open', { path: target });
      } catch (error) {
        throw new Error(`файл не открыт: ${messageOf(error)}`);
      }
    });
    ctx.commands.register('files.branches', async (root): Promise<BranchList> => {
      const target = underRoot(root, 'files.branches');
      const g = git();
      if (typeof g?.branches !== 'function') throw new Error('смена ветки недоступна: нужен плагин git с cyborg.git 1.1');
      return g.branches(target);
    });
    ctx.commands.register('files.switch', async (root, branch) => {
      const target = underRoot(root, 'files.switch');
      const g = git();
      if (typeof g?.switch !== 'function') throw new Error('смена ветки недоступна: нужен плагин git с cyborg.git 1.1');
      return g.switch(target, String(branch));
    });
    // Диагностика: сколько вызовов шлюза сделало дерево (тесты проверяют, что в простое их нет).
    ctx.commands.register('files.stats', async () => {
      await live.settle();
      return { ...live.counters, version };
    });

    scopes.start();
    live.followProviders();
    ctx.subscriptions.add(ctx.contracts.onChange('cyborg.tree-decoration', () => live.followProviders()), {
      dispose() {
        scopes.dispose();
        live.dispose();
      },
    });
    return undefined;
  },
};

export default plugin;
