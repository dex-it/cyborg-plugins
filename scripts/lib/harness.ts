// Где взять `cyborg-plugin`. Пакеты ядра ещё не в реестре (выпуск - P-10 ядра), поэтому, пока их нет,
// ядро берётся из клона cyborg-harness: `npm run harness:link` кладёт ссылки в node_modules.
// Когда пакеты выйдут, достаточно `npm install`: ссылки не понадобятся, а поиск ниже найдёт пакет сам.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './util.ts';

const CLI = path.join('dist', 'src', 'cli-bin.js');

export function findCyborgPlugin(root: string = REPO_ROOT): string {
  const candidates = [
    process.env.CYBORG_PLUGIN,
    path.join(root, 'node_modules', 'cyborg-plugin', CLI),
    process.env.CYBORG_HARNESS_DIR ? path.join(process.env.CYBORG_HARNESS_DIR, 'tools', 'cyborg-plugin', CLI) : undefined,
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error(
    'cyborg-plugin не найден. Пакеты ядра ещё не опубликованы: соберите клон cyborg-harness (npm ci && npm run build:packages) ' +
      'и выполните `npm run harness:link` (путь к клону - аргумент или CYBORG_HARNESS_DIR, по умолчанию ../cyborg-harness).',
  );
}

export interface RunResult {
  status: number;
}

/** Запускает `cyborg-plugin <args>` в каталоге `cwd` и печатает его вывод как есть. Сам инструмент ищется рядом с этим репозиторием. */
export function runCyborgPlugin(args: readonly string[], cwd: string = REPO_ROOT): RunResult {
  const result = spawnSync(process.execPath, [findCyborgPlugin(), ...args], { cwd, stdio: 'inherit' });
  return { status: result.status ?? 2 };
}
