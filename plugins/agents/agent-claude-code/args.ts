import type { LaunchRequest } from '@cyborg-harness/contracts';

/** Скрипт оболочки входа: PATH пользователя, а не меню приложений; аргументы claude приходят как "$@". Закреплён правилом `launch` манифеста. */
export const LAUNCH_SCRIPT = 'exec claude --settings "$CYBORG_SETTINGS" "$@"';

// Первый символ не дефис: id идёт в argv claude и не должен стать флагом.
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Сервер MCP сессии: имя в `--mcp-config` и в `permissions.allow` настроек (`mcp__<имя>`). */
export const MCP_SERVER = 'cyborg';

/**
 * Позиционные аргументы claude после `--settings` (FR-9002): `--resume <id>`, `--append-system-prompt`, начальный промпт, `--add-dir <каталоги...>`.
 * Промпт стоит до `--add-dir`: тот вариадический (`--add-dir <directories...>`) и забрал бы промпт, стоящий после каталогов.
 */
export function claudeArgs(request: LaunchRequest, mcpFile?: string): string[] {
  // resumeId приходит из данных документа, а их правит не только плагин: чужая форма стала бы флагом claude.
  if (request.resumeId !== undefined && !SESSION_ID.test(request.resumeId)) throw new Error(`id сессии для --resume не годится: ${request.resumeId}`);
  const fragments = request.promptFragments ?? [];
  const dirs = request.extraDirs ?? [];
  return [
    ...(request.resumeId ? ['--resume', request.resumeId] : []),
    ...(fragments.length > 0 ? ['--append-system-prompt', fragments.join('\n\n')] : []),
    // Через «=»: --mcp-config вариадический и иначе забрал бы промпт.
    ...(mcpFile !== undefined ? [`--mcp-config=${mcpFile}`] : []),
    ...(request.prompt ? [request.prompt] : []),
    ...(dirs.length > 0 ? ['--add-dir', ...dirs] : []),
  ];
}

/** Конфиг сервера MCP: токен - в окружении процесса claude, а не в файле и не в argv (их видят другие пользователи машины). */
export function mcpConfig(url: string): unknown {
  return { mcpServers: { [MCP_SERVER]: { type: 'http', url, headers: { Authorization: 'Bearer ${CYBORG_MCP_TOKEN}' } } } };
}
