import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Problem {
  where: string;
  message: string;
}

export const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
/** Идентификаторы, которые ядро держит за собой (docs/guide/reference/manifest.md ядра). */
export const RESERVED_IDS = new Set(['cyborg', 'cyborg.window', 'cyborg.workspace']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Читает JSON; ошибка разбора превращается в замечание, а не в исключение. */
export function readJson(file: string, root: string, problems: Problem[]): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    problems.push({ where: path.relative(root, file), message: `не читается как JSON: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

/** Ключи объекта, которых нет в списке допустимых: каждое поле описано, лишнее называется. */
export function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

export function printProblems(problems: readonly Problem[]): void {
  for (const p of problems) console.error(`${p.where}: ${p.message}`);
}
