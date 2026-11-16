import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkRepo } from '../lib/check-all.ts';
import { addMissingRows, compareMatrix, extractSource, loadMatrix, summarize, validateMatrix, writeMatrix } from '../lib/parity.ts';
import type { Matrix, Row } from '../lib/parity.ts';
import { generatePages } from '../lib/gen-catalog.ts';
import { REPO_ROOT } from '../lib/util.ts';
import type { Problem } from '../lib/util.ts';
import { makeRepo, repoWith } from './helpers.ts';
import type { Files } from './helpers.ts';

const text = (problems: Problem[]): string => problems.map((p) => `${p.where}: ${p.message}`).join('\n');

// Мини-копия ai-cyborg: ровно то, что читает извлечение.
const AI: Files = {
  'docs/01-product/01-tasks-panel/srs.md': '# SRS\n\n### FR-1001 Панель `задач`\n\n### NFR-1001 Токен не проходит\n',
  'docs/01-product/13-file-search/srs.md': '### FR-13001 Окно поиска\n',
  'docs/01-product/brd.md': '### FR-9999 Не фича: файл не srs.md\n',
  'src/main/main.ts': `ipcMain.handle('tasks:list', () => 1);
ipcMain.on('session:kill', () => 1);
mainWindow.webContents.send('menu:search');
registerRunChannels((channel, listener) => ipcMain.handle(channel, listener), runs, runFileChannel);
`,
  'src/main/run-file.ts': `export function registerRunChannels(handle: Handle): void {
  handle('file:runnable', () => 1);
  handle('file:run', () => 2);
}
`,
  'src/main/sessions.ts': "this.emit('session:cwd', 1); this.emit('session:exit', 2); this.emit('other:thing', 3);\n",
  'src/main/sessions.test.ts': "ipcMain.handle('test:only', () => 1);\n",
  'src/renderer/app.ts': "localStorage.getItem('cyborg.fontSize'); localStorage.getItem('cyborg.mrs.filter'); const k = `cyborg.search.${key}`; const l = `cyborg.tasks.labels:${id}`;\n",
  'src/renderer/index.html': '<dialog id="project-dialog" aria-labelledby="x"></dialog>\n<dialog class="a" id="ext-dialog"></dialog>\n',
  'src/shared/x.ts': "const f = 'commands.json';\n",
};

const ROWS: Row[] = [
  { id: 'FR-1001', kind: 'requirement', feature: '01-tasks-panel', title: 'Панель задач', owner: 'trackers', task: 'M-13', status: 'not-started' },
  { id: 'NFR-1001', kind: 'requirement', feature: '01-tasks-panel', title: 'Токен', owner: 'trackers', task: 'M-13', status: 'not-started' },
  { id: 'FR-13001', kind: 'requirement', feature: '13-file-search', title: 'Поиск', owner: 'search', task: 'M-12', status: 'not-started' },
  { id: 'tasks:list', kind: 'channel', type: 'handle', owner: 'trackers', task: 'M-13', status: 'not-started' },
  { id: 'session:kill', kind: 'channel', type: 'on', owner: 'sessions', task: 'M-03', status: 'not-started' },
  { id: 'file:runnable', kind: 'channel', type: 'handle', owner: 'viewer', task: 'M-10', status: 'not-started' },
  { id: 'file:run', kind: 'channel', type: 'handle', owner: 'viewer', task: 'M-10', status: 'not-started' },
  { id: 'menu:search', kind: 'event', owner: 'search', task: 'M-12', status: 'not-started' },
  { id: 'session:cwd', kind: 'event', owner: 'sessions', task: 'M-03', status: 'not-started' },
  { id: 'session:exit', kind: 'event', owner: 'sessions', task: 'M-03', status: 'not-started' },
  { id: 'cyborg.fontSize', kind: 'storage', owner: 'sessions', task: 'M-03', status: 'not-started' },
  { id: 'cyborg.mrs.filter', kind: 'storage', owner: 'trackers', task: 'M-13', status: 'not-started' },
  { id: 'cyborg.search.*', kind: 'storage', family: true, owner: 'search', task: 'M-12', status: 'not-started' },
  { id: 'cyborg.tasks.labels:*', kind: 'storage', family: true, owner: 'trackers', task: 'M-13', status: 'not-started' },
  { id: 'project-dialog', kind: 'dialog', owner: 'projects', task: 'M-01', status: 'not-started' },
  { id: 'ext-dialog', kind: 'dialog', owner: 'claude-extensions', task: 'M-19', status: 'not-started' },
  { id: 'userData/commands.json', kind: 'data', probe: 'commands.json', owner: 'command-buttons', task: 'M-17', status: 'not-started' },
];

const matrix = (rows: Row[] = ROWS): Matrix => ({
  format: 1,
  source: { repo: 'dex-it/ai-cyborg', commit: 'a'.repeat(40), date: '2026-11-16' },
  features: { '01-tasks-panel': { tests: ['trackers.test.ts'], scenarios: ['S6'] }, '13-file-search': { tests: [], scenarios: ['S9'] } },
  rows,
});
const OWNERS = new Set(['trackers', 'search', 'sessions', 'viewer', 'projects', 'claude-extensions', 'command-buttons', 'core', 'repo']);
const validate = (m: Matrix): string => {
  const problems: Problem[] = [];
  validateMatrix(m, OWNERS, problems);
  return text(problems);
};

describe('матрица паритета: правила данных', () => {
  it('согласованная матрица проходит', () => {
    assert.equal(validate(matrix()), '');
  });

  it('владелец не из каталога, плохая задача и статус, повтор, allowlist без причины и причина без allowlist', () => {
    const bad = [
      ...ROWS,
      { ...ROWS[0], id: 'FR-1', owner: 'призрак' },
      { ...ROWS[0], id: 'FR-2', task: 'задача' },
      { ...ROWS[0], id: 'FR-3', status: 'готово' },
      { ...ROWS[0], id: 'FR-4', status: 'allowlist' },
      { ...ROWS[0], id: 'FR-5', reason: 'зря' },
      { ...ROWS[0] },
      { ...ROWS[0], id: 'FR-6', feature: 'нет-такой' },
      { ...ROWS[3], id: 'ch:x', type: undefined },
      { ...ROWS[16], id: 'file-x', probe: undefined },
    ] as Row[];
    const t = validate(matrix(bad));
    assert.match(t, /владелец «призрак»/);
    assert.match(t, /task «задача»/);
    assert.match(t, /status - одно из/);
    assert.match(t, /allowlist требует reason/);
    assert.match(t, /reason бывает только у статуса allowlist/);
    assert.match(t, /строка повторена/);
    assert.match(t, /требование без известной фичи/);
    assert.match(t, /у канала type - handle или on/);
    assert.match(t, /у файла данных нужен probe/);
  });

  it('allowlist с причиной допустим', () => {
    assert.equal(validate(matrix([{ ...ROWS[0], status: 'allowlist', reason: 'Кнопки от модели: D-00, источник другой' } as Row])), '');
  });

  it('сценарий вида S12', () => {
    const m = matrix();
    m.features['13-file-search'] = { tests: [], scenarios: ['вообще'] };
    assert.match(validate(m), /сценарий «вообще» вида S12/);
  });
});

describe('матрица паритета: извлечение и сравнение', () => {
  it('извлекает требования, каналы (в том числе из registerRunChannels), события, ключи, семейства, диалоги; тесты и не-srs игнорирует', () => {
    using ai = makeRepo(AI);
    const code = extractSource(ai.root);
    assert.deepEqual([...code.requirements.keys()], ['FR-1001', 'NFR-1001', 'FR-13001']);
    assert.equal(code.requirements.get('FR-1001')?.title, 'Панель задач');
    assert.deepEqual([...code.channels].sort(), [['file:run', 'handle'], ['file:runnable', 'handle'], ['session:kill', 'on'], ['tasks:list', 'handle']]);
    assert.deepEqual([...code.events].sort(), ['menu:search', 'session:cwd', 'session:exit']);
    assert.deepEqual([...code.storageKeys].sort(), ['cyborg.fontSize', 'cyborg.mrs.filter']);
    assert.deepEqual([...code.storageFamilies].sort(), ['cyborg.search.*', 'cyborg.tasks.labels:*']);
    assert.deepEqual([...code.dialogs].sort(), ['ext-dialog', 'project-dialog']);
    assert.ok(code.haystack.includes('commands.json'));
  });

  it('матрица, совпавшая с кодом, - без расхождений', () => {
    using ai = makeRepo(AI);
    assert.deepEqual(compareMatrix(matrix(), extractSource(ai.root)), { missing: [], stale: [], mismatched: [] });
  });

  it('новое в коде, исчезнувшее, несовпавший вид канала и фича, переименованный файл данных', () => {
    using ai = makeRepo({ ...AI, 'src/main/new.ts': "ipcMain.handle('fresh:one', () => 1);\n", 'src/shared/x.ts': "const f = 'renamed.json';\n" });
    const rows = ROWS.filter((r) => r.id !== 'cyborg.fontSize').map((r) => (r.id === 'session:kill' ? { ...r, type: 'handle' as const } : r.id === 'FR-13001' ? { ...r, feature: '99-other' } : r));
    rows.push({ id: 'old:channel', kind: 'channel', type: 'handle', owner: 'core', task: '-', status: 'not-started' });
    const diff = compareMatrix(matrix(rows), extractSource(ai.root));
    assert.deepEqual(diff.missing, ['канал fresh:one', 'ключ хранилища cyborg.fontSize']);
    assert.deepEqual(diff.stale, ['канал old:channel', 'файл данных userData/commands.json: в коде нет «commands.json»']);
    assert.deepEqual(diff.mismatched, ['канал session:kill: в матрице handle, в коде on', 'требование FR-13001: в матрице фича 99-other, в коде 13-file-search']);
  });

  it('--write-missing: новое добавляется с владельцем «?», матрица остаётся красной, пока владелец не назначен; файл читается обратно', () => {
    using ai = makeRepo({ ...AI, 'src/main/new.ts': "ipcMain.on('fresh:one', () => 1);\n" });
    using own = makeRepo(repoWith([]));
    const file = path.join(own.root, 'matrix.json');
    const m = matrix();
    writeMatrix(file, m);
    const reread = loadMatrix(own.root, []) ?? undefined;
    assert.equal(reread, undefined, 'файл лежит не по пути parity/matrix.json');
    const added = addMissingRows(file, m, extractSource(ai.root));
    assert.equal(added, 1);
    const last = m.rows[m.rows.length - 1];
    assert.deepEqual([last?.id, last?.type, last?.owner], ['fresh:one', 'on', '?']);
    assert.match(validate(m), /владелец «\?»/);
    assert.equal(addMissingRows(file, m, extractSource(ai.root)), 0, 'повторно ничего не добавляется');
    const raw = readFileSync(file, 'utf8');
    assert.ok(raw.split('\n').filter((l) => l.includes('"fresh:one"')).length === 1, 'одна строка - одна запись');
  });

  it('сводка: по видам, статусам, владельцам и задачам', () => {
    const rows = ROWS.map((r, i) => (i === 0 ? { ...r, status: 'parity' as const } : r));
    const s = summarize(matrix(rows));
    assert.equal(s.total, ROWS.length);
    assert.equal(s.byKind.requirement, 3);
    assert.equal(s.byStatus.parity, 1);
    assert.equal(s.byOwner.get('trackers')?.requirement, 2);
    assert.deepEqual(s.byTask.get('M-13'), { rows: 5, done: 1 });
  });
});

describe('матрица паритета самого репозитория', () => {
  it('проходит проверки: владельцы из каталога, задачи, статусы; сводка не пустая', () => {
    const { problems } = checkRepo(REPO_ROOT);
    assert.deepEqual(problems, []);
    const m = loadMatrix(REPO_ROOT, []);
    assert.ok(m);
    const s = summarize(m);
    assert.ok((s.byKind.requirement ?? 0) >= 202);
    assert.ok((s.byKind.channel ?? 0) >= 78);
    assert.ok(s.total >= 338);
    assert.ok(!m.rows.some((r) => r.owner === '?'), 'строк без владельца нет');
  });

  it('каждый запланированный плагин владеет хотя бы одной строкой, кроме стендовых', () => {
    const { catalog } = checkRepo(REPO_ROOT);
    const m = loadMatrix(REPO_ROOT, []);
    assert.ok(m);
    const owners = new Set(m.rows.map((r) => r.owner));
    const standalone = new Set(['agent-shell', 'pin-lock', 'trackers-http']);
    for (const id of catalog.categories.flatMap((c) => c.planned.map((p) => p.id))) {
      if (!standalone.has(id)) assert.ok(owners.has(id), `у плагина ${id} нет ни одной строки матрицы`);
    }
  });

  it('страница сводки строится и совпадает с матрицей', () => {
    const page = generatePages(REPO_ROOT).get('parity.md') ?? '';
    const m = loadMatrix(REPO_ROOT, []);
    assert.ok(m);
    const s = summarize(m);
    const done = (s.byStatus.parity ?? 0) + (s.byStatus.allowlist ?? 0);
    assert.ok(page.includes(`**Готово ${done} из ${s.total}**`), 'итог на странице совпадает с матрицей');
    assert.ok(page.includes(`| Требования | ${s.byKind.requirement ?? 0} |`));
  });

  it('на настоящем ai-cyborg на якорном коммите матрица сходится с кодом', { skip: !existsSync(path.join(REPO_ROOT, '..', 'ai-cyborg-src', 'src')) && 'нет клона ../ai-cyborg-src' }, () => {
    const dir = process.env.AI_CYBORG_DIR ?? path.join(REPO_ROOT, '..', 'ai-cyborg-src');
    const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const m = loadMatrix(REPO_ROOT, []);
    assert.ok(m);
    if (head !== m.source.commit) {
      // Клон ушёл вперёд: расхождения - ожидаемые новости, а не ошибка теста; их видно командой npm run parity.
      return;
    }
    assert.deepEqual(compareMatrix(m, extractSource(dir)), { missing: [], stale: [], mismatched: [] });
  });
});
