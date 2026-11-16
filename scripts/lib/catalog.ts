// Каталог плагинов: plugins/<категория>/<id>/. Категория - только место в дереве, в манифест она не пишется
// (манифест ядра не принимает чужих полей). Описание для людей - карточка в шапке README.md плагина.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ID_PATTERN, RESERVED_IDS, isRecord, readJson, unknownKeys } from './util.ts';
import type { Problem } from './util.ts';
import { isPluginVersion } from './semver.ts';

export const STATUSES = ['experimental', 'beta', 'stable'] as const;
export type Status = (typeof STATUSES)[number];

export interface PlannedPlugin {
  id: string;
  summary: string;
  from: string;
}

export interface Category {
  id: string;
  title: string;
  summary: string;
  planned: PlannedPlugin[];
}

export interface Card {
  title: string;
  summary: string;
  status: Status;
  tags: string[];
  needs: string[];
  body: string;
}

export interface Manifest {
  id: string;
  version: string;
  engines?: { cyborg?: unknown };
  provides?: Record<string, unknown>;
  requires?: Record<string, unknown>;
  optional?: Record<string, unknown>;
  consumes?: Record<string, unknown>;
  commands?: unknown;
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginEntry {
  id: string;
  category: string;
  /** Путь от корня репозитория, с прямыми слэшами. */
  rel: string;
  dir: string;
  manifest: Manifest;
  card: Card | undefined;
}

export interface Catalog {
  categories: Category[];
  plugins: PluginEntry[];
  problems: Problem[];
}

const CARD_KEYS = ['title', 'summary', 'status', 'tags', 'needs'];
const CATEGORY_KEYS = ['id', 'title', 'summary', 'planned'];
const PLANNED_KEYS = ['id', 'summary', 'from'];

/** Карточка: шапка `---` ... `---` из строк `ключ: значение`, списки в виде `[а, б]`, дальше Markdown. */
export function parseCard(text: string, where: string, problems: Problem[]): Card | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) {
    problems.push({ where, message: 'нет карточки: README.md начинается с шапки `---` (title, summary, status)' });
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) {
      problems.push({ where, message: `в шапке строка не вида «ключ: значение»: ${line}` });
      continue;
    }
    const key = kv[1] ?? '';
    if (!CARD_KEYS.includes(key)) problems.push({ where, message: `в шапке неизвестное поле ${key} (допустимы ${CARD_KEYS.join(', ')})` });
    fields.set(key, (kv[2] ?? '').trim());
  }
  const text1 = (key: string): string => unquote(fields.get(key) ?? '');
  const list = (key: string): string[] => {
    const raw = (fields.get(key) ?? '').trim();
    if (raw === '' || raw === '[]') return [];
    const inner = /^\[(.*)\]$/.exec(raw);
    if (!inner) {
      problems.push({ where, message: `поле ${key} - список в виде [а, б]` });
      return [];
    }
    return (inner[1] ?? '').split(',').map((s) => unquote(s.trim())).filter((s) => s !== '');
  };
  const title = text1('title');
  const summary = text1('summary');
  const status = text1('status');
  if (title === '') problems.push({ where, message: 'в шапке нет title' });
  if (summary === '') problems.push({ where, message: 'в шапке нет summary' });
  if (!(STATUSES as readonly string[]).includes(status)) problems.push({ where, message: `status - одно из ${STATUSES.join(', ')}, а не «${status}»` });
  const body = (m[2] ?? '').replace(/^\s+/, '');
  if (/^# /m.test(body.replace(/```[\s\S]*?```/g, ''))) problems.push({ where, message: 'в тексте заголовок первого уровня: название рисует сайт, начинайте с `##`' });
  return { title, summary, status: status as Status, tags: list('tags'), needs: list('needs'), body };
}

function unquote(value: string): string {
  const m = /^(["'])(.*)\1$/.exec(value);
  return m ? (m[2] ?? '') : value;
}

export function loadCategories(root: string, problems: Problem[]): Category[] {
  const file = path.join(root, 'plugins', 'categories.json');
  const raw = readJson(file, root, problems);
  const where = 'plugins/categories.json';
  if (!Array.isArray(raw)) {
    if (raw !== undefined) problems.push({ where, message: 'ожидался список категорий' });
    return [];
  }
  const out: Category[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const at = `${where}[${i}]`;
    if (!isRecord(item)) {
      problems.push({ where: at, message: 'ожидался объект' });
      continue;
    }
    for (const key of unknownKeys(item, CATEGORY_KEYS)) problems.push({ where: at, message: `неизвестное поле ${key}` });
    const id = typeof item.id === 'string' ? item.id : '';
    if (!/^[a-z][a-z0-9-]*$/.test(id)) problems.push({ where: at, message: `id категории - строчные латинские буквы, цифры и дефис: «${id}»` });
    if (seen.has(id)) problems.push({ where: at, message: `категория ${id} повторена` });
    seen.add(id);
    if (typeof item.title !== 'string' || item.title === '') problems.push({ where: at, message: 'нет title' });
    if (typeof item.summary !== 'string' || item.summary === '') problems.push({ where: at, message: 'нет summary' });
    const planned: PlannedPlugin[] = [];
    if (item.planned !== undefined && !Array.isArray(item.planned)) problems.push({ where: at, message: 'planned - список' });
    for (const [j, p] of (Array.isArray(item.planned) ? item.planned : []).entries()) {
      const pat = `${at}.planned[${j}]`;
      if (!isRecord(p) || typeof p.id !== 'string' || typeof p.summary !== 'string' || typeof p.from !== 'string') {
        problems.push({ where: pat, message: 'ожидался объект с id, summary и from (строками)' });
        continue;
      }
      for (const key of unknownKeys(p, PLANNED_KEYS)) problems.push({ where: pat, message: `неизвестное поле ${key}` });
      if (!ID_PATTERN.test(p.id)) problems.push({ where: pat, message: `недопустимый id ${p.id}` });
      planned.push({ id: p.id, summary: p.summary, from: p.from });
    }
    out.push({ id, title: typeof item.title === 'string' ? item.title : id, summary: typeof item.summary === 'string' ? item.summary : '', planned });
  }
  return out;
}

export function loadCatalog(root: string): Catalog {
  const problems: Problem[] = [];
  const categories = loadCategories(root, problems);
  const plugins: PluginEntry[] = [];
  const pluginsDir = path.join(root, 'plugins');
  const known = new Set(categories.map((c) => c.id));

  for (const catName of dirs(pluginsDir)) {
    if (!known.has(catName)) {
      problems.push({ where: `plugins/${catName}`, message: 'каталог не объявлен в plugins/categories.json' });
      continue;
    }
    for (const entry of readdirSync(path.join(pluginsDir, catName), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = `plugins/${catName}/${entry.name}`;
      if (!entry.isDirectory()) {
        problems.push({ where: rel, message: 'в каталоге категории только каталоги плагинов' });
        continue;
      }
      const dir = path.join(pluginsDir, catName, entry.name);
      const manifestPath = path.join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) {
        problems.push({ where: rel, message: 'нет manifest.json: каталог плагина - plugins/<категория>/<id>/' });
        continue;
      }
      const manifest = readJson(manifestPath, root, problems);
      if (!isRecord(manifest)) {
        if (manifest !== undefined) problems.push({ where: `${rel}/manifest.json`, message: 'ожидался объект' });
        continue;
      }
      const m = manifest as Manifest;
      const id = typeof m.id === 'string' ? m.id : '';
      if (id !== entry.name) problems.push({ where: `${rel}/manifest.json`, message: `id «${id}» не совпадает с именем каталога «${entry.name}»` });
      if (!ID_PATTERN.test(id)) problems.push({ where: `${rel}/manifest.json`, message: `недопустимый id «${id}»` });
      if (RESERVED_IDS.has(id)) problems.push({ where: `${rel}/manifest.json`, message: `id ${id} занят ядром` });
      if (typeof m.version !== 'string' || !isPluginVersion(m.version)) problems.push({ where: `${rel}/manifest.json`, message: 'version - x.y.z' });
      if (!isRecord(m.engines) || typeof m.engines.cyborg !== 'string') problems.push({ where: `${rel}/manifest.json`, message: 'нет engines.cyborg' });
      const readme = path.join(dir, 'README.md');
      let card: Card | undefined;
      if (existsSync(readme)) card = parseCard(readFileSync(readme, 'utf8'), `${rel}/README.md`, problems);
      else problems.push({ where: `${rel}/README.md`, message: 'нет README.md с карточкой плагина' });
      plugins.push({ id, category: catName, rel, dir, manifest: m, card });
    }
  }

  const byId = new Map<string, PluginEntry>();
  for (const p of plugins) {
    const prev = byId.get(p.id);
    if (prev) problems.push({ where: p.rel, message: `id ${p.id} уже занят плагином ${prev.rel}: идентификатор общий на весь репозиторий` });
    else byId.set(p.id, p);
  }
  for (const c of categories) {
    for (const planned of c.planned) {
      if (byId.has(planned.id)) problems.push({ where: `plugins/categories.json`, message: `плагин ${planned.id} уже в каталоге: уберите его из planned категории ${c.id}` });
    }
  }
  const plannedIds = new Map<string, string>();
  for (const c of categories) {
    for (const planned of c.planned) {
      const prev = plannedIds.get(planned.id);
      if (prev) problems.push({ where: 'plugins/categories.json', message: `запланированный плагин ${planned.id} назван в категориях ${prev} и ${c.id}` });
      plannedIds.set(planned.id, c.id);
    }
  }
  return { categories, plugins, problems };
}

function dirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith('.') && statSync(path.join(dir, n)).isDirectory())
    .sort();
}
