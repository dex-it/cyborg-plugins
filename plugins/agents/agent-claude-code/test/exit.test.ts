import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { ID_A, line, rig } from './kit.ts';

// Причина выхода называется по коду выхода и состоянию файла событий, без разбора текста вывода claude (ADR-CH-0004, п. 5).
describe('ended: причины выхода', () => {
  it('код 127 - notFound: оболочка входа не нашла claude', async () => {
    await using r = await rig();
    await r.agent.launch({ sessionId: 'n1', cwd: r.cwd });
    const hint = await r.agent.ended('n1', { code: 127 });
    assert.equal(hint?.kind, 'notFound');
    assert.match(hint?.message ?? '', /claude не найден/);
  });

  it('нормальный выход, выход по сигналу и потеря процесса хостом - не сбой', async () => {
    await using r = await rig();
    for (const [id, exit] of [['z0', { code: 0 }], ['z1', { code: 143, signal: 15 }], ['z2', { code: -1 }], ['z3', { code: 1 }]] as const) {
      await r.agent.launch({ sessionId: id, cwd: r.cwd });
      assert.equal(await r.agent.ended(id, exit), null, id);
    }
  });

  it('resumeFailed: просили продолжить сессию, claude вышел с ошибкой и не дошёл до SessionStart', async () => {
    await using r = await rig();
    await r.agent.launch({ sessionId: 'r1', cwd: r.cwd, resumeId: ID_A });
    const hint = await r.agent.ended('r1', { code: 1 });
    assert.equal(hint?.kind, 'resumeFailed');
    assert.match(hint?.message ?? '', /не продолжив сессию/);
  });

  it('продолжение началось (SessionStart в файле) или сессию не продолжали - выход с ошибкой не resumeFailed', async () => {
    await using r = await rig();
    const spec = await r.agent.launch({ sessionId: 'r2', cwd: r.cwd, resumeId: ID_A });
    await appendFile(spec.env.CYBORG_EVENTS ?? '', line({ hook_event_name: 'SessionStart', session_id: ID_A }));
    assert.equal(await r.agent.ended('r2', { code: 1 }), null, 'сессия начиналась: выход позже - обычный');
    await r.agent.launch({ sessionId: 'r3', cwd: r.cwd });
    assert.equal(await r.agent.ended('r3', { code: 1 }), null, 'без resumeId причины нет');
    await r.agent.launch({ sessionId: 'r4', cwd: r.cwd, resumeId: ID_A });
    assert.equal(await r.agent.ended('r4', { signal: 15, code: 143 }), null, 'вкладку закрыл человек');
  });

  it('authRequired и rateLimited не выдаются: по коду выхода их не отличить, а текст ошибок плагин не разбирает', async () => {
    await using r = await rig();
    for (const code of [1, 2, 3, 4, 126, 128, 255]) {
      await r.agent.launch({ sessionId: 'c1', cwd: r.cwd });
      const hint = await r.agent.ended('c1', { code });
      assert.equal(hint, null, String(code));
    }
  });
});
