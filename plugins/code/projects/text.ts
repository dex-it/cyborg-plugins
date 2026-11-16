import type { ProjectsProblem } from './model.ts';

/**
 * Замечание о файле воркспейса (ADR-0014, п.4): что случилось, где исходные байты, что делать; называет фактический путь файла.
 * Перенесено из workspace-text.ts ai-cyborg. Путь файла плагин сам не знает (его держит ядро): `file` пусто - «файл воркспейса».
 */
export function projectsProblemText(problem: ProjectsProblem, file: string | null): string {
  const where = file ?? 'файл воркспейса';
  const place = file ?? 'файла воркспейса';
  if (problem.kind === 'unreadable') {
    return `Файл проектов не прочитан (${problem.detail}). Проекты не загружены, и пока файл недоступен, запись в него отключена: он не будет затёрт. Исправьте доступ к файлу ${where} и перезапустите Cyborg.`;
  }
  if (problem.kind === 'roots') return `Часть каталогов проектов недоступна остальным плагинам: ${problem.detail}.`;
  if (problem.kind === 'refused') return `Проекты не сохранены: ядро отказало в записи (${problem.detail}). Файл воркспейса не тронут.`;
  const kept = problem.copy
    ? `Исходное содержимое сохранено:\n${problem.copy}\nЧтобы вернуть проекты: закройте Cyborg, исправьте копию и положите её на место ${place}.`
    : `Исходное содержимое ядро сохранило рядом с файлом воркспейса (<файл>.corrupt-<время>). Чтобы вернуть проекты: закройте Cyborg, исправьте копию и положите её на место ${place}.`;
  return `Файл проектов повреждён (${problem.detail}), проекты не загружены. ${kept}`;
}
