// Бандлы: bundles/<id>.json - именованный набор плагинов, который ставится пачкой.
// Формат описан в docs/guide/bundles/format.md. Бандл ничего не копирует в плагины: это список,
// из которого сборка делает поставку ядра (`cyborg-plugin delivery`) и фрагмент `plugins.enabled`.

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ID_PATTERN, isRecord, isStringList, readJson, unknownKeys } from './util.ts';
import type { Problem } from './util.ts';
import { isPluginVersion, providedVersions, rangeAccepts } from './semver.ts';
import type { Catalog } from './catalog.ts';

export const BUNDLE_FORMAT = 1;
const BUNDLE_KEYS = ['format', 'id', 'version', 'title', 'description', 'extends', 'plugins'];
const PLANNED_BUNDLE_KEYS = ['id', 'title', 'summary', 'extends', 'plugins'];

export interface Bundle {
  id: string;
  version: string;
  title: string;
  description: string;
  extends: string[];
  plugins: string[];
  rel: string;
}

export interface PlannedBundle {
  id: string;
  title: string;
  summary: string;
  extends: string[];
  plugins: string[];
}

export interface Bundles {
  bundles: Bundle[];
  planned: PlannedBundle[];
}

export function loadBundles(root: string, catalog: Catalog, problems: Problem[]): Bundles {
  const dir = path.join(root, 'bundles');
  const bundles: Bundle[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json') || name === 'planned.json') continue;
      const rel = `bundles/${name}`;
      const raw = readJson(path.join(dir, name), root, problems);
      if (raw === undefined) continue;
      if (!isRecord(raw)) {
        problems.push({ where: rel, message: 'ожидался объект' });
        continue;
      }
      for (const key of unknownKeys(raw, BUNDLE_KEYS)) problems.push({ where: rel, message: `неизвестное поле ${key}` });
      if (raw.format !== BUNDLE_FORMAT) problems.push({ where: rel, message: `format - ${BUNDLE_FORMAT}` });
      const id = typeof raw.id === 'string' ? raw.id : '';
      if (!ID_PATTERN.test(id) || id !== name.slice(0, -'.json'.length)) problems.push({ where: rel, message: `id «${id}» должен совпадать с именем файла и быть вида ${ID_PATTERN.source}` });
      if (typeof raw.version !== 'string' || !isPluginVersion(raw.version)) problems.push({ where: rel, message: 'version - x.y.z' });
      if (typeof raw.title !== 'string' || raw.title === '') problems.push({ where: rel, message: 'нет title' });
      if (typeof raw.description !== 'string' || raw.description === '') problems.push({ where: rel, message: 'нет description' });
      if (raw.extends !== undefined && !isStringList(raw.extends)) problems.push({ where: rel, message: 'extends - список id бандлов' });
      if (!isStringList(raw.plugins)) problems.push({ where: rel, message: 'plugins - список id плагинов' });
      bundles.push({
        id,
        version: typeof raw.version === 'string' ? raw.version : '0.0.0',
        title: typeof raw.title === 'string' ? raw.title : id,
        description: typeof raw.description === 'string' ? raw.description : '',
        extends: isStringList(raw.extends) ? raw.extends : [],
        plugins: isStringList(raw.plugins) ? raw.plugins : [],
        rel,
      });
    }
  }

  const planned: PlannedBundle[] = [];
  const plannedFile = path.join(dir, 'planned.json');
  if (existsSync(plannedFile)) {
    const raw = readJson(plannedFile, root, problems);
    if (Array.isArray(raw)) {
      for (const [i, item] of raw.entries()) {
        const at = `bundles/planned.json[${i}]`;
        if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.summary !== 'string' || !isStringList(item.plugins)) {
          problems.push({ where: at, message: 'ожидался объект с id, title, summary и plugins' });
          continue;
        }
        for (const key of unknownKeys(item, PLANNED_BUNDLE_KEYS)) problems.push({ where: at, message: `неизвестное поле ${key}` });
        if (item.extends !== undefined && !isStringList(item.extends)) problems.push({ where: at, message: 'extends - список id бандлов' });
        planned.push({ id: item.id, title: item.title, summary: item.summary, extends: isStringList(item.extends) ? item.extends : [], plugins: item.plugins });
      }
    } else if (raw !== undefined) {
      problems.push({ where: 'bundles/planned.json', message: 'ожидался список' });
    }
  }

  const real = new Set(bundles.map((b) => b.id));
  const seen = new Set<string>();
  for (const b of bundles) {
    if (seen.has(b.id)) problems.push({ where: b.rel, message: `бандл ${b.id} повторён` });
    seen.add(b.id);
  }
  const knownBundles = new Set([...real, ...planned.map((p) => p.id)]);
  const knownPlugins = new Set(catalog.plugins.map((p) => p.id));
  const plannedPlugins = new Set(catalog.categories.flatMap((c) => c.planned.map((p) => p.id)));
  for (const p of planned) {
    if (real.has(p.id)) problems.push({ where: 'bundles/planned.json', message: `бандл ${p.id} уже есть: уберите его из planned.json` });
    for (const parent of p.extends) {
      if (!knownBundles.has(parent)) problems.push({ where: 'bundles/planned.json', message: `бандл ${p.id} расширяет ${parent}, которого нет ни среди готовых, ни среди запланированных` });
    }
    for (const pluginId of p.plugins) {
      if (!knownPlugins.has(pluginId) && !plannedPlugins.has(pluginId)) problems.push({ where: 'bundles/planned.json', message: `в бандле ${p.id} плагин ${pluginId}, которого нет ни в каталоге, ни в planned категорий` });
    }
  }
  return { bundles, planned };
}

/** То, что нужно для раскрытия `extends`: и готовый, и запланированный бандл. */
export interface BundleLike {
  id: string;
  extends: string[];
  plugins: string[];
  rel?: string;
}

/** Плагины бандла вместе с унаследованными, в порядке: сначала расширяемые бандлы, затем свои. Без повторов. */
export function resolveBundle(id: string, bundles: readonly BundleLike[], problems: Problem[]): string[] {
  const byId = new Map(bundles.map((b) => [b.id, b]));
  const out: string[] = [];
  const done = new Set<string>();
  const walk = (bundleId: string, trail: string[]): void => {
    const b = byId.get(bundleId);
    if (!b) {
      problems.push({ where: byId.get(trail[trail.length - 1] ?? '')?.rel ?? 'bundles/planned.json', message: `extends называет бандл ${bundleId}, которого нет` });
      return;
    }
    if (trail.includes(bundleId)) {
      problems.push({ where: b.rel ?? 'bundles/planned.json', message: `цикл в extends: ${[...trail, bundleId].join(' -> ')}` });
      return;
    }
    if (done.has(bundleId)) return;
    done.add(bundleId);
    for (const parent of b.extends) walk(parent, [...trail, bundleId]);
    for (const pluginId of b.plugins) if (!out.includes(pluginId)) out.push(pluginId);
  };
  walk(id, []);
  return out;
}

/** Контракты плагина: то, что нужно для проверки полноты; настоящий манифест и проектное описание приводятся к этому виду. */
export interface ContractView {
  provides?: Record<string, unknown>;
  requires?: Record<string, unknown>;
  optional?: Record<string, unknown>;
}

/**
 * Полнота набора: каждый плагин известен, и у каждого `requires` есть поставщик нужной мажорной версии среди плагинов набора.
 * Необязательное (`optional`, `consumes`) не требуется, но отсутствие поставщика `optional` попадает в notes.
 */
export function closureProblems(bundleId: string, rel: string, ids: readonly string[], viewOf: (id: string) => ContractView | undefined, problems: Problem[], what = 'каталоге'): { notes: string[] } {
  const members: { id: string; view: ContractView }[] = [];
  for (const id of ids) {
    const view = viewOf(id);
    if (!view) problems.push({ where: rel, message: `плагина ${id} нет в ${what}` });
    else members.push({ id, view });
  }
  const providers = new Map<string, { plugin: string; versions: string[] }[]>();
  for (const m of members) {
    for (const [contract, value] of Object.entries(m.view.provides ?? {})) {
      const list = providers.get(contract) ?? [];
      list.push({ plugin: m.id, versions: providedVersions(value) });
      providers.set(contract, list);
    }
  }
  const supplied = (contract: string, range: string): string[] =>
    (providers.get(contract) ?? []).filter((x) => x.versions.some((v) => rangeAccepts(range, v))).map((x) => x.plugin);

  const notes: string[] = [];
  for (const m of members) {
    for (const [contract, range] of Object.entries(m.view.requires ?? {})) {
      if (typeof range !== 'string') continue;
      const found = supplied(contract, range);
      if (found.length === 0) problems.push({ where: rel, message: `бандл ${bundleId}: плагин ${m.id} требует ${contract} ${range}, поставщика в бандле нет` });
      if (found.length > 1) problems.push({ where: rel, message: `бандл ${bundleId}: ${contract} ${range} даёт несколько плагинов (${found.join(', ')}), а requires берёт одного` });
    }
    for (const [contract, range] of Object.entries(m.view.optional ?? {})) {
      if (typeof range === 'string' && supplied(contract, range).length === 0) notes.push(`${m.id}: необязательный ${contract} ${range} без поставщика`);
    }
  }
  return { notes };
}

/** Полнота набора по каталогу готовых плагинов. */
export function checkClosure(bundleId: string, rel: string, ids: readonly string[], catalog: Catalog, problems: Problem[]): { notes: string[] } {
  const byId = new Map(catalog.plugins.map((p) => [p.id, p]));
  return closureProblems(bundleId, rel, ids, (id) => byId.get(id)?.manifest, problems);
}
