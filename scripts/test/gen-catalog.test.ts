import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CATALOG_DIR, diffPages, generatePages, writePages } from '../lib/gen-catalog.ts';
import { REPO_ROOT } from '../lib/util.ts';
import { makeRepo, repoWith } from './helpers.ts';

const manifest = { provides: { 'cyborg.files': '1.0' }, requires: { 'cyborg.projects': '^1' }, commands: { 'files.open': {} }, permissions: { 'fs.read': ['workspace'] } };
const PLUGINS = [
  { category: 'code', id: 'files', manifest },
  { category: 'code', id: 'projects', manifest: { provides: { 'cyborg.projects': '1.0' } } },
];
const BUNDLE = { format: 1, id: 'work', version: '1.0.0', title: 'Работа', description: 'Набор для работы', plugins: ['projects', 'files'] };

describe('страницы каталога', () => {
  it('на каждую категорию и плагин - страница, плюс главная и бандлы', () => {
    using repo = makeRepo(repoWith(PLUGINS, { 'bundles/work.json': BUNDLE }));
    const pages = generatePages(repo.root);
    assert.deepEqual([...pages.keys()].sort(), ['bundles.md', 'code/files.md', 'code/index.md', 'code/projects.md', 'index.md', 'sessions/index.md']);
  });

  it('страница плагина: факты из манифеста и текст карточки', () => {
    using repo = makeRepo(repoWith(PLUGINS));
    const page = generatePages(repo.root).get('code/files.md') ?? '';
    assert.match(page, /^---\ntitle: "Плагин"\ndescription: "Делает дело"/);
    assert.match(page, /\| Даёт \| `cyborg\.files 1\.0` \|/);
    assert.match(page, /\| Требует \| `cyborg\.projects \^1` \|/);
    assert.match(page, /\| Команды \| `files\.open` \|/);
    assert.match(page, /\| Права в манифесте \| `fs\.read` \|/);
    assert.match(page, /\| Нужны на машине \| `git` \|/);
    assert.match(page, /## Что делает\n\nТекст\./);
    assert.match(page, /tree\/master\/plugins\/code\/files/);
  });

  it('страница категории: готовые и запланированные; пустая категория говорит об этом', () => {
    using repo = makeRepo(repoWith(PLUGINS));
    const pages = generatePages(repo.root);
    assert.match(pages.get('code/index.md') ?? '', /\| \[Плагин\]\(\/catalog\/code\/files\/\)/);
    assert.match(pages.get('code/index.md') ?? '', /## Запланированы\n\n[^]*\| `search` \|/);
    assert.match(pages.get('sessions/index.md') ?? '', /Пока пусто/);
  });

  it('страница бандлов: состав со ссылками на плагины', () => {
    using repo = makeRepo(repoWith(PLUGINS, { 'bundles/work.json': BUNDLE }));
    const page = generatePages(repo.root).get('bundles.md') ?? '';
    assert.match(page, /### Работа/);
    assert.match(page, /\[`projects`\]\(\/catalog\/code\/projects\/\), \[`files`\]\(\/catalog\/code\/files\/\)/);
    assert.match(page, /npm run bundle -- work/);
  });

  it('diffPages: свежие, устаревшие, недостающие и лишние страницы', () => {
    using repo = makeRepo(repoWith(PLUGINS));
    const pages = generatePages(repo.root);
    assert.deepEqual(diffPages(repo.root, pages), [...pages.keys()].map((k) => `нет страницы ${k}`));
    writePages(repo.root, pages);
    assert.deepEqual(diffPages(repo.root, pages), []);
    writeFileSync(path.join(repo.root, CATALOG_DIR, 'index.md'), 'правка руками');
    writeFileSync(path.join(repo.root, CATALOG_DIR, 'code', 'лишняя.md'), 'x');
    assert.deepEqual(diffPages(repo.root, pages).sort(), ['лишняя страница code/лишняя.md', 'страница index.md устарела']);
  });

  it('страницы, закоммиченные в самом репозитории, свежие', () => {
    assert.deepEqual(diffPages(REPO_ROOT, generatePages(REPO_ROOT)), []);
    assert.match(readFileSync(path.join(REPO_ROOT, CATALOG_DIR, 'index.md'), 'utf8'), /Страница сгенерирована/);
  });
});
