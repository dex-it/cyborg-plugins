// cyborg.agent для удалённых сессий: `launch` описывает запуск `ssh -tt <хост> ... client.sh attach <sid>` - терминалом сессии становится pty потребителя,
// ввод и вывод идут через него; сессия на хосте живёт под демоном и переживает обрыв (новый `launch` с тем же `resumeId` подхватывает её).
// События (`watch`) читаются опросом файла хуков на хосте: потокового процесса у плагина нет (cyborg-harness#260).
import type { Agent, AgentEvent, HistoryEntry, LaunchRequest, LaunchSpec, Subscription } from '@cyborg-harness/contracts';
import type { ProjectView } from './args.ts';
import { STOP_QUIET_MS, translate, waitAfterStop, wholeLines, type HookEvent } from './events.ts';
import type { Host } from './host.ts';
import type { AgentdBundle } from './install.ts';
import type { RemoteService } from './service.ts';
import { parseResumeId, resumeIdOf } from './service.ts';
import { SSH_PTY_PINNED, type Ssh } from './ssh.ts';

/** Скрипт запуска без цели: закреплён правилом `launch` манифеста; печатает причину и выходит кодом 2. */
export const NO_TARGET_SCRIPT = "echo 'remote-sessions: не выбрана удалённая сессия: создайте её командой remote-sessions.create и откройте по resumeId' >&2; exit 2";

export const POLL_MS = 2000;

interface Tracked {
  host: string;
  sid: string;
  /** Подхват живой сессии: прошлое уже показано, события идут с конца файла. */
  fromEnd: boolean;
}

export interface AgentDeps {
  ssh: Ssh;
  service: RemoteService;
  host(alias: string): Host;
  bundle(): AgentdBundle;
  instance: string;
  /** Хост из списка хостов какого-либо проекта: запуск на чужом алиасе отвергается. */
  allowedHost(alias: string): Promise<boolean>;
  /** Проект, которому принадлежит каталог (по репозиториям); нет - undefined. */
  projectOf(cwd: string): Promise<ProjectView | undefined>;
  /** Версия ssh для `facts`: вывод `ssh -V` либо undefined, если ssh не найден. */
  sshVersion(): Promise<string | undefined>;
  /** Окружение процесса ssh из названного в правиле `launch` (`SSH_AUTH_SOCK`). */
  env(): Promise<Record<string, string>>;
  pollMs?: number;
}

export function makeAgent(deps: AgentDeps): Agent {
  const tracked = new Map<string, Tracked>();
  const poll = deps.pollMs ?? POLL_MS;
  const eventsPath = (sid: string): string => `.cyborg/sessions/${sid}/events.jsonl`;

  return {
    async facts() {
      const out = await deps.sshVersion();
      const version = out !== undefined ? /OpenSSH_(\d+(?:\.\d+)*)/.exec(out)?.[1] : undefined;
      return {
        id: 'claude-code-ssh',
        title: 'Claude Code на SSH-хосте',
        found: out !== undefined,
        ...(version !== undefined && { version }),
        capabilities: { resume: true, history: true, events: true },
      };
    },

    async launch(request: LaunchRequest): Promise<LaunchSpec> {
      const target = parseResumeId(request.resumeId);
      if (!target) {
        // Без цели терминал печатает причину и выходит: вызов не падает, потому что запуск без resumeId допустим по контракту.
        return { program: '$SHELL', args: ['-lc', NO_TARGET_SCRIPT], cwd: request.cwd, env: {} };
      }
      if (!(await deps.allowedHost(target.host))) throw new Error('хост не из списка хостов проектов');
      const host = deps.host(target.host);
      await host.ensure();
      const list = await host.request({ type: 'list' });
      const item = (Array.isArray(list.sessions) ? (list.sessions as Record<string, unknown>[]) : []).find((s) => s.sid === target.sid);
      if (!item) throw new Error(`сессия ${target.sid.slice(0, 8)} не найдена на ${target.host}`);
      let fromEnd = true;
      if (item.asleep === true) {
        // Спящую сначала будят: процесс claude --resume поднимает демон, терминал потом подключается к нему.
        await deps.service.wakeSession(host, target.sid, (item.dirs as string[] | undefined) ?? [], String(item.cwd));
        fromEnd = false;
      }
      tracked.set(request.sessionId, { host: target.host, sid: target.sid, fromEnd });
      return {
        program: 'ssh',
        args: [...SSH_PTY_PINNED, target.host, `sh .cyborg/agentd/${deps.bundle().version}/client.sh attach ${target.sid} ${deps.instance}`],
        cwd: request.cwd,
        env: await deps.env(),
      };
    },

    watch(sessionId: string, listener: (event: AgentEvent) => void): Subscription {
      const t = tracked.get(sessionId);
      if (!t) return { dispose: () => undefined };
      const quiet = waitAfterStop(listener, STOP_QUIET_MS);
      let offset: number | undefined = t.fromEnd ? undefined : 0;
      let cwd: string | undefined;
      let closed = false;
      let busy = false;
      const file = eventsPath(t.sid);
      const tick = async (): Promise<void> => {
        if (busy || closed) return;
        busy = true;
        try {
          if (offset === undefined) {
            const size = await deps.ssh.exec(t.host, `wc -c < ${file}`);
            const n = Number(size.stdout.trim());
            if (size.code !== 0 || !Number.isInteger(n)) return;
            offset = n;
          }
          const res = await deps.ssh.exec(t.host, `tail -c +${String(offset + 1)} ${file}`);
          if (res.code !== 0 || closed) return;
          const { lines, bytes } = wholeLines(res.stdout);
          offset += bytes;
          for (const line of lines) {
            let hook: HookEvent;
            try {
              hook = JSON.parse(line) as HookEvent;
            } catch {
              continue;
            }
            // Любое событие хука, даже не дошедшее до контракта, значит «сессия не молчит».
            quiet.touch();
            for (const event of translate(hook, cwd, (id) => resumeIdOf(id, t.host))) {
              if (event.type === 'cwd') cwd = event.cwd;
              quiet.listener(event);
            }
          }
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => void tick().catch(() => undefined), poll);
      void tick().catch(() => undefined);
      return {
        dispose: () => {
          closed = true;
          clearInterval(timer);
          quiet.dispose();
        },
      };
    },

    async ended(sessionId, exit) {
      tracked.delete(sessionId);
      if (exit.code === 127) return { kind: 'notFound', message: 'ssh не найден в PATH' };
      return null;
    },

    async history(cwd: string): Promise<HistoryEntry[]> {
      const project = await deps.projectOf(cwd);
      if (!project || project.hosts.length === 0) return [];
      const found = await deps.service.historyOf(project);
      return found.entries.map(({ id, cwd: dir, title, updated }) => ({ id, cwd: dir, title, updated }));
    },
  };
}
