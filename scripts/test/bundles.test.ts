import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadBundles, resolveBundle } from '../lib/bundles.ts';
import { checkRepo } from '../lib/check-all.ts';
import { loadCatalog } from '../lib/catalog.ts';
import type { Problem } from '../lib/util.ts';
import { makeRepo, repoWith } from './helpers.ts';

const text = (problems: Problem[]): string => problems.map((p) => `${p.where}: ${p.message}`).join('\n');

const bundle = (overrides: object = {}): object => ({ format: 1, id: 'work', version: '1.0.0', title: 'Работа', description: 'Набор', plugins: ['projects'], ...overrides });

// projects даёт cyborg.projects, files его требует, git - необязательно использует.
const PLUGINS = [
  { category: 'code', id: 'projects', manifest: { provides: { 'cyborg.projects': '1.2' } } },
  { category: 'code', id: 'files', manifest: { requires: { 'cyborg.projects': '^1' }, optional: { 'cyborg.git': '1' } } },
  { category: 'code', id: 'git', manifest: { provides: { 'cyborg.git': { version: '1.0' } } } },
];

describe('бандлы', () => {
  it('годный бандл читается и собирается без замечаний', () => {
    using repo = makeRepo(repoWith(PLUGINS, { 'bundles/work.json': bundle({ plugins: ['projects', 'files', 'git'] }) }));
    const { problems, bundles, notes } = checkRepo(repo.root);
    assert.deepEqual(problems, []);
    assert.deepEqual(notes, []);
    assert.equal(bundles.bundles[0]?.id, 'work');
  });

  it('extends приносит плагины расширяемого бандла первыми, без повторов', () => {
    using repo = makeRepo(
      repoWith(PLUGINS, {
        'bundles/base.json': bundle({ id: 'base', plugins: ['projects'] }),
        'bundles/work.json': bundle({ extends: ['base'], plugins: ['files', 'projects'] }),
      }),
    );
    const problems: Problem[] = [];
    const catalog = loadCatalog(repo.root);
    const { bundles } = loadBundles(repo.root, catalog, problems);
    assert.deepEqual(resolveBundle('work', bundles, problems), ['projects', 'files']);
    assert.deepEqual(problems, []);
  });

  it('цикл extends и бандл, которого нет, - замечания', () => {
    using repo = makeRepo(
      repoWith(PLUGINS, {
        'bundles/a.json': bundle({ id: 'a', extends: ['b'], plugins: ['projects'] }),
        'bundles/b.json': bundle({ id: 'b', extends: ['a', 'нет'], plugins: ['projects'] }),
      }),
    );
    const problems: Problem[] = [];
    const { bundles } = loadBundles(repo.root, loadCatalog(repo.root), problems);
    resolveBundle('a', bundles, problems);
    assert.match(text(problems), /цикл в extends: a -> b -> a/);
    assert.match(text(problems), /extends называет бандл нет, которого нет/);
  });

  it('плагина нет в каталоге - замечание', () => {
    using repo = makeRepo(repoWith(PLUGINS, { 'bundles/work.json': bundle({ plugins: ['призрак'] }) }));
    assert.match(text(checkRepo(repo.root).problems), /плагина призрак нет в каталоге/);
  });

  it('requires без поставщика в бандле - замечание, с поставщиком - нет', () => {
    using repo = makeRepo(repoWith(PLUGINS, { 'bundles/work.json': bundle({ plugins: ['files'] }) }));
    assert.match(text(checkRepo(repo.root).problems), /плагин files требует cyborg\.projects \^1, поставщика в бандле нет/);
  });

  it('поставщик не той мажорной версии не считается', () => {
    const plugins = [
      { category: 'code', id: 'projects', manifest: { provides: { 'cyborg.projects': '2.0' } } },
      { category: 'code', id: 'files', manifest: { requires: { 'cyborg.projects': '^1' } } },
    ];
    using repo = makeRepo(repoWith(plugins, { 'bundles/work.json': bundle({ plugins: ['projects', 'files'] }) }));
    assert.match(text(checkRepo(repo.root).problems), /поставщика в бандле нет/);
  });

  it('два поставщика одного requires - неоднозначность', () => {
    const plugins = [
      { category: 'code', id: 'a', manifest: { provides: { 'x.y': '1.0' } } },
      { category: 'code', id: 'b', manifest: { provides: { 'x.y': '1.1' } } },
      { category: 'code', id: 'c', manifest: { requires: { 'x.y': '1' } } },
    ];
    using repo = makeRepo(repoWith(plugins, { 'bundles/work.json': bundle({ plugins: ['a', 'b', 'c'] }) }));
    assert.match(text(checkRepo(repo.root).problems), /даёт несколько плагинов \(a, b\)/);
  });

  it('optional без поставщика - заметка, а не замечание', () => {
    using repo = makeRepo(repoWith(PLUGINS, { 'bundles/work.json': bundle({ plugins: ['projects', 'files'] }) }));
    const { problems, notes } = checkRepo(repo.root);
    assert.deepEqual(problems, []);
    assert.match(notes.join('\n'), /files: необязательный cyborg\.git 1 без поставщика/);
  });

  it('поля бандла: формат, id по имени файла, версия, неизвестное поле', () => {
    using repo = makeRepo(repoWith(PLUGINS, { 'bundles/work.json': bundle({ format: 2, id: 'другой', version: '1', цвет: 'красный' }) }));
    const t = text(checkRepo(repo.root).problems);
    assert.match(t, /format - 1/);
    assert.match(t, /должен совпадать с именем файла/);
    assert.match(t, /version - x\.y\.z/);
    assert.match(t, /неизвестное поле цвет/);
  });

  it('planned.json: плагин, которого нет нигде, и бандл, который уже готов, - замечания', () => {
    const planned = [
      { id: 'work', title: 'Работа', summary: 'Набор', plugins: ['projects'] },
      { id: 'later', title: 'Позже', summary: 'Набор', plugins: ['git', 'нигде'] },
    ];
    using repo = makeRepo(repoWith(PLUGINS, { 'bundles/work.json': bundle(), 'bundles/planned.json': planned as unknown as object }));
    const t = text(checkRepo(repo.root).problems);
    assert.match(t, /бандл work уже есть: уберите его из planned.json/);
    assert.match(t, /в бандле later плагин нигде, которого нет/);
  });

  it('планируемый бандл может ссылаться на запланированный плагин', () => {
    const planned = [{ id: 'later', title: 'Позже', summary: 'Набор', plugins: ['search'] }];
    using repo = makeRepo(repoWith([], { 'bundles/planned.json': planned as unknown as object }));
    assert.deepEqual(checkRepo(repo.root).problems, []);
  });
});
