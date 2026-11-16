import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCatalog, parseCard } from '../lib/catalog.ts';
import type { Problem } from '../lib/util.ts';
import { CARD, CATEGORIES, makeRepo, repoWith } from './helpers.ts';

const messages = (problems: Problem[]): string[] => problems.map((p) => `${p.where}: ${p.message}`);

describe('каталог plugins/<категория>/<id>', () => {
  it('годный плагин читается с карточкой, категорией и путём', () => {
    using repo = makeRepo(repoWith([{ category: 'code', id: 'files' }]));
    const catalog = loadCatalog(repo.root);
    assert.deepEqual(catalog.problems, []);
    const [p] = catalog.plugins;
    assert.equal(p?.id, 'files');
    assert.equal(p?.category, 'code');
    assert.equal(p?.rel, 'plugins/code/files');
    assert.deepEqual(p?.card?.tags, ['а', 'б']);
    assert.deepEqual(p?.card?.needs, ['git']);
    assert.equal(p?.card?.status, 'beta');
  });

  it('id в манифесте обязан совпадать с именем каталога', () => {
    using repo = makeRepo(repoWith([{ category: 'code', id: 'files', manifest: { id: 'other' } }]));
    assert.match(messages(loadCatalog(repo.root).problems).join('\n'), /не совпадает с именем каталога/);
  });

  it('id занят ядром - отказ', () => {
    using repo = makeRepo(repoWith([{ category: 'code', id: 'cyborg' }]));
    assert.match(messages(loadCatalog(repo.root).problems).join('\n'), /занят ядром/);
  });

  it('каталог категории, не объявленной в categories.json, - замечание', () => {
    using repo = makeRepo(repoWith([{ category: 'tools', id: 'x' }]));
    assert.match(messages(loadCatalog(repo.root).problems).join('\n'), /plugins\/tools: каталог не объявлен/);
  });

  it('один id в двух категориях - замечание про общий идентификатор', () => {
    using repo = makeRepo(repoWith([{ category: 'code', id: 'dup' }, { category: 'sessions', id: 'dup' }]));
    assert.match(messages(loadCatalog(repo.root).problems).join('\n'), /id dup уже занят/);
  });

  it('плагин, который есть в каталоге и в planned, - замечание', () => {
    using repo = makeRepo(repoWith([{ category: 'code', id: 'search' }]));
    assert.match(messages(loadCatalog(repo.root).problems).join('\n'), /плагин search уже в каталоге: уберите его из planned/);
  });

  it('один плагин в planned двух категорий - замечание', () => {
    const categories = [
      { id: 'code', title: 'Код', summary: 'к', planned: [{ id: 'x', summary: 'x', from: 'ai-cyborg' }] },
      { id: 'sessions', title: 'Сессии', summary: 'с', planned: [{ id: 'x', summary: 'x', from: 'ai-cyborg' }] },
    ];
    using repo = makeRepo(repoWith([], {}, categories));
    assert.match(messages(loadCatalog(repo.root).problems).join('\n'), /запланированный плагин x назван в категориях/);
  });

  it('каталог без manifest.json и файл вместо каталога - замечания', () => {
    using repo = makeRepo({ ...repoWith([]), 'plugins/code/empty/note.txt': 'x', 'plugins/code/file.txt': 'x' });
    const text = messages(loadCatalog(repo.root).problems).join('\n');
    assert.match(text, /plugins\/code\/empty: нет manifest.json/);
    assert.match(text, /plugins\/code\/file.txt: в каталоге категории только каталоги/);
  });

  it('нет README.md - замечание', () => {
    using repo = makeRepo({ ...repoWith([]), 'plugins/code/files/manifest.json': { id: 'files', version: '1.0.0', engines: { cyborg: '^1' } } });
    assert.match(messages(loadCatalog(repo.root).problems).join('\n'), /нет README.md с карточкой/);
  });

  it('битый categories.json не роняет проверку', () => {
    using repo = makeRepo({ 'plugins/categories.json': '{ не json' });
    const catalog = loadCatalog(repo.root);
    assert.match(messages(catalog.problems).join('\n'), /не читается как JSON/);
    assert.deepEqual(catalog.plugins, []);
  });

  it('версия плагина и engines.cyborg обязательны', () => {
    using repo = makeRepo(repoWith([{ category: 'code', id: 'files', manifest: { version: '1.0', engines: {} } }]));
    const text = messages(loadCatalog(repo.root).problems).join('\n');
    assert.match(text, /version - x\.y\.z/);
    assert.match(text, /нет engines\.cyborg/);
  });

  it('пустой список категорий - пустой каталог без замечаний', () => {
    using repo = makeRepo({ 'plugins/categories.json': CATEGORIES });
    const catalog = loadCatalog(repo.root);
    assert.deepEqual(catalog.problems, []);
    assert.equal(catalog.categories.length, 2);
  });
});

describe('карточка README.md', () => {
  const parse = (text: string): { card: ReturnType<typeof parseCard>; problems: string[] } => {
    const problems: Problem[] = [];
    const card = parseCard(text, 'README.md', problems);
    return { card, problems: messages(problems) };
  };

  it('кавычки и пустые списки', () => {
    const { card, problems } = parse('---\ntitle: "Файлы: дерево"\nsummary: Дерево\nstatus: stable\ntags: []\n---\n\nТекст\n');
    assert.deepEqual(problems, []);
    assert.equal(card?.title, 'Файлы: дерево');
    assert.deepEqual(card?.tags, []);
    assert.deepEqual(card?.needs, []);
  });

  it('нет шапки', () => {
    assert.match(parse('## Просто текст').problems.join('\n'), /нет карточки/);
  });

  it('status вне перечня, неизвестное поле, нет title и summary', () => {
    const text = parse('---\nstatus: готово\nauthor: я\n---\n').problems.join('\n');
    assert.match(text, /status - одно из/);
    assert.match(text, /неизвестное поле author/);
    assert.match(text, /нет title/);
    assert.match(text, /нет summary/);
  });

  it('заголовок первого уровня в тексте - замечание, а в блоке кода - нет', () => {
    assert.match(parse(`${CARD}\n# Лишний\n`).problems.join('\n'), /заголовок первого уровня/);
    assert.deepEqual(parse(`${CARD}\n\`\`\`sh\n# комментарий оболочки\n\`\`\`\n`).problems, []);
  });

  it('список не в квадратных скобках - замечание', () => {
    assert.match(parse('---\ntitle: А\nsummary: Б\nstatus: beta\ntags: а, б\n---\n').problems.join('\n'), /список в виде/);
  });
});
