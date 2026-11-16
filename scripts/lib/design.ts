// Проектная модель контрактов: что каждый запланированный плагин даёт и берёт (plugins/planned-contracts.json).
// Пока плагина нет в каталоге, его место в графе описывает эта модель; когда он появился, берётся его настоящий манифест.
// Модель позволяет проверить замкнутость запланированных бандлов и найти пробелы в `@cyborg-harness/contracts` до начала кода.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ID_PATTERN, isRecord, isStringList, readJson, unknownKeys } from './util.ts';
import type { Problem } from './util.ts';
import { closureProblems, resolveBundle } from './bundles.ts';
import type { BundleLike, ContractView } from './bundles.ts';
import type { Catalog } from './catalog.ts';
import type { Bundles } from './bundles.ts';
import { parseVersion } from './semver.ts';

export const DESIGN_FILE = path.join('plugins', 'planned-contracts.json');

export interface DesignPlugin {
  provides: Record<string, string>;
  requires: Record<string, string>;
  optional: Record<string, string>;
  consumes: Record<string, string>;
}

export interface DesignContract {
  /** Члены, которые нужны плагинам по проекту; сверяются с типами ядра. */
  members: string[];
}

export interface Design {
  contracts: Record<string, DesignContract>;
  plugins: Record<string, DesignPlugin>;
}

const FIELDS = ['provides', 'requires', 'optional', 'consumes'] as const;

function readMap(value: unknown, where: string, field: string, problems: Problem[], kind: 'version' | 'range'): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === undefined) return out;
  if (!isRecord(value)) {
    problems.push({ where, message: `${field} - объект «контракт - версия»` });
    return out;
  }
  for (const [name, v] of Object.entries(value)) {
    if (!ID_PATTERN.test(name)) problems.push({ where, message: `${field}: недопустимое имя контракта «${name}»` });
    if (typeof v !== 'string') {
      problems.push({ where, message: `${field}.${name}: ожидалась строка` });
      continue;
    }
    if (kind === 'version' && !parseVersion(v)) problems.push({ where, message: `${field}.${name}: версия поставщика - x.y, а не «${v}»` });
    if (kind === 'range' && !/^(\*|[\^~]?\d+(\.\d+){0,2})$/.test(v)) problems.push({ where, message: `${field}.${name}: диапазон вида *, 1, 1.2, ^1.4, ~2.3, а не «${v}»` });
    out[name] = v;
  }
  return out;
}

export function loadDesign(root: string, problems: Problem[]): Design {
  const where = 'plugins/planned-contracts.json';
  const empty: Design = { contracts: {}, plugins: {} };
  if (!existsSync(path.join(root, DESIGN_FILE))) return empty;
  const raw = readJson(path.join(root, DESIGN_FILE), root, problems);
  if (raw === undefined) return empty;
  if (!isRecord(raw)) {
    problems.push({ where, message: 'ожидался объект с contracts и plugins' });
    return empty;
  }
  for (const key of unknownKeys(raw, ['contracts', 'plugins'])) problems.push({ where, message: `неизвестное поле ${key}` });
  const design: Design = { contracts: {}, plugins: {} };

  if (isRecord(raw.contracts)) {
    for (const [name, c] of Object.entries(raw.contracts)) {
      const at = `${where}: contracts.${name}`;
      if (!ID_PATTERN.test(name)) problems.push({ where: at, message: 'недопустимое имя контракта' });
      if (!isRecord(c) || !isStringList(c.members)) {
        problems.push({ where: at, message: 'ожидался объект с members (список строк)' });
        continue;
      }
      for (const key of unknownKeys(c, ['members'])) problems.push({ where: at, message: `неизвестное поле ${key}` });
      design.contracts[name] = { members: c.members };
    }
  } else if (raw.contracts !== undefined) problems.push({ where, message: 'contracts - объект' });

  if (isRecord(raw.plugins)) {
    for (const [id, p] of Object.entries(raw.plugins)) {
      const at = `${where}: plugins.${id}`;
      if (!ID_PATTERN.test(id)) problems.push({ where: at, message: 'недопустимый id плагина' });
      if (!isRecord(p)) {
        problems.push({ where: at, message: 'ожидался объект' });
        continue;
      }
      for (const key of unknownKeys(p, FIELDS)) problems.push({ where: at, message: `неизвестное поле ${key}` });
      design.plugins[id] = {
        provides: readMap(p.provides, at, 'provides', problems, 'version'),
        requires: readMap(p.requires, at, 'requires', problems, 'range'),
        optional: readMap(p.optional, at, 'optional', problems, 'range'),
        consumes: readMap(p.consumes, at, 'consumes', problems, 'range'),
      };
    }
  } else if (raw.plugins !== undefined) problems.push({ where, message: 'plugins - объект' });
  return design;
}

export interface Effective extends ContractView {
  consumes?: Record<string, unknown>;
  source: 'real' | 'design';
}

/** Контракты плагина: настоящий манифест, если плагин в каталоге, иначе проектное описание. */
export function effectiveContracts(catalog: Catalog, design: Design): Map<string, Effective> {
  const out = new Map<string, Effective>();
  for (const [id, d] of Object.entries(design.plugins)) out.set(id, { ...d, source: 'design' });
  for (const p of catalog.plugins) {
    out.set(p.id, {
      source: 'real',
      provides: p.manifest.provides ?? {},
      requires: p.manifest.requires ?? {},
      optional: p.manifest.optional ?? {},
      consumes: p.manifest.consumes ?? {},
    });
  }
  return out;
}

/** Проверки модели: у каждого запланированного плагина есть описание, планируемые бандлы замкнуты. */
export function checkDesign(catalog: Catalog, bundles: Bundles, design: Design, problems: Problem[]): { notes: string[] } {
  const where = 'plugins/planned-contracts.json';
  const planned = new Set(catalog.categories.flatMap((c) => c.planned.map((p) => p.id)));
  const real = new Set(catalog.plugins.map((p) => p.id));
  for (const id of planned) if (!design.plugins[id]) problems.push({ where, message: `у запланированного плагина ${id} нет описания контрактов` });
  for (const id of Object.keys(design.plugins)) {
    if (!planned.has(id) && !real.has(id)) problems.push({ where, message: `описан плагин ${id}, которого нет ни в каталоге, ни в planned категорий` });
    if (real.has(id)) problems.push({ where, message: `плагин ${id} уже в каталоге: уберите его описание, настоящий манифест главнее` });
  }
  const usedContracts = new Set<string>();
  const effective = effectiveContracts(catalog, design);
  for (const e of effective.values()) for (const f of ['provides', 'requires', 'optional', 'consumes'] as const) for (const name of Object.keys(e[f] ?? {})) usedContracts.add(name);
  for (const name of Object.keys(design.contracts)) if (!usedContracts.has(name)) problems.push({ where, message: `contracts.${name}: контракт не встречается ни у одного плагина` });

  const notes: string[] = [];
  const all: BundleLike[] = [...bundles.bundles.map((b) => ({ id: b.id, extends: b.extends, plugins: b.plugins, rel: b.rel })), ...bundles.planned.map((b) => ({ id: b.id, extends: b.extends, plugins: b.plugins }))];
  for (const b of bundles.planned) {
    const ids = resolveBundle(b.id, all, problems);
    const r = closureProblems(b.id, 'bundles/planned.json', ids, (id) => effective.get(id), problems, 'каталоге и модели контрактов');
    notes.push(...r.notes.map((n) => `запланированный бандл ${b.id}: ${n}`));
  }
  // Поставщик, не названный ни одним потребителем, - повод посмотреть: вероятно, пропущена связь.
  const consumed = new Set<string>();
  for (const e of effective.values()) for (const f of ['requires', 'optional', 'consumes'] as const) for (const name of Object.keys(e[f] ?? {})) consumed.add(name);
  for (const [id, e] of effective) for (const name of Object.keys(e.provides ?? {})) if (!consumed.has(name)) notes.push(`${id}: контракт ${name} никто не берёт`);
  return { notes };
}

// ---- пробелы относительно типов ядра

export interface HarnessContracts {
  /** Имя контракта -> члены его типа (по версии с наибольшим мажором). */
  contracts: Map<string, Set<string>>;
  /** Откуда прочитано. */
  dir: string;
}

/** Читает `Contracts` и интерфейсы-члены из исходников или деклараций пакета контрактов (по текстовому разбору, без компилятора). */
export function readHarnessContracts(dir: string): HarnessContracts | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((n) => /\.(d\.)?ts$/.test(n));
  if (files.length === 0) return undefined;
  const text = files.map((n) => readFileSync(path.join(dir, n), 'utf8')).join('\n');
  const map = /interface Contracts\s*\{([\s\S]*?)\n\}/.exec(text);
  if (!map) return undefined;
  const contracts = new Map<string, Set<string>>();
  for (const m of (map[1] ?? '').matchAll(/'([a-z0-9.-]+)'\s*:\s*\{([^}]*)\}/g)) {
    const entries = [...(m[2] ?? '').matchAll(/(\d+)\s*:\s*([A-Za-z0-9_]+)/g)];
    const latest = entries.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    contracts.set(m[1] ?? '', latest ? membersOf(text, latest[2] ?? '') : new Set());
  }
  return { contracts, dir };
}

function membersOf(text: string, typeName: string): Set<string> {
  const re = new RegExp(`(?:export )?interface ${typeName}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`);
  const m = re.exec(text);
  const members = new Set<string>();
  if (!m) return members;
  for (const line of (m[1] ?? '').split('\n')) {
    const mm = /^ {2}(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\??\s*[(<:]/.exec(line);
    if (mm) members.add(mm[1] ?? '');
  }
  return members;
}

export interface Gap {
  contract: string;
  /** `absent` - контракта нет в типах ядра; `members` - нет части нужных членов. */
  kind: 'absent' | 'members';
  missing: string[];
  users: string[];
}

export function findGaps(design: Design, catalog: Catalog, harness: HarnessContracts): Gap[] {
  const effective = effectiveContracts(catalog, design);
  const users = new Map<string, Set<string>>();
  for (const [id, e] of effective) {
    for (const f of ['provides', 'requires', 'optional', 'consumes'] as const) {
      for (const name of Object.keys(e[f] ?? {})) {
        if (!name.startsWith('cyborg.')) continue;
        (users.get(name) ?? users.set(name, new Set()).get(name))?.add(id);
      }
    }
  }
  const gaps: Gap[] = [];
  for (const [name, ids] of [...users].sort(([a], [b]) => a.localeCompare(b))) {
    const have = harness.contracts.get(name);
    const needed = design.contracts[name]?.members ?? [];
    if (!have) gaps.push({ contract: name, kind: 'absent', missing: needed, users: [...ids].sort() });
    else {
      const missing = needed.filter((m) => !have.has(m));
      if (missing.length > 0) gaps.push({ contract: name, kind: 'members', missing, users: [...ids].sort() });
    }
  }
  return gaps;
}
