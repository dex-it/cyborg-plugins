import type { Disposable, OsFs, Subscription } from '@cyborg-harness/contracts';
import { dirname, resolve } from './posix.ts';

// Слежение за `.git`: вместо опроса раз в 3 с в ai-cyborg - событие, когда меняется то, что показывает дерево (индекс, голова, упакованные ссылки).
// Правка файлов рабочего дерева сюда не доходит: её видит тот, кто следит за деревом, и просит состояние заново.

/** Имена в `.git`, по которым меняется то, что показывает дерево: индекс (add, commit, checkout), голова и упакованные ссылки. Ссылки в refs/ каталогом глубже не видны: fetch отметок не меняет. */
export const WATCHED = new Set(['index', 'HEAD', 'packed-refs', 'MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']);
/** Репозиториев под слежением: каждый занимает слежение из 64 на плагин. */
export const MAX_REPOS = 16;

interface Tracked {
  readonly listeners: Set<() => unknown>;
  /** Слежения за каталогом git репозитория и за его `refs/heads`. */
  watches: Disposable[];
}

export interface Follower {
  /** Слушатель вызывается на каждое событие `.git` репозитория; первый слушатель открывает слежение, последний снимает. */
  follow(repo: string, listener: () => unknown): Promise<Subscription>;
  /** Снимает всё: выгрузка плагина. */
  close(): void;
}

/**
 * Каталог git репозитория: `<repo>/.git`, если это каталог; если файл (`git worktree`, подмодуль) - каталог из `gitdir: путь`, но только когда он читаем (лежит в `workspace`);
 * иначе `undefined` - слежения нет, а `status` по-прежнему отвечает.
 */
export async function gitDirOf(fs: Pick<OsFs, 'stat' | 'readText'>, repo: string): Promise<string | undefined> {
  const dotGit = `${repo}/.git`;
  const st = await fs.stat(dotGit).catch(() => undefined);
  if (st?.kind === 'dir') return dotGit;
  if (st?.kind !== 'file' || st.size > 4096) return undefined;
  const line = (await fs.readText(dotGit).catch(() => '')).split('\n')[0] ?? '';
  const target = /^gitdir: (.+)$/.exec(line.trim())?.[1];
  if (target === undefined) return undefined;
  const dir = resolve(dirname(dotGit), target);
  return (await fs.stat(dir).catch(() => undefined))?.kind === 'dir' ? dir : undefined;
}

/** Каталог с общими ссылками: у worktree он назван файлом `commondir` внутри его каталога git, у обычного репозитория и подмодуля - сам каталог git. */
async function commonDirOf(fs: Pick<OsFs, 'readText'>, gitDir: string): Promise<string> {
  const text = await fs.readText(`${gitDir}/commondir`).catch(() => '');
  const rel = text.split('\n')[0]?.trim();
  return rel ? resolve(gitDir, rel) : gitDir;
}

export function createFollower(fs: OsFs, log: (message: string, level?: 'info' | 'warn') => void): Follower {
  const tracked = new Map<string, Tracked>();

  function notify(repo: string): void {
    const t = tracked.get(repo);
    if (t === undefined) return;
    for (const listener of [...t.listeners]) {
      // Слушатель - обратный вызов через границу плагинов: упавший (потребитель выгружен) соседям не мешает.
      try {
        void Promise.resolve(listener()).catch((e: unknown) => log(`слушатель onChange ${repo}: ${String(e)}`, 'warn'));
      } catch (e) {
        log(`слушатель onChange ${repo}: ${String(e)}`, 'warn');
      }
    }
  }

  async function attach(repo: string, t: Tracked): Promise<void> {
    const dir = await gitDirOf(fs, repo);
    if (dir === undefined) return;
    const onClose = (where: string) => (reason: string) => {
      log(`слежение за ${where} закрыто: ${reason}`, 'warn');
      notify(repo);
    };
    t.watches.push(
      await fs.watch(
        dir,
        // Пачку имён ядро уже склеило за 50 мс: одно оповещение на пачку, без своей задержки.
        (names) => {
          if (names.some((n) => WATCHED.has(n))) notify(repo);
        },
        onClose(dir),
      ),
    );
    // Коммит на текущей ветке меняет только `refs/heads/<ветка>` (индекс при `--allow-empty` и `commit -a` может остаться тем же, HEAD - ссылкой на ветку): без этого слежения
    // расхождение с upstream и новые ветки, созданные снаружи, дерево бы не увидело. Имена `*.lock` - промежуточный шаг записи ссылки, оповещение идёт по готовой ссылке.
    const heads = `${await commonDirOf(fs, dir)}/refs/heads`;
    if ((await fs.stat(heads).catch(() => undefined))?.kind !== 'dir') return;
    t.watches.push(
      await fs.watch(
        heads,
        (names) => {
          if (names.some((n) => !n.endsWith('.lock'))) notify(repo);
        },
        onClose(heads),
      ),
    );
  }

  return {
    async follow(repo, listener) {
      let t = tracked.get(repo);
      if (t === undefined) {
        if (tracked.size >= MAX_REPOS) throw new Error(`слежение больше чем за ${String(MAX_REPOS)} репозиториями не открывается`);
        const created: Tracked = { listeners: new Set(), watches: [] };
        t = created;
        tracked.set(repo, created);
        await attach(repo, created).catch((error: unknown) => {
          for (const w of created.watches) w.dispose();
          tracked.delete(repo);
          throw error;
        });
      }
      t.listeners.add(listener);
      const own = t;
      return {
        dispose() {
          own.listeners.delete(listener);
          if (own.listeners.size > 0 || tracked.get(repo) !== own) return;
          for (const w of own.watches) w.dispose();
          tracked.delete(repo);
        },
      };
    },
    close() {
      for (const t of tracked.values()) for (const w of t.watches) w.dispose();
      tracked.clear();
    },
  };
}
