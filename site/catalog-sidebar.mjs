// Боковое меню каталога строится из сгенерированных страниц docs/guide/catalog (scripts/gen-catalog.ts).
// Starlight-овский autogenerate здесь не работает: страницы лежат вне src/content/docs, а их id задаёт свой загрузчик
// (src/content.config.ts), поэтому группа осталась бы пустой. Заголовок и порядок берутся из шапки каждой страницы.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CATALOG = fileURLToPath(new URL('../docs/guide/catalog/', import.meta.url));

function head(file) {
  const text = readFileSync(file, 'utf8');
  const title = /^title: (.*)$/m.exec(text)?.[1];
  const order = /^\s+order: (\d+)$/m.exec(text)?.[1];
  return { title: title ? JSON.parse(title) : path.basename(file, '.md'), order: order ? Number(order) : 0 };
}

export function catalogSidebar() {
  if (!existsSync(CATALOG)) return [];
  const items = [{ slug: 'catalog', label: 'Обзор' }];
  const categories = readdirSync(CATALOG)
    .filter((name) => statSync(path.join(CATALOG, name)).isDirectory())
    .map((name) => ({ name, ...head(path.join(CATALOG, name, 'index.md')) }))
    .sort((a, b) => a.order - b.order);
  for (const c of categories) {
    const plugins = readdirSync(path.join(CATALOG, c.name))
      .filter((f) => f.endsWith('.md') && f !== 'index.md')
      .map((f) => ({ id: f.slice(0, -3), ...head(path.join(CATALOG, c.name, f)) }))
      .sort((a, b) => a.order - b.order);
    if (plugins.length === 0) items.push({ slug: `catalog/${c.name}`, label: c.title });
    else {
      items.push({
        label: c.title,
        collapsed: true,
        items: [{ slug: `catalog/${c.name}`, label: 'Обзор' }, ...plugins.map((p) => ({ slug: `catalog/${c.name}/${p.id}`, label: p.title }))],
      });
    }
  }
  if (existsSync(path.join(CATALOG, 'bundles.md'))) items.push({ slug: 'catalog/bundles', label: 'Бандлы' });
  if (existsSync(path.join(CATALOG, 'contracts.md'))) items.push({ slug: 'catalog/contracts', label: 'Карта контрактов' });
  if (existsSync(path.join(CATALOG, 'parity.md'))) items.push({ slug: 'catalog/parity', label: 'Паритет с ai-cyborg' });
  return items;
}
