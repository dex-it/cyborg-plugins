import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPlugin } from '@cyborg-harness/core/plugin-check';
import { HOME } from './rig.ts';

describe('плагин session-notifications', () => {
  it('проверка состава: манифест, файлы, правило импортов - без замечаний; единственное право - notify', async () => {
    const report = await checkPlugin(HOME, { ignore: ['dist'] });
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.permissions, ['показывает системные уведомления'], 'право notify, как его называет проверка');
  });
});
