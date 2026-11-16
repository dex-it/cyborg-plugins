import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPluginVersion, parseVersion, providedVersions, rangeAccepts } from '../lib/semver.ts';

describe('версии контрактов', () => {
  it('parseVersion читает x.y и x.y.z', () => {
    assert.deepEqual(parseVersion('1.2'), { major: 1, minor: 2, patch: 0 });
    assert.deepEqual(parseVersion('2.0.5'), { major: 2, minor: 0, patch: 5 });
    assert.equal(parseVersion('один'), undefined);
  });

  it('isPluginVersion требует x.y.z', () => {
    assert.ok(isPluginVersion('1.0.0'));
    assert.ok(isPluginVersion('1.0.0-rc.1'));
    assert.ok(!isPluginVersion('1.0'));
  });

  it('providedVersions: строка, список и объект с version', () => {
    assert.deepEqual(providedVersions('1.1'), ['1.1']);
    assert.deepEqual(providedVersions(['1.0', '2.0']), ['1.0', '2.0']);
    assert.deepEqual(providedVersions({ version: '1.3', guard: {} }), ['1.3']);
    assert.deepEqual(providedVersions(5), []);
  });

  it('rangeAccepts: *, префикс, ^ и ~', () => {
    assert.ok(rangeAccepts('*', '3.1'));
    assert.ok(rangeAccepts('1', '1.7'));
    assert.ok(!rangeAccepts('1', '2.0'));
    assert.ok(rangeAccepts('^1.4', '1.4'));
    assert.ok(rangeAccepts('^1.4', '1.9'));
    assert.ok(!rangeAccepts('^1.4', '1.3'));
    assert.ok(rangeAccepts('~2.3', '2.3'));
    assert.ok(!rangeAccepts('~2.3', '2.4'));
    assert.ok(rangeAccepts('1.2', '1.2'));
    assert.ok(!rangeAccepts('1.2', '1.3'));
    assert.ok(!rangeAccepts('что-то', '1.0'));
  });
});
