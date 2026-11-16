import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PtyHandle, SessionEvent } from '@cyborg-harness/contracts';
import { sessionChange } from '../events.ts';
import { Registry, type Tab } from '../registry.ts';

const handle = { id: '1', pid: 1 } as unknown as PtyHandle;
const tab = (sessionId: string, dirs: string[] = ['/a']): Tab => ({ sessionId, doc: `d-${sessionId}`, title: `Сессия ${sessionId}`, agent: 'agent', dirs, handle });

test('слушатель, бросивший исключение, соседям не мешает; снятая подписка молчит', () => {
  const errors: unknown[] = [];
  const registry = new Registry((e) => errors.push(e));
  registry.add(tab('s1'));
  const heard: SessionEvent[] = [];
  registry.onChange(() => {
    throw new Error('сломан');
  });
  const second = registry.onChange((e) => void heard.push(e));
  registry.emit(tab('s1'), { type: 'activity' });
  assert.deepEqual(heard.map((e) => e.change), [{ type: 'activity' }]);
  assert.equal(errors.length, 1);
  second.dispose();
  registry.emit(tab('s1'), { type: 'exit', code: 0 });
  assert.equal(heard.length, 1);
});

test('uses: каталоги запуска живых сессий; после выхода и после закрытия вкладки не держатся', () => {
  const registry = new Registry(() => undefined);
  registry.add(tab('s1', ['/a', '/b']));
  registry.add(tab('s2', ['/c']));
  assert.deepEqual([registry.uses('/a'), registry.uses('/b'), registry.uses('/c'), registry.uses('/d')], [true, true, true, false]);
  registry.ended('s1');
  registry.remove('s2');
  assert.deepEqual([registry.uses('/a'), registry.uses('/b'), registry.uses('/c')], [false, false, false]);
  assert.ok(registry.get('s1'), 'вышедшая сессия остаётся вкладкой');
  assert.equal(registry.get('s2'), undefined);
});

test('сопоставление событий агента с cyborg.sessions: запрос человека - работа, session и turnEnd контракт не отдаёт', () => {
  assert.deepEqual(sessionChange({ type: 'cwd', cwd: '/w' }), { type: 'cwd', cwd: '/w' });
  assert.deepEqual(sessionChange({ type: 'activity' }), { type: 'activity' });
  assert.deepEqual(sessionChange({ type: 'activity', tool: 'Bash' }), { type: 'activity', tool: 'Bash' });
  assert.deepEqual(sessionChange({ type: 'prompt' }), { type: 'activity' });
  assert.deepEqual(sessionChange({ type: 'waiting', reason: 'Просит разрешение' }), { type: 'waiting', reason: 'Просит разрешение' });
  assert.equal(sessionChange({ type: 'session', resumeId: 'x' }), undefined);
  assert.equal(sessionChange({ type: 'turnEnd', text: 'ответ', background: false }), undefined);
});
