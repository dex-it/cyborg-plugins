// Вид «Сессии»: вкладки, терминалы, новая сессия, закрытие, диалоги вместо alert и confirm, размер шрифта, порядок вкладок, бросок пути.
// Логика вида идёт на настоящем ядре и настоящем `agent-claude-code`; DOM и xterm подменены (test/dom.ts, test/ui-kit.ts): окно и canvas проверяет приложение.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { until } from './dom.ts';
import { rig, settle } from './kit.ts';
import { labelOf, mounted, titleOf } from './ui-kit.ts';

describe('вид «Сессии»: новая сессия и терминал', () => {
  it('пустой вид: подсказка «Нет сессий»; «Новая сессия» открывает сессию в репозитории проекта, вкладка и терминал появляются, вывод и ввод идут через ядро', async () => {
    await using r = await rig();
    r.projects.repos = [r.repoA];
    await mounted(r, async (m) => {
      await until(() => m.root.find('empty'), 'вид смонтирован');
      assert.equal(m.root.find('empty').hidden, false);
      m.root.find('new').fire('click');
      await until(() => m.tabs().length === 1, 'вкладка появилась');
      assert.equal(m.root.find('empty').hidden, true);
      const [tab] = m.tabs();
      assert.ok(tab);
      assert.equal(labelOf(tab), 'Claude Code 1');
      assert.equal(tab.getAttribute('role'), 'tab');
      assert.equal(tab.getAttribute('aria-selected'), 'true');
      assert.equal(r.last().options.cwd, r.repoA, 'один репозиторий в проекте - сессия в нём, дополнительных каталогов нет');
      const term = await until(() => m.ui.terms[0], 'терминал создан');
      await until(() => term.opened, 'терминал поставлен в узел');
      // Вывод идёт из pty-хоста ядра прямо в терминал вида (не через хост плагина).
      r.last().emit('привет из сессии\r\n');
      await until(() => term.text.includes('привет из сессии'), 'вывод дошёл до терминала');
      // Ввод человека - в тот же pty; размер - тоже.
      term.hooks.input('ls\r');
      await until(() => r.last().writes.includes('ls\r'), 'ввод дошёл до процесса');
      term.hooks.resize(90, 25);
      await until(() => r.last().resizes.some(([c, rows]) => c === 90 && rows === 25), 'размер дошёл до процесса');
      assert.equal(m.ui.closedTerminals.length, 0);
    });
    r.clean();
  });

  it('в проекте несколько репозиториев: выбор в меню слоя ядра, остальные идут дополнительными каталогами; отмена меню ничего не открывает', async () => {
    await using r = await rig();
    await mounted(r, async (m) => {
      m.root.find('new').fire('click');
      const menu = await m.ui.dialog();
      assert.equal(menu.spec.kind, 'menu');
      assert.deepEqual(menu.spec.kind === 'menu' ? menu.spec.items.map((i) => i.label) : [], ['repo-a', 'repo-b']);
      r.kernel.answerDialog(menu.id, undefined);
      await settle(100);
      // меню закрыто без выбора: сессии нет, вид остался пустым
      assert.equal(r.pty.procs.length, 0);
      m.root.find('new').fire('click');
      const second = await m.ui.dialog();
      r.kernel.answerDialog(second.id, '1');
      await until(() => m.tabs().length === 1, 'вкладка появилась');
      assert.equal(r.last().options.cwd, r.repoB);
      assert.deepEqual(r.last().args.slice(-2), ['--add-dir', r.repoA]);
    });
  });

  it('проект не выбран и сессия не стартовала - вопрос слоя ядра, а не alert; причина названа', async () => {
    await using r = await rig();
    await mounted(r, async (m) => {
      r.projects.select(null);
      m.root.find('new').fire('click');
      assert.equal(titleOf(await m.ui.answer('ok')), 'Нет проекта');
      r.projects.select('Проект');
      r.projects.repos = ['/nowhere'];
      m.root.find('new').fire('click');
      const spec = await m.ui.dialog();
      assert.equal(titleOf(spec.spec), 'Сессия не открылась');
      assert.match(spec.spec.kind === 'ask' ? (spec.spec.message ?? '') : '', /Каталог не входит в репозитории проектов|вне области/);
      r.kernel.answerDialog(spec.id, 'ok');
      assert.equal(r.pty.procs.length, 0);
    });
  });
});
