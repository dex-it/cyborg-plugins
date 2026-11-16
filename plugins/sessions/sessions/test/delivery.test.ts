// Доставка навыка и хука плагина Claude Code из поставки (решение SP-02, docs/guide/authors/assets.md): настоящая сборка `cyborg-plugin build` -> плагин из `index.mjs`
// на ядре -> сессия получает `--plugin-dir` на записанный каталог -> хук запускается настоящим `bash`, как это делает Claude Code (`bash "${CLAUDE_PLUGIN_ROOT}/hooks/lsp-reap.sh"`).
// Настоящий `claude` в тестах не запускается: что он прочитает из каталога, на живом не проверено (README, «Как проверено»).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PLUGIN_DIR, rig } from './kit.ts';

const cli = path.resolve(PLUGIN_DIR, '..', '..', '..', 'node_modules', 'cyborg-plugin', 'dist', 'src', 'cli-bin.js');
const skip = !existsSync(cli) && 'нет ядра: npm run harness:link';

test('собранный плагин несёт навык и хук строками, записывает их при активации и подключает к сессии; хук исполняется bash без бита исполнения', { skip }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'cyborg-sessions-build-'));
  try {
    const build = spawnSync(process.execPath, [cli, 'build', PLUGIN_DIR, '--out', out, '--declarations-package', '@cyborg-plugins/contracts'], { encoding: 'utf8' });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const names = readdirSync(out);
    assert.ok(names.includes('index.mjs') && names.includes('manifest.json'));
    assert.ok(!names.includes('assets') && !names.includes('skills') && !names.includes('hooks'), `каталоги ресурсов в поставке: ${names.join(', ')}`);
    const bundle = readFileSync(path.join(out, 'index.mjs'), 'utf8');
    assert.ok(bundle.includes('name: parallel-sessions') && bundle.includes('lsp-reap'), 'навык и хук вшиты в index.mjs');

    await using r = await rig({ pluginDir: out });
    await r.sessions.create({ cwd: r.repoA });
    const flag = r.last().args.find((a) => a.startsWith('--plugin-dir='));
    assert.ok(flag);
    const dir = flag.slice('--plugin-dir='.length);
    assert.ok(dir.startsWith(r.kernel.dataDir('sessions')));
    for (const file of ['.claude-plugin/plugin.json', 'skills/parallel-sessions/SKILL.md', 'hooks/hooks.json', 'hooks/lsp-reap.sh']) assert.ok(existsSync(path.join(dir, file)), file);
    assert.equal(statSync(path.join(dir, 'hooks', 'lsp-reap.sh')).mode & 0o111, 0, 'бит исполнения не выставлен');

    // Команда хука из hooks.json, как её зовёт Claude Code: подстановка ${CLAUDE_PLUGIN_ROOT}, ввод - событие хука. Вне сессии claude хук ничего не делает и не падает.
    const hooks = JSON.parse(readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8')) as { hooks: { PostToolUse: { hooks: { command: string }[] }[] } };
    const command = hooks.hooks.PostToolUse[0]?.hooks[0]?.command ?? '';
    const ran = spawnSync('bash', ['-c', command], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', cwd: dir }), env: { ...process.env, CLAUDE_PLUGIN_ROOT: dir } });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, '');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
