// Матрица паритета: каждое требование, канал IPC, событие окну, ключ хранилища, диалог и файл данных ai-cyborg имеет плагин-владельца,
// задачу переноса и статус. Матрица - данные (parity/matrix.json), а скрипт сверяет её с настоящим кодом ai-cyborg, поэтому новое и
// исчезнувшее в приложении видно сразу, а не при чтении документов. Правила - docs/guide/development/roadmap.md, план ядра (ПМ-01, ПМ-04).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord, isStringList, readJson, unknownKeys } from './util.ts';
import type { Problem } from './util.ts';

export const MATRIX_FILE = path.join('parity', 'matrix.json');
export const KINDS = ['requirement', 'channel', 'event', 'storage', 'dialog', 'data'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['not-started', 'ported', 'parity', 'allowlist'] as const;
export type RowStatus = (typeof STATUSES)[number];
/** Владельцы вне каталога плагинов: ядро и то, что не код приложения (CI, README, сайт). */
export const SPECIAL_OWNERS = ['core', 'repo'] as const;

export interface Row {
  id: string;
  kind: Kind;
  owner: string;
  /** Ключ задачи эпика, которая переносит строку, или `-` (ядро и вне кода). */
  task: string;
  status: RowStatus;
  feature?: string;
  title?: string;
  /** Канал: `handle` или `on`. */
  type?: 'handle' | 'on';
  /** Ключ хранилища с вычисляемой частью (`cyborg.search.*`). */
  family?: boolean;
  /** Файл данных: строка, которая обязана встречаться в коде приложения (ловит переименование). */
  probe?: string;
  /** Для статуса `allowlist`: причина расхождения и ссылка на решение. */
  reason?: string;
}

export interface Feature {
  tests: string[];
  scenarios: string[];
}

export interface Matrix {
  format: 1;
  source: { repo: string; commit: string; date: string };
  features: Record<string, Feature>;
  rows: Row[];
}

const ROW_KEYS = ['id', 'kind', 'owner', 'task', 'status', 'feature', 'title', 'type', 'family', 'probe', 'reason'];
const TASK = /^(?:[A-Z]{1,2}-\d{2}|-)$/;

export function loadMatrix(root: string, problems: Problem[]): Matrix | undefined {
  const file = path.join(root, MATRIX_FILE);
  if (!existsSync(file)) return undefined;
  const where = 'parity/matrix.json';
  const raw = readJson(file, root, problems);
  if (!isRecord(raw)) {
    if (raw !== undefined) problems.push({ where, message: 'ожидался объект' });
    return undefined;
  }
  for (const key of unknownKeys(raw, ['format', 'source', 'features', 'rows'])) problems.push({ where, message: `неизвестное поле ${key}` });
  if (raw.format !== 1) problems.push({ where, message: 'format - 1' });
  const source = isRecord(raw.source) && typeof raw.source.repo === 'string' && typeof raw.source.commit === 'string' && typeof raw.source.date === 'string' ? { repo: raw.source.repo, commit: raw.source.commit, date: raw.source.date } : undefined;
  if (!source) problems.push({ where, message: 'source: repo, commit, date (строки)' });
  const features: Record<string, Feature> = {};
  if (isRecord(raw.features)) {
    for (const [name, f] of Object.entries(raw.features)) {
      if (isRecord(f) && isStringList(f.tests) && isStringList(f.scenarios)) features[name] = { tests: f.tests, scenarios: f.scenarios };
      else problems.push({ where: `${where}: features.${name}`, message: 'ожидались tests и scenarios (списки строк)' });
    }
  } else problems.push({ where, message: 'features - объект' });
  const rows: Row[] = [];
  if (Array.isArray(raw.rows)) {
    for (const [i, r] of raw.rows.entries()) {
      const at = `${where}: rows[${i}]`;
      if (!isRecord(r) || typeof r.id !== 'string' || typeof r.kind !== 'string' || typeof r.owner !== 'string' || typeof r.task !== 'string' || typeof r.status !== 'string') {
        problems.push({ where: at, message: 'ожидался объект с id, kind, owner, task, status (строками)' });
        continue;
      }
      for (const key of unknownKeys(r, ROW_KEYS)) problems.push({ where: at, message: `неизвестное поле ${key}` });
      rows.push(r as unknown as Row);
    }
  } else problems.push({ where, message: 'rows - список' });
  return source ? { format: 1, source, features, rows } : undefined;
}

/** Правила данных матрицы; владельцы - плагины каталога и запланированные плюс ядро и «вне кода». */
export function validateMatrix(matrix: Matrix, owners: ReadonlySet<string>, problems: Problem[]): void {
  const where = 'parity/matrix.json';
  const seen = new Set<string>();
  for (const r of matrix.rows) {
    const at = `${where}: ${r.kind} ${r.id}`;
    if (!(KINDS as readonly string[]).includes(r.kind)) problems.push({ where: at, message: `kind - одно из ${KINDS.join(', ')}` });
    const key = `${r.kind}\u0000${r.id}`;
    if (seen.has(key)) problems.push({ where: at, message: 'строка повторена' });
    seen.add(key);
    if (!owners.has(r.owner)) problems.push({ where: at, message: `владелец «${r.owner}» не плагин каталога или запланированный, не core и не repo` });
    if (!TASK.test(r.task)) problems.push({ where: at, message: `task «${r.task}»: ключ задачи вида M-05 или -` });
    if (!(STATUSES as readonly string[]).includes(r.status)) problems.push({ where: at, message: `status - одно из ${STATUSES.join(', ')}` });
    if (r.status === 'allowlist' && (typeof r.reason !== 'string' || r.reason.trim() === '')) problems.push({ where: at, message: 'allowlist требует reason: причину и ссылку на решение' });
    if (r.status !== 'allowlist' && r.reason !== undefined) problems.push({ where: at, message: 'reason бывает только у статуса allowlist: запись allowlist без расхождения роняет проверку' });
    if (r.kind === 'requirement' && (!r.feature || !matrix.features[r.feature])) problems.push({ where: at, message: 'требование без известной фичи' });
    if (r.kind === 'channel' && r.type !== 'handle' && r.type !== 'on') problems.push({ where: at, message: 'у канала type - handle или on' });
    if (r.kind === 'data' && !r.probe) problems.push({ where: at, message: 'у файла данных нужен probe' });
  }
  for (const [name, f] of Object.entries(matrix.features)) {
    for (const s of f.scenarios) if (!/^S\d+$/.test(s)) problems.push({ where: `${where}: features.${name}`, message: `сценарий «${s}» вида S12` });
  }
}

// ---- извлечение из кода ai-cyborg

export interface Extracted {
  requirements: Map<string, { feature: string; title: string }>;
  channels: Map<string, 'handle' | 'on'>;
  events: Set<string>;
  storageKeys: Set<string>;
  storageFamilies: Set<string>;
  dialogs: Set<string>;
  /** Склеенный текст исходников для probe файлов данных. */
  haystack: string;
}

function files(dir: string, ext: RegExp, skip: RegExp = /\.test\.ts$/): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p, ext, skip);
    return ext.test(e.name) && !skip.test(e.name) ? [p] : [];
  });
}

const read = (file: string): string => readFileSync(file, 'utf8');

export function extractSource(dir: string): Extracted {
  const out: Extracted = { requirements: new Map(), channels: new Map(), events: new Set(), storageKeys: new Set(), storageFamilies: new Set(), dialogs: new Set(), haystack: '' };
  const product = path.join(dir, 'docs', '01-product');
  if (existsSync(product)) {
    for (const feature of readdirSync(product).filter((n) => /^\d\d-/.test(n)).sort()) {
      const srs = path.join(product, feature, 'srs.md');
      if (!existsSync(srs)) continue;
      for (const line of read(srs).split('\n')) {
        const m = /^### (N?FR)-(\d+) (.*)$/.exec(line);
        if (m) out.requirements.set(`${m[1]}-${m[2]}`, { feature, title: (m[3] ?? '').replaceAll('`', '').trim() });
      }
    }
  }
  const main = files(path.join(dir, 'src', 'main'), /\.ts$/);
  const renderer = files(path.join(dir, 'src', 'renderer'), /\.ts$/);
  const shared = files(path.join(dir, 'src', 'shared'), /\.ts$/);
  const agentd = files(path.join(dir, 'src', 'agentd'), /\.ts$/);
  for (const file of main) {
    const text = read(file);
    for (const m of text.matchAll(/ipcMain\.(handle|on)\('([^']+)'/g)) out.channels.set(m[2] ?? '', m[1] === 'on' ? 'on' : 'handle');
    // Каналы, которые модуль регистрирует через переданный `handle(...)` (registerRunChannels в run-file.ts).
    if (/export function register\w*Channels/.test(text)) for (const m of text.matchAll(/\bhandle\('([a-z]+:[A-Za-z:-]+)'/g)) out.channels.set(m[1] ?? '', 'handle');
    for (const m of text.matchAll(/webContents\.send\('([^']+)'/g)) out.events.add(m[1] ?? '');
    if (path.basename(file) === 'sessions.ts') for (const m of text.matchAll(/emit\('(session:[a-zA-Z]+)'/g)) out.events.add(m[1] ?? '');
  }
  for (const file of renderer) {
    const text = read(file);
    for (const m of text.matchAll(/'(cyborg\.[A-Za-z]+(?:\.[A-Za-z]+)?)'/g)) out.storageKeys.add(m[1] ?? '');
    for (const m of text.matchAll(/`(cyborg\.[A-Za-z.]*?)([.:])\$\{[^}]*\}`/g)) out.storageFamilies.add(`${m[1] ?? ''}${m[2] ?? ''}*`);
  }
  const html = path.join(dir, 'src', 'renderer', 'index.html');
  if (existsSync(html)) for (const m of read(html).matchAll(/<dialog[^>]*\sid="([^"]+)"/g)) out.dialogs.add(m[1] ?? '');
  out.haystack = [...main, ...renderer, ...shared, ...agentd].map(read).join('\n');
  return out;
}

export interface Diff {
  /** Есть в коде, нет в матрице: перенос не учёл. */
  missing: string[];
  /** Есть в матрице, нет в коде: функцию убрали или переименовали. */
  stale: string[];
  /** Совпадают по имени, но не по виду. */
  mismatched: string[];
}

export function compareMatrix(matrix: Matrix, code: Extracted): Diff {
  const diff: Diff = { missing: [], stale: [], mismatched: [] };
  const rows = (kind: Kind): Row[] => matrix.rows.filter((r) => r.kind === kind);
  const compareSet = (kind: Kind, label: string, have: ReadonlySet<string>, pick: (r: Row) => boolean = () => true): void => {
    const inMatrix = new Set(rows(kind).filter(pick).map((r) => r.id));
    for (const id of [...have].sort()) if (!inMatrix.has(id)) diff.missing.push(`${label} ${id}`);
    for (const id of [...inMatrix].sort()) if (!have.has(id)) diff.stale.push(`${label} ${id}`);
  };
  compareSet('requirement', 'требование', new Set(code.requirements.keys()));
  compareSet('channel', 'канал', new Set(code.channels.keys()));
  compareSet('event', 'событие', new Set(code.events));
  compareSet('storage', 'ключ хранилища', code.storageKeys, (r) => !r.family);
  compareSet('storage', 'семейство ключей', code.storageFamilies, (r) => r.family === true);
  compareSet('dialog', 'диалог', code.dialogs);
  for (const r of rows('channel')) {
    const type = code.channels.get(r.id);
    if (type !== undefined && type !== r.type) diff.mismatched.push(`канал ${r.id}: в матрице ${String(r.type)}, в коде ${type}`);
  }
  for (const r of rows('requirement')) {
    const found = code.requirements.get(r.id);
    if (found && found.feature !== r.feature) diff.mismatched.push(`требование ${r.id}: в матрице фича ${String(r.feature)}, в коде ${found.feature}`);
  }
  for (const r of rows('data')) if (r.probe && !code.haystack.includes(r.probe)) diff.stale.push(`файл данных ${r.id}: в коде нет «${r.probe}»`);
  return diff;
}

/** Добавляет в матрицу строки для того, что есть в коде и нет в матрице: владелец `?`, пока человек не назначит. Возвращает число добавленных. */
export function addMissingRows(file: string, matrix: Matrix, code: Extracted): number {
  const have = (kind: Kind, id: string): boolean => matrix.rows.some((r) => r.kind === kind && r.id === id);
  const add: Row[] = [];
  const row = (r: Omit<Row, 'owner' | 'task' | 'status'>): void => void add.push({ ...r, owner: '?', task: '-', status: 'not-started' });
  for (const [id, v] of code.requirements) if (!have('requirement', id)) row({ id, kind: 'requirement', feature: v.feature, title: v.title });
  for (const [id, type] of code.channels) if (!have('channel', id)) row({ id, kind: 'channel', type });
  for (const id of code.events) if (!have('event', id)) row({ id, kind: 'event' });
  for (const id of code.storageKeys) if (!matrix.rows.some((r) => r.kind === 'storage' && !r.family && r.id === id)) row({ id, kind: 'storage' });
  for (const id of code.storageFamilies) if (!matrix.rows.some((r) => r.kind === 'storage' && r.family && r.id === id)) row({ id, kind: 'storage', family: true });
  for (const id of code.dialogs) if (!have('dialog', id)) row({ id, kind: 'dialog' });
  if (add.length === 0) return 0;
  matrix.rows.push(...add);
  writeMatrix(file, matrix);
  return add.length;
}

/** Запись в том же компактном виде, что у исходного файла: одна строка - одна запись. */
export function writeMatrix(file: string, matrix: Matrix): void {
  const j = (o: unknown): string => JSON.stringify(o).replace(/":/g, '": ').replace(/,"/g, ', "');
  const features = Object.entries(matrix.features);
  const out = [
    '{',
    '  "format": 1,',
    `  "source": ${j(matrix.source)},`,
    '  "features": {',
    ...features.map(([k, v], i) => `    ${JSON.stringify(k)}: ${j(v)}${i < features.length - 1 ? ',' : ''}`),
    '  },',
    '  "rows": [',
    ...matrix.rows.map((r, i) => `    ${j(r)}${i < matrix.rows.length - 1 ? ',' : ''}`),
    '  ]',
    '}',
    '',
  ];
  writeFileSync(file, out.join('\n'));
}

export interface Summary {
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  /** Владелец -> вид -> число. */
  byOwner: Map<string, Record<string, number>>;
  /** Задача -> число строк и из них готовых (parity или allowlist). */
  byTask: Map<string, { rows: number; done: number }>;
}

export function summarize(matrix: Matrix): Summary {
  const s: Summary = { total: matrix.rows.length, byKind: {}, byStatus: {}, byOwner: new Map(), byTask: new Map() };
  for (const r of matrix.rows) {
    s.byKind[r.kind] = (s.byKind[r.kind] ?? 0) + 1;
    s.byStatus[r.status] = (s.byStatus[r.status] ?? 0) + 1;
    const o = s.byOwner.get(r.owner) ?? {};
    o[r.kind] = (o[r.kind] ?? 0) + 1;
    s.byOwner.set(r.owner, o);
    const t = s.byTask.get(r.task) ?? { rows: 0, done: 0 };
    t.rows++;
    if (r.status === 'parity' || r.status === 'allowlist') t.done++;
    s.byTask.set(r.task, t);
  }
  return s;
}
