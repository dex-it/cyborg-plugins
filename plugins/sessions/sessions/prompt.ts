import type { Provider, Remote, SessionPrompt } from '@cyborg-harness/contracts';

/**
 * Фрагменты системного промпта сессии от всех поставщиков `cyborg.session-prompt` (кратность many).
 * Порядок - по id плагина-поставщика: тот же набор плагинов даёт тот же промпт. Явного порядка в ядре нет (cyborg-harness#259), поэтому порядок ai-cyborg
 * (изоляция первой, кнопки следующих шагов второй) не воспроизводится: `next-actions` по id стоит раньше `session-isolation`. Решение владельца - D-00, пункт 3;
 * расхождение записано в allowlist матрицы паритета (FR-9001).
 * Сломанный поставщик запуску не мешает: его вклад пропускается с записью в журнал. Пустой вклад (пробелы) отбрасывается.
 */
export async function collectFragments(providers: readonly Provider<Remote<SessionPrompt>>[], log: (message: string) => void): Promise<string[]> {
  const sorted = providers.toSorted((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
  const texts = await Promise.all(
    sorted.map((p) =>
      p.impl.fragment().catch((error: unknown) => {
        log(`${p.pluginId}: фрагмент промпта - ${String(error)}`);
        return '';
      }),
    ),
  );
  return texts.filter((text) => typeof text === 'string' && text.trim() !== '');
}
