import type { ProcessResult } from '@cyborg-harness/contracts';
import { FILTER_CONFIG_ARGS, LS_STAGE_ARGS } from './args.ts';
import { resolve } from './posix.ts';

// `git status` гоняет clean-фильтр по файлам с изменившимися stat-данными, а драйвер фильтра задаётся ключами `filter.<имя>.clean|process|required` конфига репозитория: отключить его одним `-c` нельзя.
// Поэтому перед status собираются ключи репозитория и вложенных (их status запускает дочерним процессом с тем же окружением) и перекрываются через GIT_CONFIG_COUNT/KEY/VALUE: в отличие от `-c`, имя ключа берётся как есть, с любым именем фильтра.
// Фильтры из пользовательского и системного конфига доверенные и остаются. Сбор ключей не должен молча давать неполный набор: любая ошибка, кроме «нет совпадений», уходит наверх, и status не запускается.
// Перенос `filterOverrides` и `repoFilterKeys` из `src/main/git.ts` ai-cyborg; пилот PL-04 ядра (`playground/plugins/git/filters.ts`) - образец формы.

/** Глубже git status спустился бы без перекрытия, поэтому превышение предела - ошибка, а не обрезка. */
const MAX_DEPTH = 8;
/** Ключи, заданные в репозитории; `system`, `global` и `command` - доверенные слои. */
export const REPO_SCOPES = new Set(['local', 'worktree']);
const GITLINK = '160000 ';
const BROKEN_TEXT = '�';
export const NOT_A_REPOSITORY = /not a git repository/i;

export interface FilterHost {
  /** Запуск git в каталоге; `args` - после закреплённого начала (`SAFE_ARGS`), `env` - только имена из правила process. */
  git(args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>): Promise<ProcessResult>;
  /** Каталог есть и в нём свой `.git`. */
  populated(dir: string): Promise<boolean>;
}

function ok(result: ProcessResult, what: string): void {
  if (result.truncated) throw new Error(`${what}: вывод длиннее предела, ключи фильтров не собрать`);
  if (result.code !== 0) throw new Error(`${what}: код ${String(result.code ?? result.signal)}: ${result.stderr.trim().slice(0, 200)}`);
}

/** Путь вложенного репозитория внутри `dir`; путь, выходящий из него, git не отдаёт, но проверка дешёвая и держит инвариант. */
function nested(dir: string, rel: string): string | undefined {
  if (rel === '' || rel.startsWith('/') || rel.split('/').some((part) => part === '..' || part === '.' || part === '')) return undefined;
  return resolve(dir, rel);
}

/** Ключи фильтров репозитория в `dir` и вложенных; `null` - `dir` не репозиторий. */
async function repoFilterKeys(host: FilterHost, dir: string, depth: number): Promise<Set<string> | null> {
  // Конфиг и индекс читаются независимо, поэтому параллельно.
  const [config, index] = await Promise.all([
    // LC_ALL=C: в UTF-8 локали `.` в ERE git не сопоставляется с невалидным UTF-8, и такой ключ не попал бы в вывод.
    host.git(FILTER_CONFIG_ARGS, dir, { LC_ALL: 'C' }),
    host.git(LS_STAGE_ARGS, dir),
  ]);
  if (index.code !== 0 && depth === 0 && NOT_A_REPOSITORY.test(index.stderr)) return null;
  // Код 1 у `--get-regexp` - «совпадений нет».
  if (config.truncated || config.code !== 1) ok(config, 'git config');
  ok(index, 'git ls-files');

  const keys = new Set<string>();
  const fields = config.stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [scope, key] = [fields[i] ?? '', fields[i + 1] ?? ''];
    if (!REPO_SCOPES.has(scope)) continue;
    if (key.includes(BROKEN_TEXT)) throw new Error('ключ фильтра не в UTF-8, перекрыть нельзя');
    keys.add(key);
  }

  const populated: string[] = [];
  for (const entry of index.stdout.split('\0')) {
    if (!entry.startsWith(GITLINK)) continue;
    const rel = entry.slice(entry.indexOf('\t') + 1);
    const sub = nested(dir, rel);
    // Незаполненный подмодуль git status не открывает, а git из него нашёл бы родителя и зациклил рекурсию.
    if (sub === undefined || !(await host.populated(sub))) continue;
    if (rel.includes(BROKEN_TEXT)) throw new Error('путь вложенного репозитория не в UTF-8, перекрыть его фильтры нельзя');
    populated.push(sub);
  }
  if (populated.length > 0 && depth >= MAX_DEPTH) throw new Error('вложенность репозиториев глубже предела');
  for (const sub of populated) {
    for (const key of (await repoFilterKeys(host, sub, depth + 1)) ?? []) keys.add(key);
  }
  return keys;
}

/**
 * Окружение для `git status` в `root`, перекрывающее фильтры репозитория и вложенных; `null` - `root` не репозиторий.
 * Прежнего GIT_CONFIG_COUNT нет: шлюз передаёт программе только базовое окружение и имена из правила.
 */
export async function filterOverrides(host: FilterHost, root: string): Promise<Record<string, string> | null> {
  const keys = await repoFilterKeys(host, root, 0);
  if (keys === null) return null;
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(keys.size) };
  [...keys].forEach((key, i) => {
    env[`GIT_CONFIG_KEY_${String(i)}`] = key;
    // `required = true` у фильтра, который не запустили, роняет status; пустое значение отключает сам драйвер.
    env[`GIT_CONFIG_VALUE_${String(i)}`] = key.endsWith('.required') ? 'false' : '';
  });
  return env;
}
