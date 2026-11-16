// Перенос test/remote-args.test.ts ai-cyborg: те же утверждения; путь импорта и форма проекта меняются (ProjectView вместо Project).
// Не перенесено: `systemSsh: закрытие канала` (EOF перед SIGTERM у долгоживущего канала): канала нет, ssh короткий (cyborg-harness#260).
// Изменено: validateRemoteFs берёт идентификатор-строку вместо номера вкладки; ограничение хостов проверяется функциями hosts.ts, а не validateProjectsState.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { branchNameProblem, hostCloneUrl, readSearchReply, REMOTE_FS_OPS, validateHumanRemoteCreate, validateRemoteCreate, validateRemoteFs, validateRemotePath, validBranchName, MAX_TEXT_BYTES, type ProjectView } from '../args.ts';
import { HOST_ALIAS, hostProblems, MAX_HOSTS, readHosts, validateHosts } from '../hosts.ts';
import { parsePreflight } from '../preflight.ts';
import { classifySshError, SSH_PINNED, sshArgs } from '../ssh.ts';

const project: ProjectView = { repos: ['/r/a', '/r/b'], hosts: ['dev1'] };
const ok = { host: 'dev1', repo: '/r/a', branch: 'feat/x' };

describe('validBranchName', () => {
  it('принимает допустимые имена', () => {
    for (const n of ['main', 'feat/x-1', 'release/1.2', 'a@b', 'я/ветка']) assert.equal(validBranchName(n), true, n);
  });
  it('отвергает недопустимые по check-ref-format и ведущий «-»', () => {
    for (const n of ['-x', 'a..b', 'x.lock', 'a/x.lock/b', '@', 'a//b', '/a', 'a/', 'a.', '.a', 'a/.b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'a@{1}', 'a\nb', '', 'x'.repeat(256)])
      assert.notEqual(branchNameProblem(n), null, JSON.stringify(n));
    assert.equal(validBranchName(5), false);
  });
});

describe('validateRemoteCreate', () => {
  it('принимает хост, репозиторий и ветку проекта; пустое задание значит «без задания»', () => {
    assert.deepEqual(validateRemoteCreate(ok, project), ok);
    assert.deepEqual(validateRemoteCreate({ ...ok, prompt: '   ' }, project), ok);
    assert.deepEqual(validateRemoteCreate({ ...ok, prompt: ' сделай\x1b  ' }, project), { ...ok, prompt: 'сделай' });
  });
  it('отвергает подмену хоста и репозитория, плохую ветку, неизвестный проект', () => {
    assert.match(validateRemoteCreate({ ...ok, host: 'evil' }, project) as string, /хост не из списка/);
    assert.match(validateRemoteCreate(ok, { ...project, hosts: [] }) as string, /хост не из списка/);
    assert.match(validateRemoteCreate({ ...ok, repo: '/etc' }, project) as string, /репозиторий/);
    assert.match(validateRemoteCreate({ ...ok, branch: '-x' }, project) as string, /«-»/);
    assert.match(validateRemoteCreate(ok, undefined) as string, /Некорректные аргументы remote:create/);
  });
  it('задание: «-» и «!» отвергаются, предел ровно 100000 байт принят, 100001 отвергнут', () => {
    assert.match(validateRemoteCreate({ ...ok, prompt: ' -x' }, project) as string, /«-»/);
    assert.match(validateRemoteCreate({ ...ok, prompt: '!ls' }, project) as string, /«!»/);
    assert.match(validateRemoteCreate({ ...ok, prompt: '\x01!ls' }, project) as string, /«!»/);
    assert.match(validateRemoteCreate({ ...ok, prompt: '\x1b -x' }, project) as string, /«-»/);
    assert.equal(typeof validateRemoteCreate({ ...ok, prompt: 'a'.repeat(MAX_TEXT_BYTES) }, project), 'object');
    assert.match(validateRemoteCreate({ ...ok, prompt: 'a'.repeat(MAX_TEXT_BYTES + 1) }, project) as string, /байт/);
  });
});

describe('validateHumanRemoteCreate', () => {
  it('задание из интерфейса не принимается: человек пишет его в терминал сам', () => {
    assert.deepEqual(validateHumanRemoteCreate({ ...ok, prompt: 'сделай' }, project), ok);
  });
  it('проверки хоста, репозитория и ветки те же', () => {
    assert.match(validateHumanRemoteCreate({ ...ok, host: 'evil' }, project) as string, /хост не из списка/);
    assert.match(validateHumanRemoteCreate({ ...ok, branch: '-x' }, project) as string, /«-»/);
    assert.match(validateHumanRemoteCreate(null, project) as string, /Некорректные аргументы remote:create/);
  });
});

describe('sshArgs и classifySshError', () => {
  it('BatchMode и ConnectTimeout заданы, «--» стоит перед алиасом', () => {
    const a = sshArgs('dev1', 'sh -s', ['-R', '/s:127.0.0.1:1']);
    assert.ok(a.includes('BatchMode=yes') && a.includes('ConnectTimeout=15'));
    assert.deepEqual(a.slice(-3), ['--', 'dev1', 'sh -s']);
  });
  it('закреплённые аргументы правила process: те же ключи, что у sshArgs, «--» последним', () => {
    assert.deepEqual([...SSH_PINNED], sshArgs('x', 'y').slice(0, -2));
    assert.equal(SSH_PINNED.at(-1), '--');
  });
  it('типовые строки stderr дают свою причину', () => {
    assert.match(classifySshError('user@h: Permission denied (publickey).'), /ssh-agent/);
    assert.match(classifySshError('Host key verification failed.'), /ключ хоста/);
    assert.match(classifySshError('ssh: Could not resolve hostname x'), /алиас/);
    assert.match(classifySshError('Connection timed out'), /15 с/);
    assert.match(classifySshError('Warning: remote port forwarding failed for listen path'), /AllowStreamLocalForwarding/);
    assert.equal(classifySshError('a\n' + 'z'.repeat(400)).length, 300);
  });
});

describe('parsePreflight', () => {
  const good = 'home=/home/u\nnode=v20.1.0\ngit=/usr/bin/git\nclaude=/bin/claude\nscript=/usr/bin/script\nauth={"loggedIn":true}\n';
  const none = { gh: false, glab: false };
  it('установленные версии агента берутся из строки agentd', () => assert.deepEqual(parsePreflight(good + 'agentd=aaa bbb \n'), { home: '/home/u', installed: ['aaa', 'bbb'], tools: none }));
  it('хост в порядке - домашний каталог', () => assert.deepEqual(parsePreflight(good), { home: '/home/u', installed: [], tools: none }));
  it('gh и glab на хосте - признаки, а не условие запуска', () => {
    assert.deepEqual(parsePreflight(good + 'gh=/usr/bin/gh\nglab=\n'), { home: '/home/u', installed: [], tools: { gh: true, glab: false } });
    assert.deepEqual(parsePreflight(good + 'glab=/usr/local/bin/glab\n'), { home: '/home/u', installed: [], tools: { gh: false, glab: true } });
  });
  it('называет все недостающие инструменты разом', () => {
    assert.deepEqual(parsePreflight('home=/h\nnode=v16.0.0\ngit=\nclaude=\nscript=/s\n'), { missing: ['на хосте нет: node ≥ 18, git, claude'] });
  });
  it('хост не Linux - отказ с причиной до проверки инструментов', () => {
    assert.deepEqual(parsePreflight('uname=Darwin\n' + good), { missing: ['хост не Linux (Darwin): нужны script и stty из util-linux'] });
    assert.deepEqual(parsePreflight('uname=Linux\n' + good), { home: '/home/u', installed: [], tools: none });
  });
  it('не залогинен: loggedIn не true, не-JSON, пусто', () => {
    for (const auth of ['{"loggedIn":false}', 'oops', '']) assert.match((parsePreflight(good.replace('{"loggedIn":true}', auth)) as { missing: string[] }).missing[0] ?? '', /не залогинен[\s\S]*Вход Claude на хостах/);
  });
  it('с токеном Claude вход на хосте не нужен', () => {
    assert.deepEqual(parsePreflight(good.replace('{"loggedIn":true}', '{"loggedIn":false}'), true), { home: '/home/u', installed: [], tools: none });
  });
});

describe('hostCloneUrl: учётные данные в адресе origin', () => {
  it('в http(s)-адресе пользователь, пароль и токен-как-пользователь отбрасываются, остальное не меняется', () => {
    const cases: [string, string][] = [
      ['https://oauth2:glpat-x@gitlab.example.com/o/a.git', 'https://gitlab.example.com/o/a.git'],
      ['https://ghp_x@github.com/o/b.git', 'https://github.com/o/b.git'],
      ['HTTP://u:p@h.example.com:8080/o/c', 'HTTP://h.example.com:8080/o/c'],
      ['https://u:p%40q@h.example.com/o/d.git', 'https://h.example.com/o/d.git'],
      ['https://u:p@q@h.example.com/o/e.git', 'https://h.example.com/o/e.git'],
      ['https://h.example.com/o/a@b.git', 'https://h.example.com/o/a@b.git'],
      ['https://h.example.com/o/f.git?x=a@b', 'https://h.example.com/o/f.git?x=a@b'],
    ];
    for (const [from, to] of cases) {
      assert.equal(hostCloneUrl(from).url, to, from);
      assert.equal(hostCloneUrl(from).stripped, from !== to, from);
    }
  });

  it('scp-форма, ssh:// с пользователем git, git:// и локальный путь уходят как есть', () => {
    for (const url of ['git@h.example.com:o/a.git', 'ssh://git@h.example.com:2222/o/a.git', 'git://h.example.com/o/a.git', '/srv/git/a.git', 'file:///srv/git/a.git']) {
      assert.deepEqual(hostCloneUrl(url), { url, stripped: false }, url);
    }
  });
});

describe('remote:fs из интерфейса', () => {
  it('операции только читающие: правка и смена ветки отвергаются, как и идентификатор не строкой', () => {
    for (const op of REMOTE_FS_OPS) assert.deepEqual(validateRemoteFs('s3', op), { id: 's3', op });
    for (const op of ['write', 'switch', 'delete', 'exec', '', undefined, 5]) assert.equal(validateRemoteFs('s3', op), null, String(op));
    assert.equal(validateRemoteFs(3, 'list'), null);
    assert.deepEqual([...REMOTE_FS_OPS], ['list', 'read', 'root', 'branch', 'status', 'head', 'files']);
  });
  it('путь операции: абсолютный, без «..» и нулевого байта', () => {
    assert.equal(validateRemotePath('/home/u/.cyborg/work/s/a'), '/home/u/.cyborg/work/s/a');
    for (const p of ['a/b', '/a/../b', '/a\0b', 5, undefined]) assert.equal(validateRemotePath(p), null, String(p));
  });
});

describe('hosts проекта', () => {
  it('форма алиаса: ведущий «-», пробел, управляющий символ, знаки двунаправленного письма - отказ', () => {
    for (const h of ['-oProxyCommand=x', 'a b', 'a\x01', '\x01a', '\x7fa', '\u009bx', 'a\u0085', '\u0085a', 'a‮', '‎x', '', 'a'.repeat(256)]) assert.equal(HOST_ALIAS.test(h), false, JSON.stringify(h));
    for (const h of ['dev1', 'u@h', 'build-box.example.com', 'я', 'a'.repeat(255)]) assert.equal(HOST_ALIAS.test(h), true, h);
  });
  it('сохранение: не строка, не массив, больше 32 - отказ; без поля - как прежде; повторы сняты', () => {
    for (const h of [['-oProxyCommand=x'], ['a b'], ['a\x01'], [5], ['']]) assert.equal(validateHosts(h), null, JSON.stringify(h));
    assert.equal(validateHosts('x'), null);
    assert.equal(validateHosts(Array(MAX_HOSTS + 1).fill('h')), null);
    assert.notEqual(validateHosts(Array(MAX_HOSTS).fill('h')), null);
    assert.deepEqual(validateHosts(undefined), []);
    assert.deepEqual(validateHosts(['u@h', 'u@h', 'b']), ['u@h', 'b']);
    assert.equal(MAX_HOSTS, 32);
  });
  it('загрузка: мусор отброшен, повторы сняты, не больше 32', () => {
    assert.deepEqual(readHosts(['a', 'a', '-x', 7, 'b c', 'd']), ['a', 'd']);
    assert.deepEqual(readHosts('x'), []);
    assert.equal(readHosts(Array.from({ length: 40 }, (_, i) => `h${String(i)}`)).length, 32);
  });
  it('форма свойств проекта: ошибки по строке, ведущий «-» назван', () => {
    assert.deepEqual(hostProblems(['dev1', 'dev2']), []);
    assert.deepEqual(hostProblems('dev1, dev2'), []);
    assert.deepEqual(hostProblems(undefined), []);
    assert.match(hostProblems(['-oProxyCommand=x'])[0] ?? '', /«-»/);
    assert.match(hostProblems(['a b'])[0] ?? '', /пробел/);
    assert.match(hostProblems(Array(33).fill('h'))[0] ?? '', /не больше 32/);
    assert.match(hostProblems(5)[0] ?? '', /список/);
  });
});

describe('ответ поиска с хоста', () => {
  it('абсолютный путь, «..», номер не целым и мусор отброшены; признаки и ошибка переносятся; попаданий не больше предела', () => {
    const reply = readSearchReply({
      hits: [
        { rel: 'a.ts', line: 3, text: 'x'.repeat(5000), range: { start: 1, end: 2 }, sign: '+' },
        { rel: '/etc/passwd', line: 1, text: '' },
        { rel: 'a/../../b', line: 1, text: '' },
        { rel: 'b.ts', line: 1.5, text: '' },
        { rel: 'c.ts', line: 2, text: 't', range: { start: -1, end: 0 }, sign: '*' },
        null,
      ],
      truncated: true,
      cancelled: true,
      error: 'e'.repeat(900),
    });
    assert.deepEqual(reply.hits.map((h) => [h.rel, h.line, h.range, h.sign, h.text.length]), [
      ['a.ts', 3, { start: 1, end: 2 }, '+', 1000],
      ['c.ts', 2, null, undefined, 1],
    ]);
    assert.equal(reply.truncated, true);
    assert.equal(reply.cancelled, true);
    assert.equal(reply.error?.length, 500);
    assert.equal(readSearchReply({ hits: Array(900).fill({ rel: 'a', line: 1, text: '' }) }).hits.length, 500);
    assert.deepEqual(readSearchReply('мусор'), { hits: [], truncated: false });
  });
});
