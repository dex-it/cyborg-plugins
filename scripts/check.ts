// npm run check - раскладка каталога, карточки плагинов, бандлы. Код возврата 1, если есть замечания.

import { checkRepo } from './lib/check-all.ts';
import { REPO_ROOT, printProblems } from './lib/util.ts';

const { catalog, bundles, problems, notes } = checkRepo(REPO_ROOT);
for (const n of notes) console.log(`заметка: ${n}`);
if (problems.length > 0) {
  printProblems(problems);
  console.error(`check: замечаний ${problems.length}`);
  process.exit(1);
}
const planned = catalog.categories.reduce((sum, c) => sum + c.planned.length, 0);
console.log(`check: плагинов ${catalog.plugins.length} в ${catalog.categories.length} категориях (запланировано ${planned}), бандлов ${bundles.bundles.length} (запланировано ${bundles.planned.length}) - без замечаний`);
