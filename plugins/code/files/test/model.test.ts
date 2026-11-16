// Модель дерева (`live.ts`) на виртуальной файловой системе: раскрытие и сворачивание по каждому каталогу независимо (tree.test.ts ai-cyborg, FR-4001..FR-4004), изоляция областей,
// разбор событий слежения (маршрут по узлам, лавина, потерянные события, закрытое слежение), отметки и ветка. События шлёт тест, поэтому результат не зависит от ОС.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TreeMark } from '@cyborg-harness/contracts';
import { createLive, newScopeState, RESYNC_QUIET_MS, type Live, type Provider, type RootSpec, type ScopeState } from '../live.ts';
import type { RootView } from '../protocol.ts';
import { pause, until } from './kit.ts';
import { Vfs } from './vfs.ts';

/** Дерево каталогов из tree.test.ts ai-cyborg. */
function sample(): Vfs {
  return new Vfs({
    '/r/a': 'dir',
    '/r/a/c': 'dir',
    '/r/a/c/deep.txt': 'file',
    '/r/a/x.txt': 'file',
    '/r/b': 'dir',
    '/r/b/c': 'dir',
    '/r/f.txt': 'file',
    '/o/a': 'dir',
    '/o/a/y.txt': 'file',
  });
}
const R: RootSpec = { path: '/r', label: 'r', hint: '' };
const O: RootSpec = { path: '/o', label: 'o', hint: '' };

interface Harness {
  readonly live: Live;
  readonly vfs: Vfs;
  readonly logs: string[];
  readonly changes: { n: number };
  readonly asked: string[];
  readonly providers: Provider[];
  /** Слушатели `onChange` поставщика отметок. */
  readonly onChange: Set<(root: string) => void>;
  marks: TreeMark[];
  branch: string | null;
  root(path: string): RootView;
  names(dir: string): string[];
}

function harness(vfs: Vfs = sample()): Harness {
  const logs: string[] = [];
  const changes = { n: 0 };
  const asked: string[] = [];
  const onChange = new Set<(root: string) => void>();
  const h: Harness = {
    vfs,
    logs,
    changes,
    asked,
    onChange,
    marks: [],
    branch: null,
    providers: [
      {
        pluginId: 'git',
        impl: {
          marks: async (root: string) => (asked.push(root), h.marks),
          onChange: (listener: (root: string) => void) => (onChange.add(listener), { dispose: () => void onChange.delete(listener) }),
        } as never,
      },
    ],
    live: undefined as never,
    root: (path) => {
      const found = h.live.views().find((r) => r.path === path);
      assert.ok(found, `корня ${path} нет`);
      return found;
    },
    names: (dir) => {
      for (const r of h.live.views()) if (r.nodes[dir]) return r.nodes[dir].map((e) => e[0]);
      return [];
    },
  };
  (h as { live: Live }).live = createLive({
    fs: vfs.fs,
    log: (m) => void logs.push(m),
    providers: () => h.providers,
    branch: async () => h.branch,
    switchable: () => false,
    changed: () => void changes.n++,
  });
  return h;
}

const isOpen = (h: Harness, dir: string): boolean => h.live.views().some((r) => r.nodes[dir] !== undefined);

async function open(h: Harness, specs: RootSpec[] = [R, O], state: ScopeState = newScopeState()): Promise<ScopeState> {
  await h.live.open(specs, state);
  return state;
}

describe('раскрытие по каждому каталогу независимо (FR-4001, FR-4002)', () => {
  it('клик по каталогу раскрывает только его: соседний, одноимённый в другом корне и вложенные остаются свёрнутыми', async () => {
    const h = harness();
    await open(h);
    await h.live.toggleRoot('/o');
    await h.live.expand('/r/a');
    assert.equal(isOpen(h, '/r/a'), true, '/r/a раскрыт');
    assert.equal(isOpen(h, '/r/b'), false, 'соседний /r/b свёрнут');
    assert.equal(isOpen(h, '/r/a/c'), false, 'вложенный /r/a/c свёрнут');
    assert.equal(isOpen(h, '/o/a'), false, 'одноимённый /o/a в другом корне свёрнут');
    assert.deepEqual(h.names('/r/a'), ['c', 'x.txt']);
    assert.equal(h.names('/r/a/c').length, 0, 'содержимое вложенного не прочитано');
    assert.equal(isOpen(h, '/r/b/c'), false);
  });

  it('повторный клик сворачивает только этот каталог; раскрытый внутри подкаталог при следующем раскрытии раскрыт', async () => {
    const h = harness();
    await open(h);
    await h.live.expand('/r/a');
    await h.live.expand('/r/b');
    await h.live.expand('/r/a/c');
    await h.live.collapse('/r/a');
    assert.equal(isOpen(h, '/r/a'), false);
    assert.equal(isOpen(h, '/r/a/c'), false, 'под свёрнутым ничего не показано');
    assert.equal(isOpen(h, '/r/b'), true, '/r/b не свёрнут');
    await h.live.expand('/r/a');
    assert.equal(isOpen(h, '/r/a/c'), true, 'вложенный раскрыт, как был');
    assert.deepEqual(h.names('/r/a/c'), ['deep.txt']);
  });

  it('первый корень раскрыт, остальные свёрнуты; клик по корню сворачивает или разворачивает только его', async () => {
    const h = harness();
    await open(h);
    assert.deepEqual(h.live.views().map((r) => [r.path, r.collapsed]), [['/r', false], ['/o', true]]);
    assert.deepEqual(h.root('/o').nodes, {}, 'свёрнутый корень не читается');
    await h.live.toggleRoot('/o');
    assert.deepEqual(h.names('/o'), ['a']);
    await h.live.toggleRoot('/r');
    assert.equal(h.root('/r').collapsed, true);
    assert.deepEqual(h.root('/r').nodes, {});
    assert.equal(h.root('/o').collapsed, false, 'другой корень не тронут');
  });

  it('корень с повторным путём: строка корня одна, клик сворачивает один корень', async () => {
    const h = harness();
    await open(h, [{ path: '/o', label: 'own', hint: '' }, { path: '/o', label: 'dup', hint: '' }]);
    assert.deepEqual(h.live.views().map((r) => r.label), ['own']);
    await h.live.toggleRoot('/o');
    assert.equal(isOpen(h, '/o'), false);
  });

  it('cwd сессии в другом репозитории проекта: клик по каталогу раскрывает одну строку, а не одноимённую в другом корне', async () => {
    const h = harness(new Vfs({ '/r/a': 'dir', '/r/a/x': 'file', '/o/a': 'dir', '/o/a/y': 'file' }));
    // свой корень - /o (cwd ушёл туда), затем стартовый репозиторий /r
    await open(h, [{ path: '/o', label: 'o', hint: 'другой репозиторий проекта, куда перешёл рабочий каталог сессии' }, { path: '/r', label: 'r', hint: 'репозиторий, где сессия была запущена' }]);
    await h.live.toggleRoot('/r');
    await h.live.expand('/o/a');
    assert.deepEqual(h.live.views().flatMap((r) => Object.keys(r.nodes)).filter((d) => d.endsWith('/a')), ['/o/a']);
  });

  it('раскрыть можно только показанный каталог: незнакомый путь, файл, корень и ссылка без цели - отказ', async () => {
    const vfs = sample();
    vfs.put('/r/dangling', { link: null });
    const h = harness(vfs);
    await open(h);
    await assert.rejects(h.live.expand('/r/zzz'), /не показан в дереве/);
    await assert.rejects(h.live.expand('/r/a/c'), /не показан в дереве - раскройте родителя/);
    await assert.rejects(h.live.expand('/r/f.txt'), /не каталог/);
    await assert.rejects(h.live.expand('/r'), /toggle-root/);
    await assert.rejects(h.live.expand('/r/dangling'), /ссылк/);
    await assert.rejects(h.live.expand('/x/y'), /вне корней/);
    await assert.rejects(h.live.collapse('/r/a'), /нужен раскрытый/);
    await assert.rejects(h.live.toggleRoot('/nope'), /такого корня/);
  });

  it('каталог без прав: раскрытие отказывает с причиной шлюза и не оставляет каталог «раскрытым»', async () => {
    const h = harness();
    await open(h);
    h.vfs.denied.add('/r/a');
    await assert.rejects(h.live.expand('/r/a'), /вне области/);
    assert.equal(isOpen(h, '/r/a'), false);
    h.vfs.denied.clear();
    await h.live.expand('/r/a');
    assert.equal(isOpen(h, '/r/a'), true);
  });
});

describe('области изолированы (FR-4003)', () => {
  it('раскрытие в одной области не меняет дерево другой; при возврате состояние на месте', async () => {
    const h = harness();
    const one = newScopeState();
    const two = newScopeState();
    await open(h, [R, O], one);
    await h.live.expand('/r/a');
    await open(h, [R, O], two);
    assert.equal(isOpen(h, '/r/a'), false, 'в другой области /r/a свёрнут');
    await h.live.expand('/r/b');
    await open(h, [R, O], one);
    assert.equal(isOpen(h, '/r/a'), true);
    assert.equal(isOpen(h, '/r/b'), false);
    await open(h, [R, O], two);
    assert.equal(isOpen(h, '/r/b'), true);
    assert.equal(isOpen(h, '/r/a'), false);
  });

  it('смена набора корней (worktree вместо репозитория): ушедший корень отпущен вместе со слежением, новый открыт', async () => {
    const vfs = sample();
    vfs.put('/w/g.txt');
    const h = harness(vfs);
    const state = newScopeState();
    await open(h, [R, O], state);
    assert.equal(vfs.live(), 1);
    await open(h, [{ path: '/w', label: 'r ⎇ w', hint: 'worktree' }, O], state);
    assert.deepEqual(h.live.views().map((r) => r.path), ['/w', '/o']);
    assert.deepEqual(h.names('/w'), ['g.txt']);
    assert.equal(vfs.live(), 1, 'слежение за /r снято, за /w открыто');
    assert.equal(vfs.watches.filter((w) => !w.disposed).map((w) => w.path).join(), '/w');
  });
});

describe('слежение вместо опроса', () => {
  it('в простое ни одного вызова: после открытия дерево не читает каталоги и не спрашивает отметки без события', async () => {
    const h = harness();
    await open(h);
    await h.live.expand('/r/a');
    await h.live.settle();
    const before = { ...h.live.counters, list: h.vfs.calls.list, stat: h.vfs.calls.stat, asked: h.asked.length };
    await pause(RESYNC_QUIET_MS + 150);
    assert.deepEqual({ ...h.live.counters, list: h.vfs.calls.list, stat: h.vfs.calls.stat, asked: h.asked.length }, before);
  });

  it('слежение одно на раскрытый корень и рекурсивное; свёрнутый корень без слежения, раскрытие его открывает', async () => {
    const h = harness();
    await open(h);
    assert.deepEqual(h.vfs.watches.map((w) => [w.path, w.recursive]), [['/r', true]]);
    await h.live.toggleRoot('/o');
    assert.deepEqual(h.vfs.watches.map((w) => [w.path, w.recursive, w.disposed]), [['/r', true, false], ['/o', true, false]]);
    await h.live.toggleRoot('/o');
    assert.equal(h.vfs.live(), 1, 'свёрнутый корень отпустил слежение');
    h.live.dispose();
    assert.equal(h.vfs.live(), 0);
  });

  it('новое имя в раскрытом каталоге: каталог читается, дерево сообщает об изменении', async () => {
    const h = harness();
    await open(h);
    await h.live.expand('/r/a');
    const n = h.changes.n;
    h.vfs.put('/r/a/new.txt');
    h.vfs.emit('/r', 'a/new.txt');
    await until('имя появилось', () => h.names('/r/a').includes('new.txt'));
    assert.ok(h.changes.n > n);
    assert.deepEqual(h.names('/r/a'), ['c', 'new.txt', 'x.txt']);
  });

  it('известное имя: один stat, каталог не читается; исчезнувшее удаляется вместе с подкаталогом; файл, ставший каталогом, меняет род', async () => {
    const h = harness();
    await open(h);
    await h.live.expand('/r/a');
    await h.live.expand('/r/a/c');
    await h.live.settle();
    const lists = h.vfs.calls.list;
    h.vfs.emit('/r', 'a/x.txt');
    await h.live.settle();
    assert.equal(h.vfs.calls.list, lists, 'известное имя без перечитывания каталога');
    assert.equal(h.live.counters.stat, 1);
    h.vfs.remove('/r/a/c');
    h.vfs.emit('/r', 'a/c');
    await until('подкаталог ушёл', () => !isOpen(h, '/r/a/c') && !h.names('/r/a').includes('c'));
    h.vfs.remove('/r/f.txt');
    h.vfs.put('/r/f.txt/inner', 'file');
    h.vfs.emit('/r', 'f.txt');
    await until('файл стал каталогом', () => h.root('/r').nodes['/r']?.some((e) => e[0] === 'f.txt' && e[1] === 'dir') === true);
  });

  it('имя глубже раскрытого узла: узел перечитывается, только если не знает первого каталога на пути; прочее - повод спросить отметки', async () => {
    const h = harness();
    await open(h);
    await h.live.settle();
    const lists = h.vfs.calls.list;
    const asks = h.asked.length;
    // b известен корню и не раскрыт: правка глубоко внутри даёт только запрос отметок
    h.vfs.emit('/r', 'b/c/new.txt');
    await until('отметки запрошены', () => h.asked.length > asks);
    assert.equal(h.vfs.calls.list, lists);
    // каталог z ещё не известен корню (ОС не назвала его самого): корень перечитывается
    h.vfs.put('/r/z/q.txt');
    h.vfs.emit('/r', 'z/q.txt');
    await until('z виден', () => h.names('/r').includes('z'));
  });

  it('имена внутри .git ни дерево, ни отметки не будят', async () => {
    const h = harness();
    await open(h);
    await h.live.settle();
    const before = { list: h.vfs.calls.list, stat: h.vfs.calls.stat, asked: h.asked.length, batches: h.live.counters.batches };
    h.vfs.emit('/r', ...Array.from({ length: 40 }, (_, i) => `.git/objects/${String(i)}`));
    await pause(RESYNC_QUIET_MS + 100);
    assert.deepEqual({ list: h.vfs.calls.list, stat: h.vfs.calls.stat, asked: h.asked.length, batches: h.live.counters.batches }, before);
  });

  it('лавина (checkout): после тишины перечитываются все раскрытые узлы, а отметки запрашиваются один раз', async () => {
    const h = harness();
    await open(h);
    await h.live.expand('/r/a');
    await h.live.expand('/r/a/c');
    await h.live.settle();
    const asks = h.asked.length;
    // ОС назвала не все имена: /r/a/lost.txt появился без события о нём
    h.vfs.put('/r/a/lost.txt');
    h.vfs.emit('/r', ...Array.from({ length: 20 }, (_, i) => `b/f${String(i)}.txt`));
    assert.equal(h.asked.length, asks, 'в лавине отметки на пачку не запрашиваются');
    await until('узлы перечитаны после тишины', () => h.names('/r/a').includes('lost.txt'), 3000);
    await h.live.settle();
    assert.equal(h.asked.length, asks + 1, 'одна пачка запросов после тишины');
    assert.equal(h.live.counters.resyncs, 3, 'корень, a и a/c');
  });

  it('пачка больше 64 имён в одном узле - один list вместо stat на каждое', async () => {
    const h = harness();
    await open(h);
    await h.live.settle();
    for (let i = 0; i < 70; i++) h.vfs.put(`/r/many${String(i)}.txt`);
    const stats = h.vfs.calls.stat;
    h.vfs.emit('/r', ...Array.from({ length: 70 }, (_, i) => `many${String(i)}.txt`));
    await until('имена появились', () => h.names('/r').includes('many69.txt'));
    assert.equal(h.vfs.calls.stat, stats);
  });

  it('слежение закрыто ядром (корень удалён): корень помечен потерянным, узлы забыты; «Обновить» не воскрешает несуществующее', async () => {
    const h = harness();
    await open(h);
    await h.live.expand('/r/a');
    h.vfs.remove('/r');
    h.vfs.close('/r', 'каталог удалён');
    assert.match(h.root('/r').notice ?? '', /корень потерян: каталог удалён/);
    assert.deepEqual(h.root('/r').nodes, {});
    await h.live.refresh();
    assert.ok(h.root('/r').error !== null || h.root('/r').notice !== null, 'причина осталась на виду');
  });

  it('слежение не открылось (Linux: fs.inotify.max_user_watches): дерево читается, причина на виду, «Обновить» пробует снова', async () => {
    const h = harness();
    const original = h.vfs.watch.bind(h.vfs);
    let refuse = true;
    h.vfs.watch = (async (...args: Parameters<typeof original>) => {
      if (refuse) throw Object.assign(new Error('Unavailable: fs.inotify.max_user_watches'), { code: 'Unavailable' });
      return original(...args);
    }) as typeof h.vfs.watch;
    await open(h);
    assert.deepEqual(h.names('/r'), ['a', 'b', 'f.txt'], 'дерево прочитано без слежения');
    assert.match(h.root('/r').notice ?? '', /слежение не открыто: .*max_user_watches/);
    assert.ok(h.logs.some((l) => /не открыто/.test(l)));
    refuse = false;
    h.vfs.put('/r/late.txt');
    await h.live.refresh();
    assert.ok(h.names('/r').includes('late.txt'), '«Обновить» перечитал каталог');
    assert.equal(h.root('/r').notice, null);
    assert.equal(h.vfs.live(), 1);
  });

  it('корень не читается (нет прав): строка корня с причиной, остальные корни работают', async () => {
    const h = harness();
    h.vfs.denied.add('/o');
    await open(h);
    await h.live.toggleRoot('/o');
    assert.match(h.root('/o').error ?? '', /вне области/);
    assert.deepEqual(h.names('/r'), ['a', 'b', 'f.txt']);
  });

  it('refresh перечитывает всё показанное и просит отметки: так возвращается потерянное событие', async () => {
    const h = harness();
    await open(h);
    await h.live.expand('/r/a');
    h.vfs.put('/r/a/silent.txt');
    h.vfs.put('/r/silent-root.txt');
    const asks = h.asked.length;
    await h.live.refresh();
    assert.ok(h.names('/r/a').includes('silent.txt'));
    assert.ok(h.names('/r').includes('silent-root.txt'));
    assert.ok(h.asked.length > asks);
  });

  it('исчезнувший раскрытый каталог: родитель перечитан, узел и состояние забыты', async () => {
    const h = harness();
    const state = await open(h);
    await h.live.expand('/r/a');
    h.vfs.remove('/r/a');
    h.vfs.emit('/r', 'a/x.txt');
    await until('узел a забыт', () => !isOpen(h, '/r/a') && !h.names('/r').includes('a'), 3000);
    assert.equal(state.expanded.has('/r/a'), false);
  });
});

describe('отметки и ветка от поставщиков', () => {
  it('отметка файла, «изменения внутри» у каталога, удалённый файл показан строкой, число изменений в корне', async () => {
    const h = harness();
    h.marks = [
      { path: 'a/x.txt', kind: 'modified' },
      { path: 'new.txt', kind: 'untracked' },
      { path: 'gone.txt', kind: 'deleted' },
    ];
    h.branch = 'main';
    await open(h);
    await h.live.expand('/r/a');
    const root = h.root('/r');
    assert.equal(root.changes, 3);
    assert.equal(root.branch, 'main');
    assert.deepEqual(root.nodes['/r']?.map((e) => [e[0], e[2]]), [['a', 'changed'], ['b', null], ['f.txt', null], ['gone.txt', 'deleted']]);
    assert.deepEqual(root.nodes['/r/a']?.map((e) => [e[0], e[2]]), [['c', null], ['x.txt', 'modified']]);
  });

  it('содержимое неотслеживаемого каталога неотслеживаемо тоже; при двух отметках на путь побеждает более значимая', async () => {
    const h = harness();
    h.providers.push({ pluginId: 'other', impl: { marks: async () => [{ path: 'f.txt', kind: 'conflict' }], onChange: () => ({ dispose() {} }) } as never });
    h.marks = [
      { path: 'b', kind: 'untracked' },
      { path: 'f.txt', kind: 'modified' },
    ];
    await open(h);
    await h.live.expand('/r/b');
    assert.equal(h.root('/r').nodes['/r']?.find((e) => e[0] === 'f.txt')?.[2], 'conflict');
    assert.deepEqual(h.root('/r').nodes['/r/b']?.map((e) => [e[0], e[2]]), [['c', 'untracked']]);
  });

  it('поставщик сообщил об изменении (индекс, голова): отметки и ветка обновлены, раскрытые каталоги перечитаны после тишины', async () => {
    const h = harness();
    h.marks = [{ path: 'f.txt', kind: 'modified' }];
    h.branch = 'main';
    await open(h);
    await h.live.expand('/r/a');
    h.live.followProviders();
    await h.live.settle();
    h.marks = [];
    h.branch = 'feature';
    h.vfs.put('/r/a/from-checkout.txt');
    for (const l of h.onChange) l('/r');
    await until('отметки и ветка обновились', () => h.root('/r').branch === 'feature' && h.root('/r').changes === 0);
    await until('каталоги перечитаны', () => h.names('/r/a').includes('from-checkout.txt'), 3000);
    for (const l of h.onChange) l('/чужой-корень');
  });

  it('статус и ветка корня запрашиваются одновременно, запросы отметок не накладываются: во время работы остальные склеиваются в один следующий (NFR-4001)', async () => {
    const h = harness();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let running = 0;
    let overlap = 0;
    let runs = 0;
    h.providers[0] = {
      pluginId: 'git',
      impl: {
        marks: async (root: string) => {
          started.push(`marks ${root}`);
          overlap = Math.max(overlap, ++running);
          runs++;
          await gate;
          running--;
          return [];
        },
        onChange: (listener: (root: string) => void) => (h.onChange.add(listener), { dispose: () => void h.onChange.delete(listener) }),
      } as never,
    };
    const live = createLive({
      fs: h.vfs.fs,
      log: () => undefined,
      providers: () => h.providers,
      branch: async (root) => {
        started.push(`branch ${root}`);
        await gate;
        return 'main';
      },
      switchable: () => false,
      changed: () => undefined,
    });
    const opening = live.open([R], newScopeState());
    await pause(30);
    assert.deepEqual(started.sort(), ['branch /r', 'marks /r'], 'до ответа первого запроса запущены оба');
    live.followProviders();
    for (let i = 0; i < 5; i++) for (const l of h.onChange) l('/r');
    release();
    await opening;
    await live.settle();
    assert.equal(overlap, 1, 'два запроса отметок одного корня не идут одновременно');
    assert.ok(runs <= 3, `первый запрос и не больше двух следующих на пять просьб, было ${String(runs)}`);
    live.dispose();
  });

  it('поставщик, бросивший исключение, дереву не мешает: причина в журнале, корни читаются', async () => {
    const h = harness();
    h.providers.splice(0, 1, { pluginId: 'git', impl: { marks: async () => Promise.reject(new Error('git упал')), onChange: () => ({ dispose() {} }) } as never });
    await open(h);
    assert.deepEqual(h.names('/r'), ['a', 'b', 'f.txt']);
    assert.ok(h.logs.some((l) => /отметки от git: git упал/.test(l)));
  });

  it('без поставщика отметок и без git дерево работает: ни отметок, ни ветки', async () => {
    const h = harness();
    h.providers.length = 0;
    await open(h);
    const root = h.root('/r');
    assert.equal(root.branch, null);
    assert.equal(root.changes, 0);
    assert.ok(root.nodes['/r']?.every((e) => e[2] === null));
  });
});
