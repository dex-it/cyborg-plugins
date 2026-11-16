// Сравнение версий контрактов по правилам манифеста ядра (docs/guide/reference/manifest.md ядра):
// поставщик объявляет `1.1`, потребитель просит `*`, `1`, `1.2`, `^1.4` или `~2.3`.
// Это предпроверка бандла до сборки; окончательно граф строит ядро при загрузке.

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(text: string): Version | undefined {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(text.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

export function isPluginVersion(text: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text);
}

/** Версии контракта из значения `provides`: строка, список или объект `{ version }`. */
export function providedVersions(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'object' && value !== null && 'version' in value) return providedVersions((value as { version: unknown }).version);
  return [];
}

export function rangeAccepts(range: string, provided: string): boolean {
  const r = range.trim();
  if (r === '*' || r === '') return true;
  const v = parseVersion(provided);
  const m = /^([\^~]?)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(r);
  if (!v || !m) return false;
  const major = Number(m[2]);
  if (v.major !== major) return false;
  if (m[3] === undefined) return true;
  const minor = Number(m[3]);
  if (m[1] === '^' && major > 0) return v.minor >= minor;
  return v.minor === minor;
}
