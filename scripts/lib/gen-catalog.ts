// Страницы каталога для сайта: docs/guide/catalog/. Их никто не пишет руками: источник - карточки README.md плагинов,
// манифесты, plugins/categories.json и bundles/*.json. Свежесть сверяет `npm run check:docs-catalog` (и CI).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkRepo } from './check-all.ts';
import { resolveBundle } from './bundles.ts';
import { effectiveContracts } from './design.ts';
import { providedVersions } from './semver.ts';
import { isRecord } from './util.ts';
import type { Problem } from './util.ts';
import type { Category, PluginEntry } from './catalog.ts';

export const CATALOG_DIR = path.join('docs', 'guide', 'catalog');
const REPO_URL = 'https://github.com/dex-it/cyborg-plugins';
const STATUS_WORDS: Record<string, string> = { experimental: 'экспериментальный', beta: 'бета', stable: 'стабильный' };
const MARK = '<!-- Страница сгенерирована: npm run docs:catalog. Правьте README.md плагина, манифест или plugins/categories.json, а не этот файл. -->';

const q = (text: string): string => JSON.stringify(text);
const code = (items: readonly string[]): string => (items.length > 0 ? items.map((i) => `\`${i}\``).join(', ') : '-');
const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

function front(title: string, description: string, order: number): string {
  return `---\ntitle: ${q(title)}\ndescription: ${q(description)}\nsidebar:\n  order: ${order}\n---\n\n${MARK}\n\n`;
}

function contractList(map: Record<string, unknown> | undefined, provided: boolean): string[] {
  return Object.entries(map ?? {}).map(([name, value]) => {
    const v = provided ? providedVersions(value).join('/') : typeof value === 'string' ? value : '';
    return v === '' ? name : `${name} ${v}`;
  });
}

function commandList(commands: unknown): string[] {
  if (Array.isArray(commands)) return commands.filter((c): c is string => typeof c === 'string');
  return isRecord(commands) ? Object.keys(commands) : [];
}

function pluginPage(p: PluginEntry, category: Category, order: number): string {
  const card = p.card;
  const m = p.manifest;
  const rows: [string, string][] = [
    ['Идентификатор', code([p.id])],
    ['Версия', code([m.version])],
    ['Категория', `[${category.title}](/catalog/${category.id}/)`],
    ['Статус', card ? (STATUS_WORDS[card.status] ?? card.status) : '-'],
    ['Теги', code(card?.tags ?? [])],
    ['Нужны на машине', code(card?.needs ?? [])],
    ['Даёт', code(contractList(m.provides, true))],
    ['Требует', code(contractList(m.requires, false))],
    ['Может использовать', code(contractList(m.optional, false))],
    ['Собирает у всех', code(contractList(m.consumes, false))],
    ['Команды', code(commandList(m.commands))],
    ['Права в манифесте', code(Object.keys(m.permissions ?? {}))],
    ['Исходники', `[${p.rel}](${REPO_URL}/tree/master/${p.rel})`],
  ];
  const table = `| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${cell(v)} |`).join('\n')}\n`;
  return `${front(card?.title ?? p.id, card?.summary ?? '', order)}${table}\n${card?.body ?? ''}`.trimEnd() + '\n';
}

function categoryPage(category: Category, plugins: PluginEntry[], order: number): string {
  let out = front(category.title, category.summary, order);
  out += `${category.summary}\n\n`;
  if (plugins.length > 0) {
    out += '## В каталоге\n\n| Плагин | Что делает | Статус |\n|---|---|---|\n';
    for (const p of plugins) out += `| [${cell(p.card?.title ?? p.id)}](/catalog/${category.id}/${p.id}/) | ${cell(p.card?.summary ?? '')} | ${STATUS_WORDS[p.card?.status ?? ''] ?? '-'} |\n`;
    out += '\n';
  } else {
    out += ':::note[Пока пусто]\nПлагины этой категории ещё не перенесены в репозиторий. Что запланировано - в таблице ниже; свой плагин можно добавить уже сейчас ([как](/authors/new-plugin/)).\n:::\n\n';
  }
  if (category.planned.length > 0) {
    out += '## Запланированы\n\n| Плагин | Что будет делать | Откуда |\n|---|---|---|\n';
    for (const p of category.planned) out += `| \`${p.id}\` | ${cell(p.summary)} | ${cell(p.from)} |\n`;
    out += '\n';
  }
  return out.trimEnd() + '\n';
}

function bundlesPage(root: string): string {
  const { catalog, bundles } = checkRepo(root);
  const problems: Problem[] = [];
  const link = (id: string): string => {
    const p = catalog.plugins.find((x) => x.id === id);
    return p ? `[\`${id}\`](/catalog/${p.category}/${p.id}/)` : `\`${id}\``;
  };
  let out = front('Бандлы', 'Именованные наборы плагинов, которые ставятся пачкой.', 90);
  out += 'Бандл - список плагинов под одним именем: из него собирается поставка для приложения и фрагмент `plugins.enabled`. Как устроен формат и как собрать - в разделе [«Бандлы»](/bundles/).\n\n';
  if (bundles.bundles.length > 0) {
    out += '## Готовые\n\n';
    for (const b of bundles.bundles) {
      const ids = resolveBundle(b.id, bundles.bundles, problems);
      out += `### ${b.title}\n\n${b.description}\n\n`;
      out += `- Идентификатор: \`${b.id}\`, версия \`${b.version}\`\n`;
      if (b.extends.length > 0) out += `- Включает бандлы: ${code(b.extends)}\n`;
      out += `- Плагины (${ids.length}): ${ids.map(link).join(', ')}\n`;
      out += `- Собрать: \`npm run bundle -- ${b.id}\`\n\n`;
    }
  } else {
    out += ':::note[Готовых бандлов пока нет]\nБандл появляется вместе с плагинами, которые в него входят: ссылка на несуществующий плагин не проходит проверку. Запланированные наборы - ниже.\n:::\n\n';
  }
  if (bundles.planned.length > 0) {
    out += '## Запланированы\n\n';
    const all = [...bundles.bundles.map((b) => ({ id: b.id, extends: b.extends, plugins: b.plugins })), ...bundles.planned.map((b) => ({ id: b.id, extends: b.extends, plugins: b.plugins }))];
    for (const b of bundles.planned) {
      const ids = resolveBundle(b.id, all, problems);
      out += `### ${b.title}\n\n${b.summary}\n\n- Идентификатор: \`${b.id}\`\n`;
      if (b.extends.length > 0) out += `- Включает бандлы: ${code(b.extends)}\n`;
      out += `- Плагины (${ids.length}): ${ids.map(link).join(', ')}\n\n`;
    }
  }
  return out.trimEnd() + '\n';
}

function contractsPage(root: string): string {
  const { catalog, design } = checkRepo(root);
  const effective = effectiveContracts(catalog, design);
  const names = new Set<string>(Object.keys(design.contracts));
  for (const e of effective.values()) for (const f of ['provides', 'requires', 'optional', 'consumes'] as const) for (const n of Object.keys(e[f] ?? {})) names.add(n);
  const link = (id: string): string => {
    const p = catalog.plugins.find((x) => x.id === id);
    return p ? `[\`${id}\`](/catalog/${p.category}/${p.id}/)` : `\`${id}\``;
  };
  const who = (name: string, field: 'provides' | 'requires' | 'optional' | 'consumes'): string => {
    const ids = [...effective].filter(([, e]) => name in (e[field] ?? {})).map(([id]) => id).sort();
    return ids.length > 0 ? ids.map(link).join(', ') : '-';
  };
  let out = front('Карта контрактов', 'Какой плагин какие контракты cyborg.* даёт и берёт: по манифестам готовых плагинов и проектной модели запланированных.', 91);
  out += 'Плагины общаются только контрактами. Для готового плагина строка строится по его `manifest.json`, для запланированного - по проектной модели `plugins/planned-contracts.json`; поэтому карта полна с первого дня и сама заменяется настоящими данными по мере переноса. Пробелы относительно типов ядра показывает `npm run contracts:gap`.\n\n';
  out += '| Контракт | Даёт | Требует | Использует, если есть | Собирает у всех | Нужные члены |\n|---|---|---|---|---|---|\n';
  for (const name of [...names].sort()) {
    const members = design.contracts[name]?.members ?? [];
    out += `| \`${name}\` | ${who(name, 'provides')} | ${who(name, 'requires')} | ${who(name, 'optional')} | ${who(name, 'consumes')} | ${members.length > 0 ? members.map((m) => `\`${m}\``).join(', ') : '-'} |\n`;
  }
  const planned = [...effective].filter(([, e]) => e.source === 'design').length;
  out += `\nГотовых плагинов в карте ${effective.size - planned}, по проектной модели ${planned}.\n`;
  return out;
}

function indexPage(root: string): string {
  const { catalog, bundles } = checkRepo(root);
  let out = front('Каталог', 'Плагины репозитория по назначению и бандлы из них.', 0);
  out += 'Плагины лежат по каталогам назначения: `plugins/<категория>/<id>/`. Категория - только место в дереве, идентификатор плагина общий на весь репозиторий и от категории не зависит.\n\n';
  out += '## Категории\n\n| Категория | Что в ней | Готово | Запланировано |\n|---|---|---|---|\n';
  for (const c of catalog.categories) {
    const ready = catalog.plugins.filter((p) => p.category === c.id).length;
    out += `| [${cell(c.title)}](/catalog/${c.id}/) | ${cell(c.summary)} | ${ready} | ${c.planned.length} |\n`;
  }
  out += `\n## Бандлы\n\nГотовых ${bundles.bundles.length}, запланировано ${bundles.planned.length}: [список бандлов](/catalog/bundles/).\n\n`;
  out += '## Статусы плагинов\n\n| Статус | Что значит |\n|---|---|\n| экспериментальный | работает, но поведение и настройки ещё меняются |\n| бета | поведение устоялось, ищем ошибки на живых задачах |\n| стабильный | изменения совместимы, ломающие идут отдельной мажорной версией |\n';
  return out;
}

export function generatePages(root: string): Map<string, string> {
  const { catalog } = checkRepo(root);
  const pages = new Map<string, string>();
  pages.set('index.md', indexPage(root));
  catalog.categories.forEach((c, i) => {
    const plugins = catalog.plugins.filter((p) => p.category === c.id).sort((a, b) => a.id.localeCompare(b.id));
    pages.set(`${c.id}/index.md`, categoryPage(c, plugins, i + 1));
    plugins.forEach((p, j) => pages.set(`${c.id}/${p.id}.md`, pluginPage(p, c, j + 1)));
  });
  pages.set('bundles.md', bundlesPage(root));
  pages.set('contracts.md', contractsPage(root));
  return pages;
}

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? listFiles(file, base) : [path.relative(base, file).split(path.sep).join('/')];
  });
}

/** Различия между тем, что должно лежать в docs/guide/catalog, и тем, что лежит. */
export function diffPages(root: string, pages: Map<string, string>): string[] {
  const dir = path.join(root, CATALOG_DIR);
  const diffs: string[] = [];
  for (const [rel, content] of pages) {
    const file = path.join(dir, rel);
    if (!existsSync(file)) diffs.push(`нет страницы ${rel}`);
    else if (readFileSync(file, 'utf8') !== content) diffs.push(`страница ${rel} устарела`);
  }
  for (const rel of listFiles(dir)) if (!pages.has(rel)) diffs.push(`лишняя страница ${rel}`);
  return diffs;
}

export function writePages(root: string, pages: Map<string, string>): void {
  const dir = path.join(root, CATALOG_DIR);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of pages) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}
