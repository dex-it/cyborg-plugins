// Ресурсы плагина от исходника до работы на настоящем ядре: assets/ -> assets.generated.ts -> cyborg-plugin check и build ->
// активация плагина на ядре -> файлы в каталоге данных -> настоящие `node` и `bash` запускают демон и хук.
// Нужен `npm run harness:link`; без него тесты пропускаются. Доказывает решение SP-02 (docs/guide/authors/assets.md).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { writeAssets } from '../lib/embed-assets.ts';
import { findCyborgPlugin } from '../lib/harness.ts';
import { makeRepo } from './helpers.ts';

const SPEC = '@cyborg-harness/testing';
interface Kernel extends AsyncDisposable {
  dataDir(pluginId: string): string;
  run(command: string, ...args: unknown[]): Promise<unknown>;
  waitForJournal(match: { kind: string; pluginId?: string }): Promise<unknown>;
}
type Kit = { startKernel: (options: Record<string, unknown>) => Promise<Kernel> };
const kit = await import(SPEC).then((m: Kit) => m).catch(() => undefined);
const cli = ((): string | undefined => {
  try {
    return findCyborgPlugin();
  } catch {
    return undefined;
  }
})();
const skip = (kit === undefined || cli === undefined) && 'нет ядра: npm run harness:link';

const PLUGIN = {
  'manifest.json': {
    id: 'assets-demo',
    version: '1.0.0',
    engines: { cyborg: '^1' },
    commands: { 'assets-demo.dir': {}, 'assets-demo.daemon': { args: ['string'] }, 'assets-demo.hook': {}, 'assets-demo.list': {} },
    permissions: { process: ['node', 'bash'] },
  },
  'index.ts': `import type { PluginModule } from '@cyborg-harness/contracts';
import { installAssets } from './assets.generated.ts';

const plugin: PluginModule = {
  async activate(ctx) {
    const dir = await installAssets(ctx.os);
    ctx.commands.register('assets-demo.dir', () => dir);
    ctx.commands.register('assets-demo.list', async () => (await ctx.os.fs.list(dir + '/hooks')).map((e) => e.name).sort());
    ctx.commands.register('assets-demo.daemon', async (arg) => {
      const r = await ctx.os.process.run('node', [dir + '/agentd/agentd.js', String(arg)]);
      return r.stdout.trim();
    });
    ctx.commands.register('assets-demo.hook', async () => {
      const r = await ctx.os.process.run('bash', [dir + '/hooks/lsp-reap.sh']);
      return r.stdout.trim();
    });
    return undefined;
  },
};

export default plugin;
`,
  'README.md': '---\ntitle: Демо ресурсов\nsummary: Плагин с навыком, хуком и демоном\nstatus: experimental\n---\n\n## Что делает\n\nПроверка.\n',
  // Демон с node:* - так выглядит настоящий agentd; расширение .txt прячет его от проверки плагина.
  'assets/agentd/agentd.js.txt': "const fs = require('node:fs');\nprocess.stdout.write('daemon:' + process.argv[2] + ':' + typeof fs.existsSync + '\\n');\n",
  'assets/hooks/lsp-reap.sh': '#!/usr/bin/env bash\necho "hook-ok:${CLAUDE_PLUGIN_ROOT:-нет}"\n',
  'assets/hooks/hooks.json': '{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"bash \\"${CLAUDE_PLUGIN_ROOT}/hooks/lsp-reap.sh\\""}]}]}}\n',
  'assets/skills/parallel-sessions/SKILL.md': '# parallel-sessions\n',
  'assets/.claude-plugin/plugin.json': '{"name":"cyborg"}\n',
};

const run = (args: string[]): { status: number; out: string } => {
  const r = spawnSync(process.execPath, [cli ?? '', ...args], { encoding: 'utf8' });
  return { status: r.status ?? 2, out: `${r.stdout}${r.stderr}` };
};

describe('ресурсы плагина на настоящем ядре', { skip }, () => {
  it('cyborg-plugin check и build принимают плагин с демоном (node:*) в .txt; в поставку ресурсы доезжают только строками', () => {
    using repo = makeRepo(PLUGIN);
    assert.deepEqual(writeAssets(repo.root).problems, []);
    const check = run(['check', repo.root]);
    assert.equal(check.status, 0, check.out);
    const out = path.join(repo.root, 'out');
    const build = run(['build', repo.root, '--out', out]);
    assert.equal(build.status, 0, build.out);
    const names = readdirSync(out).sort();
    assert.ok(names.includes('index.mjs') && names.includes('manifest.json'));
    assert.ok(!names.includes('assets') && !names.includes('skills') && !names.includes('hooks'), `каталоги ресурсов в поставке: ${names.join(', ')}`);
    const bundle = readFileSync(path.join(out, 'index.mjs'), 'utf8');
    assert.ok(bundle.includes('daemon:'), 'текст демона вшит в index.mjs');
    assert.ok(bundle.includes('parallel-sessions'), 'навык вшит в index.mjs');
  });

  it('демон с исходным расширением без .txt: cyborg-plugin check бракует его как код плагина, генератор отказывает раньше', () => {
    const { 'assets/agentd/agentd.js.txt': _daemon, ...rest } = PLUGIN;
    using repo = makeRepo({ ...rest, 'assets/agentd/agentd.mjs': "import fs from 'node:fs';\nconsole.log(fs);\n" });
    assert.match(writeAssets(repo.root).problems.join('\n'), /исходное расширение/);
    // Обход генератора (пустой модуль ресурсов): сам check ядра всё равно видит файл и называет node:*.
    writeFileSync(path.join(repo.root, 'assets.generated.ts'), 'export const ASSETS = {};\nexport async function installAssets(): Promise<string> { return \'\'; }\n');
    const check = run(['check', repo.root]);
    assert.equal(check.status, 1, check.out);
    assert.match(check.out, /assets\/agentd\/agentd\.mjs:1: 'node:fs'/);
  });

  it('плагин активируется, кладёт ресурсы в каталог данных, node запускает демон, bash - хук без бита исполнения', { skip: kit === undefined }, async () => {
    using repo = makeRepo(PLUGIN);
    writeAssets(repo.root);
    await using kernel = await (kit as Kit).startKernel({
      plugins: [repo.root],
      os: { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: repo.root } },
    });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'assets-demo' });
    const dir = (await kernel.run('assets-demo.dir')) as string;
    assert.ok(dir.startsWith(path.join(kernel.dataDir('assets-demo'), 'assets')), dir);
    assert.ok(existsSync(path.join(dir, '.installed')));
    assert.ok(existsSync(path.join(dir, '.claude-plugin', 'plugin.json')), 'каталог плагина Claude Code с точкой в имени');
    assert.ok(existsSync(path.join(dir, 'skills', 'parallel-sessions', 'SKILL.md')));
    assert.equal(statSync(path.join(dir, 'hooks', 'lsp-reap.sh')).mode & 0o111, 0, 'бит исполнения не выставляется: хук вызывается как bash <файл>');
    assert.deepEqual(await kernel.run('assets-demo.list'), ['hooks.json', 'lsp-reap.sh']);
    assert.equal(await kernel.run('assets-demo.daemon', 'ping'), 'daemon:ping:function');
    assert.match((await kernel.run('assets-demo.hook')) as string, /^hook-ok:/);
  });

  it('повторная активация с теми же данными ничего не переписывает; правка ресурса даёт новую версию рядом', async () => {
    using repo = makeRepo(PLUGIN);
    const first = writeAssets(repo.root);
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: repo.root };
    const dataDir = path.join(repo.root, 'data');
    const start = (): Promise<Kernel> => (kit as Kit).startKernel({ plugins: [repo.root], os: { env, dataDir, tempDir: path.join(repo.root, 'tmp'), home: repo.root } });

    let dir1: string;
    let marker: number;
    {
      await using k = await start();
      await k.waitForJournal({ kind: 'activated', pluginId: 'assets-demo' });
      dir1 = (await k.run('assets-demo.dir')) as string;
      marker = statSync(path.join(dir1, '.installed')).mtimeMs;
    }
    await new Promise((r) => setTimeout(r, 25));
    {
      await using k = await start();
      await k.waitForJournal({ kind: 'activated', pluginId: 'assets-demo' });
      assert.equal(await k.run('assets-demo.dir'), dir1);
      assert.equal(statSync(path.join(dir1, '.installed')).mtimeMs, marker, 'установленная версия не переписывается');
    }
    // Правка ресурса: новая версия ложится в соседний каталог, старая цела.
    const changed = { ...PLUGIN, 'assets/skills/parallel-sessions/SKILL.md': '# новая версия навыка\n' };
    using repo2 = makeRepo(changed);
    const second = writeAssets(repo2.root);
    assert.notEqual(second.version, first.version);
    await using k = await (kit as Kit).startKernel({ plugins: [repo2.root], os: { env, dataDir, tempDir: path.join(repo.root, 'tmp'), home: repo.root } });
    await k.waitForJournal({ kind: 'activated', pluginId: 'assets-demo' });
    const dir2 = (await k.run('assets-demo.dir')) as string;
    assert.notEqual(dir2, dir1);
    assert.ok(existsSync(path.join(dir1, 'skills', 'parallel-sessions', 'SKILL.md')), 'старая версия на месте');
    assert.equal(readFileSync(path.join(dir2, 'skills', 'parallel-sessions', 'SKILL.md'), 'utf8'), '# новая версия навыка\n');
  });
});
