// Плагин git как поставщик `cyborg.git` 1.1 и `cyborg.tree-decoration` 1.0: состав, права вызывающего (guard), версия, расширение интерфейса ядра членами из `contracts/`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkPlugin } from '@cyborg-harness/core/plugin-check';
import type { PluginContext, Remote } from '@cyborg-harness/contracts';
import type { GitV11 } from '@cyborg-plugins/contracts';
import type { InlinePlugin } from '@cyborg-harness/testing';
import { repo, rig, PLUGIN_DIR } from './kit.ts';

const MEMBERS = ['root', 'branch', 'status', 'headContent', 'branches', 'switch', 'remotes', 'files', 'onChange'] as const;

describe('плагин git', () => {
  it('проверка состава: манифест, файлы, правило импортов - без замечаний; права названы словами', async () => {
    const report = await checkPlugin(PLUGIN_DIR, { ignore: ['dist'], declarationPackages: ['@cyborg-plugins/contracts'] });
    assert.deepEqual(report.problems, []);
    assert.equal(report.permissions.length, 2, report.permissions.join('; '));
    assert.ok(report.permissions.some((p) => p.startsWith('читает файлы')), report.permissions.join('; '));
    assert.ok(report.permissions.some((p) => p.startsWith('запускает программы: git') && p.includes('запрещены флаги') && p.includes('--output')), report.permissions.join('; '));
  });

  it('отдаёт cyborg.git 1.1 со всеми девятью членами и cyborg.tree-decoration 1.0; плагин из поставки активируется без записей об отказах', async () => {
    using r = repo();
    await using t = await rig({ repos: [r.dir] });
    const trees = t.probe.contracts.all('cyborg.tree-decoration', 1).filter((p) => p.pluginId === 'git');
    assert.deepEqual(trees.map((p) => p.version), ['1.0']);
    for (const member of MEMBERS) assert.equal(typeof (t.git as Record<string, unknown>)[member], 'function', member);
    t.clean();
  });

  it('вызывающий без права читать репозиторий сведений не получает: каждый член с путём отказывает PermissionDenied, git не запускается', async () => {
    using r = repo({ branches: ['feature'] });
    await using t = await rig({ repos: [r.dir], probePermissions: {} });
    t.mark();
    const call = (member: string, ...rest: unknown[]) => (t.git as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[member]!(r.dir, ...rest);
    for (const [member, rest] of [['root', []], ['branch', []], ['status', []], ['headContent', []], ['branches', []], ['switch', ['feature']], ['remotes', []], ['files', []]] as const) {
      await assert.rejects(call(member, ...rest), { code: 'PermissionDenied' }, member);
    }
    await assert.rejects(t.git.onChange(r.dir, () => undefined), { code: 'PermissionDenied' });
    await assert.rejects(t.tree.marks(r.dir), { code: 'PermissionDenied' });
    assert.deepEqual(t.since(), [], 'отказанные вызовы git не запускали');
    const denied = t.kernel.journal.flatMap((e) => (e.kind === 'denied' && e.pluginId === 'probe' ? [e.reason] : []));
    assert.equal(denied.length, 10);
    assert.ok(denied.every((reason) => reason === 'via-contract'), denied.join(', '));
    assert.equal(await t.kernel.callAs('probe', 'cyborg.git', 1, 'status', [r.dir]).catch((e: { code?: string }) => e.code), 'PermissionDenied');
  });

  it('право вызывающего не расширяет права git: каталог вне workspace отказывает, даже если вызывающий его читает', async () => {
    using inside = repo();
    using outside = repo();
    await using t = await rig({ repos: [inside.dir], probePermissions: { 'fs.read': [outside.dir, 'workspace'] } });
    await assert.rejects(t.git.status(outside.dir), { code: 'PermissionDenied' });
    assert.equal((await t.git.status(inside.dir))?.branch, 'main');
  });

  it('не строка вместо пути - отказ Invalid, пустой и относительный путь отклоняет шлюз', async () => {
    using r = repo();
    await using t = await rig({ repos: [r.dir] });
    await assert.rejects(t.kernel.callAs('probe', 'cyborg.git', 1, 'status', [123]), { code: 'Invalid' });
    await assert.rejects(t.kernel.callAs('probe', 'cyborg.git', 1, 'root', [{}]), { code: 'Invalid' });
    await assert.rejects(t.git.root(''), /путь не абсолютный/, 'пустой путь отклоняет шлюз до плагина');
  });

  it('потребитель с requires ^1.1 получает поставщика и вызывает расширение; поставщик 1.0 удовлетворил бы только ^1.0', async () => {
    using r = repo({ remote: 'https://example.com/a/b.git' });
    let seen: Remote<GitV11> | undefined;
    const consumer: InlinePlugin = {
      manifest: { id: 'consumer', version: '1.0.0', engines: { cyborg: '^1' }, requires: { 'cyborg.git': '^1.1' }, permissions: { 'fs.read': ['workspace'] } },
      module: {
        activate(ctx: PluginContext) {
          seen = ctx.contracts.get('cyborg.git', 1) as Remote<GitV11> | undefined;
          return undefined;
        },
      },
    };
    await using t = await rig({ repos: [r.dir], extra: [consumer] });
    await t.kernel.waitForJournal({ kind: 'activated', pluginId: 'consumer' });
    assert.deepEqual(await seen?.remotes(r.dir), ['https://example.com/a/b.git']);
  });

  it('отметки дерева: по одной на путь, каталог не отмечается, оповещение о том же корне приходит при изменении индекса', async () => {
    using r = repo({ files: { 'a.txt': 'a\n', 'src/b.ts': 'b\n' } });
    await using t = await rig({ repos: [r.dir] });
    r.write('a.txt', 'x\n');
    r.write('src/new.ts', 'n\n');
    r.git('rm', '-q', 'src/b.ts');
    const marks = await t.tree.marks(r.dir);
    assert.deepEqual(marks.toSorted((a, b) => a.path.localeCompare(b.path)), [
      { path: 'a.txt', kind: 'modified' },
      { path: 'src/b.ts', kind: 'deleted' },
      { path: 'src/new.ts', kind: 'untracked' },
    ]);
    const roots: string[] = [];
    const sub = await t.tree.onChange((root) => void roots.push(root));
    r.git('add', 'a.txt');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual([...new Set(roots)], [r.dir]);
    sub.dispose();
  });

  it('карточка и манифест согласованы: версия контракта в манифесте и в коде одна', () => {
    const manifest = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'manifest.json'), 'utf8')) as { provides: Record<string, { version: string }> };
    const source = readFileSync(path.join(PLUGIN_DIR, 'index.ts'), 'utf8');
    assert.equal(manifest.provides['cyborg.git']?.version, '1.1');
    assert.match(source, /provide\('cyborg\.git', '1\.1'/);
    assert.match(source, /provide\('cyborg\.tree-decoration', '1\.0'/);
  });
});
