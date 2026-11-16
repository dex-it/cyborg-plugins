// События удалённой сессии: хуки claude на хосте дописывают строки JSON в `~/.cyborg/sessions/<sid>/events.jsonl` (формат тот же, что у локального агента),
// плагин читает файл по смещению и переводит строки в события `cyborg.agent`. Перевод - копия agent-claude-code/hooks.ts: чужие плагины импортировать нельзя.
import type { AgentEvent } from '@cyborg-harness/contracts';

/** Пауза после Stop, в течение которой сессия обязана молчать, чтобы «ждёт» было объявлено. */
export const STOP_QUIET_MS = 30_000;

// Первый символ не дефис: id идёт в argv claude и не должен стать флагом.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const isToolEvent = (name: string | undefined): boolean => name === 'PostToolUse' || name === 'PostToolUseFailure';

/** Событие хука Claude Code, как оно лежит в файле сессии. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  notification_type?: string;
  last_assistant_message?: string;
  agent_id?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

// Белый список: новый тип Notification не уведомляет, а текст зависит только от типа - ответ и запрос на экран блокировки не попадают (D-07).
const WAITING: ReadonlyMap<string, string> = new Map([
  ['permission_prompt', 'Просит разрешение'],
  ['elicitation_dialog', 'Задаёт вопрос'],
  ['elicitation_url_dialog', 'Задаёт вопрос'],
  ['agent_needs_input', 'Ждёт ответа'],
  ['quota_auto_resume_stale', 'Остановилась на лимите'],
  ['quota_auto_resume_disabled', 'Остановилась на лимите'],
]);

export function waitingReason(hook: HookEvent): string | null {
  if (hook.hook_event_name === 'Stop') {
    if (hook.background_tasks?.length || hook.session_crons?.length) return null;
    return 'Ход завершён, ждёт ответа';
  }
  if (hook.hook_event_name !== 'Notification') return null;
  return WAITING.get(hook.notification_type ?? '') ?? null;
}

/** Одно событие хука - не более одного события контракта; смена cwd идёт перед ним. `resumeId` называет сессию так, как её открывает `launch` (`<sid>@<хост>`). */
export function translate(hook: HookEvent, cwd: string | undefined, resumeId: (id: string) => string): AgentEvent[] {
  const out: AgentEvent[] = hook.cwd && hook.cwd !== cwd ? [{ type: 'cwd', cwd: hook.cwd }] : [];
  const name = hook.hook_event_name;
  if (name === 'UserPromptSubmit') {
    out.push({ type: 'prompt' });
  } else if (name === 'SessionStart') {
    if (typeof hook.session_id === 'string' && SESSION_ID.test(hook.session_id)) out.push({ type: 'session', resumeId: resumeId(hook.session_id) });
  } else if (name === 'Stop') {
    const background = (hook.background_tasks?.length ?? 0) > 0 || (hook.session_crons?.length ?? 0) > 0;
    out.push({ type: 'turnEnd', background, ...(typeof hook.last_assistant_message === 'string' && { text: hook.last_assistant_message }) });
  } else if (name === 'Notification') {
    const reason = waitingReason(hook);
    if (reason !== null) out.push({ type: 'waiting', reason });
  } else if (isToolEvent(name) && !hook.agent_id) {
    out.push({ type: 'activity', ...(typeof hook.tool_name === 'string' && { tool: hook.tool_name }) });
  }
  return out;
}

export interface QuietStop {
  readonly listener: (event: AgentEvent) => void;
  touch(): void;
  dispose(): void;
}

// Чужой Stop-хук может продолжить ход: «ждёт» после Stop объявляется, только если сессия молчит quietMs.
export function waitAfterStop(listener: (event: AgentEvent) => void, quietMs: number): QuietStop {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    listener: (event) => {
      dispose();
      listener(event);
      if (event.type === 'turnEnd' && !event.background) {
        timer = setTimeout(() => {
          timer = undefined;
          listener({ type: 'waiting', reason: 'Ход завершён, ждёт ответа' });
        }, quietMs);
      }
    },
    touch: dispose,
    dispose,
  };
}

/** Разбор куска `events.jsonl`: полные строки и сколько байт они заняли (хвост без перевода строки ждёт следующего чтения). */
export function wholeLines(text: string): { lines: string[]; bytes: number } {
  const end = text.lastIndexOf('\n') + 1;
  if (end === 0) return { lines: [], bytes: 0 };
  const whole = text.slice(0, end);
  return { lines: whole.split('\n').filter((l) => l.trim()), bytes: new TextEncoder().encode(whole).length };
}
