// Пара «плагин - демон» версионируется вместе (риск задачи M-05): числа плагина сверяются с исходником демона, демон в ресурсах - со сборкой из companions/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ASSETS, ASSET_VERSION } from '../assets.generated.ts';
import { DEFAULT_LIMITS, MAX_HOSTS, MAX_PER_HOST, PROTO, RING_BYTES, SLEEP_IDLE_MS } from '../limits.ts';
import * as daemon from '../../../../companions/agentd/src/agentd/protocol.ts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');

describe('лимиты хоста: числа плагина совпадают с демоном', () => {
  it('32 хоста, 4 живые сессии на хост, сон после 2 ч, кольцо 1 МиБ, версия протокола', () => {
    assert.equal(MAX_HOSTS, 32);
    assert.equal(MAX_PER_HOST, 4);
    assert.equal(SLEEP_IDLE_MS, 2 * 3_600_000);
    assert.equal(RING_BYTES, 1024 * 1024);
    assert.equal(PROTO, daemon.PROTO);
    assert.equal(RING_BYTES, daemon.RING_BYTES);
    assert.equal(SLEEP_IDLE_MS, daemon.SLEEP_IDLE_MS);
    assert.deepEqual(DEFAULT_LIMITS, daemon.DEFAULT_LIMITS);
  });
});

describe('демон в ресурсах плагина', () => {
  it('assets.generated.ts свеж относительно assets/, а assets/ - относительно companions/agentd (npm run build:companions && npm run embed-assets)', async () => {
    const { bundle, ENTRIES } = (await import(path.join(ROOT, 'companions/agentd/scripts/build.mjs'))) as { bundle(entry: string): Promise<string>; ENTRIES: Record<string, string> };
    for (const [entry, name] of Object.entries(ENTRIES)) {
      const built = await bundle(entry);
      const onDisk = readFileSync(path.join(import.meta.dirname, '..', 'assets', 'agentd', name), 'utf8');
      assert.equal(onDisk, built, `assets/agentd/${name} устарел: npm run build:companions`);
      assert.equal(ASSETS[`agentd/${name.replace(/\.txt$/, '')}`], built, `assets.generated.ts устарел: npm run embed-assets`);
    }
    assert.match(ASSET_VERSION, /^[0-9a-f]{16}$/);
  });

  it('демон не тянет ничего вне node:* и сам: один самодостаточный файл до 1 МиБ, оба файла укладываются в 2 МиБ ресурсов', () => {
    const sizes = ['agentd.js', 'client.js'].map((n) => (ASSETS[`agentd/${n}`] ?? '').length);
    assert.ok(sizes.every((s) => s > 0 && s < 1024 * 1024), String(sizes));
    assert.ok(sizes.reduce((a, b) => a + b, 0) < 2 * 1024 * 1024);
    for (const n of ['agentd.js', 'client.js']) {
      const text = ASSETS[`agentd/${n}`] ?? '';
      const requires = [...text.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1] ?? '');
      assert.ok(requires.every((r) => r.startsWith('node:')), `${n}: ${requires.filter((r) => !r.startsWith('node:')).join(', ')}`);
    }
  });
});
