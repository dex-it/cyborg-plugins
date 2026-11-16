import type { ThemeTokens } from '@cyborg-harness/contracts';

// Терминал глазами логики вида. Настоящий xterm.js живёт в xterm-term.ts (его бандл тянет DOM и canvas, в Node он не грузится), логика вида (session-view.ts)
// знает только этот узкий интерфейс: тест подставляет свой терминал, окно - xterm.

/** Что терминал просит у вида: ввод человека, новый размер, открыть путь или ссылку, записать в буфер обмена, вставить из него. */
export interface TermHooks {
  /** Ввод человека (клавиши, вставка): уходит в pty. */
  input(data: string): void;
  resize(cols: number, rows: number): void;
  openPath(path: string): void;
  openUrl(url: string): void;
  /** Запись в буфер обмена: выделение (Ctrl+Shift+C вне macOS) или OSC 52 от программы. */
  copy(text: string): void;
  /** Вставка из буфера обмена (Ctrl+Shift+V вне macOS). */
  pasteFromClipboard(): void;
}

export interface TermFacade {
  /** Ставит терминал в узел; до этого вывод копится в самом терминале. */
  open(host: HTMLElement): void;
  write(data: string): void;
  /** Вставка текста как с клавиатуры (bracketed paste, если программа его включила). */
  paste(text: string): void;
  /** Сбросить экран и историю. */
  reset(): void;
  focus(): void;
  /** Подогнать число столбцов и строк под узел. */
  fit(): void;
  setFontSize(size: number): void;
  setTheme(tokens: ThemeTokens): void;
  size(): { readonly cols: number; readonly rows: number };
  dispose(): void;
}

export interface TermInit {
  readonly fontSize: number;
  readonly tokens: ThemeTokens;
}

export type TermFactory = (hooks: TermHooks, init: TermInit) => TermFacade;
