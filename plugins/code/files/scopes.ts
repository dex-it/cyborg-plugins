import type { PluginContext, Remote, SessionEvent, Subscription } from '@cyborg-harness/contracts';
import type { GitV11, SessionsV12 } from '@cyborg-plugins/contracts';
import { newScopeState, type RootSpec, type ScopeState } from './live.ts';
import type { ScopeInfo } from './protocol.ts';

// Области дерева. В ai-cyborg у каждой сессии своё дерево и оно сменяется вместе с активной вкладкой; в плагинах активная вкладка плагину неизвестна (контракт `cyborg.sessions` её не отдаёт),
// поэтому областей две разновидности: проект (репозитории проекта, когда сессий нет) и сессия. Сессию плагин узнаёт по событиям `cyborg.sessions.onChange`: любое событие заводит её, `cwd` ведёт её корень
// (корень git каталога), `exit` убирает. Вид показывает область, выбранную человеком, иначе (auto) ту сессию, от которой событие пришло последним. Корни сессии строит `cyborg.projects.roots`:
// свой корень первым, затем остальные репозитории проекта (FR-4004, FR-4005).

export const PROJECT = 'project';
export const SESSION_PREFIX = 'session:';

const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path;
const inside = (dir: string, repo: string): boolean => dir === repo || dir.startsWith(`${repo}/`);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Track {
  readonly id: string;
  title: string;
  /** Последнее событие этой сессии: по нему выбирается область по умолчанию. */
  seq: number;
  cwd: string | undefined;
  /** Корень git текущего каталога (или сам каталог, если git его не назвал). */
  root: string | undefined;
  /** Репозиторий проекта, где сессия стартовала: единственный, который `uses` называет занятым, иначе владелец корня. */
  repo: string | undefined;
  /** Определение репозитория и корня; события одной сессии идут по очереди. */
  ready: Promise<void>;
}

export interface Resolved {
  readonly specs: readonly RootSpec[];
  /** Пояснение, когда корней нет. */
  readonly hint: string | null;
}

export interface Scopes {
  /** Подписки на проекты и сессии; снимает `dispose`. */
  start(): void;
  list(): Promise<{ readonly infos: ScopeInfo[]; readonly auto: string }>;
  rootsOf(scope: string): Promise<Resolved>;
  state(scope: string): ScopeState;
  /** Репозитории проектов (для `switchable`): обновляются при каждом `rootsOf` и перемене проектов. */
  readonly projectRepos: ReadonlySet<string>;
  dispose(): void;
}

export function createScopes(ctx: PluginContext, changed: () => void): Scopes {
  const tracks = new Map<string, Track>();
  const states = new Map<string, ScopeState>();
  let seq = 0;
  let repos = new Set<string>();
  const subs: { sessions: Subscription | undefined; projects: Subscription | undefined } = { sessions: undefined, projects: undefined };
  let disposed = false;

  const projects = () => ctx.contracts.get('cyborg.projects', 1);
  const git = () => ctx.contracts.get('cyborg.git', 1) as Remote<GitV11> | undefined;
  const sessions = () => ctx.contracts.get('cyborg.sessions', 1) as Remote<SessionsV12> | undefined;

  async function loadRepos(): Promise<string[]> {
    const p = projects();
    if (typeof p?.list !== 'function') return [];
    try {
      const all = await p.list();
      repos = new Set(all.flatMap((x) => x.repos));
      return [...repos];
    } catch (error) {
      ctx.log(`cyborg.projects.list: ${messageOf(error)}`, 'warn');
      return [...repos];
    }
  }

  /** Корень git каталога; git не ответил или его нет - сам каталог (как `gitRoot(cwd) ?? cwd` в ai-cyborg). */
  async function rootOfCwd(cwd: string): Promise<string> {
    const g = git();
    if (typeof g?.root !== 'function') return cwd;
    try {
      return (await g.root(cwd)) ?? cwd;
    } catch {
      return cwd;
    }
  }

  /** Репозиторий запуска: проекты, в которых `uses` называет живую сессию; если их несколько - тот, что содержит корень сессии. */
  async function startRepo(root: string | undefined): Promise<string | undefined> {
    const s = sessions();
    const all = await loadRepos();
    const owner = root === undefined ? undefined : all.filter((r) => inside(root, r)).sort((a, b) => b.length - a.length)[0];
    if (typeof s?.uses !== 'function') return owner;
    const busy: string[] = [];
    for (const r of all) {
      try {
        if (await s.uses(r)) busy.push(r);
      } catch {
        // поставщик не ответил: репозиторий считается незанятым
      }
    }
    if (busy.length === 1) return busy[0];
    if (busy.length > 1) return busy.find((r) => owner === r) ?? busy[0];
    return owner;
  }

  function onEvent(event: SessionEvent): void {
    if (disposed) return;
    const { sessionId, change } = event;
    if (change.type === 'exit') {
      tracks.delete(sessionId);
      states.delete(SESSION_PREFIX + sessionId);
      changed();
      return;
    }
    let track = tracks.get(sessionId);
    if (track === undefined) {
      const created: Track = { id: sessionId, title: event.title, seq: ++seq, cwd: undefined, root: undefined, repo: undefined, ready: Promise.resolve() };
      track = created;
      tracks.set(sessionId, created);
      created.ready = startRepo(undefined).then((repo) => void (created.repo ??= repo), () => undefined);
    }
    const t = track;
    t.title = event.title;
    t.seq = ++seq;
    if (change.type === 'cwd') {
      const cwd = change.cwd;
      t.cwd = cwd;
      t.ready = t.ready.then(async () => {
        const root = await rootOfCwd(cwd);
        if (tracks.get(sessionId) !== t || t.cwd !== cwd) return;
        t.root = root;
        // Сессия ушла из каталога запуска в другой репозиторий проекта или в worktree, а репозиторий запуска так и не определился: им считается владелец корня.
        t.repo ??= (await loadRepos()).filter((r) => inside(root, r)).sort((a, b) => b.length - a.length)[0];
      });
    }
    void t.ready.then(() => changed());
  }

  async function subscribe(): Promise<void> {
    if (disposed) return;
    const s = sessions();
    if (s !== undefined && subs.sessions === undefined) {
      try {
        subs.sessions = await s.onChange(onEvent);
      } catch (error) {
        ctx.log(`cyborg.sessions.onChange: ${messageOf(error)}`, 'warn');
      }
    } else if (s === undefined && subs.sessions !== undefined) {
      subs.sessions = undefined;
      tracks.clear();
      changed();
    }
    const p = projects();
    if (p !== undefined && subs.projects === undefined) {
      try {
        subs.projects = await p.onChange(() => {
          void loadRepos().then(() => changed());
        });
      } catch (error) {
        ctx.log(`cyborg.projects.onChange: ${messageOf(error)}`, 'warn');
      }
    } else if (p === undefined && subs.projects !== undefined) {
      subs.projects = undefined;
      changed();
    }
  }

  const liveTracks = async (): Promise<Track[]> => {
    const all = [...tracks.values()];
    await Promise.all(all.map((t) => t.ready));
    return all.filter((t) => tracks.get(t.id) === t && (t.root ?? t.repo) !== undefined);
  };

  return {
    start() {
      void subscribe();
      ctx.subscriptions.add(ctx.contracts.onChange('cyborg.sessions', () => void subscribe()), ctx.contracts.onChange('cyborg.projects', () => void subscribe()));
    },
    async list() {
      const selected = await projects()?.selected().catch(() => null);
      const infos: ScopeInfo[] = [{ id: PROJECT, label: selected?.name ?? 'Проект', title: 'Репозитории проекта' }];
      const live = (await liveTracks()).sort((a, b) => a.seq - b.seq);
      for (const t of live) infos.push({ id: SESSION_PREFIX + t.id, label: t.title, title: t.cwd ?? t.root ?? t.repo ?? t.title });
      const newest = live[live.length - 1];
      return { infos, auto: newest === undefined ? PROJECT : SESSION_PREFIX + newest.id };
    },
    async rootsOf(scope) {
      const p = projects();
      await loadRepos();
      if (scope !== PROJECT) {
        const t = tracks.get(scope.slice(SESSION_PREFIX.length));
        await t?.ready;
        const root = t?.root ?? t?.repo;
        if (t === undefined || root === undefined) return { specs: [], hint: 'Сессия закончилась.' };
        if (typeof p?.roots === 'function') {
          try {
            const specs = await p.roots({ repo: t.repo ?? root, root });
            if (specs.length > 0) return { specs, hint: null };
          } catch (error) {
            ctx.log(`cyborg.projects.roots: ${messageOf(error)}`, 'warn');
          }
        }
        return { specs: [{ path: root, label: basename(root), hint: 'репозиторий сессии' }], hint: null };
      }
      if (p === undefined) return { specs: [], hint: 'Проектов нет: плагин projects не подключён.' };
      let selected;
      try {
        selected = await p.selected();
      } catch (error) {
        return { specs: [], hint: `Проект не прочитан: ${messageOf(error)}` };
      }
      if (selected === null) return { specs: [], hint: 'Проект не выбран. Меню «Воркспейс» - «Новый проект»: создайте проект и добавьте в него репозитории.' };
      if (selected.repos.length === 0) return { specs: [], hint: 'В проекте нет репозиториев. Меню «Воркспейс» - «Свойства проекта»: добавьте репозиторий.' };
      return { specs: selected.repos.map((path) => ({ path, label: basename(path), hint: 'репозиторий проекта' })), hint: null };
    },
    state(scope) {
      let s = states.get(scope);
      if (s === undefined) {
        s = newScopeState();
        states.set(scope, s);
      }
      return s;
    },
    get projectRepos() {
      return repos;
    },
    dispose() {
      disposed = true;
      subs.sessions?.dispose();
      subs.projects?.dispose();
      tracks.clear();
    },
  };
}
