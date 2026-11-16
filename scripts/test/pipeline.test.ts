// Сквозная проверка «всё вместе»: плагины -> check -> бандл с extends -> поставка -> сверка хешей -> настоящее ядро на настоящих
// процессах-хостах -> вызовы между плагинами. Здесь нет подделок ядра: `cyborg-plugin` и `load()` с `forkHosts()` - те же, что у приложения
// (кроме Electron). Плагины поддельные только по содержанию: проекты, сессии, уведомления в три строки.
// Нужен `npm run harness:link`; без него тест пропускается.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { toolbox } from '@cyborg-plugins/fixtures';
import { buildBundle } from '../lib/build-bundle.ts';
import { checkRepo } from '../lib/check-all.ts';
import { writeAssets } from '../lib/embed-assets.ts';
import { findCyborgPlugin } from '../lib/harness.ts';
import { makeRepo } from './helpers.ts';
import type { Files } from './helpers.ts';

const load = async <T>(spec: string): Promise<T | undefined> => import(spec).then((m: T) => m).catch(() => undefined);
interface Core {
  load(options: Record<string, unknown>): Promise<Kernel>;
  forkHosts(options?: Record<string, unknown>): unknown;
  PLUGIN_API_VERSION: string;
}
interface Delivery {
  readDelivery(root: string): Promise<unknown>;
  verifyDelivery(root: string, manifest: unknown): Promise<string[]>;
}
interface Testing {
  fakePty(): unknown;
  memorySecrets(): unknown;
}
interface Kernel {
  active: string[];
  journal: { kind: string; pluginId?: string }[];
  run(command: string, ...args: unknown[]): Promise<unknown>;
  unload(): Promise<void>;
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

const card = (title: string): string => `---\ntitle: ${title}\nsummary: ${title}\nstatus: experimental\n---\n\n## Что делает\n\nПроверка.\n`;
const manifest = (id: string, extra: Record<string, unknown>): object => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...extra });

// Три плагина будущего бандла: projects <- sessions <- notifications. Код без типов ядра: тест не запускает tsc.
const REPO: Files = {
  'plugins/categories.json': [
    { id: 'code', title: 'Код', summary: 'Код', planned: [] },
    { id: 'sessions', title: 'Сессии', summary: 'Сессии', planned: [] },
  ],
  'plugins/code/projects/manifest.json': manifest('projects', { provides: { 'cyborg.projects': '1.0' }, commands: { 'projects.pid': {} } }),
  'plugins/code/projects/README.md': card('Проекты'),
  'plugins/code/projects/index.ts': `// @ts-nocheck
export default {
  activate(ctx) {
    ctx.contracts.provide('cyborg.projects', '1.0', { list: () => ['demo', 'second'] });
    ctx.commands.register('projects.pid', () => process.pid);
    return undefined;
  },
};
`,
  'plugins/sessions/sessions/manifest.json': manifest('sessions', {
    provides: { 'cyborg.sessions': '1.0' },
    requires: { 'cyborg.projects': '^1' },
    permissions: { process: ['node', 'claude'] },
  }),
  'plugins/sessions/sessions/README.md': card('Сессии'),
  // Демон и навык лежат ресурсами (SP-02): вшиты в index.mjs, при активации пишутся в каталог данных.
  'plugins/sessions/sessions/assets/agentd/agentd.js.txt': "const fs = require('node:fs');\nprocess.stdout.write('daemon:' + process.argv[2] + ':' + typeof fs.existsSync);\n",
  'plugins/sessions/sessions/assets/skills/parallel-sessions/SKILL.md': '# parallel-sessions\n',
  'plugins/sessions/sessions/index.ts': `// @ts-nocheck
import { installAssets } from './assets.generated.ts';
export default {
  async activate(ctx) {
    const dir = await installAssets(ctx.os);
    ctx.contracts.provide('cyborg.sessions', '1.0', {
      async open(name) {
        const known = await ctx.contracts.get('cyborg.projects', 1).list();
        if (!known.includes(name)) throw new Error('нет проекта ' + name);
        const daemon = await ctx.os.process.run('node', [dir + '/agentd/agentd.js', name]);
        const claude = await ctx.os.process.run('claude', ['--settings', 's.json'], { input: 'привет\\nask\\n' });
        return { project: name, daemon: daemon.stdout.trim(), greeted: claude.stdout.includes('got: [привет]'), assets: dir.includes('/assets/') };
      },
    });
    return undefined;
  },
};
`,
  'plugins/sessions/notifications/manifest.json': manifest('notifications', { requires: { 'cyborg.sessions': '^1' }, commands: { 'notifications.ping': { args: ['string'] } } }),
  'plugins/sessions/notifications/README.md': card('Уведомления'),
  'plugins/sessions/notifications/index.ts': `// @ts-nocheck
export default {
  activate(ctx) {
    ctx.commands.register('notifications.ping', async (name) => JSON.stringify(await ctx.contracts.get('cyborg.sessions', 1).open(name)));
    return undefined;
  },
};
`,
  'bundles/base.json': { format: 1, id: 'base', version: '1.0.0', title: 'База', description: 'Проекты и сессии', plugins: ['projects', 'sessions'] },
  'bundles/full.json': { format: 1, id: 'full', version: '1.2.0', title: 'Всё', description: 'База и уведомления', extends: ['base'], plugins: ['notifications'] },
};

// Сторонние плагины вне поставки: один берёт cyborg.sessions, второй пытается отдать cyborg.projects.
const third = (id: string, extra: Record<string, unknown>, code: string): Files => ({
  [`${id}/manifest.json`]: manifest(id, extra),
  [`${id}/index.mjs`]: code,
});
const THIRD: Files = {
  ...third('acme-ext', { requires: { 'cyborg.sessions': '^1' }, commands: { 'acme-ext.ask': { args: ['string'] } } }, `export default { activate(ctx) { ctx.commands.register('acme-ext.ask', async (n) => (await ctx.contracts.get('cyborg.sessions', 1).open(n)).daemon); return undefined; } };\n`),
  ...third('acme-bad', { provides: { 'cyborg.projects': '1.0' } }, `export default { activate(ctx) { ctx.contracts.provide('cyborg.projects', '1.0', { list: () => ['evil'] }); return undefined; } };\n`),
};

const run = (args: string[]): { status: number; out: string } => {
  const r = spawnSync(process.execPath, [cli ?? '', ...args], { encoding: 'utf8' });
  return { status: r.status ?? 2, out: `${r.stdout}${r.stderr}` };
};

describe('сквозной путь: плагины, бандл, поставка, ядро', { skip }, () => {
  it('репозиторий, плагины и бандлы проходят все проверки, ресурсы вшиты', () => {
    using repo = makeRepo(REPO);
    assert.deepEqual(writeAssets(path.join(repo.root, 'plugins/sessions/sessions')).problems, []);
    assert.deepEqual(checkRepo(repo.root).problems, []);
    for (const dir of ['code/projects', 'sessions/sessions', 'sessions/notifications']) {
      const r = run(['check', path.join(repo.root, 'plugins', dir)]);
      assert.equal(r.status, 0, `${dir}: ${r.out}`);
    }
  });

  it('бандл full (extends base) собирается; поставка цела, подмена файла видна; ядро поднимает её на настоящих хостах и плагины работают вместе', async () => {
    using repo = makeRepo({ ...REPO, ...Object.fromEntries(Object.entries(THIRD).map(([k, v]) => [`third/${k}`, v])) });
    using box = toolbox();
    writeAssets(path.join(repo.root, 'plugins/sessions/sessions'));
    const out = path.join(repo.root, 'dist');

    // 1. Сборка бандла: base раскрывается первым.
    const built = buildBundle(repo.root, 'full', { out, pack: true });
    assert.deepEqual(built.problems, []);
    assert.deepEqual(built.result?.plugins, ['projects', 'sessions', 'notifications']);
    const info = JSON.parse(readFileSync(path.join(out, 'full', 'bundle.json'), 'utf8')) as { version: string; enabled: string[]; plugins: { id: string; category: string }[] };
    assert.equal(info.version, '1.2.0');
    assert.deepEqual(info.enabled, ['projects', 'sessions', 'notifications']);
    assert.deepEqual(info.plugins.map((p) => p.category), ['code', 'sessions', 'sessions']);
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'full', 'config.json'), 'utf8')), { plugins: { enabled: ['projects', 'sessions', 'notifications'] } });
    const listing = spawnSync('tar', ['-tzf', path.join(out, 'full-1.2.0.tgz')], { encoding: 'utf8' }).stdout;
    for (const f of ['full/bundle.json', 'full/config.json', 'full/delivery/delivery.json', 'full/delivery/sessions/index.mjs']) assert.ok(listing.includes(f), `в архиве нет ${f}`);

    // 2. Контрольные суммы: цела, затем подмена файла видна по имени и хешу.
    const root = path.join(out, 'full', 'delivery');
    const { readDelivery, verifyDelivery } = delivery as Delivery;
    const listed = await readDelivery(root);
    assert.deepEqual(await verifyDelivery(root, listed), []);
    const target = path.join(root, 'notifications', 'index.mjs');
    const original = readFileSync(target, 'utf8');
    appendFileSync(target, '\n// подмена\n');
    const tampered = await verifyDelivery(root, listed);
    assert.equal(tampered.length, 1);
    assert.match(tampered[0] ?? '', /notifications\/index\.mjs: контрольная сумма не совпала/);
    writeFileSync(target, original);
    assert.deepEqual(await verifyDelivery(root, listed), []);

    // 3. Ядро на настоящих процессах-хостах: поставка встроена, сторонние плагины - нет.
    const delivered = ['projects', 'sessions', 'notifications'];
    const dirs = new Map<string, string>(delivered.map((id) => [id, path.join(root, id)]));
    for (const id of ['acme-ext', 'acme-bad']) dirs.set(id, path.join(repo.root, 'third', id));
    const manifests = [...dirs.values()].map((d) => JSON.parse(readFileSync(path.join(d, 'manifest.json'), 'utf8')) as { id: string });
    const sandbox = path.join(repo.root, 'sandbox');
    mkdirSync(sandbox, { recursive: true });
    const { load: coreLoad, forkHosts, PLUGIN_API_VERSION } = core as Core;
    const kit = testing as Testing;
    const kernel = await coreLoad({
      apiVersion: PLUGIN_API_VERSION,
      enabled: [...dirs.keys()],
      manifests,
      entry: (m: { id: string }) => pathToFileURL(path.join(dirs.get(m.id) ?? '', 'index.mjs')).href,
      spawnHost: forkHosts({ silent: true }),
      bundled: delivered,
      reservedPrefixes: ['cyborg.'],
      // Плагин получает только PATH и HOME: подставные программы доходят через fake.env рядом со скриптами.
      os: { dataDir: path.join(sandbox, 'data'), tempDir: path.join(sandbox, 'temp'), home: sandbox, env: { PATH: box.env.PATH ?? '', HOME: sandbox }, pty: kit.fakePty(), secrets: kit.memorySecrets() },
      watchdog: { interval: 200, timeout: 5000, strikes: 3 },
    });
    try {
      // Поставка и сторонний потребитель активны; сторонний поставщик cyborg.* отвергнут.
      assert.deepEqual(kernel.active.toSorted(), ['acme-ext', 'notifications', 'projects', 'sessions']);
      assert.ok(kernel.journal.some((e) => e.kind === 'rejected' && e.pluginId === 'acme-bad'), 'acme-bad с cyborg.projects отвергнут');

      // Плагины работают в другом процессе: граница данных настоящая.
      assert.notEqual(await kernel.run('projects.pid'), process.pid);

      // Цепочка через три плагина и два контракта: notifications -> sessions -> projects, плюс демон из ресурсов и подставной claude.
      const reply = JSON.parse((await kernel.run('notifications.ping', 'demo')) as string) as { project: string; daemon: string; greeted: boolean; assets: boolean };
      assert.deepEqual(reply, { project: 'demo', daemon: 'daemon:demo:function', greeted: true, assets: true });
      assert.deepEqual(box.eventList().map((e) => e.hook_event_name), ['SessionStart', 'UserPromptSubmit']);
      assert.ok(existsSync(path.join(sandbox, 'data', 'sessions', 'assets')), 'ресурсы плагина записаны в каталог его данных');

      // Ошибка внутри цепочки доходит до вызывающего как ошибка, а не как падение ядра.
      await assert.rejects(kernel.run('notifications.ping', 'нет-такого'), /нет проекта/);
      assert.ok(kernel.active.includes('sessions'), 'плагин после ошибки жив');

      // Сторонний плагин потребляет контракт поставки.
      assert.equal(await kernel.run('acme-ext.ask', 'second'), 'daemon:second:function');
    } finally {
      await kernel.unload();
    }
  });
});
