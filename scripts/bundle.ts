// npm run bundle -- <id | --all> [--out <каталог>] [--pack]
// Собирает поставку бандла (см. scripts/lib/build-bundle.ts). По умолчанию результат - dist/bundles.

import path from 'node:path';
import { buildBundle, listBundleIds } from './lib/build-bundle.ts';
import { REPO_ROOT, printProblems } from './lib/util.ts';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const outIndex = args.indexOf('--out');
const out = path.resolve(REPO_ROOT, outIndex >= 0 ? (args[outIndex + 1] ?? '') : path.join('dist', 'bundles'));
const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const ids = flag('--all') ? listBundleIds(REPO_ROOT) : names;

if (flag('--all') && ids.length === 0) {
  console.log('bundle: в bundles/ нет ни одного бандла, собирать нечего');
  process.exit(0);
}
if (ids.length === 0) {
  console.error('Использование: npm run bundle -- <id бандла>... | --all [--out <каталог>] [--pack]');
  process.exit(2);
}

let failed = false;
for (const id of ids) {
  const { result, problems } = buildBundle(REPO_ROOT, id, { out, pack: flag('--pack') });
  if (!result) {
    printProblems(problems);
    failed = true;
    continue;
  }
  console.log(`bundle ${id}: ${result.plugins.length} плагинов -> ${path.relative(REPO_ROOT, result.dir)}${result.archive ? `, архив ${path.relative(REPO_ROOT, result.archive)}` : ''}`);
}
process.exit(failed ? 1 : 0);
