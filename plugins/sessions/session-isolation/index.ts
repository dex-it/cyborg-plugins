import type { PluginModule } from '@cyborg-harness/contracts';

// Текст перенесён дословно из ai-cyborg (src/main/claude-args.ts, ISOLATION_PROMPT) на якорном коммите 6fd308f.
// EnterWorktree, а не git worktree add: он меняет cwd сессии, и дерево Cyborg переходит в worktree.
// Править текст можно только вместе с эталоном test/fixtures/isolation-prompt.txt: тест сравнивает их побайтно.
export const ISOLATION_PROMPT =
  'В этих репозиториях параллельно работают другие сессии. Перед первой правкой в репозитории, сменой ветки или коммитом - EnterWorktree, дальше работа только в нём; основной каталог - только чтение. Файлы вне репозиториев (скрэтчпад, временные) worktree не требуют. EnterWorktree изолирует только репозиторий рабочего каталога: перед правкой в репозитории из --add-dir - git worktree add <репозиторий>/.claude/worktrees/<то же имя> -b <та же ветка>, и правки только по этому пути.';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('cyborg.session-prompt', '1.0', { fragment: () => ISOLATION_PROMPT });
    return undefined;
  },
};

export default plugin;
