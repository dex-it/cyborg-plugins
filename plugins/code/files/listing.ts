import type { OsFs } from '@cyborg-harness/contracts';

// Чтение каталога (канал `fs:list` ai-cyborg, `src/main/files.ts`): без `.git`, каталоги раньше файлов, внутри групп по имени (`localeCompare`).
// Отличия от ai-cyborg: запись называет род (`kind`), а не булево `isDir`; ссылка, цель которой вне `workspace` или не читается, остаётся ссылкой (`link`) и не раскрывается:
// ядро всегда раскрывает ссылки (`realpath`), и каталог по ссылке наружу ему закрыт (`PermissionDenied`), а не открыт, как строке `AllowedPaths` ai-cyborg.

/** Род записи: файл, каталог, ссылка без читаемой цели или другое. */
export type EntryKind = 'file' | 'dir' | 'link' | 'other';

/** Запись каталога. `link` - ссылка, цель которой читаема: показана как цель (каталог раскрывается, файл открывается). */
export interface Entry {
  readonly name: string;
  readonly kind: EntryKind;
  readonly link?: true;
}

/** Каталог git не часть дерева: его изменения - дело плагина `git`. */
export const HIDDEN = new Set(['.git']);

export const isCode = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;

/** Каталоги раньше файлов, затем по имени; исходный список не меняется. */
export function sortEntries<T extends { readonly name: string; readonly kind: EntryKind }>(entries: Iterable<T>): T[] {
  return [...entries].sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name));
}

/**
 * Путь, который плагин готов отдать шлюзу: абсолютный, без NUL, без сегментов `.` и `..` (строка внутри корня после `..` могла бы выйти из него: `/repo/link/..`).
 * Повторные и хвостовые `/` снимаются. Остальное решает шлюз: путь вне `workspace` - `PermissionDenied`, ссылка наружу тоже.
 */
export function cleanPath(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 4096 || value.includes('\0')) throw new Error(`${what}: нужен путь строкой`);
  if (!value.startsWith('/')) throw new Error(`${what}: нужен абсолютный путь`);
  const parts = value.split('/').filter((s) => s !== '');
  if (parts.some((s) => s === '.' || s === '..')) throw new Error(`${what}: путь с «.» или «..» не принимается`);
  return `/${parts.join('/')}`;
}

/** Каталог целиком: записи без `.git`; ссылка раскрывается `stat`'ом, если цель читаема. Ошибка шлюза (вне области, нет каталога) идёт вызывающему как есть. */
export async function listDir(fs: Pick<OsFs, 'list' | 'stat'>, dir: string): Promise<Entry[]> {
  const raw = await fs.list(dir);
  const out: Entry[] = [];
  const links: Promise<void>[] = [];
  for (const e of raw) {
    if (HIDDEN.has(e.name)) continue;
    if (e.kind !== 'link') {
      out.push({ name: e.name, kind: e.kind });
      continue;
    }
    // Ссылка наружу `workspace` (`PermissionDenied`), висячая (`NotFound`) или с петлёй остаётся ссылкой: её цель дереву не показана.
    links.push(
      fs.stat(`${dir}/${e.name}`).then(
        (st) => void out.push({ name: e.name, kind: st.kind, link: true }),
        () => void out.push({ name: e.name, kind: 'link' }),
      ),
    );
  }
  await Promise.all(links);
  return sortEntries(out);
}
