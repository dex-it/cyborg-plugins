// Память вида вместо `localStorage` окна (ai-cyborg: prefs.ts, test/prefs.test.ts): те же утверждения - записанное читается обратно, недоступное хранилище не роняет,
// мусор и снятый вариант дают значение по умолчанию.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UiContext } from '@cyborg-harness/contracts';
import { DEFAULT_FONT_SIZE } from '../ui/font-size.ts';
import { applyOrder, readMemory, ViewMemory } from '../ui/view-memory.ts';
import { repoLabels, sessionColor } from '../ui/session-view.ts';

const state = (value?: unknown, fails = false) => {
  const saved: unknown[] = [];
  const api = {
    value,
    set: async (next: unknown) => {
      if (fails) throw new Error('память недоступна');
      saved.push(structuredClone(next));
    },
  } as unknown as UiContext['state'];
  return { api, saved };
};

describe('память вида (prefs)', () => {
  it('записанное значение читается обратно из того, что вид оставил документу; нет памяти - значения по умолчанию', () => {
    assert.deepEqual(readMemory(undefined), { fontSize: DEFAULT_FONT_SIZE, order: [], modes: {} });
    const { api } = state({ fontSize: 17, order: ['a', 'b'], modes: { a: '\x1b[?2004h' } });
    const memory = new ViewMemory(api);
    assert.equal(memory.fontSize, 17);
    assert.deepEqual(memory.order, ['a', 'b']);
    assert.equal(memory.modesOf('a'), '\x1b[?2004h');
    assert.equal(memory.modesOf('нет'), '');
  });

  it('запись идёт по очереди и целиком; не изменившееся значение не пишется', async () => {
    const { api, saved } = state();
    const memory = new ViewMemory(api);
    memory.setFontSize(DEFAULT_FONT_SIZE);
    memory.setFontSize(15);
    memory.setOrder(['x', 'y']);
    memory.setOrder(['x', 'y']);
    memory.setModes('x', '\x1b[?1000h');
    await memory.flush();
    assert.equal(saved.length, 3);
    assert.deepEqual(saved.at(-1), { fontSize: 15, order: ['x', 'y'], modes: { x: '\x1b[?1000h' } });
  });

  it('хранилище недоступно: запись не бросает, значение действует до закрытия вида', async () => {
    const { api, saved } = state(undefined, true);
    const memory = new ViewMemory(api);
    memory.setFontSize(20);
    await assert.doesNotReject(memory.flush());
    assert.equal(memory.fontSize, 20);
    assert.deepEqual(saved, []);
  });

  it('мусор в памяти (прежняя версия, чужая правка): размер по умолчанию, список порядка и режимы без негодных записей', () => {
    for (const raw of [null, 'x', 5, [], { fontSize: 'большой' }, { fontSize: 99 }]) assert.equal(readMemory(raw).fontSize, DEFAULT_FONT_SIZE, JSON.stringify(raw));
    assert.deepEqual(readMemory({ order: ['a', 5, null, 'b'] }).order, ['a', 'b']);
    assert.deepEqual(readMemory({ modes: { a: 'ok', b: 5, c: 'x'.repeat(513) } }).modes, { a: 'ok' });
    assert.deepEqual(readMemory({ order: 'мусор', modes: 5 }), { fontSize: DEFAULT_FONT_SIZE, order: [], modes: {} });
  });

  it('закрытые вкладки забываются: их порядок и режимы уходят из памяти', async () => {
    const { api, saved } = state({ order: ['a', 'b'], modes: { a: 'm1', b: 'm2' } });
    const memory = new ViewMemory(api);
    memory.forget(['b']);
    await memory.flush();
    assert.deepEqual(saved.at(-1), { fontSize: DEFAULT_FONT_SIZE, order: ['b'], modes: { b: 'm2' } });
    memory.forget(['b']);
    await memory.flush();
    assert.equal(saved.length, 1, 'ничего не изменилось - записи нет');
  });
});

describe('порядок вкладок и внешний вид вкладки', () => {
  it('applyOrder: сохранённый порядок для знакомых документов, новые - в конец, исчезнувшие - вон', () => {
    assert.deepEqual(applyOrder(['c', 'a', 'z'], ['a', 'b', 'c']), ['c', 'a', 'b']);
    assert.deepEqual(applyOrder([], ['a', 'b']), ['a', 'b']);
  });

  it('цвет вкладки зависит от документа, а не от порядка: тот же в любом запуске', () => {
    assert.equal(sessionColor('doc-1'), sessionColor('doc-1'));
    assert.match(sessionColor('doc-1'), /^#[0-9a-f]{6}$/);
    assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(sessionColor)).size > 1);
  });

  it('подписи репозиториев в меню: имя каталога, у совпавших - два последних сегмента, не длиннее 80 знаков', () => {
    assert.deepEqual(repoLabels(['/w/a', '/w/b']), ['a', 'b']);
    assert.deepEqual(repoLabels(['/w/x/app', '/w/y/app', '/w/z']), ['x/app', 'y/app', 'z']);
    const long = `/w/${'я'.repeat(100)}`;
    assert.equal(repoLabels([long])[0]?.length, 80);
  });
});
