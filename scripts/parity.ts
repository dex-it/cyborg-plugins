// npm run parity -- <клон ai-cyborg> [--write-missing]   сверить матрицу паритета с кодом ai-cyborg (клон только читается)
// npm run parity                                         сводка по матрице без клона
//
// Код возврата 1: есть расхождения (новое в коде, исчезнувшее, несовпавший вид) или матрица нарушает свои правила.
// --write-missing: добавить в матрицу строки для нового в коде с владельцем `?`; пока владелец не назначен, проверка красная.

import path from 'node:path';
import { checkRepo } from './lib/check-all.ts';
import { MATRIX_FILE, addMissingRows, compareMatrix, extractSource, loadMatrix, summarize } from './lib/parity.ts';
import { REPO_ROOT, printProblems } from './lib/util.ts';
import type { Problem } from './lib/util.ts';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const { problems: repoProblems } = checkRepo(REPO_ROOT);
const problems: Problem[] = [...repoProblems];
const matrix = loadMatrix(REPO_ROOT, problems);
if (!matrix) {
  printProblems(problems.length > 0 ? problems : [{ where: MATRIX_FILE, message: 'матрицы нет' }]);
  process.exit(1);
}
const s = summarize(matrix);
console.log(`Матрица: ${s.total} строк (${Object.entries(s.byKind).map(([k, n]) => `${k} ${n}`).join(', ')}); статусы: ${Object.entries(s.byStatus).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(`Якорь: ${matrix.source.repo} ${matrix.source.commit.slice(0, 7)} (${matrix.source.date})`);

let failed = false;
if (problems.length > 0) {
  printProblems(problems);
  failed = true;
}
if (dir) {
  const code = extractSource(path.resolve(dir));
  console.log(`Код: требований ${code.requirements.size}, каналов ${code.channels.size}, событий ${code.events.size}, ключей ${code.storageKeys.size} и семейств ${code.storageFamilies.size}, диалогов ${code.dialogs.size}`);
  const diff = compareMatrix(matrix, code);
  if (args.includes('--write-missing') && diff.missing.length > 0) {
    const added = addMissingRows(path.join(REPO_ROOT, MATRIX_FILE), matrix, code);
    console.log(`Добавлено строк с владельцем «?»: ${added}. Назначьте владельцев и задачи, затем повторите проверку.`);
  }
  for (const m of diff.missing) console.error(`в коде есть, в матрице нет: ${m}`);
  for (const m of diff.stale) console.error(`в матрице есть, в коде нет: ${m}`);
  for (const m of diff.mismatched) console.error(`расхождение: ${m}`);
  if (diff.missing.length + diff.stale.length + diff.mismatched.length > 0) failed = true;
  else console.log('Матрица сходится с кодом.');
}
process.exit(failed ? 1 : 0);
