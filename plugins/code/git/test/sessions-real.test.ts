// Отказ смены ветки при живой сессии на настоящем плагине `sessions` (а не на подставном поставщике): сессия открывается через `cyborg.sessions.create`,
// `uses` отвечает по её каталогу, `git.switch` отказывает, пока сессия идёт, и меняет ветку после выхода процесса. Образец - сценарий S12 и FR-7003.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { PluginContext, Remote } from '@cyborg-harness/contracts';
import type { GitV11 } from '@cyborg-plugins/contracts';
import type { InlinePlugin } from '@cyborg-harness/testing';
import { rig, until } from '../../../sessions/sessions/test/kit.ts';
import { PLUGIN_DIR } from './kit.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });

test('git.switch: пока в репозитории идёт сессия sessions, ветка не меняется; после выхода сессии меняется', async () => {
  let ctx: PluginContext | undefined;
  const consumer: InlinePlugin = {
    manifest: { id: 'git-consumer', version: '1.0.0', engines: { cyborg: '^1' }, requires: { 'cyborg.git': '^1.1' }, permissions: { 'fs.read': ['workspace'] } },
    module: {
      activate(c: PluginContext) {
        ctx = c;
        return undefined;
      },
    },
  };
  await using r = await rig({ extra: [PLUGIN_DIR, consumer] });
  for (const dir of [r.repoA, r.repoB]) {
    sh(dir, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', 'init');
    sh(dir, 'branch', 'feature');
  }
  await r.kernel.waitForJournal({ kind: 'activated', pluginId: 'git' });
  await r.kernel.waitForJournal({ kind: 'activated', pluginId: 'git-consumer' });
  const git = ctx?.contracts.get('cyborg.git', 1) as Remote<GitV11> | undefined;
  assert.ok(git);

  const handle = await r.sessions.create({ cwd: r.repoA });
  assert.equal(await r.sessions.uses(r.repoA), true);
  assert.deepEqual(await git.switch(r.repoA, 'feature'), { error: 'в репозитории работает сессия Claude: веткой управляет она' });
  assert.equal(await git.branch(r.repoA), 'main');
  // Соседний репозиторий проекта без сессии меняется.
  assert.deepEqual(await git.switch(r.repoB, 'feature'), {});
  assert.equal(await git.branch(r.repoB), 'feature');

  r.pty.procs.at(-1)?.exit(0);
  await until('сессия вышла', async () => !(await r.sessions.uses(r.repoA)));
  assert.deepEqual(await git.switch(r.repoA, 'feature'), {});
  assert.equal(await git.branch(r.repoA), 'feature');
  assert.ok(handle.sessionId);
});
