// Документы и данные репозитория не расходятся: страницы называют то же, что лежит в plugins/, bundles/ и parity/.
// Ловит дрейф, который тихо накапливается: плагин добавили в каталог, а в карте переноса забыли; якорь сдвинули, а решение не обновили.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkRepo } from '../lib/check-all.ts';
import { loadMatrix } from '../lib/parity.ts';
import { REPO_ROOT } from '../lib/util.ts';

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const GUIDE = path.join(REPO_ROOT, 'docs', 'guide');

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? pages(p) : /\.mdx?$/.test(n) ? [p] : [];
  });
}

describe('документы и данные согласованы', () => {
  it('карта переноса называет каждый запланированный и каждый готовый плагин', () => {
    const roadmap = read('docs/guide/development/roadmap.md');
    const { catalog } = checkRepo(REPO_ROOT);
    const ids = [...catalog.plugins.map((p) => p.id), ...catalog.categories.flatMap((c) => c.planned.map((p) => p.id))];
    for (const id of ids) assert.ok(roadmap.includes(`\`${id}\``), `в карте переноса нет плагина ${id}`);
  });

  it('README называет каждую категорию каталога', () => {
    const readme = read('README.md');
    const { catalog } = checkRepo(REPO_ROOT);
    for (const c of catalog.categories) assert.ok(readme.includes(`\`${c.id}\``), `в README нет категории ${c.id}`);
  });

  it('решения называют якорный коммит матрицы паритета', () => {
    const matrix = loadMatrix(REPO_ROOT, []);
    assert.ok(matrix);
    const decisions = read('docs/guide/development/decisions.md');
    assert.ok(decisions.includes(matrix.source.commit.slice(0, 7)), `решения не называют якорь ${matrix.source.commit.slice(0, 7)}: после сдвига якоря обновите решение 10`);
    assert.ok(decisions.includes(matrix.source.date), 'решения не называют дату якоря');
  });

  it('карта переноса называет те же числа, что матрица паритета', () => {
    const matrix = loadMatrix(REPO_ROOT, []);
    assert.ok(matrix);
    const count = (kind: string): number => matrix.rows.filter((r) => r.kind === kind).length;
    const roadmap = read('docs/guide/development/roadmap.md');
    assert.ok(roadmap.includes(`**${matrix.rows.length} строк**`), `в карте нет «${matrix.rows.length} строк»`);
    for (const [kind, word] of [['requirement', 'требования'], ['channel', 'каналов IPC'], ['event', 'событий окну'], ['dialog', 'диалогов'], ['data', 'файлов данных']] as const) {
      assert.ok(roadmap.includes(`${count(kind)} ${word}`), `в карте не совпало число: ${count(kind)} ${word}`);
    }
  });

  it('страница «Бандлы» называет каждый запланированный бандл', () => {
    const { bundles } = checkRepo(REPO_ROOT);
    const page = read('docs/guide/bundles/index.md');
    for (const b of bundles.planned) assert.ok(page.includes(`\`${b.id}\``), `страница «Бандлы» не называет бандл ${b.id}`);
  });

  it('ссылки на страницы сайта внутри docs/guide указывают на существующие страницы', () => {
    const slugs = new Set<string>();
    for (const file of pages(GUIDE)) {
      const rel = path.relative(GUIDE, file).split(path.sep).join('/').replace(/\.mdx?$/, '').replace(/\/index$/, '').toLowerCase();
      slugs.add(rel === 'index' ? '' : rel);
    }
    const broken: string[] = [];
    for (const file of pages(GUIDE)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\]\((\/[a-z0-9\-/]*)(?:#[^)]*)?\)/g)) {
        const target = (m[1] ?? '').replace(/^\/|\/$/g, '');
        if (!slugs.has(target)) broken.push(`${path.relative(GUIDE, file)} -> ${m[1] ?? ''}`);
      }
    }
    assert.deepEqual(broken, []);
  });
});
