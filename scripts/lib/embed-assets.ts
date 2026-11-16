// Ресурсы плагина: файлы, которые плагин кладёт на диск или отправляет по сети (плагин Claude Code со скиллами и хуками,
// демон для SSH-хоста). Поставка ядра несёт только манифест, `index.mjs`, схемы и всё не-исходное из `ui/`; каталог `assets/` до
// пользователя не доезжает. Поэтому ресурсы вшиваются в `index.mjs` строками (assets.generated.ts), а при активации плагин
// записывает их в свой каталог данных (`ctx.os.paths.data`, права не нужно). Подробно - docs/guide/authors/assets.md.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ASSETS_DIR = 'assets';
export const GENERATED_FILE = 'assets.generated.ts';
/** Такие файлы `cyborg-plugin check` читает как исходники и бракует `node:*` в них, даже если плагин их не импортирует. */
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/i;
/** `agentd.js.txt` на диске -> `agentd.js` при установке: исходного расширения в каталоге плагина быть не должно. */
const TXT_SUFFIX = /^(.+\.(?:[cm]?[jt]sx?))\.txt$/i;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface EmbedResult {
  /** Текст assets.generated.ts; пустой, если есть замечания. */
  module: string;
  /** Имена ресурсов после установки (`/`, без `.txt` у исходных расширений). */
  names: string[];
  version: string;
  bytes: number;
  problems: string[];
}

function walk(dir: string, base: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    if (lstatSync(file).isDirectory()) walk(file, base, out);
    else out.push(path.relative(base, file).split(path.sep).join('/'));
  }
}

export function installedName(rel: string): string {
  const m = TXT_SUFFIX.exec(rel);
  return m ? (m[1] ?? rel) : rel;
}

export function generateAssets(pluginDir: string): EmbedResult {
  const root = path.join(pluginDir, ASSETS_DIR);
  const problems: string[] = [];
  const entries = new Map<string, string>();
  const files: string[] = [];
  if (existsSync(root)) walk(root, root, files);
  let total = 0;
  for (const rel of files) {
    const abs = path.join(root, ...rel.split('/'));
    const where = `${ASSETS_DIR}/${rel}`;
    if (lstatSync(abs).isSymbolicLink()) {
      problems.push(`${where}: символическая ссылка: ресурс должен быть обычным файлом`);
      continue;
    }
    if (SOURCE_EXT.test(rel)) {
      problems.push(`${where}: исходное расширение: cyborg-plugin check прочтёт файл как код плагина и забракует node:*; назовите ${path.posix.basename(rel)}.txt`);
      continue;
    }
    const buf = readFileSync(abs);
    if (buf.length > MAX_FILE_BYTES) problems.push(`${where}: ${buf.length} байт, предел одного ресурса ${MAX_FILE_BYTES}`);
    const text = buf.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buf)) {
      problems.push(`${where}: не текст UTF-8: двоичные ресурсы не вшиваются (закодируйте в base64 текстом)`);
      continue;
    }
    total += buf.length;
    const name = installedName(rel);
    if (entries.has(name)) problems.push(`${where}: имя ${name} после установки совпадает с другим ресурсом`);
    entries.set(name, text);
  }
  if (total > MAX_TOTAL_BYTES) problems.push(`ресурсы весят ${total} байт, предел ${MAX_TOTAL_BYTES}: они целиком лежат в index.mjs`);
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const version = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
  const body = sorted.map(([name, text]) => `  ${JSON.stringify(name)}: ${JSON.stringify(text)},`).join('\n');
  const module = `// Сгенерировано: npm run embed-assets. Не править руками: правьте файлы в assets/ и запустите команду снова.
// Ресурсы плагина вшиты в index.mjs; installAssets кладёт их в каталог данных плагина (docs/guide/authors/assets.md).
import type { PluginOs } from '@cyborg-harness/contracts';

/** Ресурсы: путь внутри assets/ (без .txt у исходных расширений) -> текст. */
export const ASSETS: Readonly<Record<string, string>> = {
${body}
};

/** Первые 16 знаков sha256 содержимого: изменился ресурс - новый каталог установки, старый не переписывается. */
export const ASSET_VERSION = ${JSON.stringify(version)};

/**
 * Кладёт ресурсы в \`<данные плагина>/assets/<версия>/\` и возвращает этот каталог; уже установленную версию не трогает.
 * Файлы без бита исполнения: скрипты вызываются как \`bash "$каталог/hooks/x.sh"\`.
 */
export async function installAssets(os: Pick<PluginOs, 'fs' | 'paths'>): Promise<string> {
  const dir = \`\${os.paths.data}/assets/\${ASSET_VERSION}\`;
  const marker = \`\${dir}/.installed\`;
  const done = await os.fs.stat(marker).then(
    () => true,
    () => false,
  );
  if (done) return dir;
  for (const [name, text] of Object.entries(ASSETS)) {
    const file = \`\${dir}/\${name}\`;
    await os.fs.mkdir(file.slice(0, file.lastIndexOf('/')));
    await os.fs.writeText(file, text);
  }
  await os.fs.writeText(marker, ASSET_VERSION);
  return dir;
}
`;
  return { module: problems.length === 0 ? module : '', names: sorted.map(([n]) => n), version, bytes: total, problems };
}

export function writeAssets(pluginDir: string): EmbedResult {
  const result = generateAssets(pluginDir);
  if (result.problems.length === 0) writeFileSync(path.join(pluginDir, GENERATED_FILE), result.module);
  return result;
}

/** Состояние сгенерированного модуля плагина относительно его assets/: свежий, устарел, нет модуля, модуль без ресурсов. */
export function assetsStatus(pluginDir: string): { state: 'none' | 'fresh' | 'stale' | 'missing' | 'orphan' | 'invalid'; problems: string[] } {
  const hasDir = existsSync(path.join(pluginDir, ASSETS_DIR));
  const generated = path.join(pluginDir, GENERATED_FILE);
  const hasModule = existsSync(generated);
  if (!hasDir) return { state: hasModule ? 'orphan' : 'none', problems: [] };
  const result = generateAssets(pluginDir);
  if (result.problems.length > 0) return { state: 'invalid', problems: result.problems };
  if (!hasModule) return { state: 'missing', problems: [] };
  return { state: readFileSync(generated, 'utf8') === result.module ? 'fresh' : 'stale', problems: [] };
}
