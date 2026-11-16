// Пути без `node:path`: плагину он запрещён. Пути git - абсолютные, с `/`; Windows плагин не поддерживает (платформы эпика: macOS и Linux).

export function dirname(file: string): string {
  const i = file.lastIndexOf('/');
  return i <= 0 ? '/' : file.slice(0, i);
}

/** `rel` относительно `base` (абсолютный путь, `..` и `.` сворачиваются); абсолютный `rel` возвращается нормализованным. */
export function resolve(base: string, rel: string): string {
  const parts: string[] = [];
  for (const part of (rel.startsWith('/') ? rel : `${base}/${rel}`).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Путь `file` внутри `root` без начального `/`; вне корня или сам корень - `null`. */
export function within(root: string, file: string): string | null {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!file.startsWith(prefix)) return null;
  const rel = file.slice(prefix.length);
  return rel === '' || rel === '..' || rel.startsWith('../') ? null : rel;
}
