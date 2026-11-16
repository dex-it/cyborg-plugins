// Дымовой тест поставки бандла agent-sessions (B-01): настоящие плагины репозитория -> настоящая сборка бандла (cyborg-plugin delivery) ->
// ядро на настоящих процессах-хостах поднимает поставку, и каждый плагин бандла получает `activated`. Подставные только программы и терминал
// (`fakePty`, память секретов): живого claude и Electron здесь нет. Нужен `npm run harness:link`; без него тест пропускается.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { toolbox } from '@cyborg-plugins/fixtures';
import { buildBundle } from '../lib/build-bundle.ts';
import { checkClosure } from '../lib/bundles.ts';
import { checkRepo } from '../lib/check-all.ts';
import { findCyborgPlugin } from '../lib/harness.ts';
import { REPO_ROOT } from '../lib/util.ts';
import type { Problem } from '../lib/util.ts';

const load = async <T>(spec: string): Promise<T | undefined> => import(spec).then((m: T) => m).catch(() => undefined);
interface Kernel {
  active: string[];
  journal: { kind: string; pluginId?: string }[];
  run(command: string, ...args: unknown[]): Promise<unknown>;
  unload(): Promise<void>;
}
interface Core {
  load(options: Record<string, unknown>): Promise<Kernel>;
  forkHosts(options?: Record<string, unknown>): unknown;
  PLUGIN_API_VERSION: string;
  SectionStore: { open(store: unknown, layers: string[]): Promise<unknown> };
}
interface Delivery {
  readDelivery(root: string): Promise<unknown>;
  verifyDelivery(root: string, manifest: unknown): Promise<string[]>;
}
interface Testing {
  fakePty(): unknown;
  memorySecrets(): unknown;
  memoryStore(): { store: unknown };
}

const core = await load<Core>('@cyborg-harness/core');
const delivery = await load<Delivery>('@cyborg-harness/core/delivery');
const testing = await load<Testing>('@cyborg-harness/testing');
const cli = ((): string | undefined => {
  try {
    return findCyborgPlugin();
  } catch {
    return undefined;
  }
})();
const skip = (!core || !delivery || !testing || !cli) && 'нет ядра: npm run harness:link';

const MEMBERS = ['projects', 'agent-claude-code', 'sessions', 'session-isolation', 'session-notifications'];

describe('бандл agent-sessions: состав и полнота', () => {
  const { catalog, bundles } = checkRepo(REPO_ROOT);
  const bundle = bundles.bundles.find((b) => b.id === 'agent-sessions');

  it('бандл есть, версия 1.0.0, в нём ровно пять плагинов, remote-sessions и next-actions не входят', () => {
    assert.ok(bundle, 'нет bundles/agent-sessions.json');
    assert.equal(bundle.version, '1.0.0');
    assert.deepEqual([...bundle.plugins].sort(), [...MEMBERS].sort());
  });

  it('все плагины бандла готовы (есть в каталоге, не в planned), бандл не в planned.json', () => {
    const ready = new Set(catalog.plugins.map((p) => p.id));
    for (const id of MEMBERS) assert.ok(ready.has(id), `${id} не готов`);
    assert.ok(!bundles.planned.some((p) => p.id === 'agent-sessions'));
  });

  it('набор полон, а без поставщика обязательного контракта проверка падает', () => {
    const whole: Problem[] = [];
    checkClosure('agent-sessions', 'bundles/agent-sessions.json', MEMBERS, catalog, whole);
    assert.deepEqual(whole, []);
    // Единственный обязательный контракт набора - cyborg.projects (requires у sessions): без projects набор неполон. Остальные связи необязательны
    // (optional у session-notifications, consumes у sessions), без их поставщика проверка их не бракует: решает ядро при загрузке.
    for (const missing of ['projects']) {
      const problems: Problem[] = [];
      checkClosure('agent-sessions', 'bundles/agent-sessions.json', MEMBERS.filter((id) => id !== missing), catalog, problems);
      assert.ok(problems.length > 0, `без ${missing} проверка должна падать`);
    }
  });
});

describe('бандл agent-sessions: сборка и поставка на настоящем ядре', { skip }, () => {
  it('собирается с архивом, поставка цела, ядро поднимает все пять плагинов', { timeout: 240_000 }, async () => {
    using box = toolbox();
    const out = mkdtempSync(path.join(tmpdir(), 'agent-sessions-'));
    try {
      const built = buildBundle(REPO_ROOT, 'agent-sessions', { out, pack: true });
      assert.deepEqual(built.problems, []);
      const dir = path.join(out, 'agent-sessions');
      const info = JSON.parse(readFileSync(path.join(dir, 'bundle.json'), 'utf8')) as { version: string; enabled: string[] };
      assert.equal(info.version, '1.0.0');
      assert.deepEqual([...info.enabled].sort(), [...MEMBERS].sort());
      const config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')) as { plugins: { enabled: string[] } };
      assert.deepEqual(config.plugins.enabled, info.enabled);

      const root = path.join(dir, 'delivery');
      const { readDelivery, verifyDelivery } = delivery as Delivery;
      assert.deepEqual(await verifyDelivery(root, await readDelivery(root)), []);

      const manifests = MEMBERS.map((id) => JSON.parse(readFileSync(path.join(root, id, 'manifest.json'), 'utf8')) as { id: string });
      const sandbox = path.join(out, 'sandbox');
      mkdirSync(sandbox, { recursive: true });
      const { load: coreLoad, forkHosts, PLUGIN_API_VERSION, SectionStore } = core as Core;
      const kit = testing as Testing;
      const kernel = await coreLoad({
        apiVersion: PLUGIN_API_VERSION,
        enabled: config.plugins.enabled,
        manifests,
        // Разделы config и state приложение даёт в памяти, схемы читает из поставки (файлы схем доезжают до неё вместе с манифестом).
        schema: (manifest: { id: string }, file: string) => JSON.parse(readFileSync(path.join(root, manifest.id, file), 'utf8')) as unknown,
        config: await SectionStore.open(kit.memoryStore().store, ['user', 'workspace']),
        state: await SectionStore.open(kit.memoryStore().store, ['workspace']),
        entry: (m: { id: string }) => pathToFileURL(path.join(root, m.id, 'index.mjs')).href,
        spawnHost: forkHosts({ silent: true }),
        bundled: MEMBERS,
        reservedPrefixes: ['cyborg.'],
        os: { dataDir: path.join(sandbox, 'data'), tempDir: path.join(sandbox, 'temp'), home: sandbox, env: { PATH: box.env.PATH ?? '', HOME: sandbox }, pty: kit.fakePty(), secrets: kit.memorySecrets() },
        watchdog: { interval: 200, timeout: 5000, strikes: 3 },
      });
      try {
        assert.deepEqual(kernel.active.toSorted(), [...MEMBERS].sort(), JSON.stringify(kernel.journal.filter((e) => e.kind !== 'activated')));
        for (const id of MEMBERS) assert.ok(kernel.journal.some((e) => e.kind === 'activated' && e.pluginId === id), `нет activated для ${id}`);
        assert.deepEqual(kernel.journal.filter((e) => e.kind === 'rejected' || e.kind === 'failed').map((e) => `${e.kind}:${e.pluginId}`), []);
      } finally {
        await kernel.unload();
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
