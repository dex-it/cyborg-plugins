import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { claudeArgs, LAUNCH_SCRIPT, MCP_SERVER, SESSION_ID, mcpConfig } from '../args.ts';
import { DENIED_FLAGS, ID_A, manifest, rig, until } from './kit.ts';

// Тестовые фрагменты вместо SESSION_PROMPT ai-cyborg: промпты изоляции и кнопок отдают плагины session-isolation и next-actions (M-06, M-18).
const FRAGMENT = 'изоляция';
const request = { sessionId: 'a', cwd: '/w' } as const;

describe('FR-9002: порядок аргументов запуска', () => {
  it('claudeArgs: --resume с id стоит до --add-dir', () => {
    assert.deepEqual(claudeArgs({ ...request, extraDirs: ['/b'], resumeId: ID_A, promptFragments: [FRAGMENT] }), ['--resume', ID_A, '--append-system-prompt', FRAGMENT, '--add-dir', '/b']);
  });

  it('claudeArgs: промпт стоит до вариадического --add-dir, без задачи аргументы прежние', () => {
    const f = [FRAGMENT];
    assert.deepEqual(claudeArgs({ ...request, extraDirs: ['/b', '/c'], prompt: 'P', promptFragments: f }), ['--append-system-prompt', FRAGMENT, 'P', '--add-dir', '/b', '/c']);
    assert.deepEqual(claudeArgs({ ...request, extraDirs: ['/b'], promptFragments: f }), ['--append-system-prompt', FRAGMENT, '--add-dir', '/b']);
    assert.deepEqual(claudeArgs({ ...request, extraDirs: [], promptFragments: f }), ['--append-system-prompt', FRAGMENT]);
    assert.deepEqual(claudeArgs({ ...request, prompt: 'P', promptFragments: f }), ['--append-system-prompt', FRAGMENT, 'P']);
  });

  it('claudeArgs: промпт на «/» стоит до --add-dir', () => {
    assert.deepEqual(claudeArgs({ ...request, extraDirs: ['/b'], prompt: '/dex-auto:auto review URL', promptFragments: [FRAGMENT] }), ['--append-system-prompt', FRAGMENT, '/dex-auto:auto review URL', '--add-dir', '/b']);
  });

  it('без фрагментов --append-system-prompt не нужен; несколько фрагментов - одним значением через пустую строку', () => {
    assert.deepEqual(claudeArgs(request), []);
    assert.deepEqual(claudeArgs({ ...request, promptFragments: ['изоляция', 'кнопки'] }), ['--append-system-prompt', 'изоляция\n\nкнопки']);
  });

  it('конфиг MCP одним словом: вариадический флаг не забирает промпт', () => {
    assert.deepEqual(claudeArgs({ ...request, prompt: 'p', extraDirs: ['/x'] }, '/m.json'), ['--mcp-config=/m.json', 'p', '--add-dir', '/x']);
  });

  it('resumeId из данных документа не становится флагом claude', () => {
    for (const bad of ['--dangerously-skip-permissions', '-r', '', 'a b', '../x', 'a'.repeat(65)]) assert.throws(() => claudeArgs({ ...request, resumeId: bad }), /--resume/, bad);
  });
});

describe('id сессии', () => {
  it('принимает буквы, цифры, дефис и подчёркивание, первый знак не дефис', () => {
    for (const id of ['a1', 'claude-77', ID_A, 'S_1', '0', 'a'.repeat(64)]) assert.ok(SESSION_ID.test(id), id);
  });

  it('отвергает пустую строку, дефис в начале, путь, пробелы, перевод строки и длину сверх 64', () => {
    for (const id of ['', '-x', '--help', '../x', 'a/b', 'a b', 'a\nb', 'я', '.', 'a'.repeat(65)]) assert.ok(!SESSION_ID.test(id), JSON.stringify(id));
  });

  it('launch: негодный id сессии - отказ до записи на диск, resumeId - тоже', async () => {
    await using r = await rig();
    for (const sessionId of ['../x', '-x', '', 'a/b']) await assert.rejects(r.agent.launch({ sessionId, cwd: r.cwd }), /id сессии/, sessionId);
    await assert.rejects(r.agent.launch({ sessionId: 'ok', cwd: r.cwd, resumeId: '--tools' }), /--resume/);
    await assert.rejects(stat(path.join(r.data, 'sessions', 'ok.jsonl')), 'файл событий негодного запуска не создан');
  });
});

describe('запуск как в Cyborg: оболочка входа, --settings, окружение', () => {
  it('launch: $SHELL -lc с закреплённым скриптом, порядок аргументов, файлы по id сессии без pid', async () => {
    await using r = await rig();
    assert.deepEqual(await r.agent.facts(), { id: 'claude-code', title: 'Claude Code', found: true, version: '2.1.314', capabilities: { resume: true, history: true, events: true } });
    const spec = await r.agent.launch({ sessionId: 'a1', cwd: '/w', resumeId: 'r-1', promptFragments: ['изоляция', 'кнопки'], prompt: 'привет', extraDirs: ['/x', '/y'] });
    assert.deepEqual(spec, {
      program: '$SHELL',
      args: ['-lc', LAUNCH_SCRIPT, 'cyborg', '--resume', 'r-1', '--append-system-prompt', 'изоляция\n\nкнопки', 'привет', '--add-dir', '/x', '/y'],
      cwd: '/w',
      env: { CYBORG_EVENTS: path.join(r.data, 'sessions', 'a1.jsonl'), CYBORG_SETTINGS: path.join(r.data, 'claude-hooks.json') },
    });
    assert.equal(await readFile(spec.env.CYBORG_EVENTS ?? '', 'utf8'), '', 'файл событий создан пустым');
    assert.ok(!path.basename(spec.env.CYBORG_EVENTS ?? '').includes(String(process.pid)), 'pid в имени файла не нужен');
  });

  it('скрипт запуска закреплён в правиле launch манифеста: --settings из данных плагина и аргументы только через "$@"', () => {
    const [rule] = manifest.permissions.launch as { program: string; args: string[]; env: string[] }[];
    assert.deepEqual(rule?.args, ['-lc', LAUNCH_SCRIPT, 'cyborg']);
    assert.equal(rule?.program, '$SHELL');
    assert.deepEqual(rule?.env, ['CYBORG_EVENTS', 'CYBORG_SETTINGS', 'CYBORG_MCP_TOKEN']);
  });

  it('MCP: токен только в окружении процесса, не в файле и не в командной строке; ended убирает конфиг', async () => {
    await using r = await rig();
    const spec = await r.agent.launch({ sessionId: 'a2', cwd: '/w', tools: { url: 'http://127.0.0.1:9/mcp', token: 'секрет' } });
    const mcpFile = path.join(r.data, 'sessions', 'a2.mcp.json');
    assert.deepEqual(spec.args.slice(3), [`--mcp-config=${mcpFile}`]);
    assert.equal(spec.env.CYBORG_MCP_TOKEN, 'секрет');
    const written = await readFile(mcpFile, 'utf8');
    assert.ok(!written.includes('секрет') && !spec.args.join(' ').includes('секрет'));
    assert.deepEqual(JSON.parse(written), { mcpServers: { cyborg: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer ${CYBORG_MCP_TOKEN}' } } } });
    assert.deepEqual(mcpConfig('http://h/mcp'), { mcpServers: { [MCP_SERVER]: { type: 'http', url: 'http://h/mcp', headers: { Authorization: 'Bearer ${CYBORG_MCP_TOKEN}' } } } });
    await r.agent.ended('a2', { code: 0 });
    await assert.rejects(stat(mcpFile), 'ended убрал конфиг с токеном');
  });

  it('режим разрешений человека не меняется: в --settings только хуки и allow сервера cyborg, во флагах нет режима и списка инструментов', async () => {
    await using r = await rig();
    const spec = await r.agent.launch({ sessionId: 'p1', cwd: '/w', resumeId: 'r-1', prompt: 'привет', extraDirs: ['/x'], promptFragments: ['f'], tools: { url: 'http://127.0.0.1:9/mcp', token: 't' } });
    const settings = JSON.parse(await readFile(path.join(r.data, 'claude-hooks.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(settings).toSorted(), ['hooks', 'permissions']);
    assert.deepEqual(settings.permissions, { allow: ['mcp__cyborg'] }, 'allow - ровно сервер cyborg; deny, ask и defaultMode не заданы');
    const flags = [LAUNCH_SCRIPT, ...spec.args].join(' ');
    for (const weakening of [...DENIED_FLAGS, 'bypassPermissions']) {
      assert.ok(!flags.includes(weakening), `${weakening} не должен попасть в запуск`);
    }
  });

  it('pty потребителя с deny и переменная вне правила: ядро отклоняет опасный флаг в хвосте argv и чужую переменную; унаследованные CLAUDE* и CYBORG_CWD до claude не доходят', async () => {
    await using r = await rig({ os: { env: { PATH: '/usr/bin:/bin', HOME: '/h', SHELL: '/bin/sh', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'родитель', CLAUDE_CODE_ENTRYPOINT: 'cli', CYBORG_CWD: '/launcher/cwd', CYBORG_MCP: 'родитель.json' } } });
    const spec = await r.agent.launch({ sessionId: 'e1', cwd: realpathSync(r.consumer.os.paths.data), tools: { url: 'http://127.0.0.1:9/mcp', token: 't' } });
    const pty = r.consumer.os.pty;
    assert.ok(pty);
    const before = r.kernel.pty.procs.length;
    await pty.spawn({ ...spec, describedBy: 'agent-claude-code' });
    const proc = r.kernel.pty.procs[before];
    assert.ok(proc);
    const names = Object.keys(proc.options.env ?? {});
    assert.deepEqual(names.filter((n) => n.startsWith('CLAUDE') || n === 'CYBORG_CWD' || n === 'CYBORG_MCP'), [], 'окружение родительской сессии не унаследовано');
    assert.deepEqual(names.filter((n) => n.startsWith('CYBORG_')).toSorted(), ['CYBORG_EVENTS', 'CYBORG_MCP_TOKEN', 'CYBORG_SETTINGS']);
    // Чужая переменная и флаг, ослабляющий режим разрешений, - отказ ядра до запуска.
    await assert.rejects(pty.spawn({ ...spec, env: { ...spec.env, CLAUDECODE: '1' }, describedBy: 'agent-claude-code' }), { code: 'PermissionDenied' });
    await assert.rejects(pty.spawn({ ...spec, args: [...spec.args, '--dangerously-skip-permissions'], describedBy: 'agent-claude-code' }), { code: 'PermissionDenied' });
    assert.equal(r.kernel.pty.procs.length, before + 1, 'отклонённые запуски процессов не создали');
  });

  it('claude-hooks.json лежит в данных плагина, события сессии - в sessions/<id>.jsonl; ended убирает файл сессии', async () => {
    await using r = await rig();
    const hooks = JSON.parse(await readFile(path.join(r.data, 'claude-hooks.json'), 'utf8')) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification']);
    assert.equal(hooks.hooks.PostToolUse?.[0]?.matcher, '*');
    assert.equal(hooks.hooks.PostToolUseFailure?.[0]?.matcher, '*');
    assert.equal(hooks.hooks.Stop?.[0]?.hooks[0]?.command, '{ cat; echo; } >> "$CYBORG_EVENTS"');
    const spec = await r.agent.launch({ sessionId: 'f1', cwd: r.cwd });
    const file = spec.env.CYBORG_EVENTS ?? '';
    assert.equal((await stat(file)).isFile(), true);
    assert.equal(await r.agent.ended('f1', { code: 0 }), null);
    await until('ended убрал файл событий', () => stat(file).then(() => false, () => true));
  });
});

