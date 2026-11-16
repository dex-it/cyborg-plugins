// Клавиши терминала: Shift+Enter - перевод строки в запросе (FR-10003), копирование и вставка вне macOS.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keyAction, NEWLINE_INPUT, type KeyInfo } from '../ui/term-keys.ts';

const key = (over: Partial<KeyInfo>): KeyInfo => ({ type: 'keydown', key: '', code: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over });

describe('keyAction', () => {
  it('Shift+Enter: на нажатии уходит ESC+CR, xterm клавишу не получает; keypress и keyup гасятся без ввода (иначе уйдёт лишний \\r)', () => {
    assert.deepEqual(keyAction(key({ key: 'Enter', code: 'Enter', shiftKey: true }), false), { pass: false, input: NEWLINE_INPUT });
    assert.equal(NEWLINE_INPUT, '\x1b\r');
    for (const type of ['keypress', 'keyup']) assert.deepEqual(keyAction(key({ type, key: 'Enter', shiftKey: true }), false), { pass: false });
    assert.deepEqual(keyAction(key({ key: 'Enter', shiftKey: true }), true), { pass: false, input: NEWLINE_INPUT }, 'на macOS так же');
  });

  it('Enter без Shift, с Ctrl или Alt - обычная клавиша: запрос уходит как всегда', () => {
    assert.deepEqual(keyAction(key({ key: 'Enter' }), false), { pass: true });
    assert.deepEqual(keyAction(key({ key: 'Enter', shiftKey: true, ctrlKey: true }), false), { pass: true });
    assert.deepEqual(keyAction(key({ key: 'Enter', shiftKey: true, altKey: true }), false), { pass: true });
  });

  it('вне macOS Ctrl+Shift+C копирует выделение, Ctrl+Shift+V вставляет; голый Ctrl+C - прерывание, идёт программе', () => {
    assert.deepEqual(keyAction(key({ code: 'KeyC', ctrlKey: true, shiftKey: true }), false), { pass: false, copy: true });
    assert.deepEqual(keyAction(key({ code: 'KeyV', ctrlKey: true, shiftKey: true }), false), { pass: false, paste: true });
    assert.deepEqual(keyAction(key({ code: 'KeyC', ctrlKey: true }), false), { pass: true });
    assert.deepEqual(keyAction(key({ code: 'KeyV', ctrlKey: true, shiftKey: true, metaKey: true }), false), { pass: true });
    assert.deepEqual(keyAction(key({ code: 'KeyC', ctrlKey: true, shiftKey: true, altKey: true }), false), { pass: true });
  });

  it('на macOS Cmd+C и Cmd+V выполняют пункты меню окна: вид клавиши не трогает', () => {
    assert.deepEqual(keyAction(key({ code: 'KeyC', metaKey: true }), true), { pass: true });
    assert.deepEqual(keyAction(key({ code: 'KeyV', ctrlKey: true, shiftKey: true }), true), { pass: true });
  });

  it('отпускание клавиши и прочие клавиши - обычный путь', () => {
    assert.deepEqual(keyAction(key({ type: 'keyup', code: 'KeyC', ctrlKey: true, shiftKey: true }), false), { pass: true });
    assert.deepEqual(keyAction(key({ key: 'a', code: 'KeyA' }), false), { pass: true });
  });
});
