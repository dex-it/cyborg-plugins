// Перенос test/session-args.test.ts ai-cyborg: те же утверждения о пределах (ввод 1 МиБ, размер 1..1000), номер сессии - строковый id.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanMessage, MAX_INPUT_LENGTH, MAX_PROMPT_LENGTH, MAX_TERMINAL_SIZE, validateCreateInput, validateInputArgs, validateLabelsPatch, validateResizeArgs, validateSessionId } from '../args.ts';

const notIds = ['', ' ', '-a', '_a', 'a/b', 'a b', 'a'.repeat(65), 'я', 1, 0, 1.5, NaN, Infinity, null, undefined, {}, [], ['s1'], true, 1n, () => 'a'];

describe('validateSessionId', () => {
  it('принимает буквы, цифры, «_» и «-», до 64 знаков, первый знак - буква или цифра', () => {
    for (const id of ['s1', 'smwj5hbe4-bbf49e5b', 'A_b-c', '0', 'a'.repeat(64)]) assert.equal(validateSessionId(id), id, id);
  });

  it('отвергает пустое, длинное, с разделителями и не строки', () => {
    for (const id of notIds) assert.equal(validateSessionId(id), null, String(id));
  });
});

describe('validateInputArgs', () => {
  it('принимает id и строку, включая пустую, многострочную и unicode', () => {
    assert.deepEqual(validateInputArgs('s1', 'ls\r'), { id: 's1', data: 'ls\r' });
    assert.deepEqual(validateInputArgs('s0', ''), { id: 's0', data: '' });
    assert.deepEqual(validateInputArgs('s2', 'строка 1\nстрока 2\r\n\t\x1b[200~вставка 😀\x1b[201~'), {
      id: 's2',
      data: 'строка 1\nстрока 2\r\n\t\x1b[200~вставка 😀\x1b[201~',
    });
  });

  it('принимает вставку 200 КБ и ровно предельную длину, отвергает на единицу длиннее и 5 МБ', () => {
    assert.equal(validateInputArgs('s1', 'я'.repeat(200 * 1024))?.data.length, 200 * 1024);
    assert.equal(validateInputArgs('s1', 'x'.repeat(MAX_INPUT_LENGTH))?.data.length, MAX_INPUT_LENGTH);
    assert.equal(validateInputArgs('s1', 'x'.repeat(MAX_INPUT_LENGTH + 1)), null);
    assert.equal(validateInputArgs('s1', 'x'.repeat(5 * 1024 * 1024)), null);
  });

  it('слишком длинное отбрасывается целиком, а не обрезается', () => {
    assert.equal(validateInputArgs('s1', '😀'.repeat(MAX_INPUT_LENGTH)), null);
  });

  it('отвергает данные не строкой', () => {
    for (const data of [1, 0, NaN, null, undefined, {}, { length: 1 }, ['x'], true, 1n, Buffer.from('x'), new Uint8Array(1)]) {
      assert.equal(validateInputArgs('s1', data), null, String(data));
    }
  });

  it('отвергает недопустимый id при верной строке', () => {
    for (const id of notIds) assert.equal(validateInputArgs(id, 'x'), null, String(id));
  });
});

describe('validateResizeArgs', () => {
  it('принимает целые 1..1000', () => {
    assert.deepEqual(validateResizeArgs('s1', 120, 40), { id: 's1', cols: 120, rows: 40 });
    assert.deepEqual(validateResizeArgs('s0', 1, 1), { id: 's0', cols: 1, rows: 1 });
    assert.deepEqual(validateResizeArgs('s3', MAX_TERMINAL_SIZE, MAX_TERMINAL_SIZE), { id: 's3', cols: 1000, rows: 1000 });
  });

  it('отвергает нуль, отрицательные и выход за предел на единицу', () => {
    for (const size of [0, -1, -80, MAX_TERMINAL_SIZE + 1, 65535, 65536, 1e9, 2 ** 53]) {
      assert.equal(validateResizeArgs('s1', size, 24), null, `cols ${size}`);
      assert.equal(validateResizeArgs('s1', 80, size), null, `rows ${size}`);
    }
  });

  it('отвергает дроби, NaN, бесконечность, строки, null, объекты и прочие типы', () => {
    for (const size of ['1', '', 1.5, -1, -0.5, NaN, Infinity, -Infinity, null, undefined, {}, [], [1], true, 1n, () => 1]) {
      assert.equal(validateResizeArgs('s1', size, 24), null, `cols ${String(size)}`);
      assert.equal(validateResizeArgs('s1', 80, size), null, `rows ${String(size)}`);
    }
    assert.equal(validateResizeArgs('s1', '80', '24'), null);
    assert.equal(validateResizeArgs('s1', 80.5, 24.5), null);
  });

  it('отвергает недопустимый id при верном размере', () => {
    for (const id of notIds) assert.equal(validateResizeArgs(id, 80, 24), null, String(id));
  });
});

describe('validateCreateInput (проверка формы запроса session:create и session:resume)', () => {
  it('принимает каталог, дополнительные каталоги без повторов, запрос, агента и id продолжения', () => {
    assert.deepEqual(validateCreateInput({ cwd: '/a' }), { cwd: '/a', addDirs: [] });
    assert.deepEqual(validateCreateInput({ cwd: '/a', addDirs: ['/b', '/c', '/b'], prompt: 'почини', agent: 'agent-claude-code', resumeId: 'abc-1' }), {
      cwd: '/a',
      addDirs: ['/b', '/c'],
      prompt: 'почини',
      agent: 'agent-claude-code',
      resumeId: 'abc-1',
    });
    assert.deepEqual(validateCreateInput({ cwd: '/a', prompt: '' }), { cwd: '/a', addDirs: [] }, 'пустой запрос - сессия без запроса');
  });

  it('отвергает не объект, относительные пути, «..», NUL и негодные типы', () => {
    for (const raw of [null, undefined, 'x', 1, [], [{ cwd: '/a' }]]) assert.equal(typeof validateCreateInput(raw), 'string', String(raw));
    for (const cwd of [undefined, '', 'a', './a', '/a/../b', '/a\0b', 1, {}]) assert.equal(typeof validateCreateInput({ cwd }), 'string', String(cwd));
    for (const addDirs of ['x', { 0: '/b' }, ['b'], ['/b/..'], [1], Array.from({ length: 65 }, (_, i) => `/d${String(i)}`)]) assert.equal(typeof validateCreateInput({ cwd: '/a', addDirs }), 'string', JSON.stringify(addDirs));
  });

  it('предел запроса и форма агента и id продолжения', () => {
    assert.equal(typeof validateCreateInput({ cwd: '/a', prompt: 'x'.repeat(MAX_PROMPT_LENGTH) }), 'object');
    assert.equal(typeof validateCreateInput({ cwd: '/a', prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1) }), 'string');
    assert.equal(typeof validateCreateInput({ cwd: '/a', prompt: 5 }), 'string');
    for (const agent of ['', 'Agent', '-a', 'a b', 1, null]) assert.equal(typeof validateCreateInput({ cwd: '/a', agent }), 'string', String(agent));
    for (const resumeId of ['', '-flag', '--resume', 'a b', 'a/b', 1, null]) assert.equal(typeof validateCreateInput({ cwd: '/a', resumeId }), 'string', String(resumeId));
  });
});

describe('validateLabelsPatch', () => {
  it('принимает привязку задачи и MR, null снимает привязку, лишние поля отбрасываются', () => {
    assert.deepEqual(validateLabelsPatch({ task: { key: 'p1#7', title: 'Дерево', status: 'открыта', url: 'https://x/7', лишнее: 1 }, mr: null }), {
      task: { key: 'p1#7', title: 'Дерево', status: 'открыта', url: 'https://x/7' },
      mr: null,
    });
    assert.deepEqual(validateLabelsPatch({}), {});
  });

  it('отвергает не объект, пустой ключ, не строки и слишком длинные поля', () => {
    for (const raw of [null, 'x', 1, [], undefined]) assert.equal(typeof validateLabelsPatch(raw), 'string', String(raw));
    for (const task of ['x', 1, [], { title: 't' }, { key: '', title: 't' }, { key: 1, title: 't' }, { key: 'k', title: 5 }, { key: 'k', title: 't', status: 1 }, { key: 'k', title: 't', url: {} }, { key: 'k'.repeat(501), title: 't' }]) {
      assert.equal(typeof validateLabelsPatch({ task }), 'string', JSON.stringify(task));
    }
  });
});

describe('cleanMessage (src/main/clean-text.ts)', () => {
  it('убирает управляющие символы, кроме перевода строки и табуляции, и нормализует переводы строк', () => {
    assert.equal(cleanMessage('a\x1b[201~b\x00c\x7f\x9bd'), 'a[201~bcd');
    assert.equal(cleanMessage('  а\r\nб\rв\tг  '), 'а\nб\nв\tг');
  });
});
