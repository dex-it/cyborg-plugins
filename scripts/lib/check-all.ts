// Проверка репозитория без ядра: раскладка каталога, карточки, манифесты (по полям, нужным каталогу) и полнота бандлов.
// Полную проверку каждого плагина (импорты, права, версия API) делает `cyborg-plugin check`: `npm run check:plugins`.

import { loadCatalog } from './catalog.ts';
import type { Catalog } from './catalog.ts';
import { checkClosure, loadBundles, resolveBundle } from './bundles.ts';
import type { Bundles } from './bundles.ts';
import type { Problem } from './util.ts';

export interface CheckResult {
  catalog: Catalog;
  bundles: Bundles;
  problems: Problem[];
  notes: string[];
}

export function checkRepo(root: string): CheckResult {
  const catalog = loadCatalog(root);
  const problems: Problem[] = [...catalog.problems];
  const bundles = loadBundles(root, catalog, problems);
  const notes: string[] = [];
  for (const b of bundles.bundles) {
    const ids = resolveBundle(b.id, bundles.bundles, problems);
    notes.push(...checkClosure(b.id, b.rel, ids, catalog, problems).notes.map((n) => `бандл ${b.id}: ${n}`));
  }
  return { catalog, bundles, problems, notes };
}
