// Перенос части workspace-text.test.ts ai-cyborg: текст замечания о файле проектов с теми же утверждениями.
// Окно создания воркспейса (defaultWorkspaceFile, withDirectory, поле файла, canCreateWorkspace) в плагин не входит: «Создать воркспейс» - окно приложения и ядра
// (матрица паритета: `workspace-dialog`, `workspace:create` принадлежат ядру), поэтому эти три группы утверждений остаются в ai-cyborg до переноса приложения.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectsProblemText } from '../text.ts';

describe('projectsProblemText', () => {
  const file = '/work/team.cyborg.json';
  it('недоступный файл: называет путь воркспейса, не каталог данных', () => {
    const text = projectsProblemText({ kind: 'unreadable', detail: 'EACCES' }, file);
    assert.ok(text.includes(file));
    assert.ok(!text.includes('каталоге данных'));
  });
  it('повреждённый файл: называет копию и место, куда её положить', () => {
    const text = projectsProblemText({ kind: 'corrupt', detail: 'x', copy: `${file}.corrupt-20261026T080000` }, file);
    assert.ok(text.includes(`${file}.corrupt-20261026T080000`));
    assert.ok(text.includes(`на место ${file}`));
    assert.ok(!text.includes('каталоге данных'));
  });
  it('прежний projects.json называется фактическим путём', () => {
    assert.ok(projectsProblemText({ kind: 'unreadable', detail: 'EIO' }, '/ud/projects.json').includes('/ud/projects.json'));
  });
  it('копии ядра путь неизвестен: текст называет шаблон имени, а не выдумывает путь', () => {
    const text = projectsProblemText({ kind: 'corrupt', detail: 'x' }, null);
    assert.match(text, /<файл>\.corrupt-<время>/);
    assert.match(text, /на место файла воркспейса/);
  });
  it('отказ ядра в записи и корни, не принятые ядром, называют причину', () => {
    assert.match(projectsProblemText({ kind: 'refused', detail: 'только для чтения' }, null), /не сохранены.*только для чтения/);
    assert.match(projectsProblemText({ kind: 'roots', detail: '/a' }, null), /недоступна остальным плагинам.*\/a/);
  });
});
