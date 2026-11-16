import path from 'node:path';
import { after } from 'node:test';
import { agentContractSuite } from '@cyborg-harness/testing';
import { toolbox } from '@cyborg-plugins/fixtures';
import { PLUGIN_DIR } from './kit.ts';

// Общий набор cyborg.agent из тест-кита ядра: тот же, что у любого стороннего поставщика (ADR-CH-0004).
// Среда набора: подставной ssh в PATH и подставная оболочка входа, не читающая профиль. Запуск без resumeId - терминал печатает причину и выходит кодом 2.
const box = toolbox();
after(() => box[Symbol.dispose]());

agentContractSuite(PLUGIN_DIR, {
  os: (sandbox) => ({ env: { PATH: box.env.PATH ?? '', HOME: sandbox.root, SHELL: path.join(box.bin, 'shell') } }),
});
