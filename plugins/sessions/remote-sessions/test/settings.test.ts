// Секция «Удалённые хосты (SSH)» формы свойств проекта: контракт cyborg.project-settings на настоящем плагине, как его зовёт `projects`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PluginContext, Remote } from '@cyborg-harness/contracts';
import type { ProjectSettings } from '@cyborg-plugins/contracts';
import { memoryStore, startKernel, type InlinePlugin } from '@cyborg-harness/testing';
import { PLUGIN_DIR } from './kit.ts';

/** Хосты, как они лежат в слое воркспейса (версия раздела `$version` ядро дописывает само). */
const stored = (config: { docs: Map<string, Record<string, unknown>> }): unknown => (config.docs.get('workspace')?.['remote-sessions'] as { hosts?: unknown } | undefined)?.hosts;

async function open(initial: Record<string, unknown> = {}) {
  let consumer: PluginContext | undefined;
  const probe: InlinePlugin = {
    manifest: { id: 'probe', version: '1.0.0', engines: { cyborg: '^1' }, consumes: { 'cyborg.project-settings': '^1' } },
    module: {
      activate(ctx) {
        consumer = ctx;
      },
    },
  };
  const config = memoryStore(Object.keys(initial).length ? { workspace: { 'remote-sessions': initial } } : {});
  const kernel = await startKernel({ plugins: [PLUGIN_DIR, probe], config: config.store, state: memoryStore().store });
  assert.ok(consumer);
  const entry = consumer.contracts.all('cyborg.project-settings', 1).find((p) => p.pluginId === 'remote-sessions');
  assert.ok(entry, 'remote-sessions не отдаёт cyborg.project-settings');
  const settings: Remote<ProjectSettings> = entry.impl;
  return { kernel, settings, config, [Symbol.asyncDispose]: () => kernel[Symbol.asyncDispose]() };
}

describe('cyborg.project-settings: хосты проекта', () => {
  it('секция: идентификатор ssh, одно поле-список hosts', async () => {
    await using r = await open();
    const section = await r.settings.section();
    assert.equal(section.id, 'ssh');
    assert.deepEqual(section.fields.map((f) => [f.id, f.kind]), [['hosts', 'list']]);
    assert.match(section.title, /SSH/);
  });

  it('значения: у нового проекта пусто, у сохранённого - его алиасы; повторы и мусор в данных отброшены', async () => {
    await using r = await open({ hosts: { p1: ['dev1', 'dev1', '-x', 'b c', 'dev2'] } });
    assert.deepEqual(await r.settings.load(null), { hosts: [] });
    assert.deepEqual(await r.settings.load('нет'), { hosts: [] });
    assert.deepEqual(await r.settings.load('p1'), { hosts: ['dev1', 'dev2'] });
  });

  it('validate: ведущий «-», пробел, больше 32 - ошибки по строке; строка через запятую годится', async () => {
    await using r = await open();
    assert.deepEqual(await r.settings.validate('p1', { hosts: ['dev1', 'u@dev2'] }), []);
    assert.deepEqual(await r.settings.validate('p1', { hosts: 'dev1, dev2' }), []);
    assert.deepEqual(await r.settings.validate(null, {}), []);
    assert.match((await r.settings.validate('p1', { hosts: ['-oProxyCommand=x'] }))[0] ?? '', /«-»/);
    assert.match((await r.settings.validate('p1', { hosts: ['a b'] }))[0] ?? '', /пробел/);
    assert.match((await r.settings.validate('p1', { hosts: Array.from({ length: 33 }, (_, i) => `h${String(i)}`) }))[0] ?? '', /не больше 32/);
  });

  it('save: список ложится в слой воркспейса под id проекта, пустой список убирает запись, чужие проекты не трогаются', async () => {
    await using r = await open({ hosts: { p2: ['other'] } });
    await r.settings.save('p1', { hosts: ['dev1', 'dev2'] });
    assert.deepEqual(stored(r.config), { p1: ['dev1', 'dev2'], p2: ['other'] });
    assert.deepEqual(await r.settings.load('p1'), { hosts: ['dev1', 'dev2'] });
    await r.settings.save('p1', { hosts: [] });
    assert.deepEqual(stored(r.config), { p2: ['other'] });
    await assert.rejects(r.settings.save('p1', { hosts: ['-x'] }), /«-»/);
    await assert.rejects(r.settings.save('p1', { hosts: Array(33).fill('h') }), /не больше 32/);
    assert.deepEqual(stored(r.config), { p2: ['other'] }, 'отказ ничего не записал');
  });
});
