// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { isMenuTarget } from '../src/keyboard';
import { Dropdown } from '../src/ui/dropdown';
import { TypeSelect } from '../src/ui/fields';
import { baseState, renderPanel } from './panel';

afterEach(cleanup);

/** A manual list setup with nothing matched yet: the item row is an input. */
const EMPTY = { tag: '', label: '', path: [], selectors: [], primary: 0, count: 0, total: 0, paths: [], samples: [] };
const MANUAL = { within: { ...EMPTY, tag: 'div', label: 'div#nope', path: [1, 0], selectors: [{ strategy: 'id' as const, value: 'nope', stability: 'stable' as const, count: 0 }] }, withinInferred: false, proposed: EMPTY, skipped: 0, includeAll: false, error: null, exclude: [], origin: 'manual' as const, previousCount: null, pick: null, itemLadder: null, parentLadder: null, fieldPreview: [] };

const OPTIONS = ['apple', 'banana', 'cherry', 'blueberry'].map((v) => ({ value: v, glyph: v[0]!.toUpperCase(), name: v, hint: `${v} example` }));

function Fruit({ initial = 'banana', onChange = () => {} }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Dropdown
      value={value}
      options={OPTIONS}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
      label="Fruit"
      testId="pick-form-type"
    />
  );
}

const trigger = () => document.querySelector('[data-ws="pick-form-type"]') as HTMLButtonElement;
const menu = () => document.querySelector('[role="listbox"]') as HTMLElement | null;
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k });

describe('Dropdown', () => {
  it('opens with ArrowDown and focuses the current option', () => {
    render(<Fruit />);
    trigger().focus();
    key('ArrowDown');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(options()[1]);
  });

  it('wraps the arrow keys and jumps with Home and End', () => {
    render(<Fruit initial="blueberry" />);
    trigger().focus();
    key('Enter');
    expect(document.activeElement).toBe(options()[3]);
    key('ArrowDown');
    expect(document.activeElement).toBe(options()[0]);
    key('ArrowUp');
    expect(document.activeElement).toBe(options()[3]);
    key('Home');
    expect(document.activeElement).toBe(options()[0]);
    key('End');
    expect(document.activeElement).toBe(options()[3]);
  });

  it('moves to the next row starting with a typed letter', () => {
    render(<Fruit initial="apple" />);
    fireEvent.click(trigger());
    key('b');
    expect(document.activeElement).toBe(options()[1]);
    key('b');
    expect(document.activeElement).toBe(options()[3]);
    key('c');
    expect(document.activeElement).toBe(options()[2]);
  });

  it('chooses with Enter and returns focus to the trigger', () => {
    const chosen: string[] = [];
    render(<Fruit onChange={(v) => chosen.push(v)} />);
    trigger().focus();
    key('ArrowDown');
    key('ArrowDown');
    key('Enter');
    expect(chosen).toEqual(['cherry']);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().value).toBe('cherry');
  });

  it('closes on an outside click and on Tab without a change', () => {
    const chosen: string[] = [];
    render(
      <div>
        <Fruit onChange={(v) => chosen.push(v)} />
        <p data-ws="panel-body">outside</p>
      </div>,
    );
    fireEvent.click(trigger());
    expect(menu()).not.toBeNull();
    fireEvent.pointerDown(document.querySelector('[data-ws="panel-body"]')!);
    expect(menu()).toBeNull();
    fireEvent.click(trigger());
    key('Tab');
    expect(menu()).toBeNull();
    expect(chosen).toEqual([]);
  });

  it('exposes button, listbox, and option roles with the selected option marked', () => {
    render(<Fruit />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger());
    expect(menu()!.getAttribute('aria-label')).toBe('Fruit');
    expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false']);
    expect(isMenuTarget(options()[0]!)).toBe(true);
    expect(isMenuTarget(trigger())).toBe(false);
  });

  it('closes with Escape without a change and without the panel Esc action', () => {
    const p = renderPanel({ ...baseState(), proposal: MANUAL });
    const strategy = p.q('list-input-item-strategy') as HTMLButtonElement;
    expect(strategy).not.toBeNull();
    const before = strategy.value;
    strategy.focus();
    key('ArrowDown');
    expect(menu()).not.toBeNull();
    key('ArrowDown');
    key('Escape');
    expect(menu()).toBeNull();
    expect(strategy.value).toBe(before);
    expect(document.activeElement).toBe(strategy);
    expect(p.sent).toEqual([]);
  });
});

describe('strategy and type menus', () => {
  it('lists the seven strategies with examples and the paste footer', () => {
    const p = renderPanel({ ...baseState(), proposal: MANUAL });
    fireEvent.change(p.q('list-input-item')!, { target: { value: 'id=main' } });
    fireEvent.click(p.q('list-input-item-strategy')!);
    expect(options().map((o) => o.dataset.value)).toEqual(['role', 'testid', 'id', 'class', 'text', 'css', 'xpath']);
    expect(options().map((o) => o.querySelector('.ws-dd-hint')!.textContent)).toEqual(['button "Buy"', 'data-testid', 'main', 'card', '"Next"', 'div > a', 'ul/li']);
    expect(options().find((o) => o.getAttribute('aria-selected') === 'true')!.dataset.value).toBe('id');
    expect(menu()!.querySelector('.ws-dd-foot')!.textContent).toBe('Paste id=… to switch automatically');
  });

  it('lists the six field types in order with glyphs and examples', () => {
    const chosen: string[] = [];
    render(<TypeSelect value="text" onChange={(t) => chosen.push(t)} />);
    const t = document.querySelector('[data-ws="field-type"]') as HTMLButtonElement;
    expect(t.value).toBe('text');
    t.focus();
    key('ArrowDown');
    expect(options().map((o) => o.dataset.value)).toEqual(['text', 'number', 'url', 'image', 'date', 'html']);
    expect(options().every((o) => o.querySelector('.ws-dd-glyph')!.textContent !== null && o.querySelector('.ws-dd-hint')!.textContent !== '')).toBe(true);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    key('Enter');
    expect(chosen).toEqual(['number']);
    expect(document.activeElement).toBe(t);
  });
});
