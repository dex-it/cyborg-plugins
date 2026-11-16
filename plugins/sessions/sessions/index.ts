import type { PluginModule } from '@cyborg-harness/contracts';
import { registerCommands } from './commands.ts';
import { CONTRACT_VERSION, createContract } from './contract.ts';
import { createInput } from './input.ts';
import { createLauncher } from './launcher.ts';
import { Registry } from './registry.ts';
import { createBridge } from './view-bridge.ts';
import { keepWindowTitle } from './window-title.ts';

export { CHANNELS } from './commands.ts';

// Плагин sessions: сессии агентов - вкладки, терминал в pty ядра, события сессии и контракт `cyborg.sessions`.
// Потребитель `cyborg.agent` (описывает запуск и переводит следы агента в события), `cyborg.session-prompt` (фрагменты системного промпта) и `cyborg.agent-tool`
// (инструменты агента по MCP - сервер M-04). Каталоги проверяются по `cyborg.projects`. Терминал держит pty-хост ядра: процесс переживает перезапуск хоста плагина и окна.
const plugin: PluginModule = {
  async activate(ctx) {
    const pty = ctx.os.pty;
    if (!pty) throw new Error('у приложения нет pty');
    const registry = new Registry((error) => ctx.log(`слушатель cyborg.sessions: ${String(error)}`, 'warn'));
    const launcher = createLauncher(ctx, pty, registry);
    const input = createInput(registry);
    const bridge = createBridge(ctx, registry, launcher);
    ctx.contracts.provide('cyborg.sessions', CONTRACT_VERSION, bridge.decorate(createContract(ctx, registry, launcher, input)));
    registerCommands(ctx, registry, launcher, input, bridge.opened);
    keepWindowTitle(ctx, bridge.projectChanged);
    // Человек закрыл вкладку в окне: сессии за ней больше не на что показываться, процесс завершается, метки уходят.
    ctx.documents.onClose((doc) => {
      const tab = registry.byDoc(doc);
      if (!tab) return;
      registry.remove(tab.sessionId);
      void tab.handle?.kill().catch(() => undefined);
      bridge.nudge();
    });
    await launcher.adopt().catch((error: unknown) => ctx.log(`подхват оставленных сессий: ${String(error)}`, 'warn'));
    const kept = await ctx.documents.list();
    if (kept.length > 0) ctx.log(`с прошлого запуска: ${String(kept.length)} вкладок, вышедшие ждут восстановления`);
    return undefined;
  },
};

export default plugin;
