import type { AgentEvent } from '@cyborg-harness/contracts';
import { MCP_SERVER, SESSION_ID } from './args.ts';

/** Хук дописывает JSON события со своего stdin в файл сессии: Claude Code не оборачивается. */
export const HOOK_COMMAND = '{ cat; echo; } >> "$CYBORG_EVENTS"';
// Упавший инструмент шлёт PostToolUseFailure, а не PostToolUse: без него ход из одних отказов выглядел бы простоем.
export const HOOK_EVENTS: readonly string[] = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification'];
/** Пауза после Stop, в течение которой сессия обязана молчать, чтобы «ждёт» было объявлено. */
export const STOP_QUIET_MS = 30_000;

/** Инструмент отработал, успешно или нет: сессия (или её субагент) работает. */
export const isToolEvent = (name: string | undefined): boolean => name === 'PostToolUse' || name === 'PostToolUseFailure';

/** Событие хука Claude Code, как оно лежит в файле сессии. */
export interface HookEvent {
  hook_event_name?: string;
  /** Номер разговора Claude Code: имя журнала и аргумент `--resume`. */
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  notification_type?: string;
  last_assistant_message?: string;
  /** Есть у событий инструментов субагента, в том числе фонового, который работает после Stop главного хода. */
  agent_id?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

/**
 * Содержимое `--settings`: хуки и разрешение инструментов сервера cyborg без вопроса на каждый вызов.
 * Режим разрешений человека не меняется: больше ничего не разрешается и не запрещается (SAD 3.7).
 */
export function hookSettings(): { hooks: Record<string, unknown[]>; permissions: { allow: string[] } } {
  return {
    hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ ...(isToolEvent(event) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: HOOK_COMMAND }] }]])),
    permissions: { allow: [`mcp__${MCP_SERVER}`] },
  };
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

/** Сессия ждёт человека: ход закончен либо Claude Code стоит на вопросе, разрешении или лимите; иначе `null`. */
export function waitingReason(hook: HookEvent): string | null {
  if (hook.hook_event_name === 'Stop') {
    if (hook.background_tasks?.length || hook.session_crons?.length) return null;
    return 'Ход завершён, ждёт ответа';
  }
  if (hook.hook_event_name !== 'Notification') return null;
  return WAITING.get(hook.notification_type ?? '') ?? null;
}

/**
 * Одно событие хука - не более одного события контракта; смена cwd идёт перед ним.
 * Событие, которое состояние сессии не меняет (`idle_prompt`, инструмент субагента, служебные типы), контракта не получает.
 */
export function translate(hook: HookEvent, cwd: string | undefined): AgentEvent[] {
  const out: AgentEvent[] = hook.cwd && hook.cwd !== cwd ? [{ type: 'cwd', cwd: hook.cwd }] : [];
  const name = hook.hook_event_name;
  if (name === 'UserPromptSubmit') {
    out.push({ type: 'prompt' });
  } else if (name === 'SessionStart') {
    // id уходит в argv `--resume` и в state воркспейса: чужая форма не доходит ни туда, ни туда.
    if (typeof hook.session_id === 'string' && SESSION_ID.test(hook.session_id)) out.push({ type: 'session', resumeId: hook.session_id });
  } else if (name === 'Stop') {
    const background = (hook.background_tasks?.length ?? 0) > 0 || (hook.session_crons?.length ?? 0) > 0;
    out.push({ type: 'turnEnd', background, ...(typeof hook.last_assistant_message === 'string' && { text: hook.last_assistant_message }) });
  } else if (name === 'Notification') {
    const reason = waitingReason(hook);
    if (reason !== null) out.push({ type: 'waiting', reason });
  } else if (isToolEvent(name) && !hook.agent_id) {
    // Фоновый субагент хода главной модели не меняет.
    out.push({ type: 'activity', ...(typeof hook.tool_name === 'string' && { tool: hook.tool_name }) });
  }
  return out;
}

export interface QuietStop {
  readonly listener: (event: AgentEvent) => void;
  /** Любое событие хука, в том числе не дошедшее до контракта, отменяет отложенное «ждёт». */
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
