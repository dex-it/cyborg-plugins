import type { ProcessOptions, ProcessResult } from '@cyborg-harness/contracts';
import { HOST_ALIAS } from './hosts.ts';

/**
 * Закреплённые аргументы `ssh` для `ctx.os.process.run`: без оболочки и без запросов (BatchMode), «--» перед алиасом, токена и промпта здесь нет.
 * Правило `process` манифеста называет ровно их; тест `ssh.test.ts` сверяет манифест с этим списком.
 */
export const SSH_PINNED: readonly string[] = [
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-o', 'ExitOnForwardFailure=yes',
  '--',
];

/** То же для терминала сессии: `-tt` вместо `-T`, чтобы на хосте был pty даже при `ssh` без tty у вызывающего. */
export const SSH_PTY_PINNED: readonly string[] = ['-tt', ...SSH_PINNED.slice(1)];

/** Аргументы системного ssh: алиас после «--»; `extra` - дополнительные ключи (туннели `-R`) перед ним. */
export function sshArgs(alias: string, remoteCommand: string, extra: string[] = []): string[] {
  return [...SSH_PINNED.slice(0, -1), ...extra, '--', alias, remoteCommand];
}

/** Причина отказа ssh по stderr: человек получает совет, а не зависший запуск. */
export function classifySshError(stderr: string): string {
  if (/Permission denied/i.test(stderr)) return 'хост требует пароль либо ключ не принят или зашифрован без ssh-agent: настройте вход по ключу через ssh-agent';
  if (/Host key verification failed/i.test(stderr)) return 'ключ хоста не подтверждён: один раз выполните ssh <алиас> в терминале';
  if (/Could not resolve hostname/i.test(stderr)) return 'алиас не найден в ~/.ssh/config и DNS';
  if (/timed out/i.test(stderr)) return 'хост не ответил за 15 с';
  if (/remote port forwarding failed/i.test(stderr)) return 'sshd хоста запретил переадресацию unix-сокета (AllowStreamLocalForwarding)';
  const last = stderr.trim().split('\n').pop() ?? '';
  return last.slice(0, 300) || 'ssh завершился без пояснения';
}

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const RUN_LIMIT_MS = 30_000;

/** `ctx.os.process.run`: шов для тестов и для ядра. */
export type RunProcess = (program: string, args: readonly string[], options?: ProcessOptions) => Promise<ProcessResult>;

export interface SshOptions {
  /** Срок вызова, мс; не больше RUN_LIMIT_MS (как в ai-cyborg), если не задан `limitMs`. */
  timeoutMs?: number;
  /** Верхний предел срока: долгие операции (уборка клона, du) просят больше обычных 30 с. */
  limitMs?: number;
  /** Текст на стандартный ввод удалённой команды. */
  input?: string;
}

/** Транспорт SSH поверх `process.run`: один вызов - одна короткая программа `ssh`, долгоживущего канала нет (cyborg-harness#260). */
export class Ssh {
  private readonly runProcess: RunProcess;
  private readonly env: () => Promise<Record<string, string>>;

  /** `env` отдаёт переменные для `ssh` из названных в правиле `process` (`SSH_AUTH_SOCK`): ядро само передаёт только PATH, HOME и локаль. */
  constructor(runProcess: RunProcess, env: () => Promise<Record<string, string>> = () => Promise.resolve({})) {
    this.runProcess = runProcess;
    this.env = env;
  }

  /** Выполняет команду на хосте; алиас проверяется здесь же: ведущий «-» и пробел ssh принял бы за ключ. */
  async exec(alias: string, remoteCommand: string, options: SshOptions = {}): Promise<SshResult> {
    if (!HOST_ALIAS.test(alias)) return { code: 255, stdout: '', stderr: `алиас хоста не годится: ${alias.slice(0, 40)}` };
    const timeoutMs = Math.min(options.timeoutMs ?? RUN_LIMIT_MS, options.limitMs ?? RUN_LIMIT_MS);
    let result: ProcessResult;
    try {
      const env = await this.env();
      result = await this.runProcess('ssh', [...SSH_PINNED, alias, remoteCommand], { timeoutMs, ...(options.input !== undefined && { input: options.input }), ...(Object.keys(env).length > 0 && { env }) });
    } catch (error) {
      return { code: 255, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
    }
    // Остановленная по сроку программа - как зависшее соединение.
    if (result.code === null) return { code: 255, stdout: result.stdout, stderr: 'Connection timed out' };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  /** Скрипт идёт в stdin `sh -s`, как в ai-cyborg. */
  run(alias: string, script: string, timeoutMs?: number): Promise<SshResult> {
    return this.exec(alias, 'sh -s', { input: script, ...(timeoutMs !== undefined && { timeoutMs }) });
  }
}
