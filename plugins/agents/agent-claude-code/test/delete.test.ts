import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BAD_DELETE, deleteSessions, NOT_FOUND, projectDirName } from '../history.ts';
import { ID_A, ID_B, ID_C, journals, line, manifest, nodeFs, rig } from './kit.ts';

const session = (text = 'задача') => line({ entrypoint: 'cli' }) + line({ type: 'user', message: { content: text } });
const ID_D = '44444444-4444-4444-4444-444444444444';

describe('удаление истории (FR-8003, FR-8005): запись только по пути сессии', () => {
  it('несколько сессий разом: журнал и каталог каждой уходят, соседи, чужие проекты и прочие файлы ~/.claude остаются', async () => {
    await using r = await rig();
    const cwd = '/w/repo';
    const own = path.join(r.projects, projectDirName(cwd));
    const wt = path.join(r.projects, `${projectDirName(cwd)}--claude-worktrees-feat`);
    for (const [file, dir] of [[ID_A, own], [ID_B, own], [ID_C, wt], [ID_D, own]] as const) {
      r.journal(cwd, file, session(file), 1000, dir === wt ? '--claude-worktrees-feat' : '');
      mkdirSync(path.join(dir, file, 'subagents'), { recursive: true });
      writeFileSync(path.join(dir, file, 'subagents', 'a.jsonl'), '{}');
    }
    const other = r.journal('/w/other', ID_A, session('чужая'));
    const settings = path.join(r.home, '.claude', 'settings.json');
    writeFileSync(settings, '{"keep":true}');
    const result = await r.kernel.run('agent-claude-code.history.delete', cwd, [ID_A, ID_B, ID_C]);
    assert.deepEqual(result, { deleted: [ID_A, ID_B, ID_C], failed: [] });
    for (const [dir, id] of [[own, ID_A], [own, ID_B], [wt, ID_C]] as const) {
      assert.equal(existsSync(path.join(dir, `${id}.jsonl`)), false, `${id}.jsonl`);
      assert.equal(existsSync(path.join(dir, id)), false, `каталог ${id}`);
    }
    assert.equal(existsSync(path.join(own, `${ID_D}.jsonl`)), true, 'не названная сессия осталась');
    assert.equal(existsSync(path.join(own, ID_D, 'subagents', 'a.jsonl')), true);
    assert.equal(existsSync(other), true, 'сессия другого проекта с тем же id осталась');
    assert.equal(readFileSync(settings, 'utf8'), '{"keep":true}', 'остальное в ~/.claude не тронуто');
    assert.deepEqual((await r.agent.history(cwd)).map((e) => e.id), [ID_D]);
  });

  it('сбой одной сессии остальные не останавливает: неудавшиеся перечисляются с причиной', async () => {
    await using r = await rig();
    const cwd = '/w/repo';
    r.journal(cwd, ID_A, session());
    r.journal(cwd, ID_C, session());
    const result = await r.kernel.run('agent-claude-code.history.delete', cwd, [ID_A, ID_B, 'не-uuid', ID_C]);
    assert.deepEqual(result, {
      deleted: [ID_A, ID_C],
      failed: [
        { id: ID_B, reason: NOT_FOUND },
        { id: 'не-uuid', reason: BAD_DELETE },
      ],
    });
  });

  it('выйти за каталог нельзя: id с «..» и разделителями, чужой cwd, ссылка вместо каталога проекта - ни одного удаления вне журналов сессии', async () => {
    using j = journals();
    const outside = mkdtempSync(path.join(tmpdir(), 'cyborg-outside-'));
    try {
      const victim = path.join(outside, 'victim.jsonl');
      writeFileSync(victim, 'жив');
      mkdirSync(path.join(outside, ID_A));
      writeFileSync(path.join(outside, `${ID_A}.jsonl`), 'жив');
      const cwd = '/w/repo';
      const dir = projectDirName(cwd);
      // Каталог проекта - ссылка наружу: по ней уйти нельзя.
      symlinkSync(outside, path.join(j.root, dir));
      const log: string[] = [];
      const fs = nodeFs(log);
      const attempts: unknown[] = ['..', '../victim', `../${ID_A}`, `${ID_A}/../../x`, '/etc/passwd', `${ID_A}.jsonl`, `${ID_A}\0`, '', 7, null, {}, ID_A];
      const result = await deleteSessions(fs, j.root, cwd, attempts);
      assert.deepEqual(result.deleted, []);
      assert.equal(result.failed.length, attempts.length);
      assert.deepEqual(log, [], 'remove не вызывался ни по одному пути');
      assert.equal(readFileSync(victim, 'utf8'), 'жив');
      assert.equal(readFileSync(path.join(outside, `${ID_A}.jsonl`), 'utf8'), 'жив');
      assert.equal(existsSync(path.join(outside, ID_A)), true);
      // cwd, из которого получился бы выход наружу, и негодные формы запроса - отказ целиком.
      for (const bad of [undefined, 5, '', null]) await assert.rejects(deleteSessions(fs, j.root, bad, [ID_A]), new RegExp(BAD_DELETE), String(bad));
      for (const bad of [undefined, 'x', {}, null]) await assert.rejects(deleteSessions(fs, j.root, cwd, bad), new RegExp(BAD_DELETE), String(bad));
      await deleteSessions(fs, j.root, '../../..', [ID_A]);
      await deleteSessions(fs, j.root, `${cwd}/../..`, [ID_A]);
      assert.deepEqual(log, []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('все пути записи - ровно <каталог журналов>/<каталог проекта>/<uuid> и <uuid>.jsonl', async () => {
    using j = journals();
    const cwd = '/w/repo';
    const dir = projectDirName(cwd);
    j.write(dir, `${ID_A}.jsonl`, session());
    j.write(`${dir}--claude-worktrees-a`, `${ID_B}.jsonl`, session());
    const log: string[] = [];
    const result = await deleteSessions(nodeFs(log), j.root, cwd, [ID_A, ID_B]);
    assert.deepEqual(result.deleted, [ID_A, ID_B]);
    assert.deepEqual(log, [
      path.join(j.root, dir, ID_A),
      path.join(j.root, dir, `${ID_A}.jsonl`),
      path.join(j.root, `${dir}--claude-worktrees-a`, ID_B),
      path.join(j.root, `${dir}--claude-worktrees-a`, `${ID_B}.jsonl`),
    ]);
  });

  it('право записи плагина - только ~/.claude/projects; другой плагин без права записи в каталог проекта команду не вызовет', async () => {
    assert.deepEqual(manifest.permissions['fs.write'], ['~/.claude/projects']);
    assert.deepEqual(manifest.permissions['fs.read'], ['~/.claude/projects']);
    await using r = await rig();
    const cwd = '/w/repo';
    const file = r.journal(cwd, ID_A, session());
    // Потребитель probe вызывает команду плагина как другой плагин: guard требует у вызывающего право записи на cwd.
    await assert.rejects(r.consumer.commands.run('agent-claude-code.history.delete', cwd, [ID_A]), { code: 'PermissionDenied' });
    assert.equal(existsSync(file), true, 'журнал на месте');
  });
});
