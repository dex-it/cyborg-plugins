import type { AgentEvent, SessionChange } from '@cyborg-harness/contracts';

// События агента (`cyborg.agent.watch`) -> события сессии (`cyborg.sessions.onChange`). Хуки Claude Code в события агента переводит `agent-claude-code`
// (в том числе отложенное «ждёт» после конца хода: чужой Stop-хук мог продолжить ход), здесь остаётся соответствие каналам окна ai-cyborg:
// `session:cwd` -> cwd, `session:activity` -> activity, `session:waiting` -> waiting, `session:exit` -> exit (его даёт выход pty).

/** Событие агента глазами `cyborg.sessions`: новый запрос человека тоже «работает»; `session` и `turnEnd` контракт ядра пока не отдаёт. */
export function sessionChange(e: AgentEvent): SessionChange | undefined {
  switch (e.type) {
    case 'cwd':
      return { type: 'cwd', cwd: e.cwd };
    case 'activity':
      return { type: 'activity', ...(e.tool !== undefined && { tool: e.tool }) };
    case 'prompt':
      return { type: 'activity' };
    case 'waiting':
      return { type: 'waiting', reason: e.reason };
    case 'session':
    case 'turnEnd':
      return undefined;
  }
}

/** Строка журнала о событии агента: без текста ответа (в `turnEnd.text` он есть, в журнал не идёт). */
export function describe(e: AgentEvent): string {
  switch (e.type) {
    case 'cwd':
      return `каталог ${e.cwd}`;
    case 'session':
      return `сессия агента ${e.resumeId}`;
    case 'activity':
      return e.tool ? `работает: ${e.tool}` : 'работает';
    case 'prompt':
      return 'запрос человека';
    case 'turnEnd':
      return e.background ? 'ход завершён, ждёт фоновую работу' : 'ход завершён';
    case 'waiting':
      return e.reason;
  }
}
