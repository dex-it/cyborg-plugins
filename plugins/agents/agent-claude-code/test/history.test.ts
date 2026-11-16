import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { deleteHistory, historyExists, journalFacts, listHistory, projectDirName } from '../history.ts';
import { ID_A, ID_B, ID_C, journals, line, nodeFs, rig } from './kit.ts';

// Утверждения test/history.test.ts ai-cyborg (FR-8001, FR-8003, FR-5008): те же данные и проверки, поменялись только путь импорта и способ доступа
// к файлам (`OsFs` вместо `node:fs`) и поле `repo` -> `cwd` (HistoryEntry контракта cyborg.agent).
describe('история сессий', () => {
  it('projectDirName: всё, кроме букв и цифр, - «-», как каталоги ~/.claude/projects', () => {
    assert.equal(projectDirName('/home/mmx/Work/Cyborg'), '-home-mmx-Work-Cyborg');
    assert.equal(projectDirName('/a/b.c_d'), '-a-b-c-d');
  });

  it('journalFacts: custom-title старше ai-title, тот старше первого запроса; служебная разметка - не запрос', () => {
    const head = [
      line({ type: 'user', entrypoint: 'cli', message: { content: '<local-command-caveat>x</local-command-caveat>' } }),
      line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: '  почини\n дерево  ' }] } }),
    ].join('');
    assert.deepEqual(journalFacts(head, ''), { interactive: true, title: 'почини дерево', named: '', firstPrompt: 'почини\n дерево' });
    const tail = ['{"обрезано\n', line({ type: 'ai-title', aiTitle: 'AI' }), line({ type: 'custom-title', customTitle: 'Моё' })].join('');
    assert.equal(journalFacts(head, tail).title, 'Моё');
    assert.equal(journalFacts(head, tail).named, 'Моё');
    assert.equal(journalFacts(head, line({ type: 'ai-title', aiTitle: 'AI' })).title, 'AI');
  });

  it('journalFacts: сессия SDK не интерактивна', () => {
    assert.equal(journalFacts(line({ type: 'user', entrypoint: 'sdk-py', message: { content: 'ревью' } }), '').interactive, false);
  });

  it('listHistory: только интерактивные с заголовком, свежие первыми; лимит; чужие файлы мимо', async () => {
    using j = journals();
    const fs = nodeFs();
    const repo = '/w/repo';
    const dir = projectDirName(repo);
    const prompt = (text: string, entrypoint = 'cli') => line({ type: 'user', entrypoint, message: { content: text } });
    j.write(dir, `${ID_A}.jsonl`, prompt('старая'), 1000);
    j.write(dir, `${ID_B}.jsonl`, prompt('новая'), 2000);
    j.write(dir, `${ID_C}.jsonl`, prompt('фоновая', 'sdk-py'), 3000);
    j.write(dir, 'not-a-session.jsonl', prompt('x'), 4000);
    const list = await listHistory(fs, j.root, repo);
    assert.deepEqual(
      list.map((e) => [e.id, e.title, e.cwd]),
      [
        [ID_B, 'новая', repo],
        [ID_A, 'старая', repo],
      ],
    );
    assert.deepEqual(await listHistory(fs, j.root, '/w/none'), []);
    assert.equal((await listHistory(fs, j.root, repo, 1)).length, 1);
    assert.equal(await historyExists(fs, j.root, repo, ID_A), true);
    assert.equal(await historyExists(fs, j.root, repo, '../x'), false);
    assert.equal(await historyExists(fs, j.root, '/w/none', ID_A), false);
    mkdirSync(path.join(j.root, dir, ID_A, 'subagents'), { recursive: true });
    await deleteHistory(fs, j.root, repo, ID_A);
    assert.equal(existsSync(path.join(j.root, dir, ID_A)), false);
    assert.deepEqual((await listHistory(fs, j.root, repo)).map((e) => e.id), [ID_B]);
    await assert.rejects(deleteHistory(fs, j.root, repo, ID_A));
  });

  it('сессии worktree (FR-5008): журнал в каталоге <репозиторий>--claude-worktrees-<имя> виден, возобновляется и удаляется', async () => {
    using j = journals();
    const fs = nodeFs();
    const repo = '/w/repo';
    const prompt = (text: string) => line({ type: 'user', entrypoint: 'cli', message: { content: text } });
    // раскладка настоящего Claude Code: worktree - <repo>/.claude/worktrees/<имя>
    const wtDir = projectDirName(`${repo}/.claude/worktrees/create-a-txt`);
    assert.equal(wtDir, `${projectDirName(repo)}--claude-worktrees-create-a-txt`);
    j.write(projectDirName(repo), `${ID_A}.jsonl`, prompt('в репозитории'));
    j.write(wtDir, `${ID_B}.jsonl`, prompt('в worktree'));
    j.write(projectDirName('/w/repo2'), `${ID_C}.jsonl`, prompt('чужой репозиторий с похожим именем'));
    j.write(`${projectDirName('/w/repo2')}--claude-worktrees-x`, `${ID_C}.jsonl`, prompt('worktree чужого репозитория'));

    assert.deepEqual((await listHistory(fs, j.root, repo)).map((e) => [e.id, e.cwd]).sort(), [[ID_A, repo], [ID_B, repo]]);
    assert.equal(await historyExists(fs, j.root, repo, ID_B), true);
    assert.equal(await historyExists(fs, j.root, '/w/other', ID_B), false);

    mkdirSync(path.join(j.root, wtDir, ID_B, 'subagents'), { recursive: true });
    await deleteHistory(fs, j.root, repo, ID_B);
    assert.equal(existsSync(path.join(j.root, wtDir, `${ID_B}.jsonl`)), false);
    assert.equal(existsSync(path.join(j.root, wtDir, ID_B)), false);
    assert.deepEqual((await listHistory(fs, j.root, repo)).map((e) => e.id), [ID_A]);
    await assert.rejects(deleteHistory(fs, j.root, repo, ID_B));
  });
});

describe('cyborg.agent: history(cwd) через ядро', () => {
  it('интерактивные сессии каталога и его worktree, заголовок с краёв длинного журнала, свежие первыми', async () => {
    await using r = await rig();
    const cwd = '/home/u/repo';
    const id = (n: number) => `0000000${String(n)}-0000-4000-8000-000000000000`;
    r.journal(cwd, id(1), line({ entrypoint: 'cli' }) + line({ type: 'user', message: { content: '<local-command-caveat>' } }) + line({ type: 'user', message: { content: [{ type: 'text', text: 'почини   тесты' }] } }), 1000);
    r.journal(cwd, id(2), line({ entrypoint: 'sdk-cli' }) + line({ type: 'user', message: { content: 'из claude -p' } }), 3000);
    const long = line({ entrypoint: 'cli' }) + line({ type: 'user', message: { content: 'первый запрос' } }) + 'x'.repeat(200 * 1024) + '\n' + line({ type: 'ai-title', aiTitle: 'Длинная сессия' });
    r.journal(cwd, id(3), long, 2000, '--claude-worktrees-feat');
    r.journal('/home/u/other', id(4), line({ entrypoint: 'cli' }) + line({ type: 'user', message: { content: 'чужой' } }), 4000);
    r.journal(cwd, 'не-сессия', line({ entrypoint: 'cli' }), 5000);
    const expected = [
      { id: id(3), cwd, title: 'Длинная сессия', updated: 2_000_000 },
      { id: id(1), cwd, title: 'почини тесты', updated: 1_000_000 },
    ];
    assert.deepEqual(await r.agent.history(cwd), expected);
    assert.deepEqual(await r.kernel.run('agent-claude-code.history.list', cwd), expected, 'тот же список командой для вида «Сессии»');
    assert.deepEqual(await r.agent.history('/nowhere'), []);
  });

  it('список не длиннее 50 записей', async () => {
    await using r = await rig();
    const cwd = '/home/u/many';
    for (let i = 0; i < 55; i++) r.journal(cwd, `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, line({ entrypoint: 'cli' }) + line({ type: 'user', message: { content: `запрос ${String(i)}` } }), 1000 + i);
    const list = await r.agent.history(cwd);
    assert.equal(list.length, 50);
    assert.equal(list[0]?.title, 'запрос 54');
  });

  it('продолжение: id из истории годится как resumeId запуска, порядок аргументов прежний', async () => {
    await using r = await rig();
    const cwd = '/home/u/repo';
    r.journal(cwd, ID_A, line({ entrypoint: 'cli' }) + line({ type: 'user', message: { content: 'задача' } }), 1000);
    const [entry] = await r.agent.history(cwd);
    assert.equal(entry?.id, ID_A);
    const spec = await r.agent.launch({ sessionId: 'resume-1', cwd, resumeId: entry?.id ?? '', promptFragments: ['f'], extraDirs: ['/b'] });
    assert.deepEqual(spec.args.slice(3), ['--resume', ID_A, '--append-system-prompt', 'f', '--add-dir', '/b']);
  });
});
