import type { PluginContext } from '@cyborg-harness/contracts';

// Заголовок окна: ядро собирает «воркспейс - фрагменты плагинов по id - приложение» (windowTitle из src/renderer/title.ts ai-cyborg), фрагмент плагина `sessions` - название
// выбранного проекта. Нет проекта - фрагмента нет. Источник - `cyborg.projects`: выбранный проект и его события.

export function keepWindowTitle(ctx: PluginContext, changed: () => void = () => undefined): void {
  const projects = ctx.contracts.get('cyborg.projects', 1);
  if (!projects) return;
  let seq = 0;
  const refresh = async (): Promise<void> => {
    const mine = ++seq;
    const selected = await projects.selected().catch(() => null);
    // Ответ опоздал: названа уже другая перемена.
    if (mine !== seq) return;
    changed();
    await ctx.window.setTitle(selected?.name).catch((error: unknown) => ctx.log(`заголовок окна: ${String(error)}`, 'warn'));
  };
  void projects.onChange(() => void refresh()).then(
    (subscription) => ctx.subscriptions.add({ dispose: () => void subscription.dispose() }),
    () => undefined,
  );
  void refresh();
}
