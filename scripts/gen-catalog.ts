// npm run docs:catalog          - пересобрать docs/guide/catalog/ (закоммитьте результат)
// npm run check:docs-catalog    - сверить с источниками, устарело - код 1

import { checkRepo } from './lib/check-all.ts';
import { diffPages, generatePages, writePages } from './lib/gen-catalog.ts';
import { REPO_ROOT, printProblems } from './lib/util.ts';

const { problems } = checkRepo(REPO_ROOT);
if (problems.length > 0) {
  printProblems(problems);
  console.error('gen-catalog: сначала исправьте замечания npm run check');
  process.exit(1);
}
const pages = generatePages(REPO_ROOT);
if (process.argv.includes('--check')) {
  const diffs = diffPages(REPO_ROOT, pages);
  if (diffs.length > 0) {
    for (const d of diffs) console.error(`gen-catalog: ${d}`);
    console.error('gen-catalog: выполните npm run docs:catalog и закоммитьте результат');
    process.exit(1);
  }
  console.log(`gen-catalog: ${pages.size} страниц свежие`);
} else {
  writePages(REPO_ROOT, pages);
  console.log(`gen-catalog: записано ${pages.size} страниц в docs/guide/catalog`);
}
