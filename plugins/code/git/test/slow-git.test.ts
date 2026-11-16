// Медленный git из фикстур (`toolbox({ slowGit })`: `rev-parse --show-toplevel` отвечает с задержкой) через шлюз ядра: медленный запрос не держит остальные,
// срок и результат сохраняются, а запросы, которые зависят от корня (`headContent`), ждут его и отвечают верно.

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { describe, it } from 'node:test';
import { repo, rig } from './kit.ts';

const DELAY_S = 0.8;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

describe('git: медленный git через шлюз', () => {
  it('root ждёт задержанную команду и отвечает верно; status, branch и files, идущие рядом, её не ждут', async () => {
    using r = repo({ files: { 'a.txt': 'a\n' } });
    await using t = await rig({ repos: [r.dir], slowGit: DELAY_S });
    await t.git.branch(r.dir); // прогрев: первый запуск программы в ядре сам идёт дольше секунды
    const slow = timed(() => t.git.root(r.dir));
    const [status, branch, files] = await Promise.all([timed(() => t.git.status(r.dir)), timed(() => t.git.branch(r.dir)), timed(() => t.git.files(r.dir))]);
    const root = await slow;
    assert.equal(root.value, r.dir);
    assert.ok(root.ms >= DELAY_S * 1000 * 0.9, `root вернулся за ${String(root.ms)} мс: задержки не было, проверка ничего не доказывает`);
    for (const fast of [status, branch, files]) assert.ok(fast.ms < root.ms - 300, `быстрый запрос ждал медленный: ${String(fast.ms)} мс против ${String(root.ms)} мс`);
    assert.equal(branch.value, 'main');
    assert.equal(status.value?.branch, 'main');
    assert.deepEqual(files.value, ['a.txt']);
    t.clean();
  });

  it('headContent зависит от корня: ждёт медленный rev-parse и всё равно отдаёт текст из HEAD; параллельные запросы к нескольким файлам не склеиваются в один ответ', async () => {
    using r = repo({ files: { 'a.txt': 'первый\n', 'b.txt': 'второй\n' } });
    await using t = await rig({ repos: [r.dir], slowGit: DELAY_S });
    r.write('a.txt', 'правка\n');
    await t.git.branch(r.dir); // прогрев
    const [a, b] = await Promise.all([timed(() => t.git.headContent(path.join(r.dir, 'a.txt'))), timed(() => t.git.headContent(path.join(r.dir, 'b.txt')))]);
    assert.equal(a.value, 'первый\n');
    assert.equal(b.value, 'второй\n');
    // Запросы идут параллельно: вдвое больше задержки означало бы, что шлюз их сериализовал.
    assert.ok(Math.max(a.ms, b.ms) < DELAY_S * 1000 * 1.8, `запросы шли друг за другом: ${String(a.ms)} и ${String(b.ms)} мс`);
  });

  it('медленный git не мешает слежению: onChange приходит, пока root ещё ждёт', async () => {
    using r = repo();
    await using t = await rig({ repos: [r.dir], slowGit: DELAY_S, countWatches: true });
    const w = await t.watch(r.dir);
    const slow = t.git.root(r.dir);
    await new Promise((resolve) => setTimeout(resolve, 100));
    r.git('commit', '-q', '--allow-empty', '-m', 'during');
    const start = performance.now();
    while (w.count() === 0 && performance.now() - start < DELAY_S * 1000) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(w.count() > 0, 'оповещение не пришло, пока root ждал');
    assert.equal(await slow, r.dir);
  });

  it('git, которого нет в PATH, - пустые ответы, а не падение плагина', async () => {
    using r = repo();
    await using t = await rig({ repos: [r.dir], os: { env: { PATH: '/nonexistent', HOME: '/nonexistent' } } });
    assert.equal(await t.git.root(r.dir), null);
    assert.equal(await t.git.branch(r.dir), null);
    assert.deepEqual(await t.git.remotes(r.dir), []);
    assert.equal(await t.git.files(r.dir), null);
    await assert.rejects(t.git.status(r.dir), /git|ENOENT/);
  });
});
