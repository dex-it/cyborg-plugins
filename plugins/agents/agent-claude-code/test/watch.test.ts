import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AgentEvent } from '@cyborg-harness/contracts';
import { armed, line, rig, until, type Rig } from './kit.ts';

const probe = line({ hook_event_name: 'PostToolUse', tool_name: 'armed' });

/** Подписка с пробой: события с инструментом `armed` в итог не входят. */
async function listen(r: Rig, sessionId: string): Promise<{ seen: AgentEvent[]; probed: () => boolean; dispose(): void }> {
  const seen: AgentEvent[] = [];
  let probed = false;
  const sub = await r.agent.watch(sessionId, (e) => {
    if (e.type === 'activity' && e.tool === 'armed') probed = true;
    else seen.push(e);
  });
  return { seen, probed: () => probed, dispose: () => sub.dispose() };
}

describe('FR-5003: чтение журнала событий независимо от момента взвода наблюдателя', () => {
  it('подставной claude запущен командой из launch: события, записанные до подписки, читаются с начала и в том же порядке', async () => {
    await using r = await rig();
    const wt = path.join(r.cwd, '.claude', 'worktrees', 'feat');
    const spec = await r.agent.launch({ sessionId: 's1', cwd: r.cwd, promptFragments: ['изоляция'] });
    // claude запускается так, как его запустит pty: оболочка входа, --settings, "$@"; хуки подставной программы пишут в файл сессии.
    const run = r.run(spec, `cd ${wt}\nperm\nask\nwork suggest\n`);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /fake-claude ready/);
    assert.match(run.stdout, /ARGS: --settings .*claude-hooks\.json --append-system-prompt изоляция/);
    const { seen, dispose } = await listen(r, 's1');
    await until('события прочитаны', () => seen.length >= 5);
    assert.deepEqual(seen.slice(0, 4), [{ type: 'cwd', cwd: wt }, { type: 'activity', tool: 'EnterWorktree' }, { type: 'waiting', reason: 'Просит разрешение' }, { type: 'prompt' }]);
    const end = seen[4];
    assert.deepEqual([end?.type, end?.type === 'turnEnd' && end.background], ['turnEnd', false]);
    assert.match(end?.type === 'turnEnd' ? (end.text ?? '') : '', /^Готово\./);
    dispose();
  });

  it('запись между запуском и взводом наблюдателя читается, а повторная подписка продолжает с того места, где остановилась', async () => {
    await using r = await rig();
    const spec = await r.agent.launch({ sessionId: 's2', cwd: r.cwd });
    const file = spec.env.CYBORG_EVENTS ?? '';
    await appendFile(file, line({ hook_event_name: 'PostToolUse', cwd: '/b', tool_name: 'Edit' }));
    const first = await listen(r, 's2');
    await until('первое событие', () => first.seen.length >= 2);
    assert.deepEqual(first.seen, [{ type: 'cwd', cwd: '/b' }, { type: 'activity', tool: 'Edit' }]);
    first.dispose();
    await appendFile(file, line({ hook_event_name: 'UserPromptSubmit' }));
    const second = await listen(r, 's2');
    await until('событие после повторной подписки', () => second.seen.length >= 1);
    assert.deepEqual(second.seen, [{ type: 'prompt' }], 'прочитанное не повторяется');
    second.dispose();
  });

  it('живая запись после подписки: событие доходит, недописанная строка ждёт перевода строки', async () => {
    await using r = await rig();
    const spec = await r.agent.launch({ sessionId: 's3', cwd: '/w' });
    const file = spec.env.CYBORG_EVENTS ?? '';
    const live = await listen(r, 's3');
    await armed(file, probe, live.probed);
    await appendFile(
      file,
      [
        line({ hook_event_name: 'SessionStart', cwd: '/w', session_id: 'c-1' }),
        line({ hook_event_name: 'SessionStart', cwd: '/w', session_id: '--help me' }),
        line({ hook_event_name: 'PostToolUse', cwd: '/w', tool_name: 'Bash' }),
        line({ hook_event_name: 'UserPromptSubmit', cwd: '/w' }),
        line({ hook_event_name: 'Stop', cwd: '/w/sub', last_assistant_message: 'готово', background_tasks: [] }),
        line({ hook_event_name: 'Stop', cwd: '/w/sub', session_crons: [{}] }),
        line({ hook_event_name: 'Notification', cwd: '/w/sub', notification_type: 'permission_prompt', message: 'секрет' }),
        line({ hook_event_name: 'Notification', cwd: '/w/sub', notification_type: 'idle_prompt' }),
        'не json\n',
        '{"hook_event_name":"Stop"',
      ].join(''),
    );
    await until('события хуков', () => live.seen.length >= 7);
    assert.deepEqual(live.seen, [
      { type: 'session', resumeId: 'c-1' },
      { type: 'activity', tool: 'Bash' },
      { type: 'prompt' },
      { type: 'cwd', cwd: '/w/sub' },
      { type: 'turnEnd', background: false, text: 'готово' },
      { type: 'turnEnd', background: true },
      { type: 'waiting', reason: 'Просит разрешение' },
    ]);
    await appendFile(file, '}\n');
    await until('дописанная строка', () => live.seen.length === 8);
    assert.deepEqual(live.seen.at(-1), { type: 'turnEnd', background: false });
    live.dispose();
  });

  it('сессия, запущенная не этим экземпляром плагина (подхват после перезапуска): подписка начинается с конца файла', async () => {
    await using r = await rig();
    const dir = path.join(r.data, 'sessions');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'old.jsonl');
    await writeFile(file, line({ hook_event_name: 'PostToolUse', cwd: '/old', tool_name: 'Old' }));
    const live = await listen(r, 'old');
    await armed(file, probe, live.probed);
    await appendFile(file, line({ hook_event_name: 'UserPromptSubmit', cwd: '/old' }));
    await until('новое событие', () => live.seen.length >= 2);
    assert.deepEqual(live.seen, [{ type: 'cwd', cwd: '/old' }, { type: 'prompt' }], 'прошлые события уже показаны; cwd сообщается, пока он неизвестен');
    live.dispose();
  });

  it('«ждёт» после Stop не объявляется, пока сессия не промолчит; Stop с фоновой работой и после dispose - никогда', async () => {
    await using r = await rig();
    const spec = await r.agent.launch({ sessionId: 's4', cwd: '/w' });
    const file = spec.env.CYBORG_EVENTS ?? '';
    const live = await listen(r, 's4');
    await armed(file, probe, live.probed);
    await appendFile(file, line({ hook_event_name: 'Stop', cwd: '/w', session_crons: [{}] }) + line({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }));
    await until('Stop', () => live.seen.some((e) => e.type === 'turnEnd'));
    assert.deepEqual(live.seen, [{ type: 'turnEnd', background: true }]);
    live.dispose();
  });
});

describe('файлы событий', () => {
  it('файл сессии - sessions/<id>.jsonl в данных плагина; ended убирает его и возвращает null при нормальном выходе', async () => {
    await using r = await rig();
    const spec = await r.agent.launch({ sessionId: 'x1', cwd: '/w' });
    assert.equal(spec.env.CYBORG_EVENTS, path.join(r.data, 'sessions', 'x1.jsonl'));
    assert.equal(await r.agent.ended('x1', { code: 0 }), null);
    await assert.rejects(stat(spec.env.CYBORG_EVENTS ?? ''));
  });

  it('файлы убитого приложения старше недели убираются при активации, свежие остаются (pid в имени не нужен)', async () => {
    const dir = (data: string) => path.join(data, 'sessions');
    const old = (data: string) => path.join(dir(data), 'dead.jsonl');
    const fresh = (data: string) => path.join(dir(data), 'alive.jsonl');
    await using r = await rig({
      beforeStart: ({ data }) => {
        mkdirSync(dir(data), { recursive: true });
        writeFileSync(old(data), 'x');
        writeFileSync(fresh(data), 'y');
        const longAgo = new Date(Date.now() - 8 * 24 * 3600_000);
        utimesSync(old(data), longAgo, longAgo);
      },
    });
    await assert.rejects(stat(old(r.data)), 'давний файл убран');
    assert.equal(await readFile(fresh(r.data), 'utf8'), 'y', 'свежий остался: сессия могла дожить до перезапуска');
  });
});
