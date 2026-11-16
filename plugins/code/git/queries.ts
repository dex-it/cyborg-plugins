import type { ProcessResult } from '@cyborg-harness/contracts';
import type { GitBranches } from '@cyborg-plugins/contracts';
import { BLOB_ARGS, BRANCH_ARGS, BRANCHES_ARGS, FILES_ARGS, REMOTES_ARGS, ROOT_ARGS, SIZE_ARGS } from './args.ts';
import { dirname, within } from './posix.ts';

// Читающие запросы ai-cyborg (`src/main/git.ts`): корень, ветка, файлы, содержимое HEAD, remote, ветки. Ошибка git (не репозиторий, нет коммита) - пустой ответ, как там.

/** Запуск git в каталоге: аргументы после закреплённого начала. */
export type Run = (args: readonly string[], cwd: string, options?: { readonly maxOutputBytes?: number; readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number }) => Promise<ProcessResult>;

/** Репозиторий с этим файлом больше не читается: текст больше предела - не показывать сравнение. */
export const MAX_ORIGINAL_BYTES = 5 * 1024 * 1024;
/** Двоичным файл считается по нулевому байту в первых 8000 байтах. */
const BINARY_PROBE_BYTES = 8000;
/** Вывод `ls-files` и `for-each-ref` в большом репозитории: предел `maxBuffer` ai-cyborg, 64 МиБ. */
export const BIG_OUTPUT = 64 * 1024 * 1024;

const FAILED: ProcessResult = { code: null, signal: null, stdout: '', stderr: '', truncated: false };

/**
 * Читающий запрос, как у ai-cyborg, любой отказ называет пустым ответом: каталога нет (`spawn ENOENT`), он вне области чтения, git не нашёлся.
 * Пустой ответ ничего не раскрывает; отказ шлюза остаётся записью `denied` в журнале ядра.
 */
function quiet(run: Run): Run {
  return (args, cwd, options) => run(args, cwd, options).catch(() => FAILED);
}

const clean = (result: ProcessResult): string | null => (result.code === 0 && !result.truncated ? result.stdout : null);

export async function gitRoot(raw: Run, dir: string): Promise<string | null> {
  const run = quiet(raw);
  const out = clean(await run(ROOT_ARGS, dir));
  return out === null ? null : out.trim();
}

/** Имя ветки; голова отсоединена - `HEAD`, как у `rev-parse --abbrev-ref`. */
export async function gitBranch(raw: Run, root: string): Promise<string | null> {
  const run = quiet(raw);
  const out = clean(await run(BRANCH_ARGS, root));
  return out === null ? null : out.trim();
}

/** Файлы под root относительно него, без игнорируемых .gitignore; null - root не в git. */
export async function gitFiles(raw: Run, root: string): Promise<string[] | null> {
  const run = quiet(raw);
  const out = clean(await run(FILES_ARGS, root, { maxOutputBytes: BIG_OUTPUT }));
  return out === null ? null : [...new Set(out.split('\0').filter(Boolean))];
}

/** Текст файла в HEAD его репозитория; нет репозитория, файла в HEAD, двоичный или больше предела - null. */
export async function gitHeadContent(raw: Run, file: string): Promise<string | null> {
  const run = quiet(raw);
  const dir = dirname(file);
  const root = await gitRoot(raw, dir);
  if (!root) return null;
  const rel = within(root, file);
  if (rel === null) return null;
  // `HEAD:./путь` - путь относительно каталога запуска (корня), а не рабочего дерева, и всегда начинается с `HEAD:`, а не с «-».
  const spec = `HEAD:./${rel}`;
  const size = clean(await run([...SIZE_ARGS, spec], root));
  if (size === null || Number(size) > MAX_ORIGINAL_BYTES) return null;
  // cat-file blob отдаёт байты как есть: ни textconv, ни smudge-фильтр репозитория не запускаются.
  const blob = clean(await run([...BLOB_ARGS, spec], root, { maxOutputBytes: MAX_ORIGINAL_BYTES + 1024 }));
  if (blob === null) return null;
  return new TextEncoder().encode(blob.slice(0, BINARY_PROBE_BYTES)).subarray(0, BINARY_PROBE_BYTES).includes(0) ? null : blob;
}

/** URL всех fetch-remote репозитория (у частичного клона после `(fetch)` стоит `[blob:none]`); не git или нет remote - пусто. Только читающая команда. */
export async function gitRemotes(raw: Run, root: string): Promise<string[]> {
  const run = quiet(raw);
  const out = clean(await run(REMOTES_ARGS, root));
  if (out === null) return [];
  return out
    .split('\n')
    .map((line) => /^\S+\s+(\S+)\s+\(fetch\)(?:\s+\[[^\]]*\])?$/.exec(line.trim())?.[1])
    .filter((url): url is string => !!url);
}

/** Свежие первыми; не git - пустые списки. */
export async function gitBranches(raw: Run, root: string): Promise<GitBranches> {
  const run = quiet(raw);
  const [current, out] = await Promise.all([gitBranch(raw, root), run(BRANCHES_ARGS, root).then(clean)]);
  if (out === null) return { current: null, local: [], remote: [] };
  const local: string[] = [];
  const remote = new Set<string>();
  for (const ref of out.split('\n')) {
    if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
    else {
      const name = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)?.[1];
      if (name && name !== 'HEAD') remote.add(name);
    }
  }
  for (const name of local) remote.delete(name);
  return { current: current === 'HEAD' ? null : current, local, remote: [...remote] };
}
