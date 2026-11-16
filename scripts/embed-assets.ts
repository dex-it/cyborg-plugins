// npm run embed-assets -- <каталог плагина>... | --all [--check]
// Собирает assets.generated.ts из каталога assets/ плагина (см. scripts/lib/embed-assets.ts, docs/guide/authors/assets.md).
//   --all     все плагины каталога, у которых есть assets/
//   --check   ничего не писать: сверить сгенерированный модуль с assets/, устарел - код 1

import path from 'node:path';
import { loadCatalog } from './lib/catalog.ts';
import { ASSETS_DIR, GENERATED_FILE, assetsStatus, writeAssets } from './lib/embed-assets.ts';
import { REPO_ROOT } from './lib/util.ts';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const check = args.includes('--check');
let dirs = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
if (args.includes('--all')) dirs = loadCatalog(REPO_ROOT).plugins.filter((p) => existsSync(path.join(p.dir, ASSETS_DIR))).map((p) => p.dir);
if (dirs.length === 0) {
  console.log(args.includes('--all') ? 'embed-assets: ни у одного плагина нет assets/, делать нечего' : 'Использование: npm run embed-assets -- <каталог плагина>... | --all [--check]');
  process.exit(args.includes('--all') ? 0 : 2);
}
let failed = 0;
for (const dir of dirs) {
  const rel = path.relative(REPO_ROOT, dir) || dir;
  if (check) {
    const s = assetsStatus(dir);
    if (s.state === 'fresh') console.log(`ok   ${rel}: ${GENERATED_FILE} свеж`);
    else {
      failed++;
      for (const p of s.problems) console.error(`${rel}: ${p}`);
      if (s.problems.length === 0) console.error(`${rel}: ${GENERATED_FILE} ${s.state === 'missing' ? 'нет' : s.state === 'orphan' ? 'лишний: assets/ нет' : 'устарел'}; выполните npm run embed-assets -- ${rel}`);
    }
    continue;
  }
  const r = writeAssets(dir);
  if (r.problems.length > 0) {
    failed++;
    for (const p of r.problems) console.error(`${rel}/${p}`);
  } else console.log(`${rel}: ${r.names.length} ресурсов, ${r.bytes} байт, версия ${r.version} -> ${GENERATED_FILE}`);
}
process.exit(failed > 0 ? 1 : 0);
