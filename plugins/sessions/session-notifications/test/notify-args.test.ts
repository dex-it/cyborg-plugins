import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BODY_LENGTH, SESSION_ID_LENGTH, TITLE_LENGTH, validateNotifyArgs } from '../notify-args.ts';

// Перенос test/notify-args.test.ts ai-cyborg. Что изменилось и почему:
// - номер сессии (целое неотрицательное) стал id сессии (непустая строка): так их отдаёт cyborg.sessions;
// - заголовок обрезается до 120, а не 200: больше ядро не принимает (NOTIFY_LIMITS.title), отказ `Invalid` убил бы уведомление;
// - добавлены управляющие символы (в ai-cyborg их не чистили).
// Тест notificationKey не переносится: ключ уведомления теперь id сессии, а у итога без вкладки (id 0) в cyborg.sessions нет аналога.

describe('validateNotifyArgs', () => {
  it('принимает id сессии, заголовок и текст', () => {
    assert.deepEqual(validateNotifyArgs('s3', 'CC3 · проект', 'ждёт'), { sessionId: 's3', title: 'CC3 · проект', body: 'ждёт' });
    assert.deepEqual(validateNotifyArgs('s0', 'CC0', ''), { sessionId: 's0', title: 'CC0', body: '' });
  });

  it('отвергает id не строкой, пустой и слишком длинный', () => {
    for (const id of [1, 1.5, -1, NaN, null, undefined, {}, ['s1'], '', 'я'.repeat(SESSION_ID_LENGTH + 1)]) assert.equal(validateNotifyArgs(id, 'CC', 'x'), null, String(id));
    assert.notEqual(validateNotifyArgs('я'.repeat(SESSION_ID_LENGTH), 'CC', 'x'), null);
  });

  it('отвергает заголовок и текст не строкой, пустой заголовок тоже', () => {
    for (const bad of [1, null, undefined, {}, ['a']]) {
      assert.equal(validateNotifyArgs('s1', bad, 'x'), null);
      assert.equal(validateNotifyArgs('s1', 'CC', bad), null);
    }
    assert.equal(validateNotifyArgs('s1', '   ', 'x'), null);
  });

  it('обрезает длинные заголовок и текст с многоточием', () => {
    const args = validateNotifyArgs('s1', 'я'.repeat(1000), 'ы'.repeat(1000))!;
    assert.equal(args.title.length, TITLE_LENGTH);
    assert.equal(args.body.length, BODY_LENGTH);
    assert.ok(args.title.endsWith('…') && args.body.endsWith('…'));
    assert.equal(validateNotifyArgs('s1', 'я'.repeat(TITLE_LENGTH), 'ы'.repeat(BODY_LENGTH))!.body.length, BODY_LENGTH);
    assert.ok(!validateNotifyArgs('s1', 'я'.repeat(TITLE_LENGTH), 'ы'.repeat(BODY_LENGTH))!.body.endsWith('…'));
    assert.ok(!validateNotifyArgs('s1', 'я'.repeat(TITLE_LENGTH), 'ы')!.title.endsWith('…'));
  });

  it('пределы не больше пределов ядра, иначе show отказал бы Invalid', () => {
    assert.ok(TITLE_LENGTH <= 120, 'NOTIFY_LIMITS.title ядра - 120');
    assert.ok(BODY_LENGTH <= 1000, 'NOTIFY_LIMITS.body ядра - 1000');
  });

  it('заменяет управляющие символы пробелом: перевод строки, табуляция, ESC, NUL, DEL и C1', () => {
    const args = validateNotifyArgs('s1', 'CC\u0000\u001b[31m1\nпроект\t', 'Просит\r\nразрешение\u007f\u0085!')!;
    assert.equal(args.title, 'CC [31m1 проект');
    assert.equal(args.body, 'Просит разрешение !');
    for (const text of [args.title, args.body]) assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/);
  });

  it('заголовок из одних управляющих символов - как пустой, уведомления нет', () => {
    assert.equal(validateNotifyArgs('s1', '\n\t\u001b', 'x'), null);
  });
});
