// Числа удалённых сессий: те же, что в ai-cyborg (src/main/projects.ts, src/agentd/protocol.ts). Демон держит свои копии в companions/agentd;
// тест `limits.test.ts` сверяет эти значения с исходником демона, чтобы пара «плагин - демон» не разошлась молча.

/** Хостов в проекте. */
export const MAX_HOSTS = 32;
/** Живых удалённых сессий на хосте. */
export const MAX_PER_HOST = 4;
/** Простой в waiting без хуков и ввода, после которого сессия засыпает, мс. */
export const SLEEP_IDLE_MS = 2 * 3_600_000;
/** Кольцо вывода сессии на хосте для отсутствующего клиента, байт. */
export const RING_BYTES = 1024 * 1024;
/** Версия протокола канала плагин - демон: меняется при несовместимой правке сообщений. */
export const PROTO = 2;
/** Предел задания, байт (MAX_TEXT_BYTES в ai-cyborg). */
export const MAX_TEXT_BYTES = 100_000;
/** Лимиты, с которыми сессия уходит демону: задача 4 ч, простой 30 мин. */
export const DEFAULT_LIMITS = { maxPerHost: MAX_PER_HOST, taskMs: 4 * 3600_000, idleMs: 30 * 60_000 };
/** Начальный размер терминала на хосте. */
export const START_SIZE = { cols: 120, rows: 40 } as const;
