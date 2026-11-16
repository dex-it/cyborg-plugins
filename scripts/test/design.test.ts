import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkRepo } from '../lib/check-all.ts';
import { loadCatalog } from '../lib/catalog.ts';
import { findGaps, loadDesign, readHarnessContracts } from '../lib/design.ts';
import { generatePages } from '../lib/gen-catalog.ts';
import { REPO_ROOT } from '../lib/util.ts';
import type { Problem } from '../lib/util.ts';
import { makeRepo, repoWith } from './helpers.ts';
import type { Files } from './helpers.ts';

const text = (problems: Problem[]): string => problems.map((p) => `${p.where}: ${p.message}`).join('\n');

// Две запланированные категории из helpers: code (planned: search) и sessions (planned: нет). Для опыта нужны свои.
const CATEGORIES = [
  { id: 'code', title: 'Код', summary: 'к', planned: [{ id: 'projects', summary: 'п', from: 'ai-cyborg' }, { id: 'files', summary: 'ф', from: 'ai-cyborg' }] },
  { id: 'sessions', title: 'Сессии', summary: 'с', planned: [{ id: 'sessions', summary: 'с', from: 'ai-cyborg' }] },
];
const DESIGN = {
  contracts: { 'cyborg.projects': { members: ['list'] }, 'cyborg.sessions': { members: ['onChange', 'create'] } },
  plugins: {
    projects: { provides: { 'cyborg.projects': '1.0' } },
    files: { requires: { 'cyborg.projects': '^1' }, optional: { 'cyborg.sessions': '^1' } },
    sessions: { provides: { 'cyborg.sessions': '1.1' }, requires: { 'cyborg.projects': '^1' } },
  },
};
const PLANNED = [{ id: 'work', title: 'Работа', summary: 'р', plugins: ['projects', 'files', 'sessions'] }];

const repo = (design: object = DESIGN, extra: Files = {}, plugins: Parameters<typeof repoWith>[0] = []): Files =>
  repoWith(plugins, { 'plugins/planned-contracts.json': design, 'bundles/planned.json': PLANNED as unknown as object, ...extra }, CATEGORIES);

describe('проектная модель контрактов', () => {
  it('согласованная модель и замкнутый запланированный бандл - без замечаний', () => {
    using r = makeRepo(repo());
    assert.deepEqual(checkRepo(r.root).problems, []);
  });

  it('у запланированного плагина нет описания - замечание', () => {
    const design = { ...DESIGN, plugins: { projects: DESIGN.plugins.projects, sessions: DESIGN.plugins.sessions } };
    using r = makeRepo(repo(design));
    assert.match(text(checkRepo(r.root).problems), /у запланированного плагина files нет описания контрактов/);
  });

  it('описан плагин, которого нигде нет; описан готовый плагин; контракт без пользователей', () => {
    const design = { contracts: { ...DESIGN.contracts, 'cyborg.ghost': { members: ['a'] } }, plugins: { ...DESIGN.plugins, призрак: {}, search: {} } };
    using r = makeRepo(repo(design, {}, [{ category: 'code', id: 'search' }]));
    const t = text(checkRepo(r.root).problems);
    assert.match(t, /описан плагин призрак, которого нет/);
    assert.match(t, /плагин search уже в каталоге: уберите его описание/);
    assert.match(t, /contracts\.cyborg\.ghost: контракт не встречается ни у одного плагина/);
  });

  it('запланированный бандл без поставщика requires - замечание; поставщик не той версии не считается', () => {
    const noProjects = [{ id: 'work', title: 'Работа', summary: 'р', plugins: ['files', 'sessions'] }];
    using a = makeRepo(repo(DESIGN, { 'bundles/planned.json': noProjects as unknown as object }));
    assert.match(text(checkRepo(a.root).problems), /бандл work: плагин files требует cyborg\.projects \^1, поставщика в бандле нет/);
    const v2 = { ...DESIGN, plugins: { ...DESIGN.plugins, projects: { provides: { 'cyborg.projects': '2.0' } } } };
    using b = makeRepo(repo(v2));
    assert.match(text(checkRepo(b.root).problems), /поставщика в бандле нет/);
  });

  it('extends запланированного бандла раскрывается; несуществующий или циклический - замечание', () => {
    const base = { id: 'base', title: 'База', summary: 'б', plugins: ['projects'] };
    const top = { id: 'top', title: 'Верх', summary: 'в', extends: ['base'], plugins: ['files'] };
    using ok = makeRepo(repo(DESIGN, { 'bundles/planned.json': [base, top] as unknown as object }));
    assert.deepEqual(checkRepo(ok.root).problems, []);
    const ghost = { ...top, extends: ['нет'] };
    using bad = makeRepo(repo(DESIGN, { 'bundles/planned.json': [base, ghost] as unknown as object }));
    assert.match(text(checkRepo(bad.root).problems), /расширяет нет, которого нет/);
    const a = { id: 'a', title: 'А', summary: 'а', extends: ['b'], plugins: ['projects'] };
    const b = { id: 'b', title: 'Б', summary: 'б', extends: ['a'], plugins: ['projects'] };
    using loop = makeRepo(repo(DESIGN, { 'bundles/planned.json': [a, b] as unknown as object }));
    assert.match(text(checkRepo(loop.root).problems), /цикл в extends/);
  });

  it('поля модели: неизвестное поле, версия поставщика, диапазон', () => {
    const design = { лишнее: 1, contracts: {}, plugins: { projects: { provides: { 'cyborg.projects': '1' }, requires: { 'cyborg.x': 'любая' }, лишнее: {} }, files: {}, sessions: {} } };
    using r = makeRepo(repo(design));
    const problems: Problem[] = [];
    loadDesign(r.root, problems);
    const t = text(problems);
    assert.match(t, /неизвестное поле лишнее/);
    assert.match(t, /версия поставщика - x\.y, а не «1»/);
    assert.match(t, /диапазон вида/);
  });

  it('настоящий плагин главнее модели: карта контрактов берёт его манифест', () => {
    const design = { contracts: DESIGN.contracts, plugins: { files: DESIGN.plugins.files, sessions: DESIGN.plugins.sessions } };
    const cats = [{ id: 'code', title: 'Код', summary: 'к', planned: [{ id: 'files', summary: 'ф', from: 'ai-cyborg' }] }, { id: 'sessions', title: 'Сессии', summary: 'с', planned: [{ id: 'sessions', summary: 'с', from: 'ai-cyborg' }] }];
    const files = repoWith([{ category: 'code', id: 'projects', manifest: { provides: { 'cyborg.projects': '1.3' } } }], { 'plugins/planned-contracts.json': design, 'bundles/planned.json': [{ id: 'work', title: 'Р', summary: 'р', plugins: ['projects', 'files', 'sessions'] }] as unknown as object }, cats);
    using r = makeRepo(files);
    assert.deepEqual(checkRepo(r.root).problems, []);
    const page = generatePages(r.root).get('contracts.md') ?? '';
    assert.match(page, /\| `cyborg\.projects` \| \[`projects`\]\(\/catalog\/code\/projects\/\) \|/);
    assert.match(page, /Готовых плагинов в карте 1, по проектной модели 2/);
  });
});

describe('пробелы относительно типов ядра', () => {
  const HARNESS: Files = {
    'contracts/index.ts': `import type { Git } from './git.ts';
export interface Contracts {
  'cyborg.git': { 1: Git };
  'cyborg.sessions': { 1: Sessions };
  /** Демо вне cyborg. */
  'demo.chat': { 1: Chat };
}
export interface Sessions {
  onChange(listener: () => void): void;
  reveal?(id: string): Promise<void>;
}
export interface Chat {
  say(): void;
}
`,
    'contracts/git.ts': `/** Git. */
export interface Git {
  /** Статус. */
  status(repo: string): Promise<null>;
  onChange(repo: string, listener: () => void): void;
  readonly root: string;
}
`,
  };

  it('читает Contracts и члены интерфейсов', () => {
    using h = makeRepo(HARNESS);
    const harness = readHarnessContracts(path.join(h.root, 'contracts'));
    assert.ok(harness);
    assert.deepEqual([...harness.contracts.keys()].sort(), ['cyborg.git', 'cyborg.sessions', 'demo.chat']);
    assert.deepEqual([...(harness.contracts.get('cyborg.git') ?? [])].sort(), ['onChange', 'root', 'status']);
    assert.deepEqual([...(harness.contracts.get('cyborg.sessions') ?? [])].sort(), ['onChange', 'reveal']);
  });

  it('нет каталога или нет Contracts - undefined', () => {
    using h = makeRepo({ 'contracts/other.ts': 'export const x = 1;' });
    assert.equal(readHarnessContracts(path.join(h.root, 'contracts')), undefined);
    assert.equal(readHarnessContracts(path.join(h.root, 'нет')), undefined);
  });

  it('находит отсутствующие контракты и члены; не-cyborg контракты не считаются', () => {
    using h = makeRepo(HARNESS);
    using r = makeRepo(
      repo(
        {
          contracts: { 'cyborg.projects': { members: ['list'] }, 'cyborg.sessions': { members: ['onChange', 'create', 'labels'] }, 'cyborg.git': { members: ['status', 'branch'] } },
          plugins: {
            projects: { provides: { 'cyborg.projects': '1.0', 'demo.x': '1.0' } },
            files: { requires: { 'cyborg.projects': '^1' }, optional: { 'cyborg.git': '^1' } },
            sessions: { provides: { 'cyborg.sessions': '1.1' }, requires: { 'cyborg.projects': '^1' } },
          },
        },
        { 'bundles/planned.json': [] as unknown as object },
      ),
    );
    const harness = readHarnessContracts(path.join(h.root, 'contracts'));
    assert.ok(harness);
    const { design } = checkRepo(r.root);
    const gaps = findGaps(design, loadCatalog(r.root), harness);
    assert.deepEqual(
      gaps.map((g) => [g.contract, g.kind, g.missing.join(',')]),
      [
        ['cyborg.git', 'members', 'branch'],
        ['cyborg.projects', 'absent', 'list'],
        ['cyborg.sessions', 'members', 'create,labels'],
      ],
    );
    assert.deepEqual(gaps.find((g) => g.contract === 'cyborg.projects')?.users, ['files', 'projects', 'sessions']);
  });

  it('модель самого репозитория замкнута и покрывает все запланированные плагины', () => {
    const { problems, design, catalog } = checkRepo(REPO_ROOT);
    assert.deepEqual(problems, []);
    const planned = catalog.categories.flatMap((c) => c.planned.map((p) => p.id));
    for (const id of planned) assert.ok(design.plugins[id], `нет описания ${id}`);
  });
});
