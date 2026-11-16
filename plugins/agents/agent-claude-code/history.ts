import type { HistoryEntry, OsFs } from '@cyborg-harness/contracts';

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Журнал длинной сессии - мегабайты: заголовок и первый запрос ищутся только у краёв файла.
const EDGE_BYTES = 64 * 1024;
const LIMIT = 50;
const TITLE_MAX = 120;
// Сессия, ушедшая в worktree (`EnterWorktree`: <repo>/.claude/worktrees/<имя>), пишет журнал в каталог проекта worktree: его имя -
// projectDirName пути worktree, то есть каталог репозитория плюс `--claude-worktrees-<имя>`. Так изолируется каждая параллельная
// сессия, и без этих каталогов история не видела бы именно такие сессии. Возобновляет их `claude --resume <id>` из каталога
// репозитория: Claude Code сам находит журнал worktree и возвращает сессию в него (FR-5008).
const WORKTREE_INFIX = '--claude-worktrees-';

/** Имя каталога журналов проекта в `~/.claude/projects`: всё, кроме букв и цифр, - «-». */
export const projectDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** Идентификатор журнала Claude Code: только UUID, поэтому в путь не попадут ни `..`, ни разделители. */
export const isSessionId = (value: unknown): value is string => typeof value === 'string' && SESSION_UUID.test(value);

const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

function promptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const text = (content as ({ type?: unknown; text?: unknown } | null)[]).find((c) => c?.type === 'text');
  return typeof text?.text === 'string' ? text.text : '';
}

export interface JournalFacts {
  /** Сессия запущена человеком в терминале, а не `claude -p` / SDK. */
  interactive: boolean;
  /** Последний custom-title, иначе последний ai-title, иначе первый набранный запрос. */
  title: string;
  /** Последний custom-title, иначе последний ai-title; пусто, пока Claude Code не назвал разговор. */
  named: string;
  firstPrompt: string;
}

export function journalFacts(head: string, tail: string): JournalFacts {
  let entrypoint: string | undefined;
  let custom = '';
  let ai = '';
  let firstPrompt = '';
  for (const [chunk, isHead] of [
    [head, true],
    [tail, false],
  ] as const) {
    for (const line of chunk.split('\n')) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (isHead && entrypoint === undefined && typeof record.entrypoint === 'string') entrypoint = record.entrypoint;
      if (record.type === 'custom-title' && typeof record.customTitle === 'string') custom = record.customTitle;
      if (record.type === 'ai-title' && typeof record.aiTitle === 'string') ai = record.aiTitle;
      if (isHead && !firstPrompt && record.type === 'user' && !record.isMeta) {
        const text = promptText((record.message as { content?: unknown } | undefined)?.content).trim();
        // `<local-command-caveat>` и прочая служебная разметка - не набранный человеком текст.
        if (text && !text.startsWith('<')) firstPrompt = text;
      }
    }
  }
  return { interactive: entrypoint === 'cli', title: oneLine(custom || ai || firstPrompt), named: oneLine(custom || ai), firstPrompt };
}

/** Каталоги журналов репозитория в `root`: собственный и его worktree. Имена берутся из листинга `root`, а не из ввода. */
async function journalDirs(fs: OsFs, root: string, cwd: string): Promise<string[]> {
  const own = projectDirName(cwd);
  const entries = await fs.list(root).catch(() => []);
  return entries.filter((e) => e.kind === 'dir' && (e.name === own || e.name.startsWith(own + WORKTREE_INFIX))).map((e) => e.name);
}

/** Интерактивные сессии каталога и его worktree, свежие первыми; журнал без заголовка не показывается. */
export async function listHistory(fs: OsFs, root: string, cwd: string, limit = LIMIT): Promise<HistoryEntry[]> {
  const candidates: { id: string; file: string; size: number; updated: number }[] = [];
  for (const dir of await journalDirs(fs, root, cwd)) {
    for (const entry of await fs.list(`${root}/${dir}`).catch(() => [])) {
      const id = entry.name.replace(/\.jsonl$/, '');
      if (entry.kind !== 'file' || id === entry.name || !isSessionId(id)) continue;
      const file = `${root}/${dir}/${entry.name}`;
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat && stat.size > 0) candidates.push({ id, file, size: stat.size, updated: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.updated - a.updated);
  const entries: HistoryEntry[] = [];
  for (const c of candidates) {
    if (entries.length >= limit) break;
    try {
      const head = await fs.readSlice(c.file, 0, EDGE_BYTES);
      const tail = c.size > EDGE_BYTES ? await fs.readSlice(c.file, c.size - EDGE_BYTES, EDGE_BYTES) : { text: '' };
      const facts = journalFacts(head.text, tail.text);
      if (facts.interactive && facts.title) entries.push({ id: c.id, cwd, title: facts.title, updated: c.updated });
    } catch {
      continue;
    }
  }
  return entries;
}

/** Каталог журналов, где лежит `<id>.jsonl` сессии каталога `cwd`: сам каталог либо его worktree. */
async function journalDirOf(fs: OsFs, root: string, cwd: string, id: string): Promise<string | undefined> {
  if (!isSessionId(id)) return undefined;
  for (const dir of await journalDirs(fs, root, cwd)) {
    const stat = await fs.stat(`${root}/${dir}/${id}.jsonl`).catch(() => undefined);
    if (stat?.kind === 'file') return dir;
  }
  return undefined;
}

export async function historyExists(fs: OsFs, root: string, cwd: string, id: string): Promise<boolean> {
  return (await journalDirOf(fs, root, cwd, id)) !== undefined;
}

export const NOT_FOUND = 'Журнал сессии не найден';
export const BAD_DELETE = 'Некорректное удаление сессии';

/**
 * Журнал сессии и её каталог (вывод инструментов, субагенты) удаляются; продолжить её после этого нельзя.
 * Пишет только по двум путям `<root>/<каталог журналов каталога cwd>/<id>` и `.../<id>.jsonl`: id - UUID, каталог - из листинга `root`.
 */
export async function deleteHistory(fs: OsFs, root: string, cwd: string, id: string): Promise<void> {
  const dir = await journalDirOf(fs, root, cwd, id);
  if (dir === undefined) throw new Error(NOT_FOUND);
  await fs.remove(`${root}/${dir}/${id}`);
  await fs.remove(`${root}/${dir}/${id}.jsonl`);
}

export interface DeleteResult {
  readonly deleted: readonly string[];
  /** Сбой одной сессии остальные не останавливает: неудавшиеся перечисляются с причиной. */
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

/** Удаление нескольких сессий разом (FR-8005): по одной, с теми же проверками, что у одной. */
export async function deleteSessions(fs: OsFs, root: string, cwd: unknown, ids: unknown): Promise<DeleteResult> {
  if (typeof cwd !== 'string' || cwd === '' || !Array.isArray(ids)) throw new Error(BAD_DELETE);
  const deleted: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const id of ids as unknown[]) {
    if (!isSessionId(id)) {
      failed.push({ id: String(id), reason: BAD_DELETE });
      continue;
    }
    try {
      await deleteHistory(fs, root, cwd, id);
      deleted.push(id);
    } catch (error) {
      failed.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deleted, failed };
}
