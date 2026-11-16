import { MAX_HOSTS } from './limits.ts';

export { MAX_HOSTS } from './limits.ts';

/**
 * Алиас хоста из `~/.ssh/config`: без пробелов, управляющих символов и знаков двунаправленного письма, не начинается с «-» (иначе ssh примет его за ключ),
 * до 255 знаков. Форма та же, что у HOST_ALIAS в ai-cyborg (src/main/projects.ts).
 */
export const HOST_ALIAS = /^[^\s\p{Cc}‎‏‪-‮⁦-⁩-][^\s\p{Cc}‎‏‪-‮⁦-⁩]{0,254}$/u;

/** Хосты из сохранённых данных: строки по форме, без повторов, не больше MAX_HOSTS; не массив - пусто. */
export function readHosts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const hosts = value.filter((h): h is string => typeof h === 'string' && HOST_ALIAS.test(h));
  return [...new Set(hosts)].slice(0, MAX_HOSTS);
}

/** Хосты при сохранении: нет поля - допустимо, есть - массив по форме до MAX_HOSTS; иначе `null` (как validateHosts в ai-cyborg). */
export function validateHosts(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_HOSTS || value.some((h) => typeof h !== 'string' || !HOST_ALIAS.test(h))) return null;
  return [...new Set(value as string[])];
}

/** Ошибки списка хостов для формы свойств проекта: по строке на ошибку. */
export function hostProblems(value: unknown): string[] {
  if (value === undefined) return [];
  // Форма отдаёт `list` строкой через запятую либо уже списком.
  const list = typeof value === 'string' ? splitList(value) : value;
  if (!Array.isArray(list)) return ['хосты - список алиасов'];
  const problems: string[] = [];
  if (list.length > MAX_HOSTS) problems.push(`хостов не больше ${String(MAX_HOSTS)}`);
  for (const h of list) {
    if (typeof h !== 'string') problems.push('алиас хоста - строка');
    else if (h.startsWith('-')) problems.push(`алиас «${h.slice(0, 40)}» не может начинаться с «-»: ssh примет его за ключ`);
    else if (!HOST_ALIAS.test(h)) problems.push(`алиас «${h.slice(0, 40)}» содержит пробел или управляющий символ либо длиннее 255 знаков`);
  }
  return problems;
}

/** Список из строки формы: через запятую или перевод строки, пустые отброшены. */
export function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
