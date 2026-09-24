// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actionableAncestor, BrowseObserver, isTextEntry, type ObservedAction } from '../src/picker';

let observer: BrowseObserver;
let actions: ObservedAction[];
let active: boolean;

beforeEach(() => {
  document.body.innerHTML = `
    <div id="modal"><button id="accept"><span class="icon">✓</span> <b>Accept all</b></button></div>
    <form id="search"><input name="q" type="search"><textarea id="notes"></textarea><button type="submit">Search</button></form>
    <select id="sort"><option value="name">Name</option><option value="price">Price</option></select>
    <div role="tablist"><div role="tab" id="products"><span>Products</span></div></div>
    <p id="plain">Just text</p>
    <webscoop-root><button id="panel">Panel</button></webscoop-root>`;
  actions = [];
  active = true;
  observer = new BrowseObserver(window, { isActive: () => active, onAction: (a) => actions.push(a) });
});

afterEach(() => observer.dispose());

const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
const summary = () => actions.map((a) => `${a.kind}:${a.el.id || a.el.getAttribute('name') || a.el.tagName.toLowerCase()}${'value' in a ? `=${a.value}` : ''}`);

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  el.focus();
  for (const ch of text) {
    el.value += ch;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

describe('browse observer', () => {
  it('attributes a click to the nearest actionable ancestor and ignores plain text', () => {
    $('#accept b').click();
    $('#products span').click();
    $('#plain').click();
    expect(summary()).toEqual(['click:accept', 'click:products']);
    expect(actionableAncestor($('#accept .icon'))).toBe($('#accept'));
    expect(actionableAncestor($('#plain'))).toBeNull();
  });

  it('never prevents the page default action', () => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    $('#accept').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('coalesces typing into one step with the final value, flushed on blur', () => {
    const input = $('input[name="q"]') as HTMLInputElement;
    type(input, 'mouse');
    expect(actions).toEqual([]);
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(summary()).toEqual(['type:q=mouse']);
  });

  it('flushes typing before an Enter press and records the press', () => {
    const input = $('input[name="q"]') as HTMLInputElement;
    type(input, 'keyboard');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(summary()).toEqual(['type:q=keyboard', 'press:q=Enter']);
  });

  it('flushes typing into one input when another is typed into or something is clicked', () => {
    type($('input[name="q"]') as HTMLInputElement, 'a');
    type($('#notes') as HTMLTextAreaElement, 'b');
    $('#accept').click();
    expect(summary()).toEqual(['type:q=a', 'type:notes=b', 'click:accept']);
  });

  it('records a select change and not the click that opened it', () => {
    const select = $('#sort') as HTMLSelectElement;
    select.click();
    select.value = 'price';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(summary()).toEqual(['select:sort=price']);
  });

  it('ignores the recorder panel and does nothing while inactive', () => {
    $('#panel').click();
    active = false;
    $('#accept').click();
    type($('input[name="q"]') as HTMLInputElement, 'x');
    observer.flush();
    expect(actions).toEqual([]);
  });

  it('flushes pending typing on demand, as when browse mode ends', () => {
    type($('input[name="q"]') as HTMLInputElement, 'mo');
    observer.flush();
    observer.flush();
    expect(summary()).toEqual(['type:q=mo']);
  });

  it('knows which elements take typed text', () => {
    expect(isTextEntry($('input[name="q"]'))).toBe(true);
    expect(isTextEntry($('#notes'))).toBe(true);
    expect(isTextEntry($('#accept'))).toBe(false);
  });
});
