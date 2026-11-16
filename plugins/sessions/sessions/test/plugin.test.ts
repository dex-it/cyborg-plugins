import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkPlugin } from '@cyborg-harness/core/plugin-check';
import { memoryStore, startKernel } from '@cyborg-harness/testing';
import { CHANNELS } from '../index.ts';
import { AGENT_DIR, ISOLATION_DIR, PLUGIN_DIR, prepare } from './kit.ts';

const manifest = JSON.parse(await readFile(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8')) as {
  provides: Record<string, string>;
  consumes: Record<string, string>;
  commands: Record<string, { args?: string[] }>;
  permissions: { 'fs.read': string[]; 'fs.write': string[]; shell: string[]; clipboard: string[]; pty: { program: string; deny: string[]; env: string[] }[] };
};

describe('плагин sessions', () => {
  it('проверка состава: манифест, файлы, правило импортов - без замечаний; права названы словами', async () => {
    const report = await checkPlugin(PLUGIN_DIR, { ignore: ['dist'], declarationPackages: ['@cyborg-plugins/contracts'] });
    assert.deepEqual(report.problems, []);
    assert.equal(report.permissions.length, 7, report.permissions.join('; '));
    assert.ok(report.permissions.some((p) => p.includes('запрещены флаги') && p.includes('--dangerously-skip-permissions')), report.permissions.join('; '));
    for (const word of ['читает файлы', 'пишет файлы', 'открывает в системе', 'запускает в терминале', 'буфер обмена']) assert.ok(report.permissions.some((p) => p.startsWith(word)), word);
  });

  it('виды: «Сессии» (основная область) и «Сессии проекта» (боковая колонка), модули собираются в ui/*.js; таблица xterm лежит рядом и совпадает с пакетом', async () => {
    const full = JSON.parse(await readFile(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8')) as { ui: { views: Record<string, { module: string; area: string; title?: string }>; inlineStyles: boolean } };
    assert.deepEqual(Object.keys(full.ui.views), ['main', 'history']);
    assert.equal(full.ui.views.main?.area, 'main');
    assert.equal(full.ui.views.history?.area, 'sidebar');
    assert.equal(full.ui.views.history?.title, 'Сессии проекта');
    assert.equal(full.ui.inlineStyles, true, 'xterm.js ставит встроенные стили');
    for (const view of Object.values(full.ui.views)) assert.ok(existsSync(path.join(PLUGIN_DIR, view.module.replace(/\.js$/, '.ts'))), view.module);
    // Вид грузит стили только со своего origin: таблица xterm - копия файла пакета (`npm ci` кладёт его в node_modules), версия записана в package.json плагина.
    const installed = path.join(PLUGIN_DIR, '..', '..', '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
    if (existsSync(installed)) assert.equal(await readFile(path.join(PLUGIN_DIR, 'ui', 'xterm.css'), 'utf8'), await readFile(installed, 'utf8'), 'ui/xterm.css разошёлся с @xterm/xterm: обновите копию');
    const pkg = JSON.parse(await readFile(path.join(PLUGIN_DIR, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    assert.deepEqual(Object.keys(pkg.dependencies).toSorted(), ['@xterm/addon-fit', '@xterm/xterm']);
  });

  it('манифест: версия контракта, потребляемые контракты, закреплённый запуск и запрет всех шести опасных флагов', () => {
    assert.deepEqual(manifest.provides, { 'cyborg.sessions': '1.3' });
    assert.deepEqual(Object.keys(manifest.consumes).toSorted(), ['cyborg.agent', 'cyborg.agent-tool', 'cyborg.session-prompt']);
    assert.deepEqual(manifest.permissions['fs.read'], ['workspace'], 'рабочий каталог pty проверяется как чтение; сам плагин файлов не читает');
    assert.deepEqual(manifest.permissions['fs.write'], ['workspace'], 'нужен проверке ядра команды агента history.delete (guard fs.write); сам плагин файлов не пишет');
    assert.deepEqual(manifest.permissions.shell, ['any', 'http:', 'https:'], 'открыть путь и ссылку из вывода: исполняемое и чужие схемы ядро не пускает');
    assert.deepEqual(manifest.permissions.clipboard, ['read', 'write']);
    const [rule] = manifest.permissions.pty;
    assert.ok(rule);
    assert.equal(rule.program, '$SHELL');
    assert.deepEqual(rule.deny.toSorted(), ['--allowed-tools', '--allowedTools', '--dangerously-skip-permissions', '--disallowedTools', '--permission-mode', '--tools']);
  });

  it('правило pty совпадает с правилом launch агента: тот же скрипт и те же переменные, запрет - только у sessions', async () => {
    const agentManifest = JSON.parse(await readFile(path.join(AGENT_DIR, 'manifest.json'), 'utf8')) as { permissions: { launch: { program: string; args: string[]; env: string[]; deny?: string[] }[] } };
    const [launch] = agentManifest.permissions.launch;
    const [rule] = manifest.permissions.pty;
    assert.ok(launch && rule);
    assert.equal(launch.deny, undefined, 'у launch поля deny быть не может');
    assert.equal(rule.program, launch.program);
    assert.deepEqual((rule as unknown as { args: string[] }).args, launch.args);
    assert.deepEqual(rule.env, launch.env);
  });

  it('каналы ai-cyborg -> команды плагина: соответствие сверено с манифестом', () => {
    for (const [channel, command] of Object.entries(CHANNELS)) assert.ok(command in manifest.commands, `${channel} -> ${command}`);
    assert.deepEqual(Object.keys(CHANNELS).toSorted(), ['history:delete', 'history:list', 'session:create', 'session:kill', 'session:resume']);
  });

  it('на настоящем projects: сессия открывается в репозитории проекта, каталог вне проектов отвергается, рабочий каталог принят ядром как корень', async () => {
    const shared = await prepare();
    try {
      const { box, claude, dataRoot, repoA, repoB } = shared;
      const config = memoryStore({ user: { projects: { $version: 1, items: [{ id: 'p1', name: 'Проект', description: '', repos: [repoA] }] } } });
      const projectsDir = path.resolve(PLUGIN_DIR, '..', '..', 'code', 'projects');
      await using kernel = await startKernel({
        plugins: [AGENT_DIR, ISOLATION_DIR, PLUGIN_DIR, projectsDir],
        config: config.store,
        state: memoryStore().store,
        os: { home: claude.dir, dataDir: dataRoot, env: { PATH: box.env.PATH ?? '', HOME: claude.dir, SHELL: path.join(box.bin, 'shell') } },
        load: { reservedPrefixes: ['cyborg.'], bundled: ['projects', 'sessions', 'agent-claude-code', 'session-isolation'] },
      });
      await kernel.waitForJournal({ kind: 'activated', pluginId: 'sessions' });
      const opened = (await kernel.run('sessions.create', { cwd: repoA })) as { sessionId: string };
      assert.match(opened.sessionId, /^s/);
      assert.equal(kernel.pty.procs.length, 1);
      await assert.rejects(kernel.run('sessions.create', { cwd: repoB }), /Каталог не входит в репозитории проектов/);
      assert.equal(kernel.pty.procs.length, 1);
      assert.deepEqual(kernel.journal.filter((e) => e.kind === 'failed' || e.kind === 'denied' || e.kind === 'invalid' || e.kind === 'rejected'), []);
    } finally {
      await shared.dispose();
    }
  });
});
