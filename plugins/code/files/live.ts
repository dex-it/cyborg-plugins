import type { Disposable, OsFs, Remote, TreeDecoration, TreeMarkKind } from '@cyborg-harness/contracts';
import { HIDDEN, isCode, listDir, sortEntries, type Entry } from './listing.ts';
import type { Mark, RootView, ViewEntry } from './protocol.ts';

// Живое дерево одной области (проект или сессия): корни, раскрытые каталоги, слежение и отметки. Основа - пилот PL-04 ядра (`playground/plugins/files`): дерево строится по `fs.list`,
// обновляется по именам из `fs.watch` (stat на каждое известное имя, list каталога - когда имя незнакомо или имён слишком много) и не опрашивает ничего: без событий плагин не делает ни одного вызова.
// В отличие от пилота корней несколько (репозитории проекта, worktree сессии), а слежение рекурсивное только за раскрытыми корнями: свёрнутый корень не стоит ни слежения ОС, ни чтения каталогов,
// его ветка и число изменений обновляются по оповещению поставщика отметок (индекс и голова) и по кнопке «Обновить».

/** Имён в одном событии больше - дешевле прочитать каталог, чем звать stat на каждое. */
export const RELIST_AT = 64;
/**
 * ОС теряет события при лавине (на macOS корень не назвал три из шести ушедших при checkout каталогов): событиям нельзя верить как единственному источнику.
 * Лавина - не меньше STORM_NAMES имён подряд без тишины в RESYNC_QUIET_MS; после тишины перечитываются все узлы корня. Так же после оповещения поставщика отметок об индексе и голове. В простое это ни одного вызова.
 */
export const STORM_NAMES = 16;
export const RESYNC_QUIET_MS = 300;

const hidden = (name: string): boolean => name.split('/').some((segment) => HIDDEN.has(segment));
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const parentOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export interface RootSpec {
  readonly path: string;
  readonly label: string;
  readonly hint: string;
}

/** Память области: раскрытые каталоги (абсолютные пути, вложенные помнятся и при свёрнутом родителе) и свёрнутые корни. Пока область не показана, плагин держит только это. */
export interface ScopeState {
  readonly expanded: Set<string>;
  readonly collapsed: Set<string>;
  /** Корни, которые область уже видела: первый корень раскрыт, остальные свёрнуты, дальше выбор человека. */
  readonly seen: Set<string>;
}
export const newScopeState = (): ScopeState => ({ expanded: new Set(), collapsed: new Set(), seen: new Set() });

export interface Provider {
  readonly pluginId: string;
  readonly impl: Remote<TreeDecoration>;
}

export interface LiveDeps {
  readonly fs: OsFs;
  log(message: string, level?: 'info' | 'warn'): void;
  /** Поставщики отметок на сейчас (`cyborg.tree-decoration`, кратность many). */
  providers(): readonly Provider[];
  /** Ветка корня; не git, нет `cyborg.git` или он не ответил - `null`. */
  branch(root: string): Promise<string | null>;
  switchable(root: string): boolean;
  /** Что-то изменилось: вид просит `files.view`. */
  changed(): void;
}

export interface Counters {
  list: number;
  stat: number;
  batches: number;
  relists: number;
  markRuns: number;
  resyncs: number;
  /** Когда началась обработка последней пачки событий слежения (`performance.now()`): от неё считается цена дерева до сообщения виду. */
  lastBatchAt: number;
}

interface Rt {
  spec: RootSpec;
  watch: Disposable | undefined;
  watchError: string | undefined;
  lost: string | undefined;
  error: string | undefined;
  marks: Map<string, TreeMarkKind>;
  changedDirs: Set<string>;
  branch: string | null | undefined;
  burst: { names: number; timer: NodeJS.Timeout | undefined };
  queue: { running: boolean; again: boolean; done: Promise<void> };
}

interface Node {
  readonly dir: string;
  readonly rt: Rt;
  readonly entries: Map<string, Entry>;
  /** События одного каталога обрабатываются по очереди. */
  work: Promise<unknown>;
}

const STRENGTH: readonly TreeMarkKind[] = ['conflict', 'untracked', 'added', 'renamed', 'deleted', 'modified'];

export interface Live {
  readonly counters: Counters;
  /** Приводит дерево к области: корни, свёрнутость и раскрытые каталоги берутся из `state`. Вызовы идут по очереди. */
  open(specs: readonly RootSpec[], state: ScopeState): Promise<void>;
  expand(dir: string): Promise<void>;
  collapse(dir: string): Promise<void>;
  toggleRoot(root: string): Promise<void>;
  /** Перечитывает всё показанное и просит отметки заново: на случай потерянных событий и после отказа слежения. */
  refresh(): Promise<void>;
  /** Корень, которому принадлежит путь; нет - `undefined`. */
  rootOf(path: string): string | undefined;
  /** Каталог показан (раскрыт и прочитан). */
  shows(dir: string): boolean;
  readonly version: number;
  views(): RootView[];
  /** Дожидается обработки событий по всем узлам. */
  settle(): Promise<void>;
  /** Поставщики отметок пришли или ушли. */
  followProviders(): void;
  dispose(): void;
}

export function createLive(deps: LiveDeps): Live {
  const { fs } = deps;
  const roots = new Map<string, Rt>();
  let order: string[] = [];
  const nodes = new Map<string, Node>();
  const counters: Counters = { list: 0, stat: 0, batches: 0, relists: 0, markRuns: 0, resyncs: 0, lastBatchAt: 0 };
  let state: ScopeState = newScopeState();
  let version = 0;
  let disposed = false;
  /** Операции над деревом идут по очереди: открытие области и раскрытия не перемешиваются. */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job);
    chain = next.catch(() => undefined);
    return next;
  };
  const bump = (): void => {
    version++;
    if (!disposed) deps.changed();
  };

  const rel = (rt: Rt, path: string): string => (path === rt.spec.path ? '' : path.slice(rt.spec.path.length + 1));
  const rootOf = (path: string): Rt | undefined => {
    let best: Rt | undefined;
    for (const rt of roots.values()) {
      const p = rt.spec.path;
      if ((path === p || path.startsWith(`${p}/`)) && (best === undefined || p.length > best.spec.path.length)) best = rt;
    }
    return best;
  };
  const collapsed = (rt: Rt): boolean => state.collapsed.has(rt.spec.path);

  function dropSubtree(dir: string): void {
    for (const path of [...nodes.keys()]) if (path === dir || path.startsWith(`${dir}/`)) nodes.delete(path);
  }

  // --- отметки ---

  function markOf(rt: Rt, path: string, kind: Entry['kind']): Mark | null {
    const r = rel(rt, path);
    const own = rt.marks.get(r);
    if (own !== undefined) return own;
    // Всё внутри неотслеживаемого каталога не отслеживается тоже: git называет только каталог.
    for (let p = parentOf(r); p !== ''; p = parentOf(p)) if (rt.marks.get(p) === 'untracked') return 'untracked';
    if (kind === 'dir' && rt.changedDirs.has(r)) return 'changed';
    return null;
  }

  function entriesOf(node: Node): ViewEntry[] {
    const out: ViewEntry[] = [...sortEntries(node.entries.values())].map((e) => [e.name, e.kind, markOf(node.rt, `${node.dir}/${e.name}`, e.kind), e.link === true]);
    // Удалённый файл на диске уже не виден, но в дереве его надо показать (ai-cyborg, `renderDir`).
    const relDir = rel(node.rt, node.dir);
    const extra: ViewEntry[] = [];
    for (const [path, kind] of node.rt.marks) {
      if (kind !== 'deleted' || parentOf(path) !== relDir) continue;
      const name = baseOf(path);
      if (!node.entries.has(name)) extra.push([name, 'file', 'deleted', false]);
    }
    return extra.length === 0 ? out : [...out, ...extra].sort((a, b) => Number(b[1] === 'dir') - Number(a[1] === 'dir') || a[0].localeCompare(b[0]));
  }

  function views(): RootView[] {
    return order.flatMap((path) => {
      const rt = roots.get(path);
      if (rt === undefined) return [];
      const shown: Record<string, ViewEntry[]> = {};
      for (const node of nodes.values()) if (node.rt === rt) shown[node.dir] = entriesOf(node);
      const notice = rt.lost ?? (rt.watchError !== undefined && !collapsed(rt) ? `слежение не открыто: ${rt.watchError}` : undefined);
      return [
        {
          path,
          label: rt.spec.label,
          hint: rt.spec.hint,
          collapsed: collapsed(rt),
          branch: rt.branch ?? null,
          switchable: deps.switchable(path),
          changes: rt.marks.size,
          error: rt.error ?? null,
          notice: notice ?? null,
          nodes: shown,
        },
      ];
    });
  }

  const asked = (rt: Rt): boolean => rt.queue.again;

  /**
   * Запрос отметок сразу; пока он идёт, остальные просьбы склеиваются в один следующий (git status дорог, события идут пачками). Ответ - когда очередь опустела:
   * просившему видно, что отметки уже в дереве.
   */
  function scheduleMarks(rt: Rt): Promise<void> {
    if (disposed || roots.get(rt.spec.path) !== rt) return Promise.resolve();
    if (rt.queue.running) {
      rt.queue.again = true;
      return rt.queue.done;
    }
    rt.queue.running = true;
    rt.queue.done = (async () => {
      try {
        do {
          rt.queue.again = false;
          await refreshMarks(rt).catch((error: unknown) => deps.log(`отметки ${rt.spec.path}: ${message(error)}`, 'warn'));
        } while (asked(rt));
      } finally {
        rt.queue.running = false;
      }
    })();
    return rt.queue.done;
  }

  async function refreshMarks(rt: Rt): Promise<void> {
    counters.markRuns++;
    const at = rt.spec.path;
    const next = new Map<string, TreeMarkKind>();
    const [branch] = await Promise.all([
      deps.branch(at).catch(() => null),
      (async () => {
        for (const provider of deps.providers()) {
          try {
            for (const m of await provider.impl.marks(at)) {
              const path = m.path.replace(/\/$/, '');
              const old = next.get(path);
              if (old === undefined || STRENGTH.indexOf(m.kind) < STRENGTH.indexOf(old)) next.set(path, m.kind);
            }
          } catch (error) {
            deps.log(`отметки от ${provider.pluginId}: ${message(error)}`, 'warn');
          }
        }
      })(),
    ]);
    if (roots.get(at) !== rt) return;
    const dirs = new Set<string>();
    for (const path of next.keys()) for (let p = parentOf(path); p !== ''; p = parentOf(p)) dirs.add(p);
    const same = next.size === rt.marks.size && [...next].every(([p, k]) => rt.marks.get(p) === k) && rt.branch === branch;
    rt.marks = next;
    rt.changedDirs = dirs;
    rt.branch = branch;
    if (!same) bump();
  }

  // --- чтение каталога и разбор события ---

  async function list(dir: string): Promise<Map<string, Entry>> {
    counters.list++;
    return new Map((await listDir(fs, dir)).map((e) => [e.name, e]));
  }

  /** Каталог перечитан целиком; ушедшие каталоги забывают свои узлы. Да - состав изменился. */
  async function relist(node: Node): Promise<boolean> {
    counters.relists++;
    const next = await list(node.dir);
    let changed = false;
    for (const [name, e] of node.entries) {
      const now = next.get(name);
      if (now !== undefined && now.kind === e.kind && now.link === e.link) continue;
      changed = true;
      dropSubtree(`${node.dir}/${name}`);
    }
    for (const [name, e] of next) {
      const was = node.entries.get(name);
      if (was === undefined || was.kind !== e.kind || was.link !== e.link) changed = true;
    }
    node.entries.clear();
    for (const [name, e] of next) node.entries.set(name, e);
    return changed;
  }

  /** Известное имя: узел обновляется одним stat; исчезнувшее удаляется. Ссылка остаётся ссылкой: её цель меняется, не меняя имени, и это увидит только перечитывание. */
  async function restat(node: Node, name: string): Promise<boolean> {
    const known = node.entries.get(name);
    if (known === undefined) return false;
    const path = `${node.dir}/${name}`;
    counters.stat++;
    try {
      const st = await fs.stat(path);
      if (known.link === true || known.kind === 'link' || known.kind === 'other' || st.kind === known.kind) return false;
      node.entries.set(name, { name, kind: st.kind });
      dropSubtree(path);
      return true;
    } catch (error) {
      if (isCode(error, 'NotFound')) {
        node.entries.delete(name);
        dropSubtree(path);
        return true;
      }
      // Нет прав: имя остаётся таким, каким его показал list.
      if (isCode(error, 'PermissionDenied')) return false;
      throw error;
    }
  }

  /** Имена одного узла: незнакомое имя или пачка больше RELIST_AT - перечитать каталог, иначе stat на каждое известное. */
  async function onNames(node: Node, shown: readonly string[]): Promise<void> {
    if (nodes.get(node.dir) !== node) return;
    let changed = false;
    const before = node.entries.size;
    try {
      if (shown.length > RELIST_AT || shown.some((n) => !node.entries.has(n))) changed = await relist(node);
      else for (const name of shown) changed = (await restat(node, name)) || changed;
    } catch (error) {
      // Каталог узла исчез раньше, чем дошло событие о его имени у родителя: родитель перечитает и забудет узел.
      if (isCode(error, 'NotFound') && (await fs.stat(node.dir).then(() => false, () => true))) return onNodeGone(node);
      throw error;
    }
    // Имена ушли из узла не потому ли, что исчез сам каталог (ОС назвала только имена внутри него)? Проверка - один stat и только когда записей стало меньше.
    if (changed && node.entries.size < before && (await fs.stat(node.dir).then(() => false, (e: unknown) => isCode(e, 'NotFound')))) return onNodeGone(node);
    if (changed) bump();
  }

  /**
   * Имя из события рекурсивного слежения (путь от корня через `/`) -> узел, который его разбирает, и имя в нём. Идём от корня вниз по раскрытым узлам:
   * имя прямого ребёнка узла разбирает узел; глубже последнего раскрытого узла дерево ничего не показывает, но если узел не знает первого каталога на пути,
   * он перечитывается (ОС могла не назвать сам новый каталог). Всё остальное - только повод обновить отметки.
   */
  function route(rt: Rt, name: string): { readonly node: Node; readonly entry: string } | undefined {
    let node = nodes.get(rt.spec.path);
    const segments = name.split('/');
    for (const [i, entry] of segments.entries()) {
      if (node === undefined) return undefined;
      if (i === segments.length - 1) return { node, entry };
      const next = nodes.get(`${node.dir}/${entry}`);
      if (next === undefined) return node.entries.has(entry) ? undefined : { node, entry };
      node = next;
    }
    return undefined;
  }

  function enqueue(node: Node, job: () => Promise<void>): Promise<void> {
    node.work = node.work.then(job).catch((error: unknown) => deps.log(`${node.dir}: ${message(error)}`, 'warn'));
    return node.work as Promise<void>;
  }

  /** Событие слежения за корнем: имена внутри `.git` отбрасываются, остальные расходятся по узлам; отметки запрашиваются на любую пачку, кроме лавины (правка могла быть и в нераскрытом каталоге). */
  function onBatch(rt: Rt, names: readonly string[]): void {
    if (disposed || roots.get(rt.spec.path) !== rt) return;
    const shown = [...new Set(names)].filter((n) => n !== '' && !hidden(n));
    if (shown.length === 0) return;
    counters.batches++;
    counters.lastBatchAt = performance.now();
    noteBurst(rt, shown.length);
    const byNode = new Map<Node, string[]>();
    for (const name of shown) {
      const target = route(rt, name);
      if (target !== undefined) byNode.set(target.node, [...(byNode.get(target.node) ?? []), target.entry]);
    }
    const jobs = [...byNode].map(([node, entries]) => enqueue(node, () => onNames(node, entries)));
    // Отметки запрашиваются после того, как узлы обновлены и вид уже знает об этом: запуск git занимает цикл событий на миллисекунды, а имена в дереве нужны раньше отметок.
    // В лавине (checkout) события идут со всего дерева, и git status на каждую пачку не успевает за ходом checkout: отметки придут после тишины, вместе с перечитыванием.
    if (rt.burst.names < STORM_NAMES) void Promise.all(jobs).then(() => void scheduleMarks(rt));
  }

  // --- перечитывание после лавины и смены ветки ---

  async function resync(node: Node): Promise<void> {
    if (nodes.get(node.dir) !== node) return;
    counters.resyncs++;
    try {
      if (await relist(node)) bump();
    } catch (error) {
      if (isCode(error, 'NotFound')) await onNodeGone(node);
      else throw error;
    }
  }

  /** После тишины перечитываются все узлы корня, а не только те, где были события: потерянное событие по определению не оставляет следа. */
  function armResync(rt: Rt): void {
    clearTimeout(rt.burst.timer);
    rt.burst.timer = setTimeout(() => {
      rt.burst.names = 0;
      rt.burst.timer = undefined;
      if (disposed || roots.get(rt.spec.path) !== rt) return;
      // Родители раньше детей: ушедший каталог забирает свои узлы с собой.
      for (const node of [...nodes.values()].filter((n) => n.rt === rt).sort((a, b) => a.dir.length - b.dir.length)) void enqueue(node, () => resync(node));
      void scheduleMarks(rt);
    }, RESYNC_QUIET_MS);
  }

  function noteBurst(rt: Rt, count: number): void {
    rt.burst.names += count;
    if (rt.burst.names >= STORM_NAMES) {
      armResync(rt);
      return;
    }
    // Редкие мелкие события лавины не делают: счёт сбрасывается, если за RESYNC_QUIET_MS новых не было.
    rt.burst.timer ??= setTimeout(() => {
      rt.burst.names = 0;
      rt.burst.timer = undefined;
    }, RESYNC_QUIET_MS);
  }

  /** Каталог узла исчез: узел и всё под ним забыто, родитель перечитан; исчез корень - он помечен потерянным. */
  async function onNodeGone(node: Node): Promise<void> {
    if (nodes.get(node.dir) !== node) return;
    if (node.dir === node.rt.spec.path) return onRootClosed(node.rt, 'каталог удалён');
    dropSubtree(node.dir);
    state.expanded.delete(node.dir);
    const parent = nodes.get(parentOf(node.dir));
    if (parent !== undefined && (await relist(parent))) bump();
    void scheduleMarks(node.rt);
  }

  function onRootClosed(rt: Rt, reason: string): void {
    if (roots.get(rt.spec.path) !== rt) return;
    rt.watch = undefined;
    rt.lost = `корень потерян: ${reason}`;
    dropSubtree(rt.spec.path);
    bump();
  }

  // --- слежение: одно рекурсивное за каждым раскрытым корнем ---

  /** Слежение раньше чтения корня: правка между ними даст событие, а не потеряется. Отказ шлюза (на Linux `fs.inotify.max_user_watches`) не мешает дереву: оно читается, но не обновляется само. */
  async function startWatch(rt: Rt): Promise<void> {
    if (rt.watch !== undefined) return;
    try {
      rt.watch = await fs.watch(rt.spec.path, (names) => onBatch(rt, names), (reason) => onRootClosed(rt, reason), { recursive: true });
      rt.watchError = undefined;
    } catch (error) {
      rt.watchError = message(error);
      deps.log(`слежение за ${rt.spec.path} не открыто: ${rt.watchError}`, 'warn');
    }
  }

  function stopWatch(rt: Rt): void {
    rt.watch?.dispose();
    rt.watch = undefined;
    clearTimeout(rt.burst.timer);
    rt.burst.timer = undefined;
    rt.burst.names = 0;
  }

  // --- загрузка видимого ---

  async function ensureNode(rt: Rt, dir: string): Promise<Node> {
    const known = nodes.get(dir);
    if (known !== undefined) return known;
    const node: Node = { dir, rt, entries: await list(dir), work: Promise.resolve() };
    // Пока читался каталог, корень могли закрыть или заменить.
    if (roots.get(rt.spec.path) !== rt) return node;
    nodes.set(dir, node);
    return node;
  }

  /** Корень и раскрытые каталоги под ним, чья цепочка родителей раскрыта; узлы, которым в этой цепочке места нет, забываются. Сначала родители. */
  async function loadVisible(rt: Rt): Promise<void> {
    const root = rt.spec.path;
    const wanted = [...state.expanded].filter((d) => d.startsWith(`${root}/`)).sort((a, b) => a.length - b.length);
    const visible = new Set<string>([root]);
    try {
      await ensureNode(rt, root);
      rt.error = undefined;
    } catch (error) {
      rt.error = message(error);
      dropSubtree(root);
      return;
    }
    for (const dir of wanted) {
      // Родитель свёрнут: каталог помнится в области, но не показан.
      const parent = nodes.get(parentOf(dir));
      if (parent === undefined) continue;
      // Родитель раскрыт, а записи нет или это уже не каталог: забыть.
      if (parent.entries.get(baseOf(dir))?.kind !== 'dir') {
        state.expanded.delete(dir);
        continue;
      }
      try {
        await ensureNode(rt, dir);
        visible.add(dir);
      } catch (error) {
        if (isCode(error, 'NotFound')) state.expanded.delete(dir);
        else deps.log(`${dir}: ${message(error)}`, 'warn');
      }
    }
    for (const node of [...nodes.values()]) if (node.rt === rt && !visible.has(node.dir)) nodes.delete(node.dir);
  }

  /** Приводит корень к состоянию области: свёрнут - ни слежения, ни узлов; раскрыт - слежение, затем чтение. */
  async function sync(rt: Rt): Promise<void> {
    if (collapsed(rt)) {
      stopWatch(rt);
      dropSubtree(rt.spec.path);
      rt.error = undefined;
      rt.lost = undefined;
      return;
    }
    rt.lost = undefined;
    await startWatch(rt);
    await loadVisible(rt);
  }

  function release(rt: Rt): void {
    stopWatch(rt);
    dropSubtree(rt.spec.path);
    roots.delete(rt.spec.path);
  }

  // --- поставщики отметок ---

  const subscribed = new Map<string, Promise<Disposable | undefined>>();

  /** Поставщики отметок приходят и уходят; каждый сообщает, что набор отметок корня мог измениться. */
  function followProviders(): void {
    if (disposed) return;
    const present = new Set<string>();
    for (const provider of deps.providers()) {
      present.add(provider.pluginId);
      if (subscribed.has(provider.pluginId)) continue;
      subscribed.set(
        provider.pluginId,
        Promise.resolve(
          provider.impl.onChange((at) => {
            const rt = roots.get(at);
            if (rt === undefined) return;
            // Индекс или голова поменялись (commit, checkout, pull): каталоги могли смениться так, что событий не хватит.
            void scheduleMarks(rt);
            armResync(rt);
          }),
        ).then(
          (sub) => sub,
          (error: unknown) => {
            deps.log(`подписка на ${provider.pluginId}: ${message(error)}`, 'warn');
            return undefined;
          },
        ),
      );
    }
    for (const [id, sub] of subscribed) {
      if (present.has(id)) continue;
      subscribed.delete(id);
      void sub.then((s) => s?.dispose());
    }
    for (const rt of roots.values()) void scheduleMarks(rt);
  }

  // --- операции ---

  async function open(given: readonly RootSpec[], next: ScopeState): Promise<void> {
    // Путь корня не повторяется: две строки одного корня делили бы одно состояние раскрытия и сворачивания (FR-4004); остаётся первая.
    const specs = given.filter((spec, i) => given.findIndex((s) => s.path === spec.path) === i);
    state = next;
    specs.forEach((spec, i) => {
      if (state.seen.has(spec.path)) return;
      state.seen.add(spec.path);
      if (i > 0) state.collapsed.add(spec.path);
    });
    const wanted = new Set(specs.map((s) => s.path));
    for (const rt of [...roots.values()]) if (!wanted.has(rt.spec.path)) release(rt);
    order = specs.map((s) => s.path);
    const fresh: Rt[] = [];
    for (const spec of specs) {
      const known = roots.get(spec.path);
      if (known !== undefined) {
        known.spec = spec;
        continue;
      }
      const rt: Rt = {
        spec,
        watch: undefined,
        watchError: undefined,
        lost: undefined,
        error: undefined,
        marks: new Map(),
        changedDirs: new Set(),
        branch: undefined,
        burst: { names: 0, timer: undefined },
        queue: { running: false, again: false, done: Promise.resolve() },
      };
      roots.set(spec.path, rt);
      fresh.push(rt);
    }
    await Promise.all([...roots.values()].map((rt) => sync(rt)));
    // Первый ответ вида ждёт отметок: дерево без них показало бы вспышку «чистого» репозитория; следующий запрос идёт отдельно и склеивается.
    await Promise.all(fresh.map((rt) => scheduleMarks(rt)));
    bump();
  }

  async function expand(dir: string): Promise<void> {
    const rt = rootOf(dir);
    if (rt === undefined) throw new Error('files.expand: каталог вне корней дерева');
    if (dir === rt.spec.path) throw new Error('files.expand: корень раскрывается командой files.toggle-root');
    const parent = nodes.get(parentOf(dir));
    const entry = parent?.entries.get(baseOf(dir));
    if (entry === undefined) throw new Error(`files.expand: ${dir} не показан в дереве - раскройте родителя`);
    if (entry.kind === 'link') throw new Error(`files.expand: ${dir} - ссылка без читаемой цели, она не раскрывается`);
    if (entry.kind !== 'dir') throw new Error(`files.expand: ${dir} - не каталог`);
    state.expanded.add(dir);
    try {
      await ensureNode(rt, dir);
    } catch (error) {
      state.expanded.delete(dir);
      throw error;
    }
    await loadVisible(rt);
    bump();
  }

  function collapse(dir: string): Promise<void> {
    const rt = rootOf(dir);
    if (rt === undefined || dir === rt.spec.path || !nodes.has(dir)) return Promise.reject(new Error('files.collapse: нужен раскрытый каталог, не корень'));
    // Вложенные раскрытые остаются в памяти области: при следующем раскрытии они раскрыты (FR-4001).
    state.expanded.delete(dir);
    dropSubtree(dir);
    bump();
    return Promise.resolve();
  }

  async function toggleRoot(root: string): Promise<void> {
    const rt = roots.get(root);
    if (rt === undefined) throw new Error('files.toggle-root: такого корня в дереве нет');
    if (collapsed(rt)) state.collapsed.delete(root);
    else state.collapsed.add(root);
    await sync(rt);
    bump();
  }

  async function refresh(): Promise<void> {
    for (const rt of roots.values()) {
      if (collapsed(rt)) continue;
      // После отказа слежения «Обновить» пробует открыть его снова.
      await startWatch(rt);
      await loadVisible(rt);
      for (const node of [...nodes.values()].filter((n) => n.rt === rt).sort((a, b) => a.dir.length - b.dir.length)) {
        if (nodes.get(node.dir) === node) await relist(node).catch((error: unknown) => deps.log(`${node.dir}: ${message(error)}`, 'warn'));
      }
    }
    await Promise.all([...roots.values()].map((rt) => scheduleMarks(rt)));
    bump();
  }

  return {
    counters,
    open: (specs, next) => serial(() => open(specs, next)),
    expand: (dir) => serial(() => expand(dir)),
    collapse: (dir) => serial(() => collapse(dir)),
    toggleRoot: (root) => serial(() => toggleRoot(root)),
    refresh: () => serial(refresh),
    rootOf: (path) => rootOf(path)?.spec.path,
    shows: (dir) => nodes.has(dir),
    get version() {
      return version;
    },
    views,
    async settle() {
      await chain;
      await Promise.all([...nodes.values()].map((n) => n.work));
      for (const rt of roots.values()) while (rt.queue.running) await new Promise((resolve) => setTimeout(resolve, 2));
    },
    followProviders,
    dispose() {
      disposed = true;
      for (const rt of roots.values()) stopWatch(rt);
      roots.clear();
      nodes.clear();
      for (const sub of subscribed.values()) void sub.then((s) => s?.dispose());
      subscribed.clear();
    },
  };
}
