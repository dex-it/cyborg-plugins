import type { Disposable, PluginModule, SessionEvent } from '@cyborg-harness/contracts';
import type { NotificationsSwitch } from './contracts.ts';
import { validateNotifyArgs } from './notify-args.ts';

export const OPEN_COMMAND = 'session-notifications.open';
export const TOGGLE_COMMAND = 'session-notifications.toggle';

// Решение «показывать ли» живёт здесь, а не в ядре. Событие «ждёт» при окне без фокуса - одно уведомление на сессию;
// новая работа сессии, её выход или выключение уведомлений снимают его; клик поднимает окно (ядро) и запускает команду плагина,
// а та открывает вкладку сессии (cyborg.sessions.reveal, если поставщик его даёт).
const plugin: PluginModule = {
  state: { defaults: { enabled: true } },
  activate(ctx) {
    // Права notify нет в манифесте или ядро её не выдало: ctx.os.notify тогда нет совсем, и плагин честно говорит, что показывать нечем.
    if (!ctx.os.notify) ctx.log('нет права notify: уведомления не показываются', 'warn');

    // Выключатель (FR-10006): по умолчанию включён; значение живёт в разделе state и переживает перезапуск.
    // Недоступное хранилище не отключает плагин: выбор действует до выгрузки, запись не удалась - строка в журнале.
    const stored = (value: Record<string, unknown>): boolean => value.enabled !== false;
    let enabled = stored(ctx.state?.get() ?? {});
    ctx.subscriptions.add(
      ctx.state?.onChange((value) => {
        enabled = stored(value);
        if (!enabled) void closeAll();
      }) ?? { dispose: () => undefined },
    );

    // onFocusChange сообщает только перемены, начальное состояние даёт focused(): сначала подписка, потом вопрос, чтобы перемена между ними не потерялась.
    // Ответ старше перемены, пришедшей раньше него, не затирает её.
    let focused = true;
    let changed = false;
    ctx.window.onFocusChange((now) => {
      changed = true;
      focused = now;
    });
    void ctx.window
      .focused()
      .then((now) => {
        if (!changed) focused = now;
      })
      .catch((e: unknown) => ctx.log(`фокус окна неизвестен, считаю окно активным: ${String(e)}`, 'warn'));

    // id уведомления ядра по сессии; уведомление у сессии одно, новое событие «ждёт» заменяет прежнее.
    const live = new Map<string, string>();
    // События одной очередью: «ждёт» и сразу за ним «работает» не должны разминуться на асинхронном show.
    let queue: Promise<void> = Promise.resolve();

    const unnotify = async (sessionId: string) => {
      const id = live.get(sessionId);
      if (id === undefined) return;
      live.delete(sessionId);
      await ctx.os.notify?.close(id);
    };
    // Выключение гасит показанные (в ai-cyborg их гасил главный процесс, получив notifications:state false).
    const closeAll = () => {
      queue = queue.then(() => Promise.all([...live.keys()].map(unnotify)).then(() => undefined)).catch((e: unknown) => ctx.log(`уведомления не сняты: ${String(e)}`, 'warn'));
      return queue;
    };
    const handle = async (event: SessionEvent) => {
      const { change } = event;
      switch (change.type) {
        case 'waiting': {
          if (!enabled) return;
          if (focused) {
            ctx.log(`${event.title}: окно в фокусе, уведомление не нужно`);
            return;
          }
          const notify = ctx.os.notify;
          if (!notify) {
            ctx.log(`${event.title}: ждёт, но показывать нечем`);
            return;
          }
          const args = validateNotifyArgs(event.sessionId, event.title, change.reason);
          if (!args) {
            ctx.log('событие «ждёт» с недопустимыми аргументами уведомления отброшено', 'warn');
            return;
          }
          await unnotify(args.sessionId);
          live.set(args.sessionId, await notify.show(args.title, args.body, { onClick: { command: OPEN_COMMAND, args: [args.sessionId] } }));
          return;
        }
        case 'activity':
        case 'exit':
          await unnotify(event.sessionId);
          return;
        case 'cwd':
          return;
      }
    };
    const onEvent = (event: SessionEvent) => {
      queue = queue.then(() => handle(event)).catch((e: unknown) => ctx.log(`${event.title}: уведомление не показано - ${String(e)}`, 'warn'));
    };

    let subscription: Disposable | undefined;
    const join = async () => {
      subscription?.dispose();
      subscription = undefined;
      const sessions = ctx.contracts.get('cyborg.sessions', 1);
      if (!sessions) return;
      subscription = await sessions.onChange(onEvent);
      ctx.log('подписан на cyborg.sessions');
    };
    // Поставщик sessions может уйти и вернуться (перезапуск хоста): подписка тогда снята ядром, берём заново.
    const rejoin = () => void join().catch((e: unknown) => ctx.log(`подписка на cyborg.sessions: ${String(e)}`, 'warn'));
    ctx.contracts.onChange('cyborg.sessions', rejoin);
    rejoin();

    const provider: NotificationsSwitch = { isOn: async () => enabled };
    ctx.contracts.provide('session-notifications.switch', '1.0', provider);

    // Без аргумента переключает (пункт меню), с аргументом задаёт значение (как событие notifications:toggle с новым состоянием у ai-cyborg).
    ctx.commands.register(TOGGLE_COMMAND, async (value) => {
      enabled = typeof value === 'boolean' ? value : !enabled;
      ctx.log(enabled ? 'уведомления включены' : 'уведомления выключены');
      if (!enabled) await closeAll();
      try {
        await ctx.state?.set('workspace', { enabled });
      } catch (e) {
        ctx.log(`выбор не сохранён, действует до выгрузки: ${String(e)}`, 'warn');
      }
      return enabled;
    });
    ctx.commands.register(OPEN_COMMAND, async (sessionId) => {
      if (typeof sessionId !== 'string') return;
      // Ядро закрыло уведомление клика само.
      live.delete(sessionId);
      // reveal появился в cyborg.sessions 1.1: поставщик прежней версии члена не даёт, и клик тогда только поднимает окно.
      const sessions = ctx.contracts.get('cyborg.sessions', 1);
      if (typeof sessions?.reveal !== 'function') {
        ctx.log(`сессия ${sessionId}: вкладку открыть нечем (sessions без reveal)`, 'warn');
        return;
      }
      await sessions.reveal(sessionId);
      ctx.log(`открыта сессия ${sessionId}`);
    });
    return { dispose: () => subscription?.dispose() };
  },
};

export default plugin;
