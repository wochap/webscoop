// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { detach, emptyDraft, HOST_BINDING, nodeAt, type PageMessage, type RecorderState } from '@webscoop/core';
import { dataset, render } from '@webscoop/playground';
import { afterEach, describe, expect, it } from 'vitest';
import { byClass, cardPath, harness, type Harness } from '../../core/test/recorder-helpers';
import { tier0Snapshot } from '../../core/test/snapshot';
import { pathOfElement } from '../src/dom';
import { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';
import { baseState, renderPanel, withTable } from './panel';

afterEach(cleanup);

/** Item container confirmed, the title added as a field, and nothing selected. */
async function withItems(): Promise<Harness> {
  const t = await harness(tier0Snapshot(), emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] }));
  await t.pick(byClass(t.page, 'product-title', 0));
  await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
  return t;
}

async function pickedPrice(): Promise<{ t: Harness; state: RecorderState }> {
  const t = await withItems();
  const price = byClass(t.page, 'product-price', 0);
  await t.pick(price, cardPath(price));
  return { t, state: t.controller.state };
}

const toggle = (el: HTMLElement | null) => el!.getAttribute('aria-checked');

describe('field options form', () => {
  it('seeds from the defaults and sends the chosen options with Add', async () => {
    const { state } = await pickedPrice();
    const p = renderPanel(state);
    const name = p.q('form-name') as HTMLInputElement;
    expect(name.value).toBe(state.selected!.defaults.name);
    expect((p.q('form-type') as HTMLSelectElement).value).toBe('number');
    expect((p.q('form-scope') as HTMLSelectElement).value).toBe('item');
    expect(toggle(p.q('form-optional'))).toBe('false');
    fireEvent.change(name, { target: { value: 'amount' } });
    fireEvent.change(p.q('form-type')!, { target: { value: 'text' } });
    fireEvent.click(p.q('form-optional')!);
    fireEvent.click(p.q('form-key')!);
    fireEvent.click(p.q('add-field')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addField', patch: { name: 'amount', type: 'text', scope: 'item', attr: null, optional: true, key: true, table: 0 } });
  });

  it('follows the type with the attribute and refuses a duplicate name', async () => {
    const { state } = await pickedPrice();
    const p = renderPanel(state);
    fireEvent.change(p.q('form-type')!, { target: { value: 'url' } });
    expect((p.q('form-attr') as HTMLInputElement).value).toBe('href');
    fireEvent.change(p.q('form-name')!, { target: { value: state.draft.tables[0]!.fields[0]!.name } });
    expect(p.q('form-name-error')!.textContent).toMatch(/already named/);
    expect((p.q('add-field') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('typed selection selector', () => {
  it('is offered in the empty state with an item container and sends the text with the scope', async () => {
    const t = await withItems();
    const p = renderPanel(t.controller.state);
    expect(p.q('inspector')).toBeNull();
    const input = p.q('selection-selector') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'css=h2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sent.at(-1)).toEqual({ kind: 'selection.setSelector', selector: 'css=h2', scope: 'item' });
    act(() => p.store.setHost({ ...t.controller.state, selectorError: '"css=.nope" matches nothing inside the item containers' }));
    expect(p.q('selector-error')!.textContent).toMatch(/matches nothing/);
  });

  it('is not offered in the empty state without an item container', () => {
    const p = renderPanel(baseState());
    expect(p.q('selection-selector')).toBeNull();
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
    expect(p.q('coverage-count')!.textContent).toBe('7 / 10 items');
    expect(p.q('candidate-items')!.textContent).toBe('7/10');
    fireEvent.click(p.q('coverage-optional')!);
    expect(toggle(p.q('form-optional'))).toBe('true');
    expect(p.q('coverage-optional')).toBeNull();
    fireEvent.click(p.q('add-field')!);
    expect(p.sent.at(-1)).toMatchObject({ kind: 'draft.addField', patch: { optional: true } });
  });
});

describe('clear control', () => {
  it('sends selection.clear from the inspector ×', async () => {
    const { state } = await pickedPrice();
    const p = renderPanel(state);
    fireEvent.click(p.q('clear-selection')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'selection.clear' });
    fireEvent.keyDown(p.q('body')!, { key: 'Escape' });
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
    expect(p.q('mode')!.dataset.mode).toBe('editing');
    expect(p.qa('field').map((f) => f.dataset.editing ?? null)).toEqual([null, 'true']);
    expect((p.q('form-name') as HTMLInputElement).value).toBe('price');
    expect(toggle(p.q('form-optional'))).toBe('true');
    expect(p.q('actions')).toBeNull();
    expect(p.q('update-field')).not.toBeNull();
    fireEvent.change(p.q('form-type')!, { target: { value: 'text' } });
    fireEvent.click(p.q('update-field')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.updateEditedField', patch: { name: 'price', type: 'text', scope: 'item', attr: null, optional: true, key: false } });
    fireEvent.click(p.q('cancel-edit')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.cancelEdit' });
    fireEvent.keyDown(p.q('body')!, { key: 'Escape' });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.cancelEdit' });
  });

  it('shows a field that matches nothing with its candidates and a notice', async () => {
    const { state } = await pickedPrice();
    const editing = { index: 0, options: { name: 'title', type: 'text' as const, scope: 'item' as const, optional: false, key: false }, candidates: [{ strategy: 'css' as const, value: '.gone', stability: 'medium' as const, count: 0, items: 0 }], primary: 0 };
    const p = renderPanel({ ...state, selected: null, editing });
    expect(p.q('edit-zero-match')).not.toBeNull();
    expect(p.q('inspector')).toBeNull();
    expect(p.qa('candidate-count').map((c) => c.textContent)).toEqual(['0']);
    expect(p.q('update-field')).not.toBeNull();
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
