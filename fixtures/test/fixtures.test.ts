import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FAKE_BIN, SLOW_GIT, claudeHome, fixturePath, fixtureRepo, toolbox } from '@cyborg-plugins/fixtures';

const lines = (text: string): string[] => text.split('\n').filter((l) => l !== '');
const json = (text: string): unknown => JSON.parse(text) as unknown;

describe('подставные программы: состав', () => {
  it('все скрипты исполняемы и начинаются с shebang', () => {
    for (const rel of ['fake-bin/claude', 'fake-bin/gh', 'fake-bin/glab', 'fake-bin/jira', 'fake-bin/shell', 'fake-bin/ssh', 'slow-git/git']) {
      const file = fixturePath(rel);
      accessSync(file, constants.X_OK);
      assert.match(readFileSync(file, 'utf8'), /^#!\/bin\/sh\n/, rel);
    }
  });

  it('данные на месте: каталог настроек Claude, магазин плагинов, кнопки модели', () => {
    assert.ok(existsSync(fixturePath('claude-home', '.claude.json')));
    assert.ok(existsSync(fixturePath('claude-home', 'skills', 'own-skill', 'SKILL.md')));
    assert.ok(existsSync(fixturePath('market', '.claude-plugin', 'marketplace.json')));
    const suggest = json(readFileSync(path.join(FAKE_BIN, 'suggest.json'), 'utf8')) as { hook_event_name: string };
    assert.equal(suggest.hook_event_name, 'Stop');
  });
});

describe('gh', () => {
  it('без входа: сообщение и код 1; со входом: пользователь и списки', () => {
    using out = toolbox({ gh: false });
    const r = out.run('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not logged in/);
    using box = toolbox();
    assert.equal(box.run('gh', ['api', 'user']).stdout.trim(), 'fake-user');
    const issues = lines(box.run('gh', ['api', '--paginate', 'repos/acme/demo/issues?state=open']).stdout);
    assert.equal(issues.length, 30);
    assert.equal((json(issues[0] ?? '') as { number: number }).number, 1);
  });

  it('число элементов из параметра; MR чередуют автора и ревьюера; неизвестный вызов - код 1; журнал ведётся', () => {
    using box = toolbox({ gh: { items: 4 } });
    const mrs = lines(box.run('gh', ['api', 'repos/acme/demo/pulls?state=open']).stdout).map((l) => json(l) as { user: string; reviewers: string[] });
    assert.equal(mrs.length, 4);
    assert.deepEqual(mrs.map((m) => m.user), ['fake-user', 'colleague', 'fake-user', 'colleague']);
    assert.deepEqual(mrs[1]?.reviewers, ['fake-user']);
    assert.equal(box.run('gh', ['что-то']).status, 1);
    assert.equal(box.log('gh').length, 2);
    assert.match(box.log('gh')[0] ?? '', /pulls\?state=open/);
  });
});

describe('glab', () => {
  it('без входа: auth status говорит «No token provided» в stderr с кодом 0, api - 401', () => {
    using box = toolbox({ glab: false });
    const status = box.run('glab', ['auth', 'status']);
    assert.equal(status.status, 0);
    assert.match(status.stderr, /^gitlab\.example\.com\n {2}x No token provided/);
    assert.match(box.run('glab', ['api', 'user']).stdout, /401/);
  });

  it('со входом: хост и пользователь в формате, который разбирает ai-cyborg; задачи и MR - массивы GitLab', () => {
    using box = toolbox({ glab: { host: 'git.corp', items: 3 } });
    assert.match(box.run('glab', ['auth', 'status']).stderr, /^git\.corp\n {2}✓ Logged in to git\.corp as fake-user/);
    const issues = json(box.run('glab', ['api', '--hostname', 'git.corp', '--paginate', 'projects/acme%2Fdemo/issues?state=opened']).stdout) as { iid: number; author: { username: string } }[];
    assert.deepEqual(issues.map((i) => i.iid), [1, 2, 3]);
    assert.equal(issues[0]?.author.username, 'fake-user');
    const mrs = json(box.run('glab', ['api', 'projects/acme%2Fdemo/merge_requests?state=opened&per_page=100']).stdout) as { iid: number; head_pipeline: { status: string }; source_branch: string }[];
    assert.equal(mrs.length, 3);
    assert.equal(mrs[0]?.head_pipeline.status, 'success');
    assert.equal(mrs[1]?.source_branch, 'feat-2');
    const one = json(box.run('glab', ['api', 'projects/acme%2Fdemo/merge_requests/7']).stdout) as { iid: number };
    assert.equal(one.iid, 7);
    assert.equal(box.run('glab', ['странное']).status, 1);
    assert.ok(box.log('glab').length >= 5);
  });
});

describe('jira', () => {
  it('версия, пользователь, список и карточка задачи SMK-1', () => {
    using box = toolbox();
    assert.match(box.run('jira', ['version']).stdout, /1\.7\.0/);
    assert.equal(box.run('jira', ['me']).stdout.trim(), 'smoke@example.com');
    assert.equal(box.run('jira', ['issue', 'list', '--plain']).stdout.trim(), 'SMK-1');
    const list = json(box.run('jira', ['issue', 'list', '--raw']).stdout) as { key: string }[];
    assert.equal(list[0]?.key, 'SMK-1');
    const view = json(box.run('jira', ['issue', 'view', 'SMK-1', '--raw']).stdout) as { fields: { comment: { total: number } } };
    assert.equal(view.fields.comment.total, 1);
    assert.equal(box.log('jira').length, 5);
  });
});

describe('claude', () => {
  it('подкоманды окна «Расширения»: версия, plugin, mcp; вызовы plugin пишутся в журнал', () => {
    using box = toolbox();
    assert.match(box.run('claude', ['--version']).stdout, /^2\.1\.314/);
    const market = json(box.run('claude', ['plugin', 'marketplace', 'list']).stdout) as { name: string; path: string }[];
    assert.equal(market[0]?.name, 'smoke-market');
    assert.equal(market[0]?.path, fixturePath('market'));
    const list = json(box.run('claude', ['plugin', 'list', '--json']).stdout) as { id: string }[];
    assert.equal(list[0]?.id, 'smk-plugin@smoke-market');
    assert.deepEqual(json(box.run('claude', ['plugin', 'install', 'smk-plugin']).stdout), { command: 'install', outcome: 'ok', message: 'Готово: smk-plugin' });
    assert.match(box.run('claude', ['mcp', 'list']).stdout, /smk-mcp.*Connected/);
    assert.deepEqual(box.log('claudePlugin'), ['plugin marketplace list', 'plugin list --json', 'plugin install smk-plugin']);
  });

  it('сессия: событие старта, эхо, cd, запрос, разрешение, кнопки, поток строк, журнал аргументов', () => {
    using box = toolbox();
    using repo = fixtureRepo();
    const input = ['привет', `cd ${repo.dir}`, 'ask', 'perm', 'please suggest', 'flood 3 10', 'trickle 2', 'link', ''].join('\n');
    const r = box.run('claude', ['--settings', 'x.json', 'продолжи'], { input, cwd: repo.dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /fake-claude ready/);
    assert.match(r.stdout, /ARGS: --settings x\.json продолжи/);
    assert.match(r.stdout, /got: \[привет\]/);
    assert.match(r.stdout, /moved/);
    assert.match(r.stdout, /FLOOD-DONE 3/);
    assert.match(r.stdout, /FLOOD-DONE 2/);
    assert.match(r.stdout, /https:\/\/example\.com\/docs\/start/);
    const events = box.eventList();
    assert.deepEqual(events.map((e) => e.hook_event_name), ['SessionStart', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop']);
    assert.equal(events[1]?.tool_name, 'EnterWorktree');
    assert.equal(events[1]?.cwd, repo.dir);
    assert.deepEqual(box.log('claudeArgs'), ['--settings x.json продолжи']);
  });

  it('вывод при старте до чтения ввода (FAKE_FLOOD_ON_START)', () => {
    using box = toolbox({ floodOnStart: 5 });
    const r = box.run('claude', [], { input: '' });
    assert.match(r.stdout, /FLOOD-DONE 5/);
    assert.ok(r.stdout.indexOf('FLOOD-DONE 5') > r.stdout.indexOf('fake-claude ready'));
  });
});

describe('shell и медленный git', () => {
  it('shell пропускает -lc и исполняет команду как есть', () => {
    using box = toolbox();
    assert.equal(box.run('shell', ['-lc', 'echo $((20+22))']).stdout.trim(), '42');
  });

  it('git без задержки идёт в настоящий git; rev-parse --show-toplevel ждёт FAKE_GIT_DELAY', () => {
    using repo = fixtureRepo();
    using box = toolbox({ slowGit: 0.5 });
    assert.ok(box.env.PATH?.startsWith(`${box.bin}:${path.join(box.root, 'slow-git')}`));
    // Время сравнивается друг с другом, а не с порогом: под нагрузкой параллельного прогона абсолютные пороги ненадёжны.
    const t0 = Date.now();
    const status = box.run('git', ['status', '--short'], { cwd: repo.dir });
    const fast = Date.now() - t0;
    assert.equal(status.status, 0);
    const t1 = Date.now();
    const top = box.run('git', ['rev-parse', '--show-toplevel'], { cwd: repo.dir });
    const slow = Date.now() - t1;
    assert.ok(slow >= 450, `rev-parse --show-toplevel ждёт задержку: ${slow} мс`);
    assert.ok(slow - fast >= 300, `медленный вызов дольше быстрого на задержку: быстрый ${fast} мс, медленный ${slow} мс`);
    assert.equal(top.stdout.trim(), repo.git('rev-parse', '--show-toplevel').trim());
  });
});

describe('ssh: хост - эта же машина', () => {
  it('исполняет команду локально, stdin и код выхода сквозные; опции и туннель разобраны; журнал ведётся', () => {
    using box = toolbox();
    const r = box.run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-R', '/run/x.sock:/tmp/y.sock', '--', 'work-host', 'echo $((1+2))']);
    assert.equal(r.stdout.trim(), '3');
    assert.equal(box.run('ssh', ['--', 'h', 'cat'], { input: 'строка\n' }).stdout, 'строка\n');
    assert.equal(box.run('ssh', ['--', 'h', 'exit 7']).status, 7);
    assert.equal(box.log('ssh').length, 3);
    assert.match(box.log('ssh')[0] ?? '', /-R \/run\/x\.sock:\/tmp\/y\.sock -- work-host echo/);
  });

  it('установка по `sh -s` из stdin кладёт файлы в «дом хоста», а не в настоящий', () => {
    using box = toolbox();
    const script = 'set -e\nmkdir -p "$HOME/.cyborg/agentd"\necho installed > "$HOME/.cyborg/agentd/ok"\necho done';
    const r = box.run('ssh', ['-T', '--', 'work-host', 'sh -s'], { input: script });
    assert.equal(r.stdout.trim(), 'done');
    assert.equal(readFileSync(path.join(box.sshHome, '.cyborg', 'agentd', 'ok'), 'utf8').trim(), 'installed');
    assert.ok(!existsSync(path.join(process.env.HOME ?? '/nonexistent', '.cyborg', 'agentd', 'ok')) || process.env.HOME === box.sshHome);
  });

  it('хост из FAKE_SSH_FAIL отказывает как ssh без ключа; другие работают', () => {
    using box = toolbox({ sshFail: 'bad-host' });
    const bad = box.run('ssh', ['--', 'bad-host', 'echo hi']);
    assert.equal(bad.status, 255);
    assert.match(bad.stderr, /Permission denied/);
    assert.equal(box.run('ssh', ['--', 'good-host', 'echo hi']).stdout.trim(), 'hi');
  });
});

describe('временные репозитории и каталог настроек', () => {
  it('fixtureRepo: коммит, ветки, remote, изменения; удаляется', () => {
    let dir = '';
    {
      using repo = fixtureRepo({ branches: ['feature', 'release'], remote: 'https://example.com/acme/demo.git', dirty: true, files: { 'src/a.txt': 'a\n', 'README.md': 'r\n' } });
      dir = repo.dir;
      assert.deepEqual(repo.git('branch', '--format=%(refname:short)').trim().split('\n').sort(), ['feature', 'main', 'release']);
      assert.equal(repo.git('remote', 'get-url', 'origin').trim(), 'https://example.com/acme/demo.git');
      assert.deepEqual(lines(repo.git('status', '--porcelain')).sort(), [' M src/a.txt', '?? untracked.txt']);
      assert.equal(repo.git('log', '--format=%an <%ae>').trim(), 'Fixture <fixture@example.com>');
      assert.throws(() => repo.git('нет-такой-команды'), /git нет-такой-команды/);
    }
    assert.ok(!existsSync(dir));
  });

  it('claudeHome: копия, которую можно менять, не трогая исходник', () => {
    using home = claudeHome();
    const mcp = json(readFileSync(path.join(home.dir, '.claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.ok('smk-mcp' in mcp.mcpServers);
    writeFileSync(path.join(home.dir, '.claude.json'), '{}');
    assert.match(readFileSync(fixturePath('claude-home', '.claude.json'), 'utf8'), /smk-mcp/);
  });

  it('toolbox: каталог набора удаляется при выходе из блока', () => {
    let root = '';
    {
      using box = toolbox();
      root = box.root;
      assert.ok(existsSync(root));
      assert.deepEqual(box.log('gh'), []);
    }
    assert.ok(!existsSync(root));
  });
});
