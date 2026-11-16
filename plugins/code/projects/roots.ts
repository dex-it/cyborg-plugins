import type { ProjectRoot, RootsRequest } from '@cyborg-plugins/contracts';

// Корни дерева файлов сессии (src/renderer/roots.ts ai-cyborg): свой корень первым, затем остальные репозитории проекта. Отвечает `cyborg.projects.roots`.

/** Что нужно знать о сессии, чтобы построить корни её дерева; `repos` - репозитории проекта. */
export interface RootsInput extends Pick<RootsRequest, 'repo' | 'root'> {
  readonly repos: readonly string[];
}

const basename = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;

const inside = (dir: string, repo: string): boolean => dir === repo || dir.startsWith(`${repo}/`) || dir.startsWith(`${repo}\\`);

// Сессия уходит и в worktree репозитория из --add-dir (<репозиторий>/.claude/worktrees/<имя>); worktree вне проекта - стартового.
function ownerRepo(s: RootsInput): string {
  const owners = s.repos.filter((r) => inside(s.root, r));
  return owners.length ? owners.reduce((a, b) => (b.length > a.length ? b : a)) : s.repo;
}

export function rootLabel(s: RootsInput): string {
  const owner = ownerRepo(s);
  return s.root === owner ? basename(s.root) : `${basename(owner)} ⎇ ${basename(s.root)}`;
}

/** Свой корень первым, затем прочие репозитории проекта; путь корня не повторяется. */
export function treeRoots(s: RootsInput): ProjectRoot[] {
  const owner = ownerRepo(s);
  const own: ProjectRoot = {
    path: s.root,
    label: rootLabel(s),
    hint: s.root === s.repo ? 'репозиторий сессии' : s.root === owner ? 'другой репозиторий проекта, куда перешёл рабочий каталог сессии' : `worktree репозитория ${owner}`,
  };
  const others = s.repos
    .filter((r) => r !== owner)
    .map((r) => ({
      path: r,
      label: basename(r),
      hint: r === s.repo ? 'репозиторий, где сессия была запущена' : 'другой репозиторий проекта, доступен сессии через --add-dir',
    }));
  return [own, ...others];
}
