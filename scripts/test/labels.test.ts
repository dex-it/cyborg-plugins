import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkRepo } from '../lib/check-all.ts';
import { loadLabels, planSync } from '../lib/labels.ts';
import type { Label } from '../lib/labels.ts';
import { REPO_ROOT } from '../lib/util.ts';
import type { Problem } from '../lib/util.ts';
import { makeRepo, repoWith } from './helpers.ts';

const text = (problems: Problem[]): string => problems.map((p) => `${p.where}: ${p.message}`).join('\n');
const label = (name: string, color = 'ededed', description = 'д'): Label => ({ name, color, description });
const LABELS = [label('category: code'), label('category: sessions')];

describe('метки: .github/labels.json', () => {
  it('годный файл читается, цвет приводится к нижнему регистру', () => {
    using repo = makeRepo({ '.github/labels.json': [{ name: 'bug', color: 'D73A4A', description: 'Сломано' }] });
    const problems: Problem[] = [];
    assert.deepEqual(loadLabels(repo.root, problems), [{ name: 'bug', color: 'd73a4a', description: 'Сломано' }]);
    assert.deepEqual(problems, []);
  });

  it('замечания: повтор без учёта регистра, цвет, длинное описание, лишнее поле, не объект', () => {
    using repo = makeRepo({
      '.github/labels.json': [
        { name: 'Bug', color: 'ffffff', description: 'a' },
        { name: 'bug', color: 'ffffff', description: 'a' },
        { name: 'x', color: '#fff', description: 'a' },
        { name: 'y', color: 'ffffff', description: 'я'.repeat(101) },
        { name: 'z', color: 'ffffff', description: 'a', лишнее: 1 },
        'строка',
      ],
    });
    const problems: Problem[] = [];
    loadLabels(repo.root, problems);
    const t = text(problems);
    assert.match(t, /повторена/);
    assert.match(t, /шесть шестнадцатеричных цифр/);
    assert.match(t, /длиннее 100 знаков/);
    assert.match(t, /допустимы только name, color и description/);
    assert.match(t, /ожидался объект/);
  });

  it('каждой категории - своя метка category:, лишних меток category: нет', () => {
    using ok = makeRepo(repoWith([], { '.github/labels.json': LABELS as unknown as object }));
    assert.deepEqual(checkRepo(ok.root).problems, []);
    using bad = makeRepo(repoWith([], { '.github/labels.json': [label('category: code'), label('category: чужая')] as unknown as object }));
    const t = text(checkRepo(bad.root).problems);
    assert.match(t, /нет метки «category: sessions»/);
    assert.match(t, /метка «category: чужая» без категории чужая/);
  });

  it('репозиторий без labels.json проверяется без замечаний про метки', () => {
    using repo = makeRepo(repoWith([]));
    assert.deepEqual(checkRepo(repo.root).problems, []);
  });

  it('labels.json самого репозитория годен и покрывает категории', () => {
    const problems: Problem[] = [];
    const labels = loadLabels(REPO_ROOT, problems);
    assert.deepEqual(problems, []);
    assert.ok(labels.length > 50);
    assert.deepEqual(checkRepo(REPO_ROOT).problems, []);
    // Метки про ядро в репозиторий плагинов не переносятся.
    for (const n of ['component: core', 'component: electron-adapter', 'type: pilot']) assert.ok(!labels.some((l) => l.name === n), n);
    assert.ok(readFileSync(path.join(REPO_ROOT, '.github', 'labels.json'), 'utf8').endsWith('\n'));
  });
});

describe('sync-labels: план', () => {
  it('создать, обновить (цвет или описание), лишние; регистр имени не различает', () => {
    const desired = [label('a'), label('b', 'ff0000', 'новое'), label('c', 'ABCDEF'), label('D')];
    const existing = [label('a'), label('b', '00ff00', 'старое'), label('c', 'abcdef'), label('d'), label('лишняя')];
    const plan = planSync(desired, existing);
    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.update.map((l) => l.name), ['b', 'D']);
    assert.deepEqual(plan.extra, ['лишняя']);
  });

  it('совпавший набор - пустой план', () => {
    const l = [label('a'), label('b')];
    assert.deepEqual(planSync(l, l), { create: [], update: [], extra: [] });
  });

  it('новая метка попадает в create', () => {
    assert.deepEqual(planSync([label('a'), label('новая')], [label('a')]).create.map((l) => l.name), ['новая']);
  });
});
