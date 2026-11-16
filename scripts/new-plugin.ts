// npm run new -- <категория> <id> ["Название для каталога"]
// Заводит plugins/<категория>/<id>/ из templates/plugin: манифест, главная часть, контракт, вид, тест, карточка README.md.

import path from 'node:path';
import { createPlugin } from './lib/new-plugin.ts';
import { REPO_ROOT } from './lib/util.ts';

const [category, id, title] = process.argv.slice(2);
if (!category || !id) {
  console.error('Использование: npm run new -- <категория> <id> ["Название для каталога"]');
  process.exit(2);
}
const result = createPlugin(REPO_ROOT, { category, id, title: title ?? id });
if ('error' in result) {
  console.error(`new: ${result.error}`);
  process.exit(1);
}
console.log(`new: ${path.relative(REPO_ROOT, result.dir)}`);
console.log('Дальше: заполните README.md (карточка и описание), npm run check, npm run check:plugins.');
console.log(`Если плагин был в planned категории ${category} (plugins/categories.json), уберите запись оттуда: проверка потребует.`);
