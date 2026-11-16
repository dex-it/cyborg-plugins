// Правила ядра, на которых держится устройство репозитория, проверенные на настоящем ядре (@cyborg-harness/testing).
// Нужен `npm run harness:link`; без него тесты пропускаются. Что здесь доказывается: документация (authors/namespaces.md) не выдумывает правил.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Имя в переменной: типы тест-кита не нужны, чтобы `npm run typecheck` проходил и без ссылок на ядро.
const SPEC = '@cyborg-harness/testing';
type Kit = { startKernel: (options: Record<string, unknown>) => Promise<Kernel> };
interface Kernel extends AsyncDisposable {
  active: string[];
  journal: { kind: string; pluginId?: string }[];
  run(command: string, ...args: unknown[]): Promise<unknown>;
  waitForJournal(match: { kind: string; pluginId?: string }): Promise<unknown>;
}

const kit = await import(SPEC).then((m: Kit) => m).catch(() => undefined);
const skip = kit === undefined && 'нет @cyborg-harness/testing: npm run harness:link';

const manifest = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...extra });

// Плагин из кода теста: поставщик отдаёт контракт, потребитель зовёт его командой.
const provider = (id: string, contract: string): Record<string, unknown> => ({
  manifest: manifest(id, { provides: { [contract]: '1.0' } }),
  module: { activate: (ctx: { contracts: { provide(name: string, v: string, impl: object): void } }) => void ctx.contracts.provide(contract, '1.0', { ping: () => `pong от ${id}` }) },
});
const consumer = (id: string, contract: string): Record<string, unknown> => ({
  manifest: manifest(id, { requires: { [contract]: '^1' }, commands: { [`${id}.ask`]: {} } }),
  module: {
    activate: (ctx: { contracts: { get(name: string, major: number): { ping(): Promise<string> } | undefined }; commands: { register(name: string, fn: () => unknown): void } }) =>
      void ctx.commands.register(`${id}.ask`, async () => ctx.contracts.get(contract, 1)?.ping()),
  },
});

const start = (plugins: Record<string, unknown>[], bundled?: string[]): Promise<Kernel> => {
  if (!kit) throw new Error('тест-кит не подключён');
  return kit.startKernel({ plugins, load: { reservedPrefixes: ['cyborg.'], ...(bundled && { bundled }) } });
};

describe('пространство cyborg.* на настоящем ядре', { skip }, () => {
  it('плагин из поставки отдаёт cyborg.projects и становится активным', async () => {
    await using kernel = await start([provider('projects', 'cyborg.projects')], ['projects']);
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'projects' });
    assert.deepEqual(kernel.active, ['projects']);
  });

  it('сторонний плагин (его нет среди встроенных) с cyborg.projects отвергается', async () => {
    await using kernel = await start([provider('projects', 'cyborg.projects')], []);
    await kernel.waitForJournal({ kind: 'rejected', pluginId: 'projects' });
    assert.deepEqual(kernel.active, []);
  });

  it('сторонний плагин берёт cyborg.* у встроенного поставщика (requires) и работает', async () => {
    await using kernel = await start([provider('projects', 'cyborg.projects'), consumer('acme-ext', 'cyborg.projects')], ['projects']);
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'acme-ext' });
    assert.equal(await kernel.run('acme-ext.ask'), 'pong от projects');
  });

  it('сторонний плагин отдаёт контракт своего пространства acme.*', async () => {
    await using kernel = await start([provider('acme-reports', 'acme.reports'), consumer('acme-ui', 'acme.reports')], []);
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'acme-ui' });
    assert.equal(await kernel.run('acme-ui.ask'), 'pong от acme-reports');
  });

  it('requires без поставщика: потребитель не активируется, причина в журнале', async () => {
    await using kernel = await start([consumer('acme-ext', 'cyborg.projects')], []);
    await kernel.waitForJournal({ kind: 'rejected', pluginId: 'acme-ext' });
    assert.deepEqual(kernel.active, []);
  });
});
