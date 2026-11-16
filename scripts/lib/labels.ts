// Метки GitHub как файл: .github/labels.json - единственный источник набора меток репозитория.
// `npm run sync-labels` приводит репозиторий к файлу; правила и группы - docs/guide/development/labels.md.

import path from 'node:path';
import { isRecord, readJson } from './util.ts';
import type { Problem } from './util.ts';
import type { Category } from './catalog.ts';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export const LABELS_FILE = path.join('.github', 'labels.json');
/** Предел GitHub на длину описания метки. */
export const MAX_DESCRIPTION = 100;

export function loadLabels(root: string, problems: Problem[]): Label[] {
  const where = '.github/labels.json';
  const raw = readJson(path.join(root, LABELS_FILE), root, problems);
  if (!Array.isArray(raw)) {
    if (raw !== undefined) problems.push({ where, message: 'ожидался список меток' });
    return [];
  }
  const labels: Label[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const at = `${where}[${i}]`;
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.color !== 'string' || typeof item.description !== 'string') {
      problems.push({ where: at, message: 'ожидался объект с name, color и description (строками)' });
      continue;
    }
    if (Object.keys(item).length !== 3) problems.push({ where: at, message: 'допустимы только name, color и description' });
    if (item.name.trim() === '') problems.push({ where: at, message: 'пустое имя метки' });
    if (seen.has(item.name.toLowerCase())) problems.push({ where: at, message: `метка «${item.name}» повторена (имена без учёта регистра)` });
    seen.add(item.name.toLowerCase());
    if (!/^[0-9a-f]{6}$/i.test(item.color)) problems.push({ where: at, message: `color «${item.color}» - шесть шестнадцатеричных цифр без #` });
    if (item.description.length > MAX_DESCRIPTION) problems.push({ where: at, message: `описание метки «${item.name}» длиннее ${MAX_DESCRIPTION} знаков` });
    labels.push({ name: item.name, color: item.color.toLowerCase(), description: item.description });
  }
  return labels;
}

/** Каждой категории каталога - своя метка `category: <id>`, и наоборот. */
export function checkCategoryLabels(labels: readonly Label[], categories: readonly Category[], problems: Problem[]): void {
  const where = '.github/labels.json';
  const have = new Set(labels.filter((l) => l.name.startsWith('category: ')).map((l) => l.name.slice('category: '.length)));
  const want = new Set(categories.map((c) => c.id));
  for (const id of want) if (!have.has(id)) problems.push({ where, message: `нет метки «category: ${id}» для категории ${id} из plugins/categories.json` });
  for (const id of have) if (!want.has(id)) problems.push({ where, message: `метка «category: ${id}» без категории ${id} в plugins/categories.json` });
}

export interface SyncPlan {
  create: Label[];
  update: Label[];
  /** Есть в репозитории, нет в файле. Удаляются только с --prune и только неиспользуемые. */
  extra: string[];
}

export function planSync(desired: readonly Label[], existing: readonly Label[]): SyncPlan {
  const have = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
  const plan: SyncPlan = { create: [], update: [], extra: [] };
  for (const d of desired) {
    const e = have.get(d.name.toLowerCase());
    if (!e) plan.create.push(d);
    else if (e.name !== d.name || e.color.toLowerCase() !== d.color.toLowerCase() || e.description !== d.description) plan.update.push(d);
  }
  const want = new Set(desired.map((d) => d.name.toLowerCase()));
  plan.extra = existing.filter((e) => !want.has(e.name.toLowerCase())).map((e) => e.name);
  return plan;
}
