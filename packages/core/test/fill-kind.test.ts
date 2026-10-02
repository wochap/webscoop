// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { classifyFillElement, currentFillValue } from '../src';

function el(html: string): Element {
  document.body.innerHTML = html;
  return document.body.querySelector('[data-t]') ?? document.body.firstElementChild!;
}

describe('classifyFillElement', () => {
  it.each([
    ['<input type="file">', 'file'],
    ['<input type="checkbox">', 'toggle'],
    ['<div role="switch" aria-checked="false"></div>', 'toggle'],
    ['<span role="checkbox"></span>', 'toggle'],
    ['<input type="radio">', 'radio'],
    ['<div role="radio"></div>', 'radio'],
    ['<select><option>a</option></select>', 'select'],
    ['<select multiple><option>a</option></select>', 'select'],
    ['<input role="combobox">', 'combobox'],
    ['<input aria-autocomplete="list">', 'combobox'],
    ['<input list="cities">', 'combobox'],
    ['<input aria-autocomplete="none">', 'text'],
    ['<input maxlength="1">', 'otp'],
    ['<input>', 'text'],
    ['<input type="email">', 'text'],
    ['<input type="password">', 'text'],
    ['<input type="date">', 'text'],
    ['<textarea></textarea>', 'text'],
    ['<div contenteditable="true"></div>', 'text'],
    ['<button>Select file</button>', 'none'],
    ['<input type="submit">', 'none'],
  ])('%s is %s', (html, kind) => {
    expect(classifyFillElement(el(html))).toBe(kind);
  });
});

describe('currentFillValue', () => {
  it('reads each kind', () => {
    const input = el('<input value="dev@example.test">');
    expect(currentFillValue(input, 'text')).toBe('dev@example.test');
    const box = el('<input type="checkbox" checked>');
    expect(currentFillValue(box, 'toggle')).toBe('true');
    expect(currentFillValue(el('<div role="switch" aria-checked="false"></div>'), 'toggle')).toBe('false');
    expect(currentFillValue(el('<select multiple><option value="PE" selected>Peru</option><option>Chile</option><option selected>Lima</option></select>'), 'select')).toBe('Peru\nLima');
    expect(currentFillValue(el('<input role="combobox" value="Lima">'), 'combobox')).toBe('Lima');
    const first = el('<div><input data-t maxlength="1" value="4"><input maxlength="1" value="8"><input maxlength="1" value="2"></div>');
    expect(currentFillValue(first, 'otp')).toBe('482');
    expect(currentFillValue(el('<input type="file">'), 'file')).toBe('');
  });
});
