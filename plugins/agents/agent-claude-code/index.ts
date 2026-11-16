import type { Agent, Disposable, PluginModule } from '@cyborg-harness/contracts';
import { claudeArgs, LAUNCH_SCRIPT, mcpConfig, SESSION_ID } from './args.ts';
import { deleteSessions, listHistory } from './history.ts';
import { hookSettings, STOP_QUIET_MS, translate, waitAfterStop, type HookEvent } from './hooks.ts';

export { claudeArgs, LAUNCH_SCRIPT } from './args.ts';
export { waitAfterStop } from './hooks.ts';

const SLICE_BYTES = 256 * 1024;
// Файлы событий убитого приложения: без pid в имени отличить их от живых нельзя, поэтому убираются давние.
const ORPHAN_AGE_MS = 7 * 24 * 3600_000;

/** Что плагин помнит о сессии, пока она идёт. */
interface Tracked {
  /** Сколько байт файла событий уже отдано подписчику; нет - подписка начнётся с конца файла. */
  offset?: number;
  /** Текущий каталог сессии: смена идёт событием `cwd`. */
  cwd?: string;
  /** Сессию просили продолжить: без `SessionStart` в файле её выход - `resumeFailed`. */
  resume: boolean;
}

/** В файле событий есть начало сессии: claude загрузился и прочитал журнал. */
function startedSession(text: string): boolean {
  return text.split('\n').some((line) => {
    try {
      return (JSON.parse(line) as HookEvent).hook_event_name === 'SessionStart';
    } catch {
      return false;
    }
  });
}

const plugin: PluginModule = {
  async activate(ctx) {
    const { fs, paths } = ctx.os;
    const settings = `${paths.data}/claude-hooks.json`;
    const sessionsDir = `${paths.data}/sessions`;
    const projects = `${paths.home}/.claude/projects`;
    await fs.mkdir(sessionsDir);
    // Атомарно (writeText): соседний инстанс пишет тот же файл, а запускающийся claude не должен прочитать обрезанный.
    await fs.writeText(settings, JSON.stringify(hookSettings(), null, 2));

    // Имя файла - от устойчивого id сессии потребителя, а не от pid приложения: подхваченная после перезапуска сессия находит свой файл.
    const eventsFile = (sessionId: string): string => {
      if (!SESSION_ID.test(sessionId)) throw new Error(`id сессии не годится для имени файла: ${sessionId}`);
      return `${sessionsDir}/${sessionId}.jsonl`;
    };
    const mcpFile = (sessionId: string): string => `${eventsFile(sessionId).slice(0, -'.jsonl'.length)}.mcp.json`;

    for (const entry of await fs.list(sessionsDir).catch(() => [])) {
      const file = `${sessionsDir}/${entry.name}`;
      const stat = await fs.stat(file).catch(() => undefined);
      if (entry.kind === 'file' && stat && Date.now() - stat.mtimeMs > ORPHAN_AGE_MS) await fs.remove(file).catch(() => undefined);
    }

    const sessions = new Map<string, Tracked>();

    const agent: Agent = {
      async facts() {
        const result = await ctx.os.process?.run('$SHELL', ['-lc', 'claude --version']).catch(() => undefined);
        const version = result?.code === 0 ? /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] : undefined;
        return {
          id: 'claude-code',
          title: 'Claude Code',
          found: result?.code === 0,
          ...(version !== undefined && { version }),
          capabilities: { resume: true, history: true, events: true },
        };
      },
      async launch(request) {
        const file = eventsFile(request.sessionId);
        // Аргументы проверяются до первой записи на диск: негодный resumeId не оставляет файлов.
        const mcp = request.tools ? mcpFile(request.sessionId) : undefined;
        const args = claudeArgs(request, mcp);
        await fs.writeText(file, '');
        if (request.tools && mcp !== undefined) await fs.writeText(mcp, JSON.stringify(mcpConfig(request.tools.url)));
        // Файл создан пустым при запуске: первая подписка читает его с начала, события до взвода наблюдателя не теряются (FR-5003).
        sessions.set(request.sessionId, { offset: 0, cwd: request.cwd, resume: request.resumeId !== undefined });
        // Окружение claude - только названное здесь и в правиле `launch`: ядро добавляет PATH, HOME, локаль и ничего из окружения приложения,
        // поэтому унаследованные CLAUDE*, CYBORG_CWD и прочие переменные родительской сессии до claude не доходят.
        return {
          program: '$SHELL',
          args: ['-lc', LAUNCH_SCRIPT, 'cyborg', ...args],
          cwd: request.cwd,
          env: { CYBORG_EVENTS: file, CYBORG_SETTINGS: settings, ...(request.tools && { CYBORG_MCP_TOKEN: request.tools.token }) },
        };
      },
      watch(sessionId, onEvent) {
        const quiet = waitAfterStop(onEvent, STOP_QUIET_MS);
        const file = eventsFile(sessionId);
        const name = file.slice(sessionsDir.length + 1);
        const state = sessions.get(sessionId) ?? { resume: false };
        sessions.set(sessionId, state);
        let busy = false;
        let again = false;
        let closed = false;
        const emit = (line: string): void => {
          let hook: HookEvent;
          try {
            hook = JSON.parse(line) as HookEvent;
          } catch {
            return;
          }
          // Любое событие хука, даже не дошедшее до контракта, значит «сессия не молчит».
          quiet.touch();
          for (const event of translate(hook, state.cwd)) {
            if (event.type === 'cwd') state.cwd = event.cwd;
            quiet.listener(event);
          }
        };
        // Хук может дописывать строку прямо сейчас: сдвиг только до последнего полного перевода строки, хвост придёт следующим событием.
        const pull = async (): Promise<void> => {
          if (busy) {
            again = true;
            return;
          }
          busy = true;
          try {
            for (;;) {
              if (closed) return;
              const from = state.offset ?? (await fs.stat(file)).size;
              state.offset = from;
              const slice = await fs.readSlice(file, from, SLICE_BYTES);
              const end = slice.text.lastIndexOf('\n') + 1;
              if (end === 0) break;
              const whole = slice.text.slice(0, end);
              state.offset = from + new TextEncoder().encode(whole).length;
              for (const line of whole.split('\n')) if (line.trim()) emit(line);
              if (slice.bytes < SLICE_BYTES) break;
            }
          } catch {
            // Файл убрал ended или его ещё нет: следующее изменение попробует снова.
          } finally {
            busy = false;
            if (again) {
              again = false;
              void pull();
            }
          }
        };
        // Наблюдатель взводится позже возврата вызова (на macOS - на следующем витке цикла): запись между чтением и взводом события не даёт,
        // поэтому после взвода файл читается ещё раз. Чтение идёт по смещению и повторное безопасно.
        const watching: Promise<Disposable | undefined> = pull()
          .then(() =>
            fs.watch(sessionsDir, (names) => {
              if (names.length === 0 || names.includes(name)) void pull();
            }),
          )
          .then((watcher) => {
            void pull();
            return watcher;
          })
          .catch(() => undefined);
        return {
          dispose: () => {
            closed = true;
            quiet.dispose();
            void watching.then((w) => w?.dispose());
          },
        };
      },
      async ended(sessionId, exit) {
        const file = eventsFile(sessionId);
        const state = sessions.get(sessionId);
        sessions.delete(sessionId);
        const journal = await fs.readText(file).catch(() => '');
        await fs.remove(file).catch(() => undefined);
        await fs.remove(mcpFile(sessionId)).catch(() => undefined);
        // 127 - оболочка входа не нашла claude в своём PATH.
        if (exit.code === 127) return { kind: 'notFound', message: 'claude не найден в PATH оболочки входа' };
        // Без текста ошибок: просили продолжить, claude вышел с ошибкой и не дошёл до SessionStart - журнал сессии он не принял.
        if (state?.resume && exit.signal === undefined && exit.code > 0 && !startedSession(journal)) {
          return { kind: 'resumeFailed', message: `claude завершился, не продолжив сессию: журнал сессии не найден или не читается (код ${String(exit.code)})` };
        }
        return null;
      },
      history: (cwd) => listHistory(fs, projects, cwd),
    };
    ctx.contracts.provide('cyborg.agent', '1.0', agent);

    // Список и удаление по каталогу: вид «Сессии проекта» (history:list, history:delete) строится на них, когда появится cyborg.projects.
    ctx.commands.register('agent-claude-code.history.list', (cwd) => (typeof cwd === 'string' ? listHistory(fs, projects, cwd) : []));
    ctx.commands.register('agent-claude-code.history.delete', (cwd, ids) => deleteSessions(fs, projects, cwd, ids));
    return undefined;
  },
};

export default plugin;
