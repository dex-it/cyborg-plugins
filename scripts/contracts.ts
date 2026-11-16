// npm run contracts:gap [-- --strict] [-- --harness <каталог contracts>]
// Сверяет проектную модель контрактов (plugins/planned-contracts.json и манифесты готовых плагинов) с типами ядра:
// каких контрактов `cyborg.*` в `@cyborg-harness/contracts` нет и каких членов не хватает. Без --strict пробелы - сведения (код 0),
// с --strict любой пробел - код 1. Ошибки самой модели (нет описания, бандл не замкнут) всегда код 1.

import path from 'node:path';
import { checkRepo } from './lib/check-all.ts';
import { findGaps, loadDesign, readHarnessContracts } from './lib/design.ts';
import { REPO_ROOT, printProblems } from './lib/util.ts';
import type { Problem } from './lib/util.ts';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const at = args.indexOf('--harness');
const dir = path.resolve(REPO_ROOT, at >= 0 ? (args[at + 1] ?? '') : path.join('node_modules', '@cyborg-harness', 'contracts'));

const { catalog, problems } = checkRepo(REPO_ROOT);
if (problems.length > 0) {
  printProblems(problems);
  process.exit(1);
}
const harness = readHarnessContracts(dir);
if (!harness) {
  console.error(`contracts:gap: типы ядра не найдены в ${dir}. Выполните npm run harness:link или укажите --harness <каталог contracts>.`);
  process.exit(2);
}
const design = loadDesign(REPO_ROOT, [] as Problem[]);
const gaps = findGaps(design, catalog, harness);
console.log(`Типы ядра: ${dir} (${harness.contracts.size} контрактов: ${[...harness.contracts.keys()].join(', ')})`);
if (gaps.length === 0) console.log('Пробелов нет: все контракты и члены, которые нужны плагинам, объявлены в ядре.');
for (const g of gaps) {
  const what = g.kind === 'absent' ? 'не объявлен в ядре' : 'не хватает членов';
  console.log(`- ${g.contract}: ${what}${g.missing.length > 0 ? ` (${g.missing.join(', ')})` : ''}; нужен: ${g.users.join(', ')}`);
}
process.exit(strict && gaps.length > 0 ? 1 : 0);
