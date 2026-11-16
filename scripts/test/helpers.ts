import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../lib/util.ts';

export type Files = Record<string, string | object>;

/** Временный репозиторий из словаря «путь - содержимое»; объект записывается как JSON. */
export function makeRepo(files: Files): { root: string; [Symbol.dispose](): void } {
  const root = mkdtempSync(path.join(tmpdir(), 'cyborg-plugins-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return { root, [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }) };
}

export const CATEGORIES = [
  { id: 'code', title: 'Код', summary: 'Работа с кодом', planned: [{ id: 'search', summary: 'поиск', from: 'ai-cyborg' }] },
  { id: 'sessions', title: 'Сессии', summary: 'Сессии', planned: [] },
];

export const CARD = '---\ntitle: Плагин\nsummary: Делает дело\nstatus: beta\ntags: [а, б]\nneeds: [git]\n---\n\n## Что делает\n\nТекст.\n';

export function plugin(id: string, manifest: object = {}, readme: string = CARD): Files {
  return {
    [`manifest.json`]: { id, version: '1.0.0', engines: { cyborg: '^1' }, ...manifest },
    [`README.md`]: readme,
  };
}

/** Раскладывает плагины по plugins/<категория>/<id>/. */
export function repoWith(plugins: { category: string; id: string; manifest?: object; readme?: string }[], extra: Files = {}, categories: object = CATEGORIES): Files {
  const files: Files = { 'plugins/categories.json': categories as object };
  for (const p of plugins) {
    for (const [name, content] of Object.entries(plugin(p.id, p.manifest, p.readme))) files[`plugins/${p.category}/${p.id}/${name}`] = content;
  }
  return { ...files, ...extra };
}

/** Копия настоящего шаблона плагина в временный репозиторий: тесты `npm run new` идут на нём. */
export function copyTemplate(root: string): void {
  cpSync(path.join(REPO_ROOT, 'templates', 'plugin'), path.join(root, 'templates', 'plugin'), { recursive: true });
}
