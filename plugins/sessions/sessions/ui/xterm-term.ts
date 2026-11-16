import type { ThemeTokens } from '@cyborg-harness/contracts';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import { osc52Allowed, osc52Text } from './osc52.ts';
import { keyAction } from './term-keys.ts';
import { osc8Handler, termLinkProvider, type LinkOpeners } from './term-links.ts';
import type { TermFactory } from './term-facade.ts';

// Настоящий терминал вида: xterm.js с поправками ai-cyborg (createTerminal в app.ts): ссылки и пути в выводе, OSC 8, OSC 52 (копирование от программы),
// Shift+Enter - перевод строки в запросе (FR-10003), копирование и вставка вне macOS на Ctrl+Shift+C и Ctrl+Shift+V. Буфер обмена у вида закрыт,
// поэтому копирует и вставляет главная часть (`sessions.copy`, `sessions.paste-text`).

const FONT = "'JetBrains Mono', 'SF Mono', Menlo, 'DejaVu Sans Mono', 'Ubuntu Mono', monospace";
const mac = (): boolean => /Mac/i.test(navigator.platform);

/** Палитра терминала из токенов темы окна; нет токена - тёмная палитра VS Code, на которую рассчитан Claude Code. */
function palette(tokens: ThemeTokens): ITheme {
  const bg = tokens['--cy-surface'] ?? tokens['--cy-bg'] ?? '#1e1e1e';
  const fg = tokens['--cy-fg'] ?? '#cccccc';
  return { background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selectionBackground: tokens['--cy-border'] ?? '#3f72af' };
}

export const xtermFactory: TermFactory = (hooks, init) => {
  const openers: LinkOpeners = { openPath: hooks.openPath, openUrl: hooks.openUrl };
  const term = new Terminal({
    fontFamily: init.tokens['--cy-font-mono'] ?? FONT,
    fontSize: init.fontSize,
    scrollback: 10000,
    // Claude Code сам рисует выделение фоном ANSI blue, не меняя цвет текста - без поправки текст сливается с фоном.
    minimumContrastRatio: 4.5,
    theme: palette(init.tokens),
    linkHandler: osc8Handler(openers),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.registerLinkProvider(termLinkProvider(term, openers));
  // Копирование - ответ программы на действие человека: позже вывод сам подменил бы буфер.
  let lastUserAt = Number.NEGATIVE_INFINITY;
  const touch = (): void => void (lastUserAt = performance.now());
  for (const type of ['keydown', 'pointerup'] as const) window.addEventListener(type, touch, true);
  term.parser.registerOscHandler(52, (data) => {
    const focused = document.hasFocus() && term.textarea !== undefined && document.activeElement === term.textarea;
    const text = osc52Allowed(focused, performance.now(), lastUserAt) ? osc52Text(data) : undefined;
    if (text !== undefined) hooks.copy(text);
    return true;
  });
  term.onData((data) => hooks.input(data));
  term.onResize(({ cols, rows }) => hooks.resize(cols, rows));
  term.attachCustomKeyEventHandler((event) => {
    const action = keyAction(event, mac());
    if (action.pass) return true;
    if (action.input !== undefined) hooks.input(action.input);
    if (action.copy) {
      const selection = term.getSelection();
      if (selection) hooks.copy(selection);
    }
    if (action.paste) hooks.pasteFromClipboard();
    return false;
  });
  return {
    open: (host) => term.open(host),
    write: (data) => term.write(data),
    paste: (text) => term.paste(text),
    reset: () => term.reset(),
    focus: () => term.focus(),
    fit: () => fit.fit(),
    setFontSize: (size) => void (term.options.fontSize = size),
    setTheme: (tokens) => void (term.options.theme = palette(tokens)),
    size: () => ({ cols: term.cols, rows: term.rows }),
    dispose: () => {
      for (const type of ['keydown', 'pointerup'] as const) window.removeEventListener(type, touch, true);
      term.dispose();
    },
  };
};
