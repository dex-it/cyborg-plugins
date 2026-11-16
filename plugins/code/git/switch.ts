import type { GitSwitchResult } from '@cyborg-plugins/contracts';
import { SWITCH_ARGS, SWITCH_RISK_ARGS } from './args.ts';
import { REPO_SCOPES } from './filters.ts';
import { gitBranches, type Run } from './queries.ts';

// Смена ветки (`gitSwitch` и `repoSwitchRisk` ai-cyborg): репозиторий меняется единственной командой `git switch` и только когда она не запустит команду из конфига.
// Решения «репозиторий проекта» и «работает сессия» принимает вызывающая сторона (`index.ts`): здесь только git.

/** Срок самой смены: выписывание файлов большого репозитория долгое, а убитая посередине смена оставляет `index.lock`. */
export const SWITCH_TIMEOUT_MS = 10 * 60_000;

/**
 * Выписывание файлов запускает smudge-фильтры, а в partial clone - докачку недостающих объектов транспортом из конфига
 * (core.sshCommand, remote.*.uploadpack); GIT_NO_LAZY_FETCH есть только с git 2.45, поэтому такие репозитории не переключаются.
 * Возвращает первый ключ из слоёв репозитория, который это запустил бы; `null` - таких нет.
 */
export async function switchRisk(run: Run, root: string): Promise<string | null> {
  const result = await run(SWITCH_RISK_ARGS, root, { env: { LC_ALL: 'C' } });
  // Код 1 у `--get-regexp` - «совпадений нет».
  if (result.code === 1 && !result.truncated) return null;
  if (result.code !== 0 || result.truncated) throw new Error(`не удалось проверить конфиг репозитория: ${firstLine(result.stderr) || `код ${String(result.code ?? result.signal)}`}`);
  const cfg = result.stdout.split('\0');
  for (let i = 0; i + 1 < cfg.length; i += 2) if (REPO_SCOPES.has(cfg[i] ?? '')) return cfg[i + 1] ?? null;
  return null;
}

/** Первая строка причины, с которой git отказал: без `error: ` и `fatal: `. */
export function firstLine(stderr: string): string {
  const line = stderr.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().replace(/^(error|fatal): /, '');
}

/** Только ветка из `branches`: имя не уходит в git опцией. Незакоммиченные правки git переносит сам или отказывает. */
export async function gitSwitch(run: Run, root: string, branch: string): Promise<GitSwitchResult> {
  try {
    const { local, remote } = await gitBranches(run, root);
    if (branch.startsWith('-') || (!local.includes(branch) && !remote.includes(branch))) return { error: `Ветки ${branch} нет` };
    const risk = await switchRisk(run, root);
    if (risk) return { error: `в конфиге репозитория задан ${risk}: при смене ветки git запустил бы команду из него, переключите ветку в терминале` };
    const result = await run([...SWITCH_ARGS, branch], root, { timeoutMs: SWITCH_TIMEOUT_MS });
    if (result.code === 0) return {};
    return { error: firstLine(result.stderr) || 'git switch не выполнен' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
