// npm run check:plugins | build | typecheck | test - то же действие для каждого плагина каталога.
//   check      cyborg-plugin check <каталог>
//   build      cyborg-plugin build <каталог> --out dist/plugins/<id>
//   typecheck  npm run typecheck внутри плагина, если у него есть такой скрипт
//   test       npm test внутри плагина, если у него есть такой скрипт
// Ключ `--only <id>` ограничивает один плагин.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadCatalog } from './lib/catalog.ts';
import { DECLARATION_FLAGS, runCyborgPlugin } from './lib/harness.ts';
import { REPO_ROOT, printProblems } from './lib/util.ts';

const [action = '', ...rest] = process.argv.slice(2);
const onlyIndex = rest.indexOf('--only');
const only = onlyIndex >= 0 ? rest[onlyIndex + 1] : undefined;

if (!['check', 'build', 'typecheck', 'test'].includes(action)) {
  console.error('Использование: node scripts/each-plugin.ts check|build|typecheck|test [--only <id>]');
  process.exit(2);
}

const catalog = loadCatalog(REPO_ROOT);
if (catalog.problems.length > 0) {
  printProblems(catalog.problems);
  process.exit(1);
}
const plugins = catalog.plugins.filter((p) => only === undefined || p.id === only);
if (plugins.length === 0) {
  console.log(`${action}: плагинов нет, делать нечего`);
  process.exit(0);
}

function hasScript(dir: string, name: string): boolean {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return false;
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> };
  return pkg.scripts?.[name] !== undefined;
}

let failed = 0;
for (const p of plugins) {
  console.log(`\n== ${action} ${p.rel}`);
  let status = 0;
  if (action === 'check') status = runCyborgPlugin(['check', p.dir, ...DECLARATION_FLAGS]).status;
  else if (action === 'build') status = runCyborgPlugin(['build', p.dir, '--out', path.join(REPO_ROOT, 'dist', 'plugins', p.id), ...DECLARATION_FLAGS]).status;
  else if (hasScript(p.dir, action)) status = spawnSync('npm', ['run', '--silent', action], { cwd: p.dir, stdio: 'inherit' }).status ?? 1;
  else console.log(`у плагина нет скрипта ${action}, пропущен`);
  if (status !== 0) failed++;
}
if (failed > 0) {
  console.error(`\n${action}: не прошли ${failed} из ${plugins.length}`);
  process.exit(1);
}
console.log(`\n${action}: ${plugins.length} - без замечаний`);
