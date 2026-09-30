// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { dataset, render } from '@webscoop/playground';
import { afterEach, describe, expect, it } from 'vitest';
import { baseState, chooseOption, newDraft, renderPanel, withTable } from './panel';
import { emptyDraft, type RecorderState, detach, HOST_BINDING, nodeAt, type PageMessage } from '@webscoop/core';
import { acceptList, byClass, cardPath, harness, openList, type Harness } from '../../core/test/recorder-helpers';
import { tier0Snapshot } from '../../core/test/snapshot';
import { pathOfElement } from '../src/dom';
import { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';

afterEach(cleanup);

const field = (name: string, extra: object = {}) => ({
  name,
  type: 'text' as const,
  scope: 'item' as const,
  selectors: [{ strategy: 'css' as const, value: `.${name}`, stability: 'medium' as const, count: 24 }],
  optional: false,
  key: false,
  count: 24,
  sample: `${name} sample`,
  ...extra,
});

async function withItems(): Promise<Harness> {
  const t = await harness(tier0Snapshot(), emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] }));
  await openList(t, byClass(t.page, 'product-title', 0));
  await acceptList(t);
  return t;
}

async function pickedPrice(): Promise<{ t: Harness; state: RecorderState }> {
  const t = await withItems();
  const price = byClass(t.page, 'product-price', 0);
  await t.pick(price, cardPath(price));
  return { t, state: t.controller.state };
}

const toggle = (el: HTMLElement | null) => el!.getAttribute('aria-checked');

describe('fields', () => {
  it('reorders with Alt+Up and Alt+Down and by drag', () => {
    const draft = withTable(newDraft(), { fields: [field('title'), field('price'), field('url')] });
    const p = renderPanel(baseState(draft));
    const rows = p.qa('field');
    expect(rows.map((r) => r.dataset.name)).toEqual(['title', 'price', 'url']);
    fireEvent.click(rows[0]!);
    expect(p.store.get().ui.focusedField).toBe(0);
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown', altKey: true });
    expect(p.sent).toEqual([{ kind: 'draft.moveField', from: 0, to: 1 }]);
    expect(p.store.get().ui.focusedField).toBe(1);
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp', altKey: true });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveField', from: 1, to: 0 });

    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!);
    fireEvent.drop(rows[0]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.moveField', from: 2, to: 0 });
  });

  it('removes a field from its row', () => {
    const draft = withTable(newDraft(), { fields: [field('title'), field('price')] });
    const p = renderPanel(baseState(draft));
    fireEvent.click(p.qa('field-remove')[1]!);
    expect(p.sent).toEqual([{ kind: 'draft.removeField', index: 1 }]);
  });

  it('shows the duplicate-name error inline and a zero-match warning', () => {
    const draft = withTable(newDraft(), { fields: [field('price'), field('price', { error: 'duplicate field name "price" (first declared at $.fields[0])' }), field('badge', { count: 0, sample: null })] });
    const p = renderPanel(baseState(draft));
    const names = p.qa('field-name') as HTMLInputElement[];
    expect(names[1]!.getAttribute('aria-invalid')).toBe('true');
    expect(p.q('field-error')!.textContent).toMatch(/duplicate field name "price"/);
    fireEvent.change(names[1]!, { target: { value: 'amount' } });
    fireEvent.blur(names[1]!);
    expect(p.sent).toEqual([{ kind: 'draft.updateField', index: 1, patch: { name: 'amount' } }]);
    const warning = p.q('field-zero')!;
    expect(warning.textContent).toContain('Matches nothing');
    fireEvent.click(p.q('field-make-optional')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateField', index: 2, patch: { optional: true } });
    fireEvent.click(p.q('field-repick')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.repickTarget', target: 'field', index: 2 });
    expect(p.store.get().ui.picking).toBe(true);
  });

  it('shows the chain as chips, the container coverage, and a fallback toggle on item fields', () => {
    const longClass = 'div.VwiC3b.yXK7lf.p4wth.r025kc.hJNv6b';
    const item = {
      selectors: [{ strategy: 'css' as const, value: ':scope > div > div', stability: 'medium' as const }],
      within: [{ strategy: 'id' as const, value: 'rso', stability: 'stable' as const }],
      exclude: [],
      count: 11,
      total: 11,
    };
    const draft = withTable(newDraft(), {
      item,
      fields: [
        field('desc', { selectors: [{ strategy: 'class', value: longClass, stability: 'medium' }], coverage: { matched: 9, total: 11 } }),
        field('heading', { scope: 'page', coverage: null }),
      ],
    });
    const p = renderPanel(baseState(draft));
    const [desc, heading] = p.qa('field');
    // One chip for the field's own selector, not the list parent or item.
    const chips = Array.from(desc!.querySelectorAll('[data-ws="chip"]')) as HTMLElement[];
    expect(chips.map((c) => c.dataset.selector)).toEqual([`class=${longClass}`]);
    expect(chips[0]!.dataset.level).toBe('field');
    expect(chips[0]!.title).toBe(`class=${longClass} · medium stability`);
    expect(chips[0]!.querySelector('[data-ws="chip-value"]')!.className).toContain('ws-sel-value');
    expect(chips[0]!.tagName).toBe('SPAN');
    expect(chips[0]!.hasAttribute('tabindex')).toBe(false);
    expect(desc!.querySelector('[data-ws="field-summary"]')!.getAttribute('data-chain')).toBe(`id=rso » css=:scope > div > div » class=${longClass}`);
    const coverage = desc!.querySelector('[data-ws="field-coverage"]') as HTMLElement;
    expect(coverage.textContent).toBe('9/11');
    expect(coverage.dataset.partial).toBe('true');
    expect(coverage.title).toMatch(/Items holding a match/);
    expect(heading!.querySelector('[data-ws="field-coverage"]')).toBeNull();
    const pageChips = Array.from(heading!.querySelectorAll('[data-ws="chip"]')) as HTMLElement[];
    expect(pageChips.map((c) => [c.dataset.selector, c.dataset.level])).toEqual([['css=.heading', 'page']]);

    const toggle = desc!.querySelector('[data-ws="field-fallback"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateField', index: 0, patch: { fallback: true } });
  });

  it('shows a hover toggle with the stored value and a badge on hover fields', () => {
    const draft = withTable(newDraft(), { fields: [field('title'), field('link', { hover: true })] });
    const p = renderPanel(baseState(draft));
    const [title, link] = p.qa('field');
    const off = title!.querySelector('[data-ws="field-hover"]')!;
    expect(off.getAttribute('aria-checked')).toBe('false');
    expect(off.closest('[title]')!.getAttribute('title')).toBe('Move the mouse over the element before reading it');
    expect(title!.querySelector('[data-ws="field-hover-badge"]')).toBeNull();
    expect(link!.querySelector('[data-ws="field-hover"]')!.getAttribute('aria-checked')).toBe('true');
    const badge = link!.querySelector('[data-ws="field-hover-badge"]') as HTMLElement;
    expect(badge.textContent).toBe('on hover');
    expect(badge.title).toBe('Resolved on hover at run time');
    fireEvent.click(off);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateField', index: 0, patch: { hover: true } });
  });

  it('does nothing on a chip click beyond what clicking the field row does', () => {
    const draft = withTable(newDraft(), { fields: [field('title')] });
    const p = renderPanel(baseState(draft));
    fireEvent.click(p.q('field-summary')!);
    const row = { sent: [...p.sent], ui: p.store.get().ui };
    cleanup();
    const q = renderPanel(baseState(draft));
    fireEvent.click(q.q('field')!.querySelector('[data-ws="chip"]')!);
    expect(q.sent).toEqual(row.sent);
    expect(q.store.get().ui).toEqual(row.ui);
  });
});

describe('field options form', () => {
  it('seeds from the defaults and sends the chosen options with Add', async () => {
    const { state } = await pickedPrice();
    const p = renderPanel(state);
    const name = p.q('pick-form-name') as HTMLInputElement;
    expect(name.value).toBe(state.selected!.defaults.name);
    expect((p.q('pick-form-type') as HTMLButtonElement).value).toBe('number');
    expect(p.q('pick-add-hint')!.textContent).toBe('Reads inside each of 24 items.');
    expect(toggle(p.q('pick-form-optional'))).toBe('false');
    fireEvent.change(name, { target: { value: 'amount' } });
    chooseOption(p.q('pick-form-type')!, 'text');
    fireEvent.click(p.q('pick-form-optional')!);
    fireEvent.click(p.q('pick-form-key')!);
    fireEvent.click(p.q('pick-add-field')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addField', patch: { name: 'amount', type: 'text', attr: null, optional: true, key: true } });
  });

  it('follows the type with the attribute and refuses a duplicate name', async () => {
    const { state } = await pickedPrice();
    const p = renderPanel(state);
    chooseOption(p.q('pick-form-type')!, 'url');
    expect((p.q('pick-form-attr') as HTMLInputElement).value).toBe('href');
    fireEvent.change(p.q('pick-form-name')!, { target: { value: state.draft.tables[0]!.fields[0]!.name } });
    expect(p.q('pick-form-name-error')!.textContent).toMatch(/already named/);
    expect((p.q('pick-add-field') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('typed selection selector', () => {
  it('is offered in the empty state with an item container and sends the text with the scope', async () => {
    const t = await withItems();
    const p = renderPanel(t.controller.state);
    expect(p.q('pick-inspector')).toBeNull();
    const input = p.q('pick-selector') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'css=h2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sent.at(-1)).toEqual({ kind: 'selection.setSelector', selector: 'css=h2', scope: 'item' });
    act(() => p.store.setHost({ ...t.controller.state, selectorError: '"css=.nope" matches nothing inside the item containers' }));
    expect(p.q('pick-selector-error')!.textContent).toMatch(/matches nothing/);
  });

  it('is not offered in the empty state without an item container', () => {
    const p = renderPanel(baseState());
    expect(p.q('pick-selector')).toBeNull();
  });

  it('shows items per containers and offers to mark a partial field optional', async () => {
    const { state } = await pickedPrice();
    const selected = state.selected!;
    const partial: RecorderState = {
      ...state,
      draft: withTable(state.draft, { item: { ...state.draft.tables[0]!.item!, count: 10 } }),
      selected: { ...selected, selection: { ...selected.selection, candidates: [{ strategy: 'css', value: '.badge', stability: 'medium', count: 7, items: 7 }] } },
    };
    const p = renderPanel(partial);
    expect(p.q('pick-coverage-count')!.textContent).toBe('7 / 10 items');
    expect(p.q('pick-candidate-items')!.textContent).toBe('7/10');
    fireEvent.click(p.q('pick-coverage-optional')!);
    expect(toggle(p.q('pick-form-optional'))).toBe('true');
    expect(p.q('pick-coverage-optional')).toBeNull();
    fireEvent.click(p.q('pick-add-field')!);
    expect(p.sent.at(-1)).toMatchObject({ kind: 'draft.addField', patch: { optional: true } });
  });
});

describe('clear control', () => {
  it('sends selection.clear from the inspector ×', async () => {
    const { state } = await pickedPrice();
    const p = renderPanel(state);
    fireEvent.click(p.q('pick-clear')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'selection.clear' });
    fireEvent.keyDown(p.q('panel-body')!, { key: 'Escape' });
    expect(p.sent.at(-1)).toEqual({ kind: 'selection.clear' });
  });
});

describe('editing a saved field', () => {
  it('opens from the Edit button and the summary', async () => {
    const { t } = await pickedPrice();
    await t.send({ kind: 'draft.addField', patch: { name: 'price', type: 'number', optional: true } });
    const p = renderPanel(t.controller.state);
    fireEvent.click(p.qa('field-edit')[1]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.editField', index: 1 });
    fireEvent.click(p.qa('field-summary')[0]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.editField', index: 0 });
  });

  it('marks the field, prefills the form, and offers Update and Cancel in place of the actions', async () => {
    const { t } = await pickedPrice();
    await t.send({ kind: 'draft.addField', patch: { name: 'price', type: 'number', optional: true } });
    await t.send({ kind: 'draft.editField', index: 1, snapshot: detach(t.page) });
    const pending = t.controller.state.pendingSelect!;
    const node = nodeAt(t.page, pending.path)!;
    await t.pick(node, cardPath(node));
    const p = renderPanel(t.controller.state);
    expect(p.q('panel-mode')!.dataset.mode).toBe('editing');
    expect(p.qa('field').map((f) => f.dataset.editing ?? null)).toEqual([null, 'true']);
    expect((p.q('pick-form-name') as HTMLInputElement).value).toBe('price');
    expect(toggle(p.q('pick-form-optional'))).toBe('true');
    expect(p.q('pick-actions')).toBeNull();
    expect(p.q('pick-update')).not.toBeNull();
    chooseOption(p.q('pick-form-type')!, 'text');
    fireEvent.click(p.q('pick-update')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateEditedField', patch: { name: 'price', type: 'text', attr: null, optional: true, key: false } });
    fireEvent.click(p.q('pick-cancel-edit')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.cancelEdit' });
    fireEvent.keyDown(p.q('panel-body')!, { key: 'Escape' });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.cancelEdit' });
  });

  it('shows a field that matches nothing with its candidates and a notice', async () => {
    const { state } = await pickedPrice();
    const editing = { index: 0, options: { name: 'title', type: 'text' as const, scope: 'item' as const, optional: false, key: false }, candidates: [{ strategy: 'css' as const, value: '.gone', stability: 'medium' as const, count: 0, items: 0 }], primary: 0 };
    const p = renderPanel({ ...state, selected: null, editing });
    expect(p.q('pick-edit-zero')).not.toBeNull();
    expect(p.q('pick-inspector')).toBeNull();
    expect(p.qa('pick-candidate-count').map((c) => c.textContent)).toEqual(['0']);
    expect(p.q('pick-update')).not.toBeNull();
  });
});

describe('runtime', () => {
  it('selects the element the host asks for and drops the highlight when the selection clears', async () => {
    const html = render(dataset, { tier: 0, seed: 1 });
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
    const sent: PageMessage[] = [];
    const { state } = await pickedPrice();
    const target = document.querySelectorAll('p.product-price')[2]!;
    (window as unknown as Record<string, unknown>)[HOST_BINDING] = async (msg: PageMessage) => {
      sent.push(msg);
      return { kind: 'draft.state', state: { ...state, selected: null, pendingSelect: null } };
    };
    const layer = document.createElement('div');
    document.body.appendChild(layer);
    const overlay = new Overlay(layer);
    const runtime = new Runtime({ win: window, overlay });
    runtime.store.setHost({ ...state, selected: null });
    runtime.dispatch({ kind: 'draft.state', state: { ...state, selected: null, pendingSelect: { path: pathOfElement(target) } } });
    await new Promise((r) => setTimeout(r, 0));
    const select = sent.find((m): m is PageMessage & { kind: 'picker.select' } => m.kind === 'picker.select')!;
    expect(select.selection.path).toEqual(pathOfElement(target));
    expect(select.selection.containerPath).toEqual(pathOfElement(target.closest('article')!));

    await runtime.send({ kind: 'draft.editField', index: 0 });
    expect(sent.at(-1)).toMatchObject({ kind: 'draft.editField', index: 0, snapshot: { tag: 'html' } });

    runtime.dispatch({ kind: 'draft.state', state: { ...state, selected: { ...state.selected!, selection: { ...state.selected!.selection, path: pathOfElement(target) } } } });
    expect(overlay.boxes().some((b) => b.variant === 'selected')).toBe(true);
    runtime.dispatch({ kind: 'draft.state', state: { ...state, selected: null } });
    expect(overlay.boxes().some((b) => b.variant === 'selected')).toBe(false);
    runtime.dispose();
    overlay.dispose();
  });
});
