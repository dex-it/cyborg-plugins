// Сценарии приложения на настоящем ядре с подменённым DOM: S2 (смена cwd сессии на worktree переносит дерево) и S13 (бросок строки дерева на терминал вставляет путь).
// Ядро, `files`, `git` и `projects` настоящие; сессии - подставной поставщик `cyborg.sessions` (настоящий требует агента и pty), принимающая сторона броска - модуль `sessions/ui/drop-path.ts`,
// которым настоящий вид `sessions` вставляет путь в терминал (xterm в Node не живёт: терминал - запись вставок).

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dropIntoSession, pastePaths, TREE_PATH_MIME } from '../../../sessions/sessions/ui/drop-path.ts';
import { FakeElement, until, withDocument } from './dom.ts';
import { asRoot, fakeSessions, files, repo, rig, uiRig, type Rig } from './kit.ts';

async function show(t: Rig) {
  const { mount } = await import('../ui/tree.ts');
  const root = new FakeElement('div');
  root.mounted = true;
  const ui = uiRig(t);
  const view = mount(asRoot(root), ui.ctx);
  const tree = root.find('tree');
  const rows = (): FakeElement[] => tree.querySelectorAll('[role="treeitem"]');
  const nameOf = (row: FakeElement): string => row.children.find((c) => c.classList.contains('name'))?.textContent ?? '';
  await until(() => rows().length > 0 || (root.find('hint').hidden ? undefined : true), 'дерево показано');
  return {
    root,
    view,
    ui,
    rows,
    nameOf,
    roots: (): FakeElement[] => rows().filter((r) => r.classList.contains('root')),
    tabs: (): { id: string; label: string }[] => (root.find('scopes').tabs as { id: string; label: string }[] | undefined) ?? [],
  };
}

describe('S2: смена cwd сессии на worktree переносит дерево', () => {
  it('свой корень сессии - worktree (подпись «репозиторий ⎇ worktree», подсказка про worktree); вернулась - прежний корень; вышла - дерево проекта', async () => {
    using r = repo({ files: { 'a.txt': 'a\n', 'src/app.ts': 'app\n' } });
    const worktree = `${r.dir}/.claude/worktrees/wt`;
    r.git('worktree', 'add', '-q', '-b', 'wt', worktree);
    files(worktree, { 'only-in-worktree.txt': 'w' });
    const sessions = fakeSessions();
    await using t = await rig({ sessions });
    await t.setProject([r.dir]);
    sessions.live.add(r.dir);
    await withDocument(async () => {
      const v = await show(t);
      assert.deepEqual(v.tabs().map((x) => x.id), ['project'], 'сессий ещё нет: область одна');
      const repoName = r.dir.split('/').pop() ?? '';

      // сессия заявила о себе событием: дерево сессии - корень репозитория запуска
      sessions.emit('s1', { type: 'activity' }, 'CC1 · задача');
      await until(() => v.tabs().length === 2, 'область сессии появилась');
      await until(() => v.roots()[0]?.title.endsWith('репозиторий сессии'), 'свой корень - репозиторий сессии');
      assert.equal(v.nameOf(v.roots()[0] as FakeElement), repoName);
      assert.deepEqual(v.tabs().map((x) => x.label), ['Проект', 'CC1 · задача']);
      assert.equal(v.root.find('scopes').selected, 'session:s1', 'по умолчанию дерево идёт за сессией, от которой событие пришло последним');

      // раскрыли каталог в дереве сессии
      v.rows().find((x) => v.nameOf(x) === 'src')?.click();
      await until(() => v.rows().some((x) => v.nameOf(x) === 'app.ts'), 'src раскрыт');

      // cwd сессии ушёл в worktree: дерево переносится
      sessions.emit('s1', { type: 'cwd', cwd: worktree });
      await until(() => v.nameOf(v.roots()[0] as FakeElement) === `${repoName} ⎇ wt`, 'свой корень - worktree', 10000);
      assert.match(v.roots()[0]?.title ?? '', new RegExp(`^${worktree}\\nworktree репозитория ${r.dir}`));
      await until(() => v.rows().some((x) => v.nameOf(x) === 'only-in-worktree.txt'), 'в дереве файлы worktree');
      assert.equal(v.roots().length, 1, 'репозиторий-владелец отдельным корнем не стоит (FR-4005)');
      assert.equal(v.rows().some((x) => v.nameOf(x) === 'app.ts'), false, 'раскрытый каталог прежнего корня не переехал');
      const branch = v.roots()[0]?.children.find((c) => c.className === 'meta')?.children.map((c) => c.textContent).join('');
      assert.match(branch ?? '', /⎇ wt/);

      // событие в worktree доходит до вида через слежение за ним
      for (let i = 0; i < 40 && !v.rows().some((x) => v.nameOf(x) === 'created-later.txt'); i++) {
        files(worktree, { 'created-later.txt': String(i) });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      assert.ok(v.rows().some((x) => v.nameOf(x) === 'created-later.txt'), 'правка в worktree видна без опроса');

      // вернулась в репозиторий
      sessions.emit('s1', { type: 'cwd', cwd: r.dir });
      await until(() => v.nameOf(v.roots()[0] as FakeElement) === repoName, 'свой корень снова репозиторий', 10000);
      assert.equal(v.roots()[0]?.getAttribute('aria-expanded'), 'true');

      // сессия вышла: областей снова одна, дерево проекта
      sessions.emit('s1', { type: 'exit', code: 0 });
      await until(() => v.tabs().length === 1, 'область сессии ушла');
      await until(() => v.roots()[0]?.title.endsWith('репозиторий проекта'), 'дерево проекта');
      v.view.dispose();
    });
  });

  it('две сессии: у каждой свой корень и своё раскрытие; выбор вкладки области не сбивается событиями другой сессии, пока выбран', async () => {
    using a = repo({ files: { 'x/inner.txt': 'i\n' } });
    using b = repo({ files: { 'y/inner.txt': 'i\n' } });
    const sessions = fakeSessions();
    await using t = await rig({ sessions });
    await t.setProject([a.dir, b.dir]);
    sessions.live.add(a.dir);
    sessions.emit('one', { type: 'activity' }, 'CC1');
    await withDocument(async () => {
      const v = await show(t);
      await until(() => v.tabs().length === 2, 'первая сессия');
      sessions.live.add(b.dir);
      sessions.emit('two', { type: 'cwd', cwd: b.dir }, 'CC2');
      await until(() => v.tabs().length === 3, 'вторая сессия');
      await until(() => v.root.find('scopes').selected === 'session:two', 'по умолчанию - последняя по событию');
      await until(() => v.nameOf(v.roots()[0] as FakeElement) === (b.dir.split('/').pop() ?? ''), 'у второй свой корень первым');
      // человек выбирает первую
      v.root.find('scopes').fire('cy-select', { detail: { id: 'session:one' } });
      await until(() => v.nameOf(v.roots()[0] as FakeElement) === (a.dir.split('/').pop() ?? ''), 'дерево первой сессии');
      v.rows().find((x) => v.nameOf(x) === 'x')?.click();
      await until(() => v.rows().some((x) => v.nameOf(x) === 'inner.txt'), 'x раскрыт в первой сессии');
      // событие второй сессии выбор человека не сбивает
      sessions.emit('two', { type: 'activity' }, 'CC2');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(v.root.find('scopes').selected, 'session:one');
      // во второй раскрытие не появилось (FR-4003)
      v.root.find('scopes').fire('cy-select', { detail: { id: 'session:two' } });
      await until(() => v.nameOf(v.roots()[0] as FakeElement) === (b.dir.split('/').pop() ?? ''), 'дерево второй сессии');
      assert.equal(v.rows().some((x) => v.nameOf(x) === 'inner.txt'), false);
      // вернулись к первой: раскрытие помнится
      v.root.find('scopes').fire('cy-select', { detail: { id: 'session:one' } });
      await until(() => v.rows().some((x) => v.nameOf(x) === 'inner.txt'), 'раскрытие первой сессии на месте');
      // «Проект» - дерево репозиториев проекта
      v.root.find('scopes').fire('cy-select', { detail: { id: 'project' } });
      await until(() => v.roots().length === 2, 'оба репозитория проекта');
      // первая вышла: выбор снимается, дерево следует за оставшейся
      sessions.emit('one', { type: 'exit', code: 0 });
      await until(() => v.tabs().length === 2, 'осталась одна сессия');
      v.view.dispose();
    });
  });

  it('сессия ушла в другой репозиторий проекта: свой корень первым, стартовый - вторым (FR-4004, FR-4005), без повтора пути', async () => {
    using a = repo({ files: { 'a.txt': 'a\n' } });
    using b = repo({ files: { 'b.txt': 'b\n' } });
    const sessions = fakeSessions();
    await using t = await rig({ sessions });
    await t.setProject([a.dir, b.dir]);
    sessions.live.add(a.dir);
    sessions.emit('s', { type: 'cwd', cwd: b.dir }, 'CC1');
    await withDocument(async () => {
      const v = await show(t);
      await until(() => v.root.find('scopes').selected === 'session:s', 'область сессии');
      await until(() => v.roots().length === 2, 'два корня');
      assert.deepEqual(
        v.roots().map((x) => x.title.split('\n')[1]),
        ['другой репозиторий проекта, куда перешёл рабочий каталог сессии', 'репозиторий, где сессия была запущена'],
      );
      assert.deepEqual(v.roots().map((x) => x.title.split('\n')[0]), [b.dir, a.dir]);
      v.view.dispose();
    });
  });

  it('без поставщика сессий дерево проекта работает; поставщик 1.1 без uses - тоже (сессия определяется по каталогу)', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' } });
    const old = fakeSessions('1.1');
    await using t = await rig({ sessions: old });
    await t.setProject([r.dir]);
    old.emit('s', { type: 'cwd', cwd: r.dir }, 'CC1');
    await withDocument(async () => {
      const v = await show(t);
      await until(() => v.tabs().length === 2, 'сессия опознана по каталогу');
      assert.equal(v.nameOf(v.roots()[0] as FakeElement), r.dir.split('/').pop());
      v.view.dispose();
    });
    await using bare = await rig();
    await bare.setProject([r.dir]);
    await withDocument(async () => {
      const v = await show(bare);
      assert.deepEqual(v.tabs().map((x) => x.id), ['project']);
      assert.equal(v.rows().some((x) => v.nameOf(x) === 'a.txt'), true);
      v.view.dispose();
    });
  });

  it('нет проекта, проект без репозиториев: вместо дерева пояснение', async () => {
    await using t = await rig();
    await withDocument(async () => {
      const v = await show(t);
      assert.equal(v.root.find('hint').hidden, false);
      assert.match(v.root.find('hint').textContent, /Проект не выбран/);
      await t.setProject([]);
      v.root.find('refresh').fire('click');
      await until(() => /нет репозиториев/.test(v.root.find('hint').textContent), 'пояснение про репозитории');
      v.view.dispose();
    });
  });
});

describe('S13: бросок строки дерева на терминал вставляет путь', () => {
  /** Принимающая сторона: терминал вида `sessions` записывает вставки. */
  const terminal = (exited = false) => {
    const pasted: string[] = [];
    let shown = 0;
    return { pasted, shown: () => shown, session: { exited, term: { paste: (text: string) => void pasted.push(text) } }, show: () => void shown++ };
  };
  /** Ядро отдаёт принимающему виду путь, который источник назвал в `ctx.drag.start`: сброс на его фрейм. */
  const drop = (path: string) => ({ types: [TREE_PATH_MIME], getData: () => path, files: [] as unknown as FileList });

  it('строка файла, каталога и корня: источник называет ядру абсолютный путь, терминал получает его с кавычками оболочки и пробелом', async () => {
    using r = repo({ files: { 'plain.txt': 'p' } });
    mkdirSync(`${r.dir}/my docs`);
    files(r.dir, { 'my docs/it\'s.md': 'q' });
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const v = await show(t);
      v.rows().find((x) => v.nameOf(x) === 'my docs')?.click();
      await until(() => v.rows().some((x) => v.nameOf(x) === "it's.md"), 'каталог раскрыт');
      const sink = terminal();
      const drag = async (name: string | null): Promise<string> => {
        const row = name === null ? v.roots()[0] : v.rows().find((x) => v.nameOf(x) === name);
        assert.ok(row, name ?? 'корень');
        const event = row.fire('dragstart');
        assert.equal(event.prevented, true, 'собственное перетаскивание Chromium погашено: его ведёт ядро');
        const path = v.ui.drag.started.at(-1);
        assert.ok(path);
        dropIntoSession(sink.session, drop(path), () => '', sink.show);
        return path;
      };
      assert.equal(await drag('plain.txt'), `${r.dir}/plain.txt`);
      assert.equal(await drag('my docs'), `${r.dir}/my docs`);
      assert.equal(await drag("it's.md"), `${r.dir}/my docs/it's.md`);
      assert.equal(await drag(null), r.dir);
      assert.deepEqual(sink.pasted, [
        pastePaths([`${r.dir}/plain.txt`]),
        pastePaths([`${r.dir}/my docs`]),
        pastePaths([`${r.dir}/my docs/it's.md`]),
        pastePaths([r.dir]),
      ]);
      assert.equal(sink.pasted[0], `${r.dir}/plain.txt `, 'путь из безопасных символов - как есть, с пробелом в конце');
      assert.equal(sink.pasted[1], `'${r.dir}/my docs' `, 'пробел в пути - в одинарных кавычках');
      assert.equal(sink.pasted[2], `'${r.dir}/my docs/it'\\''s.md' `, 'кавычка в имени записана как \'\\\'\'');
      assert.equal(sink.shown(), 4, 'после вставки терминал показан');
      v.view.dispose();
    });
  });

  it('завершённая сессия и бросок вне терминала путь не получают', async () => {
    using r = repo({ files: { 'a.txt': 'a' } });
    await using t = await rig();
    await t.setProject([r.dir]);
    await withDocument(async () => {
      const v = await show(t);
      v.rows().find((x) => v.nameOf(x) === 'a.txt')?.fire('dragstart');
      const path = v.ui.drag.started.at(-1) ?? '';
      const ended = terminal(true);
      dropIntoSession(ended.session, drop(path), () => '', ended.show);
      assert.deepEqual(ended.pasted, []);
      assert.equal(ended.shown(), 0);
      // ядро вне зон броска ничего не отдаёт: `drop()` даёт null, вставки нет (решает принимающая сторона, здесь - что источник не вставляет сам)
      assert.deepEqual(v.ui.commands.filter((c) => c.name === 'files.open'), [], 'бросок не открывает файл');
      v.view.dispose();
    });
  });
});
