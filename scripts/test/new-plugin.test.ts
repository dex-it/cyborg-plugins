import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkRepo } from '../lib/check-all.ts';
import { buildBundle } from '../lib/build-bundle.ts';
import { findCyborgPlugin } from '../lib/harness.ts';
import { createPlugin } from '../lib/new-plugin.ts';
import { copyTemplate, makeRepo, repoWith } from './helpers.ts';

function haveCyborgPlugin(): boolean {
  try {
    findCyborgPlugin();
    return true;
  } catch {
    return false;
  }
}

describe('npm run new', () => {
  it('создаёт плагин из шаблона, подставляет id и название; каталог проходит проверку', () => {
    using repo = makeRepo(repoWith([]));
    copyTemplate(repo.root);
    const result = createPlugin(repo.root, { category: 'code', id: 'my-files', title: 'Мои файлы' });
    assert.ok('dir' in result);
    const dir = path.join(repo.root, 'plugins', 'code', 'my-files');
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { id: string; provides: object };
    assert.equal(manifest.id, 'my-files');
    assert.deepEqual(manifest.provides, { 'my-files.greeting': '1.0' });
    assert.match(readFileSync(path.join(dir, 'README.md'), 'utf8'), /title: Мои файлы/);
    assert.ok(!readFileSync(path.join(dir, 'test', 'plugin.test.ts'), 'utf8').includes('__ID__'));
    assert.deepEqual(checkRepo(repo.root).problems, []);
  });

  it('отказывает: чужая категория, дубль id, зарезервированный id, плохой id', () => {
    using repo = makeRepo(repoWith([{ category: 'code', id: 'files' }]));
    copyTemplate(repo.root);
    const error = (category: string, id: string): string => {
      const r = createPlugin(repo.root, { category, id, title: id });
      return 'error' in r ? r.error : '';
    };
    assert.match(error('нет-такой', 'x'), /категории нет-такой нет в plugins\/categories.json/);
    assert.match(error('sessions', 'files'), /id files уже занят/);
    assert.match(error('code', 'cyborg'), /недопустимый id/);
    assert.match(error('code', 'Плохой Id'), /недопустимый id/);
  });

  it('собранный из шаблона плагин входит в бандл: delivery.json, bundle.json и config.json на месте', { skip: !haveCyborgPlugin() && 'нет cyborg-plugin: npm run harness:link' }, () => {
    using repo = makeRepo(
      repoWith([], {
        'bundles/demo.json': { format: 1, id: 'demo', version: '1.0.0', title: 'Демо', description: 'Проверка сборки', plugins: ['my-files'] },
      }),
    );
    copyTemplate(repo.root);
    assert.ok('dir' in createPlugin(repo.root, { category: 'code', id: 'my-files', title: 'Мои файлы' }));
    const out = path.join(repo.root, 'out');
    const { result, problems } = buildBundle(repo.root, 'demo', { out, pack: true });
    assert.deepEqual(problems, []);
    assert.ok(result);
    for (const rel of ['demo/bundle.json', 'demo/config.json', 'demo/delivery/delivery.json', 'demo/delivery/my-files/manifest.json', 'demo/delivery/my-files/index.mjs', 'demo-1.0.0.tgz']) {
      assert.ok(existsSync(path.join(out, rel)), `нет ${rel}`);
    }
    const bundle = JSON.parse(readFileSync(path.join(out, 'demo', 'bundle.json'), 'utf8')) as { enabled: string[]; plugins: { id: string; category: string }[] };
    assert.deepEqual(bundle.enabled, ['my-files']);
    assert.deepEqual(bundle.plugins, [{ id: 'my-files', version: '1.0.0', category: 'code' }]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'demo', 'config.json'), 'utf8')), { plugins: { enabled: ['my-files'] } });
  });

  it('сборка бандла не идёт с замечаниями бандла и не стирает чужой каталог', () => {
    const demo = { format: 1, id: 'demo', version: '1.0.0', title: 'Демо', description: 'Д' };
    using repo = makeRepo(repoWith([], { 'bundles/demo.json': { ...demo, plugins: ['призрак'] }, 'bundles/empty.json': { ...demo, id: 'empty', plugins: [] }, 'out/empty/чужое.txt': 'не трогать' }));
    const out = path.join(repo.root, 'out');
    const bad = buildBundle(repo.root, 'demo', { out, pack: false });
    assert.match(bad.problems.map((p) => p.message).join('\n'), /плагина призрак нет в каталоге/);
    const foreign = buildBundle(repo.root, 'empty', { out, pack: false });
    assert.match(foreign.problems.map((p) => p.message).join('\n'), /каталог занят чужим содержимым/);
    assert.ok(existsSync(path.join(out, 'empty', 'чужое.txt')));
    const missing = buildBundle(repo.root, 'нет', { out, pack: false });
    assert.match(missing.problems.map((p) => p.message).join('\n'), /бандла нет нет/);
  });
});
