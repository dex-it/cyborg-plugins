// npm run docs:catalog - пересобрать docs/guide/catalog/ (каталог не коммитится: его строит сборка сайта, а в git лежат только источники)

import { checkRepo } from './lib/check-all.ts';
import { generatePages, writePages } from './lib/gen-catalog.ts';
import { REPO_ROOT, printProblems } from './lib/util.ts';

const { problems } = checkRepo(REPO_ROOT);
if (problems.length > 0) {
  printProblems(problems);
  console.error('gen-catalog: сначала исправьте замечания npm run check');
  process.exit(1);
}
const pages = generatePages(REPO_ROOT);
writePages(REPO_ROOT, pages);
console.log(`gen-catalog: записано ${pages.size} страниц в docs/guide/catalog`);
