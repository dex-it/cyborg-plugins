// npm run harness:link [каталог клона cyborg-harness]
// Пока пакеты ядра не в реестре npm, кладёт в node_modules ссылки на собранный клон ядра:
// @cyborg-harness/{contracts,core,electron,testing} и cyborg-plugin. После выпуска пакетов не нужно.
// Клон должен быть собран: `npm ci && npm run build:packages` в нём. Путь: аргумент, CYBORG_HARNESS_DIR или ../cyborg-harness.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/util.ts';

const harness = path.resolve(REPO_ROOT, process.argv[2] ?? process.env.CYBORG_HARNESS_DIR ?? path.join('..', 'cyborg-harness'));
const links: [string, string, string][] = [
  ['@cyborg-harness/contracts', 'contracts', 'dist'],
  ['@cyborg-harness/core', 'core', 'dist'],
  ['@cyborg-harness/electron', 'electron', 'dist'],
  ['@cyborg-harness/testing', 'testing', 'dist'],
  ['cyborg-plugin', path.join('tools', 'cyborg-plugin'), 'dist'],
];

if (!existsSync(path.join(harness, 'core', 'package.json'))) {
  console.error(`harness:link: ${harness} не похож на клон cyborg-harness (нет core/package.json)`);
  process.exit(1);
}
let made = 0;
for (const [name, source, builtMarker] of links) {
  const target = path.join(harness, source);
  if (!existsSync(path.join(target, builtMarker))) {
    console.error(`harness:link: ${source} не собран (нет ${builtMarker}/): в клоне выполните npm ci && npm run build:packages`);
    process.exit(1);
  }
  const link = path.join(REPO_ROOT, 'node_modules', name);
  mkdirSync(path.dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, 'dir');
  made++;
}
console.log(`harness:link: ${made} ссылок на ${harness}`);

// Сборка ядра старше его исходников: тесты пойдут на устаревшем поведении (так, сборка двухдневной давности не знала правила deny).
const newest = (dir: string, ext: RegExp): number =>
  existsSync(dir) ? Math.max(0, ...readdirSync(dir).filter((n) => ext.test(n)).map((n) => statSync(path.join(dir, n)).mtimeMs)) : 0;
const sources = Math.max(newest(path.join(harness, 'core', 'src'), /\.ts$/), newest(path.join(harness, 'contracts'), /\.ts$/));
const built = statSync(path.join(harness, 'core', 'dist')).mtimeMs;
if (sources > built) console.warn(`harness:link: ПРЕДУПРЕЖДЕНИЕ: исходники ядра новее его сборки (${new Date(sources).toISOString()} против ${new Date(built).toISOString()}); пересоберите: (cd ${harness} && npm run build:packages)`);
