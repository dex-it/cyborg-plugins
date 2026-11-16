import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkRepo } from '../lib/check-all.ts';
import { GENERATED_FILE, assetsStatus, generateAssets, installedName, writeAssets } from '../lib/embed-assets.ts';
import type { Problem } from '../lib/util.ts';
import { makeRepo, repoWith } from './helpers.ts';

const text = (problems: Problem[]): string => problems.map((p) => `${p.where}: ${p.message}`).join('\n');
const FILES = {
  'assets/skills/parallel-sessions/SKILL.md': '# Навык\n\nТекст с «кавычками», \\ обратной чертой и ${не подстановкой}.\n',
  'assets/hooks/hooks.json': '{"hooks":{}}\n',
  'assets/agentd/agentd.js.txt': "import fs from 'node:fs';\nconsole.log(fs);\n",
};

describe('ресурсы плагина: генератор', () => {
  it('имена, версия, порядок и экранирование; .txt у исходных расширений снимается', () => {
    using r = makeRepo(FILES);
    const res = generateAssets(r.root);
    assert.deepEqual(res.problems, []);
    assert.deepEqual(res.names, ['agentd/agentd.js', 'hooks/hooks.json', 'skills/parallel-sessions/SKILL.md']);
    assert.match(res.version, /^[0-9a-f]{16}$/);
    assert.match(res.module, /export const ASSET_VERSION = "[0-9a-f]{16}";/);
    assert.match(res.module, /"agentd\/agentd\.js": "import fs from 'node:fs';\\nconsole\.log\(fs\);\\n",/);
    // Подстановка шаблона в тексте ресурса не должна ожить: строки - JSON-литералы, а не шаблонные.
    assert.match(res.module, /\\\\ обратной чертой и \$\{не подстановкой\}/);
  });

  it('детерминирован: те же файлы - те же байты; правка файла меняет версию', () => {
    using a = makeRepo(FILES);
    using b = makeRepo(FILES);
    assert.equal(generateAssets(a.root).module, generateAssets(b.root).module);
    using c = makeRepo({ ...FILES, 'assets/hooks/hooks.json': '{"hooks":{"x":1}}\n' });
    assert.notEqual(generateAssets(a.root).version, generateAssets(c.root).version);
  });

  it('генерируемый модуль сам является годным TypeScript и вычисляется без компилятора типов', async () => {
    using r = makeRepo(FILES);
    writeAssets(r.root);
    const mod = (await import(path.join(r.root, GENERATED_FILE))) as { ASSETS: Record<string, string>; ASSET_VERSION: string };
    assert.equal(mod.ASSETS['hooks/hooks.json'], '{"hooks":{}}\n');
    assert.equal(mod.ASSETS['skills/parallel-sessions/SKILL.md'], FILES['assets/skills/parallel-sessions/SKILL.md']);
    assert.equal(mod.ASSET_VERSION, generateAssets(r.root).version);
  });

  it('отказывает: исходное расширение, двоичный файл, ссылка, слишком большой файл, совпадение имён', () => {
    using r = makeRepo({
      'assets/agentd.mjs': 'import fs from "node:fs";',
      'assets/legacy.cjs': 'require("node:fs")',
      'assets/big.txt': 'я'.repeat(600 * 1024),
      'assets/clash.js.txt': 'a',
      'assets/clash.js': 'b',
    });
    writeFileSync(path.join(r.root, 'assets', 'bin.dat'), Buffer.from([0xff, 0xfe, 0xc3, 0x28]));
    symlinkSync(path.join(r.root, 'assets', 'big.txt'), path.join(r.root, 'assets', 'link.txt'));
    const res = generateAssets(r.root);
    const t = res.problems.join('\n');
    assert.match(t, /assets\/agentd\.mjs: исходное расширение.*agentd\.mjs\.txt/);
    assert.match(t, /assets\/legacy\.cjs: исходное расширение/);
    assert.match(t, /assets\/bin\.dat: не текст UTF-8/);
    assert.match(t, /assets\/link\.txt: символическая ссылка/);
    assert.match(t, /assets\/big\.txt: \d+ байт, предел/);
    assert.equal(res.module, '');
    assert.equal(installedName('a/b.mts.txt'), 'a/b.mts');
    assert.equal(installedName('a/b.txt'), 'a/b.txt');
  });

  it('нет каталога assets - ресурсов нет, модуль пустой, но годный', () => {
    using r = makeRepo({ 'x.txt': 'x' });
    const res = generateAssets(r.root);
    assert.deepEqual(res.names, []);
    assert.match(res.module, /export const ASSETS: Readonly<Record<string, string>> = \{\n\n\};/);
  });
});

describe('ресурсы плагина: проверка свежести в npm run check', () => {
  const plugin = (extra: Record<string, string> = {}): Parameters<typeof makeRepo>[0] => ({
    ...repoWith([{ category: 'code', id: 'files' }]),
    ...Object.fromEntries(Object.entries({ ...FILES, ...extra }).map(([k, v]) => [`plugins/code/files/${k}`, v])),
  });

  it('assets есть, модуля нет - замечание; после генерации - чисто; правка assets - устарел', () => {
    using r = makeRepo(plugin());
    const dir = path.join(r.root, 'plugins', 'code', 'files');
    assert.equal(assetsStatus(dir).state, 'missing');
    assert.match(text(checkRepo(r.root).problems), /у плагина есть assets\/, но нет модуля ресурсов/);
    writeAssets(dir);
    assert.equal(assetsStatus(dir).state, 'fresh');
    assert.deepEqual(checkRepo(r.root).problems, []);
    writeFileSync(path.join(dir, 'assets', 'hooks', 'hooks.json'), '{"changed":true}\n');
    assert.equal(assetsStatus(dir).state, 'stale');
    assert.match(text(checkRepo(r.root).problems), /устарел относительно assets\//);
  });

  it('модуль без каталога assets - замечание; плохие ресурсы называются в check', () => {
    using r = makeRepo({ ...repoWith([{ category: 'code', id: 'files' }]), 'plugins/code/files/assets.generated.ts': '// старый' });
    assert.match(text(checkRepo(r.root).problems), /есть, а каталога assets\/ нет/);
    using bad = makeRepo(plugin({ 'assets/agentd.mjs': 'import "node:fs"' }));
    assert.match(text(checkRepo(bad.root).problems), /plugins\/code\/files\/assets: assets\/agentd\.mjs: исходное расширение/);
  });

  it('сгенерированный файл читается обратно тем же текстом', () => {
    using r = makeRepo(plugin());
    const dir = path.join(r.root, 'plugins', 'code', 'files');
    writeAssets(dir);
    mkdirSync(path.join(dir, 'assets', 'extra'), { recursive: true });
    assert.equal(readFileSync(path.join(dir, GENERATED_FILE), 'utf8'), generateAssets(dir).module);
  });
});
