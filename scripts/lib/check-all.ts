// Проверка репозитория без ядра: раскладка каталога, карточки, манифесты (по полям, нужным каталогу) и полнота бандлов.
// Полную проверку каждого плагина (импорты, права, версия API) делает `cyborg-plugin check`: `npm run check:plugins`.

import { loadCatalog } from './catalog.ts';
import type { Catalog } from './catalog.ts';
import { checkClosure, loadBundles, resolveBundle } from './bundles.ts';
import type { Bundles } from './bundles.ts';
import type { Problem } from './util.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { LABELS_FILE, checkCategoryLabels, loadLabels } from './labels.ts';
import { DESIGN_FILE, checkDesign, loadDesign } from './design.ts';
import type { Design } from './design.ts';

export interface CheckResult {
  catalog: Catalog;
  bundles: Bundles;
  design: Design;
  problems: Problem[];
  notes: string[];
}

export function checkRepo(root: string): CheckResult {
  const catalog = loadCatalog(root);
  const problems: Problem[] = [...catalog.problems];
  const bundles = loadBundles(root, catalog, problems);
  const notes: string[] = [];
  // Метки проверяются, если репозиторий их описывает (.github/labels.json): временные репозитории тестов файла не имеют.
  if (existsSync(path.join(root, LABELS_FILE))) checkCategoryLabels(loadLabels(root, problems), catalog.categories, problems);
  // Модель контрактов проверяется, если репозиторий её ведёт (plugins/planned-contracts.json): временные репозитории тестов файла не имеют.
  const design = loadDesign(root, problems);
  if (existsSync(path.join(root, DESIGN_FILE))) notes.push(...checkDesign(catalog, bundles, design, problems).notes);
  for (const b of bundles.bundles) {
    const ids = resolveBundle(b.id, bundles.bundles, problems);
    notes.push(...checkClosure(b.id, b.rel, ids, catalog, problems).notes.map((n) => `бандл ${b.id}: ${n}`));
  }
  return { catalog, bundles, design, problems, notes };
}
