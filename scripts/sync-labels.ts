// npm run sync-labels [-- --dry-run] [-- --prune]
// Приводит метки репозитория на GitHub к .github/labels.json: создаёт недостающие, правит цвет и описание.
//   --dry-run  только показать, что будет сделано
//   --prune    удалить метки, которых нет в файле, но только если ни одна задача и PR их не несёт
// Нужен `gh` с правом на метки репозитория; репозиторий берётся из git remote текущего каталога.

import { spawnSync } from 'node:child_process';
import { loadLabels, planSync } from './lib/labels.ts';
import type { Label } from './lib/labels.ts';
import { REPO_ROOT, printProblems } from './lib/util.ts';
import type { Problem } from './lib/util.ts';

const dryRun = process.argv.includes('--dry-run');
const prune = process.argv.includes('--prune');

function gh(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('gh', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

const problems: Problem[] = [];
const desired = loadLabels(REPO_ROOT, problems);
if (problems.length > 0) {
  printProblems(problems);
  process.exit(1);
}

const listed = gh(['label', 'list', '--limit', '500', '--json', 'name,color,description']);
if (!listed.ok) {
  console.error(`sync-labels: gh label list не удалось: ${listed.out}`);
  process.exit(1);
}
const existing = JSON.parse(listed.out) as Label[];
const plan = planSync(desired, existing);

const run = (title: string, args: string[]): boolean => {
  if (dryRun) {
    console.log(`[dry-run] ${title}`);
    return true;
  }
  const r = gh(args);
  console.log(`${r.ok ? 'ok ' : 'ОШИБКА'} ${title}${r.ok ? '' : `: ${r.out}`}`);
  return r.ok;
};

let failed = 0;
for (const l of plan.create) if (!run(`создать «${l.name}»`, ['label', 'create', l.name, '--color', l.color, '--description', l.description])) failed++;
for (const l of plan.update) if (!run(`обновить «${l.name}»`, ['label', 'edit', l.name, '--name', l.name, '--color', l.color, '--description', l.description])) failed++;

let kept = 0;
for (const name of plan.extra) {
  if (!prune) {
    console.log(`лишняя метка «${name}» (нет в файле); --prune удалит её, если она не используется`);
    kept++;
    continue;
  }
  const used = ['issue', 'pr'].some((kind) => {
    const r = gh([kind, 'list', '--label', name, '--state', 'all', '--limit', '1', '--json', 'number']);
    return !r.ok || (JSON.parse(r.out) as unknown[]).length > 0;
  });
  if (used) {
    console.log(`пропущена «${name}»: есть задачи или PR с этой меткой (или не удалось проверить)`);
    kept++;
  } else if (!run(`удалить «${name}»`, ['label', 'delete', name, '--yes'])) failed++;
}

console.log(`sync-labels: создано ${plan.create.length}, обновлено ${plan.update.length}, лишних ${plan.extra.length}${prune ? ` (оставлено ${kept})` : ''}${dryRun ? ' [dry-run]' : ''}`);
process.exit(failed > 0 ? 1 : 0);
