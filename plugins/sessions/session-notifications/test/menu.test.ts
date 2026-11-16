import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InlinePlugin } from '@cyborg-harness/testing';
import { rig, waiting, waitFor } from './rig.ts';

// Часть test/menu.test.ts ai-cyborg: выключатель уведомлений - галочка в «Вид» с известным id, подпись по-русски, клик передаёт новое состояние.
// Меню здесь не собирается из шаблона Electron: пункт объявлен манифестом (contributes.menus), снимок меню отдаёт ядро (`Kernel.menus`), нажатие - `runMenuItem`.

const entry = (r: Awaited<ReturnType<typeof rig>>) => r.k.menus.find((m) => m.pluginId === 'session-notifications' && m.id === 'toggle');

describe('пункт меню «Уведомления о ждущих сессиях»', () => {
  it('в меню «Вид», подписан по-русски, с галочкой из состояния плагина', async () => {
    await using r = await rig();
    const item = entry(r);
    assert.ok(item, 'нет выключателя уведомлений');
    assert.equal(item.menu, 'view');
    assert.equal(item.title, 'Уведомления о ждущих сессиях');
    assert.doesNotMatch(item.title, /[A-Za-z]/);
    assert.equal(item.command, 'session-notifications.toggle');
    assert.equal(item.checked, true, 'по умолчанию включён');
    assert.equal(item.enabled, true);
  });

  it('нажатие пункта переключает состояние, галочка следует за ним без перезапуска и обратно', async () => {
    await using r = await rig();
    await r.k.runMenuItem('session-notifications', 'toggle');
    await waitFor('галочка снята', () => entry(r)?.checked === false);
    r.sessions.emit(waiting('s1'));
    await r.k.runMenuItem('session-notifications', 'toggle');
    await waitFor('галочка вернулась', () => entry(r)?.checked === true);
  });

  it('выключение из меню гасит показанное уведомление', async () => {
    await using r = await rig();
    r.sessions.emit(waiting('s1'));
    await waitFor('показано', () => r.notices.shown.length === 1);
    await r.k.runMenuItem('session-notifications', 'toggle');
    assert.equal(r.notices.shown[0]!.closed, true);
    await waitFor('галочка снята', () => entry(r)?.checked === false);
  });

  it('контракт session-notifications.switch отдаёт то же состояние, что и галочка', async () => {
    const probe: InlinePlugin = {
      manifest: { id: 'probe', version: '1.0.0', engines: { cyborg: '^1' }, requires: { 'session-notifications.switch': '^1' } },
      module: { activate: () => undefined },
    };
    await using r = await rig({ extra: [probe] });
    const isOn = () => r.k.callAs('probe', 'session-notifications.switch', 1, 'isOn', []);
    assert.equal(await isOn(), true);
    await r.k.run('session-notifications.toggle', false);
    assert.equal(await isOn(), false);
  });
});
