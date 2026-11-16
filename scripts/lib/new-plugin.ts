import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadCategories } from './catalog.ts';
import { ID_PATTERN, RESERVED_IDS } from './util.ts';
import type { Problem } from './util.ts';

export interface NewPluginOptions {
  category: string;
  id: string;
  title: string;
}

function substitute(dir: string, replacements: [string, string][]): void {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      substitute(file, replacements);
      continue;
    }
    let text = readFileSync(file, 'utf8');
    for (const [from, to] of replacements) text = text.split(from).join(to);
    writeFileSync(file, text);
  }
}

/** Копирует templates/plugin в plugins/<категория>/<id>; возвращает путь или причину отказа. */
export function createPlugin(root: string, options: NewPluginOptions): { dir: string } | { error: string } {
  const { category, id, title } = options;
  if (!ID_PATTERN.test(id) || RESERVED_IDS.has(id)) return { error: `недопустимый id «${id}»: строчные латинские буквы, цифры и дефис` };
  const categories = loadCategories(root, [] as Problem[]);
  if (!categories.some((c) => c.id === category)) {
    return { error: `категории ${category} нет в plugins/categories.json (есть: ${categories.map((c) => c.id).join(', ')}); новая категория заводится записью туда` };
  }
  const categoryDir = path.join(root, 'plugins', category);
  const pluginsDir = path.join(root, 'plugins');
  for (const cat of existsSync(pluginsDir) ? readdirSync(pluginsDir) : []) {
    const clash = path.join(pluginsDir, cat, id);
    if (existsSync(clash)) return { error: `id ${id} уже занят: ${path.relative(root, clash)}` };
  }
  const dir = path.join(categoryDir, id);
  mkdirSync(categoryDir, { recursive: true });
  cpSync(path.join(root, 'templates', 'plugin'), dir, { recursive: true });
  substitute(dir, [
    ['__ID__', id],
    ['__TITLE__', title],
  ]);
  return { dir };
}
