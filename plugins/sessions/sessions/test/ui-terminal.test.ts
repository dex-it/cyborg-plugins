// Вид «Сессии»: размер шрифта (cyborg.fontSize -> память вида), вывод окна без фокуса, режимы терминала, бросок пути, восстановление вкладок, пути и ссылки, буфер обмена.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { memoryStore } from '@cyborg-harness/testing';
import { until, type FakeElement } from './dom.ts';
import { prepare, rig, settle, UUID_A } from './kit.ts';
import { mounted, titleOf } from './ui-kit.ts';

const wheel = (root: FakeElement, deltaY: number, ctrlKey = true, timeStamp = 1): void => void root.fire('wheel', { deltaY, ctrlKey, metaKey: false, timeStamp });

describe('вид «Сессии»: размер шрифта (FR-10001, ключ cyborg.fontSize)', () => {
  it('колесо с клавишей команд меняет размер всех терминалов и пишет его в память вида; без клавиши - нет, предел 8..32 держится', async () => {
    await using r = await rig();
    await r.sessions.create({ cwd: r.repoA });
    await r.sessions.create({ cwd: r.repoB });
    await mounted(r, async (m) => {
      await until(() => m.ui.terms.length === 2, 'два терминала');
      assert.deepEqual(m.ui.terms.map((t) => t.fontSize), [13, 13]);
      wheel(m.root, -100, false);
      assert.deepEqual(m.ui.terms.map((t) => t.fontSize), [13, 13], 'без клавиши команд колесо прокручивает историю');
      wheel(m.root, -100);
      assert.deepEqual(m.ui.terms.map((t) => t.fontSize), [14, 14]);
      wheel(m.root, 100, true, 1000);
      wheel(m.root, 100, true, 2000);
      assert.deepEqual(m.ui.terms.map((t) => t.fontSize), [12, 12]);
      await until(() => (m.ui.state.value as { fontSize?: number } | undefined)?.fontSize === 12, 'размер записан в память вида');
      // команда окна «размер по умолчанию» (Ctrl+0) идёт через главную часть
      await r.run('sessions.font-reset');
      await until(() => m.ui.terms.every((t) => t.fontSize === 13), 'сброшен');
      for (let i = 0; i < 30; i++) wheel(m.root, 100, true, 10_000 + i * 1000);
      assert.deepEqual(m.ui.terms.map((t) => t.fontSize), [8, 8], 'ниже предела не уходит');
      for (let i = 0; i < 40; i++) wheel(m.root, -100, true, 100_000 + i * 1000);
      assert.deepEqual(m.ui.terms.map((t) => t.fontSize), [32, 32], 'выше предела не уходит');
    });
  });

  it('после перезапуска вида размер тот же; негодное значение в памяти - размер по умолчанию; память недоступна - размер действует до закрытия вида', async () => {
    await using r = await rig();
    await r.sessions.create({ cwd: r.repoA });
    await mounted(r, async (m) => {
      await until(() => m.ui.terms.length === 1, 'терминал');
      assert.equal(m.ui.terms[0]?.fontSize, 18);
    }, { state: { fontSize: 18 } });
    await mounted(r, async (m) => {
      await until(() => m.ui.terms.length === 1, 'терминал');
      assert.equal(m.ui.terms[0]?.fontSize, 13);
    }, { state: { fontSize: 99, order: 'мусор', modes: 5 } });
    await mounted(r, async (m) => {
      await until(() => m.ui.terms.length === 1, 'терминал');
      wheel(m.root, -100);
      assert.equal(m.ui.terms[0]?.fontSize, 14);
      await settle(50);
      assert.deepEqual(m.ui.state.saved, [], 'запись отклонена, вид не упал');
    }, { stateFails: true });
  });
});

describe('вид «Сессии»: вывод, режимы терминала, бросок пути', () => {
  it('окно без фокуса отдаёт вывод пачкой раз в 250 мс, запрос терминалу (DA) - сразу и вместе с накопленным по порядку', async () => {
    await using r = await rig();
    await r.sessions.create({ cwd: r.repoA });
    await mounted(
      r,
      async (m) => {
        const term = await until(() => m.ui.terms[0], 'терминал');
        await until(() => term.opened, 'открыт');
        const before = term.writes.length;
        for (const part of ['a', 'b', 'c']) r.last().emit(part);
        await settle(60);
        assert.equal(term.writes.length, before, 'без фокуса вывод копится');
        await until(() => term.text.endsWith('abc'), 'пачка ушла');
        assert.equal(term.writes.length, before + 1, 'одной записью');
        r.last().emit('x');
        r.last().emit('\x1b[c');
        await until(() => term.text.endsWith('x\x1b[c'), 'запрос терминалу ушёл сразу, накопленное перед ним');
      },
      { focused: () => false },
    );
  });

  it('режимы DEC, включённые до начала хвоста, возвращаются из памяти вида перед хвостом: после перезагрузки окна вставка и мышь не пропадают', async () => {
    await using r = await rig({ os: { ptyBacklog: 64 } });
    await r.sessions.create({ cwd: r.repoA });
    let remembered: unknown;
    await mounted(r, async (m) => {
      const term = await until(() => m.ui.terms[0], 'терминал');
      await until(() => term.opened, 'открыт');
      r.last().emit('\x1b[?2004h\x1b[?1000h');
      r.last().emit('х'.repeat(200));
      await until(() => term.text.includes('хххх'), 'вывод дошёл');
      await until(() => (m.ui.state.value as { modes?: Record<string, string> } | undefined)?.modes && Object.keys((m.ui.state.value as { modes: object }).modes).length > 0, 'режимы записаны в память вида', 8000);
      remembered = m.ui.state.value;
      assert.match(JSON.stringify(remembered), /2004h/);
    });
    await mounted(
      r,
      async (m) => {
        const term = await until(() => m.ui.terms[0], 'терминал после перезагрузки');
        await until(() => term.writes.length > 0, 'хвост записан');
        // хвост 64 символа уже без включения режимов, они приходят из памяти и стоят первыми
        assert.ok(term.writes[0]?.startsWith('\x1b[?2004h\x1b[?1000h'), JSON.stringify(term.writes[0]?.slice(0, 40)));
        assert.ok(!term.writes[0]?.slice(30).includes('\x1b[?2004h'), 'хвост режимов не содержит');
      },
      { state: remembered },
    );
  });

  it('бросок строки дерева на терминал вставляет путь в кавычках оболочки и показывает терминал; вышедшая сессия, пустой бросок и бросок вне терминала - ничего (FR-3002, FR-3003, FR-3005)', async () => {
    await using r = await rig();
    await r.sessions.create({ cwd: r.repoA });
    await r.sessions.create({ cwd: r.repoB });
    await mounted(r, async (m) => {
      await until(() => m.ui.terms.length === 2, 'два терминала');
      const [first, second] = m.ui.terms as [(typeof m.ui.terms)[number], (typeof m.ui.terms)[number]];
      const hosts = m.root.byClass('term-host');
      m.ui.drop.value = { from: 'files', path: '/home/u/My Repo/a b.ts' };
      hosts[0]?.fire('drop');
      await until(() => first.pasted.length === 1, 'путь вставлен');
      assert.deepEqual(first.pasted, ["'/home/u/My Repo/a b.ts' "]);
      assert.equal(m.tabs()[0]?.getAttribute('aria-selected'), 'true', 'терминал показан');
      m.ui.drop.value = { from: 'files', path: '/safe/path.ts' };
      hosts[1]?.fire('drop');
      await until(() => second.pasted.length === 1, 'вторая вставка');
      assert.deepEqual(second.pasted, ['/safe/path.ts '], 'безопасный путь без кавычек');
      // пути с управляющими символами отбрасываются
      m.ui.drop.value = { from: 'files', path: '/a\nb' };
      hosts[1]?.fire('drop');
      m.ui.drop.value = null;
      hosts[1]?.fire('drop');
      // вне терминала (полоса вкладок): ничего
      m.root.find('strip').fire('drop');
      await settle(60);
      assert.equal(second.pasted.length, 1);
      // вышедшая сессия не принимает бросок
      r.pty.procs[0]?.exit(0);
      await until(() => m.tabs()[0]?.getAttribute('data-state') === 'exited', 'вышла');
      m.ui.drop.value = { from: 'files', path: '/late.ts' };
      hosts[0]?.fire('drop');
      await settle(60);
      assert.equal(first.pasted.length, 1);
      // перетаскивание вкладки терминалом не принимается
      const tabDrag = hosts[1]?.fire('dragover', { dataTransfer: { types: ['application/x-cyborg-tab'] } });
      assert.equal(tabDrag?.prevented, false);
      assert.equal(hosts[1]?.fire('dragover', { dataTransfer: { types: ['Files'] } }).prevented, true);
    });
  });
});

describe('вид «Сессии»: вкладки прошлого запуска и восстановление', () => {
  it('вкладка прошлого запуска показана вышедшей с кнопкой «Восстановить»; восстановление поднимает ту же вкладку с новым терминалом, у вышедшей в этом запуске - то же', async () => {
    const state = memoryStore();
    const shared = await prepare();
    try {
      {
        await using first = await rig({ state: state.store, shared });
        await first.sessions.create({ cwd: first.repoA });
        const proc = first.last();
        await first.armed(proc);
        await first.hook(proc, { hook_event_name: 'SessionStart', session_id: UUID_A });
        await settle(200);
      }
      await using r = await rig({ state: state.store, shared });
      await mounted(r, async (m) => {
        await until(() => m.tabs().length === 1, 'вкладка прошлого запуска');
        const tab = m.tabs()[0] as FakeElement;
        assert.equal(tab.getAttribute('data-state'), 'exited');
        const notice = m.root.byClass('notice')[0] as FakeElement;
        assert.equal(notice.hidden, false);
        assert.equal(notice.children[0]?.textContent, 'Сессия прошлого запуска');
        assert.equal(r.pty.procs.length, 0, 'процессов при старте нет');
        (notice.children[1] as FakeElement).fire('click');
        const term = await until(() => m.ui.terms[0], 'терминал восстановленной сессии');
        assert.deepEqual(r.last().args.slice(3, 5), ['--resume', UUID_A]);
        await until(() => tab.getAttribute('data-state') !== 'exited', 'вкладка ожила');
        assert.equal(m.tabs().length, 1, 'та же вкладка, не новая');
        assert.equal(notice.hidden, true);
        // выход и повторное восстановление: прежний терминал убран, новый подключён
        r.last().exit(1);
        await until(() => tab.getAttribute('data-state') === 'exited', 'вышла');
        assert.match(notice.children[0]?.textContent ?? '', /код 1/);
        (notice.children[1] as FakeElement).fire('click');
        await until(() => m.ui.terms.length === 2, 'второй терминал');
        assert.equal(term.disposed, true, 'прежний терминал убран');
      });
    } finally {
      await shared.dispose();
    }
  });
});

describe('вид «Сессии»: пути, ссылки и буфер обмена из вывода', () => {
  const sink = () => {
    const opened: string[] = [];
    const urls: string[] = [];
    const copied: string[] = [];
    let clip = 'из буфера';
    return {
      opened,
      urls,
      copied,
      os: {
        shell: { openPath: async (p: string) => void opened.push(p), openExternal: async (u: string) => void urls.push(u) },
        clipboard: { readText: () => clip, writeText: (t: string) => void ((clip = t), copied.push(t)) },
      },
    };
  };

  it('путь и ссылка из вывода открываются системой: документ из репозитория - да, исполняемый файл, чужая схема и вне областей - диалог с отказом (FR-10012)', async () => {
    const s = sink();
    await using r = await rig({ os: s.os });
    await r.sessions.create({ cwd: r.repoA });
    const shot = path.join(r.repoA, 'shot.png');
    const script = path.join(r.repoA, 'run.sh');
    await writeFile(shot, '');
    await writeFile(script, '#!/bin/sh\n', { mode: 0o755 });
    await mounted(r, async (m) => {
      const term = await until(() => m.ui.terms[0], 'терминал');
      term.hooks.openPath(shot);
      await until(() => s.opened.length === 1, 'документ открыт');
      assert.deepEqual(s.opened, [shot]);
      term.hooks.openUrl('https://github.com/dex-it/cyborg-plugins/pull/1');
      await until(() => s.urls.length === 1, 'ссылка открыта');
      term.hooks.openPath(script);
      assert.equal(titleOf(await m.ui.answer('ok')), 'Не удалось открыть', 'исполняемый файл ядро не открывает');
      term.hooks.openUrl('javascript:alert(1)');
      assert.equal(titleOf(await m.ui.answer('ok')), 'Не удалось открыть ссылку');
      term.hooks.openPath('relative/path.png');
      assert.equal(titleOf(await m.ui.answer('ok')), 'Не удалось открыть');
      assert.deepEqual(s.opened, [shot]);
      assert.equal(s.urls.length, 1);
    });
  });

  it('копирование (OSC 52, Ctrl+Shift+C) и вставка (Ctrl+Shift+V) идут через команды главной части с правом clipboard', async () => {
    const s = sink();
    await using r = await rig({ os: s.os });
    await r.sessions.create({ cwd: r.repoA });
    await mounted(r, async (m) => {
      const term = await until(() => m.ui.terms[0], 'терминал');
      term.hooks.copy('выделенный текст');
      await until(() => s.copied.length === 1, 'записано в буфер');
      assert.deepEqual(s.copied, ['выделенный текст']);
      term.hooks.pasteFromClipboard();
      await until(() => term.pasted.length === 1, 'вставлено');
      assert.deepEqual(term.pasted, ['выделенный текст']);
    });
  });
});
