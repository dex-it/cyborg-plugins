// Пути и ссылки из вывода сессии (src/main/open-path.ts ai-cyborg). Интерфейсу не доверяют: форма проверяется здесь, а что открывать можно, решает шлюз ядра
// (право `shell`): он не открывает исполняемые файлы по расширению и биту `x`, ссылку раскрывает до настоящего файла и не пускает вне областей.

/** Путь из вывода сессии: абсолютный или от `~`. Существование и «не запускается» проверяет ядро при открытии. */
export function openablePath(value: unknown, home: string): { path: string } | { error: string } {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f]/.test(value)) return { error: 'Некорректный путь' };
  const expanded = value === '~' || value.startsWith('~/') ? `${home.replace(/\/+$/, '')}${value.slice(1)}` : value;
  if (!expanded.startsWith('/')) return { error: `Путь не абсолютный: ${value}` };
  if (expanded.split('/').includes('..')) return { error: `Путь с «..» не открывается: ${value}` };
  return { path: expanded };
}

/** Только http(s): иные схемы (javascript:, file:, ссылки на приложения) браузеру системы не отдаются. */
export function webUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
