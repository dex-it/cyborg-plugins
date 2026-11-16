import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';
import { mountSessions } from './session-view.ts';
import { xtermFactory } from './xterm-term.ts';

/** Вид «Сессии»: вкладки и терминалы. Логика - в session-view.ts (она не знает xterm, поэтому проверяется тестами без него), здесь - настоящий терминал. */
export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  return mountSessions(root, ctx, { makeTerm: xtermFactory });
}

mount satisfies UiModule<HTMLElement>['mount'];
