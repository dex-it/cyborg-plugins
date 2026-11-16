import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent } from '@cyborg-harness/contracts';
import { hookSettings, translate, waitAfterStop, waitingReason } from '../hooks.ts';

describe('waitingReason: только ожидание человека, текст по типу события без содержимого ответа', () => {
  it('Stop - ход завершён, ответ Claude в текст не идёт; с фоновой задачей или расписанием - паузы нет', () => {
    assert.equal(waitingReason({ hook_event_name: 'Stop' }), 'Ход завершён, ждёт ответа');
    assert.equal(
      waitingReason({ hook_event_name: 'Stop', last_assistant_message: 'пароль от стенда: hunter2', background_tasks: [], session_crons: [] }),
      'Ход завершён, ждёт ответа',
      'ответ Claude в уведомление не идёт',
    );
    assert.equal(waitingReason({ hook_event_name: 'Stop', background_tasks: [{ id: 't', type: 'subagent', status: 'running' }] }), null, 'пауза до фоновой задачи');
    assert.equal(waitingReason({ hook_event_name: 'Stop', session_crons: [{ id: 'c', schedule: '*/5 * * * *' }] }), null, 'пауза до пробуждения');
  });

  it('Notification: белый список типов, сообщение запроса в текст не идёт', () => {
    assert.equal(waitingReason({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' } as never), 'Просит разрешение');
    const byType: Record<string, string> = {
      elicitation_dialog: 'Задаёт вопрос',
      elicitation_url_dialog: 'Задаёт вопрос',
      agent_needs_input: 'Ждёт ответа',
      quota_auto_resume_stale: 'Остановилась на лимите',
      quota_auto_resume_disabled: 'Остановилась на лимите',
    };
    for (const [type, text] of Object.entries(byType)) assert.equal(waitingReason({ hook_event_name: 'Notification', notification_type: type }), text, type);
    for (const type of ['idle_prompt', 'auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed', 'quota_auto_resume_fired', 'plugin_notification', 'unknown_future_type', undefined]) {
      assert.equal(waitingReason({ hook_event_name: 'Notification', ...(type !== undefined && { notification_type: type }) }), null, String(type));
    }
    assert.equal(waitingReason({ hook_event_name: 'PostToolUse' }), null);
    assert.equal(waitingReason({ hook_event_name: 'UserPromptSubmit' }), null);
  });
});

describe('translate: событие хука - событие контракта cyborg.agent', () => {
  it('смена cwd идёт перед событием и только когда каталог изменился', () => {
    assert.deepEqual(translate({ hook_event_name: 'PostToolUse', cwd: '/b', tool_name: 'Edit' }, '/a'), [{ type: 'cwd', cwd: '/b' }, { type: 'activity', tool: 'Edit' }]);
    assert.deepEqual(translate({ hook_event_name: 'PostToolUse', cwd: '/a', tool_name: 'Edit' }, '/a'), [{ type: 'activity', tool: 'Edit' }]);
    assert.deepEqual(translate({ hook_event_name: 'PostToolUse', tool_name: 'EnterWorktree', cwd: '/a/.claude/worktrees/x' }, '/a'), [
      { type: 'cwd', cwd: '/a/.claude/worktrees/x' },
      { type: 'activity', tool: 'EnterWorktree' },
    ]);
  });

  it('SessionStart с годным id - session, с негодным (флаг, путь) - ничего, кроме смены cwd', () => {
    assert.deepEqual(translate({ hook_event_name: 'SessionStart', session_id: 'c-1' }, undefined), [{ type: 'session', resumeId: 'c-1' }]);
    for (const id of ['--help me', '--resume', '../x', '']) assert.deepEqual(translate({ hook_event_name: 'SessionStart', session_id: id }, undefined), [], id);
    assert.deepEqual(translate({ hook_event_name: 'SessionStart', cwd: '/w' }, undefined), [{ type: 'cwd', cwd: '/w' }]);
  });

  it('UserPromptSubmit - prompt без текста запроса; Stop - turnEnd с ответом и признаком фона', () => {
    assert.deepEqual(translate({ hook_event_name: 'UserPromptSubmit' }, undefined), [{ type: 'prompt' }]);
    assert.deepEqual(translate({ hook_event_name: 'Stop', last_assistant_message: 'готово', background_tasks: [] }, undefined), [{ type: 'turnEnd', background: false, text: 'готово' }]);
    assert.deepEqual(translate({ hook_event_name: 'Stop', session_crons: [{}] }, undefined), [{ type: 'turnEnd', background: true }]);
    assert.deepEqual(translate({ hook_event_name: 'Stop', background_tasks: [{}] }, undefined), [{ type: 'turnEnd', background: true }]);
  });

  it('Notification: ожидание только по белому списку, остальные типы (idle_prompt) состояния не меняют', () => {
    assert.deepEqual(translate({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }, undefined), [{ type: 'waiting', reason: 'Просит разрешение' }]);
    assert.deepEqual(translate({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, undefined), []);
  });

  it('упавший инструмент (PostToolUseFailure) - работа; инструмент субагента (agent_id) хода главной модели не меняет', () => {
    assert.deepEqual(translate({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }, undefined), [{ type: 'activity', tool: 'Bash' }]);
    assert.deepEqual(translate({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'sub-1' }, undefined), []);
    assert.deepEqual(translate({ hook_event_name: 'PostToolUse' }, undefined), [{ type: 'activity' }]);
    assert.deepEqual(translate({ hook_event_name: 'SomethingNew' }, undefined), []);
  });
});

describe('waitAfterStop: «ждёт» после Stop только если сессия молчит', () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('«ждёт» - только если сессия молчит, без фоновой работы и до dispose', async () => {
    const seen: AgentEvent[] = [];
    const quiet = waitAfterStop((e) => seen.push(e), 30);
    quiet.listener({ type: 'turnEnd', background: false });
    await pause(80);
    quiet.listener({ type: 'turnEnd', background: false });
    quiet.listener({ type: 'activity', tool: 'Bash' });
    quiet.listener({ type: 'turnEnd', background: true });
    await pause(80);
    quiet.listener({ type: 'turnEnd', background: false });
    quiet.dispose();
    await pause(80);
    assert.deepEqual(seen, [
      { type: 'turnEnd', background: false },
      { type: 'waiting', reason: 'Ход завершён, ждёт ответа' },
      { type: 'turnEnd', background: false },
      { type: 'activity', tool: 'Bash' },
      { type: 'turnEnd', background: true },
      { type: 'turnEnd', background: false },
    ]);
  });

  it('событие, не дошедшее до контракта (touch), тоже отменяет отложенное «ждёт»', async () => {
    const seen: AgentEvent[] = [];
    const quiet = waitAfterStop((e) => seen.push(e), 30);
    quiet.listener({ type: 'turnEnd', background: false });
    quiet.touch();
    await pause(80);
    assert.deepEqual(seen, [{ type: 'turnEnd', background: false }]);
    quiet.dispose();
  });

  it('запрос разрешения объявляется сразу, выход сессии (dispose) снимает отложенный Stop', async () => {
    const seen: AgentEvent[] = [];
    const quiet = waitAfterStop((e) => seen.push(e), 30);
    quiet.listener({ type: 'waiting', reason: 'Просит разрешение' });
    quiet.listener({ type: 'turnEnd', background: false });
    quiet.dispose();
    await pause(80);
    assert.deepEqual(seen.map((e) => e.type), ['waiting', 'turnEnd']);
  });
});

describe('hookSettings', () => {
  it('хуки на шесть событий, инструменты с matcher *, команда дописывает JSON в файл сессии; разрешён только сервер cyborg', () => {
    const settings = hookSettings();
    assert.deepEqual(Object.keys(settings.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification']);
    for (const [name, entries] of Object.entries(settings.hooks)) {
      const [entry] = entries as { matcher?: string; hooks: { type: string; command: string }[] }[];
      assert.deepEqual(entry?.hooks, [{ type: 'command', command: '{ cat; echo; } >> "$CYBORG_EVENTS"' }], name);
      assert.equal(entry?.matcher, name.startsWith('PostToolUse') ? '*' : undefined, name);
    }
    assert.deepEqual(settings.permissions, { allow: ['mcp__cyborg'] });
  });
});
