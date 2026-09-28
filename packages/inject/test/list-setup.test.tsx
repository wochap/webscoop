// @vitest-environment jsdom
import { act, cleanup, fireEvent } from '@testing-library/react';
import { dataset, render } from '@webscoop/playground';
import { afterEach, describe, expect, it } from 'vitest';
import { baseState, hostStates, renderPanel, withTable } from './panel';
import { HOST_BINDING, type PageMessage } from '@webscoop/core';
import { byClass, cardPath } from '../../core/test/recorder-helpers';
import { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';

afterEach(cleanup);
async function confirmedState() {
  const { t } = await hostStates();
  await t.send({ kind: 'draft.confirmItems' });
  await t.send({ kind: 'selection.clear' });
  return { t, confirmed: t.controller.state };
}

describe('list setup', () => {
  it('shows the setup from the suggestion, accepts with Enter, and updates the count on exclusion (05a)', async () => {
    const { proposed } = await hostStates({ sponsored: 2 });
    const p = renderPanel(proposed);
    expect(p.q('panel-mode')!.dataset.mode).toBe('items');
    expect(p.q('list-setup')!.dataset.origin).toBe('pick');
    expect(p.q('list-setup')!.textContent).toContain('Set up list');
    expect(p.q('list-count')!.textContent).toBe('24');
    expect(p.q('list-your-pick')!.textContent).toContain('24/24');
    expect(p.q('list-samples')!.textContent).toContain(dataset[0]!.title);
    expect(p.q('list-samples-more')!.textContent).toContain('+ 21 more');
    expect(p.q('list-accept')!.textContent).toContain('Accept 24 items');
    // The field form and the Add field action wait until the setup closes.
    expect(p.q('pick-form')).toBeNull();
    expect(p.q('pick-add-field')).toBeNull();

    fireEvent.change(p.q('list-exclude-input')!, { target: { value: '.sponsored' } });
    fireEvent.submit(p.q('list-exclude-input')!.closest('form')!);
    expect(p.sent).toEqual([{ kind: 'draft.addExclusion', selector: 'css=.sponsored' }]);
    const proposal = proposed.proposal!;
    act(() =>
      p.store.setHost({
        ...proposed,
        proposal: { ...proposal, proposed: { ...proposal.proposed, count: 22, total: 24 }, exclude: [{ strategy: 'css', value: '.sponsored', stability: 'medium', count: 2 }] },
      }),
    );
    expect(p.q('list-count')!.textContent).toBe('22');
    expect(p.q('list-exclusion')!.textContent).toContain('.sponsored');

    fireEvent.keyDown(p.q('panel-body')!, { key: 'Enter' });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.confirmItems' });
    fireEvent.click(p.q('list-back')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.cancelItems' });
  });

  it('turns a stack row into the selector input, edits it, and shows a refused edit inline (05c)', async () => {
    const { proposed } = await hostStates();
    const p = renderPanel(proposed);
    expect(p.q('list-input-within')).toBeNull();
    expect(p.q('list-row-within')!.textContent).toContain('list parent');
    fireEvent.click(p.q('list-row-within')!);
    expect((p.q('list-input-within-strategy') as HTMLSelectElement).value).toBe('role');
    expect((p.q('list-input-within') as HTMLInputElement).value).toBe('list');
    fireEvent.click(p.q('list-row-item')!);
    expect((p.q('list-input-item-strategy') as HTMLSelectElement).value).toBe('role');
    expect((p.q('list-input-item') as HTMLInputElement).value).toBe('article');
    expect(p.q('list-skipped')!.textContent).toBe('0 skipped as dissimilar');

    fireEvent.change(p.q('list-input-item')!, { target: { value: 'role=listitem' } });
    fireEvent.submit(p.q('list-input-item')!.closest('form')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.setLevel', level: 'item', by: 'selector', selector: 'role=listitem' });
    fireEvent.click(p.q('list-more-item')!);
    const rows = p.q('list-candidates-item')!.querySelectorAll('[data-ws="pick-candidate"]');
    fireEvent.click(rows[1]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.setPrimary', level: 'item', index: 1 });
    fireEvent.click(p.q('list-row-done-item')!);
    fireEvent.click(p.q('list-row-within')!);
    fireEvent.click(p.q('list-pick-within')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.pickLevel', level: 'within' });
    fireEvent.click(p.q('list-clear-within')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.setLevel', level: 'within', by: 'clear' });

    const proposal = proposed.proposal!;
    act(() =>
      p.store.setHost({
        ...proposed,
        proposal: { ...proposal, skipped: 6, includeAll: false, error: { level: 'within', message: 'the list parent "css=#nope" matches nothing' } },
      }),
    );
    expect(p.q('list-error-within')!.textContent).toContain('matches nothing');
    expect(p.q('list-skipped')!.textContent).toBe('6 skipped as dissimilar');
  });

  it('shows 0 items, names the level, and disables Accept and Enter when nothing matches (05c2)', () => {
    const empty = { tag: '', label: '', path: [], selectors: [], primary: 0, count: 0, total: 0, paths: [], samples: [] };
    const within = { ...empty, tag: 'div', label: 'div#nope', path: [1, 0], selectors: [{ strategy: 'id' as const, value: 'nope', stability: 'stable' as const, count: 0 }], count: 0, total: 0 };
    const proposal = { within, withinInferred: false, proposed: empty, skipped: 0, includeAll: false, error: null, exclude: [], origin: 'manual' as const, previousCount: null, pick: null, itemLadder: null, parentLadder: null, fieldPreview: [] };
    const p = renderPanel({ ...baseState(), proposal });
    expect(p.q('list-count')!.textContent).toBe('0');
    expect(p.q('list-invalid')!.textContent).toBe('list parent matches nothing');
    expect((p.q('list-accept') as HTMLButtonElement).disabled).toBe(true);
    // The empty item row is an input straight away.
    expect(p.q('list-input-item')).not.toBeNull();
    fireEvent.keyDown(p.q('panel-body')!, { key: 'Enter' });
    expect(p.sent).toEqual([]);
    fireEvent.keyDown(p.q('panel-body')!, { key: 'Escape' });
    expect(p.sent).toEqual([{ kind: 'draft.cancelItems' }]);
  });

  it('opens the item ladder lazily, lists the levels, folds same elements, and picks a level (05b)', async () => {
    const { proposed } = await hostStates();
    const p = renderPanel(proposed);
    expect(p.q('list-item-ladder')).toBeNull();
    fireEvent.click(p.q('list-adjust-item-toggle')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'list.ladder', which: 'item' });
    const proposal = proposed.proposal!;
    const chip = (value: string) => ({ strategy: 'css' as const, value, stability: 'medium' as const, count: 24 });
    const itemLadder = [
      { distance: 0, path: [1, 0, 1, 0, 0, 1], selector: chip('h2'), count: 24, likely: false, sameAs: null },
      { distance: 1, path: [1, 0, 1, 0, 0], selector: chip('article'), count: 24, likely: true, sameAs: 2 },
      { distance: 2, path: [1, 0, 1, 0], selector: chip('li'), count: 24, likely: false, sameAs: null },
    ];
    act(() => p.store.setHost({ ...proposed, proposal: { ...proposal, itemLadder } }));
    const rows = p.qa('list-ladder-row');
    expect(rows.map((r) => r.dataset.distance)).toEqual(['0', '2']);
    expect(rows[0]!.textContent).toContain('your pick');
    expect(rows[1]!.textContent).toContain('24 in list');
    expect(p.q('list-ladder-folded')!.textContent).toBe('↑1 hidden · same elements as ↑2');
    expect(p.q('list-ladder-parent')!.textContent).toContain('is the list parent');
    fireEvent.click(rows[1]!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.setLevel', level: 'item', by: 'path', path: [1, 0, 1, 0] });
    fireEvent.click(p.q('list-include-all')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.toggleIncludeAll' });

    fireEvent.click(p.q('list-adjust-parent-toggle')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'list.ladder', which: 'parent' });
    const parentLadder = [{ distance: 1, path: [1, 0, 1], selector: { ...chip('ul'), count: 1 }, children: 24, likely: true }];
    act(() => p.store.setHost({ ...proposed, proposal: { ...proposal, itemLadder, parentLadder } }));
    expect(p.q('list-parent-row')!.textContent).toContain('24 like the item');
    expect(p.q('list-parent-row')!.textContent).toContain('likely list parent');
    fireEvent.click(p.q('list-parent-row')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.setLevel', level: 'within', by: 'path', path: [1, 0, 1] });
  });

  it('shows the list parent of the confirmed item in its stack, read-only', async () => {
    const { proposed } = await hostStates();
    const item = {
      selectors: [{ strategy: 'role' as const, value: 'article', stability: 'stable' as const, count: 24 }],
      within: [{ strategy: 'role' as const, value: 'list', stability: 'stable' as const, count: 1 }],
      withinCount: 1,
      exclude: [],
      count: 24,
      total: 24,
    };
    const p = renderPanel({ ...proposed, proposal: null, draft: withTable(proposed.draft, { item }) });
    const list = p.qa('stack-level').find((l) => l.dataset.level === 'list')!;
    expect(list.querySelector('[data-ws="chip"]')!.getAttribute('data-selector')).toBe('role=list');
    expect(list.querySelector('[data-ws="stack-count"]')!.textContent).toBe('1');
    expect(p.q('rows')!.querySelector('[aria-label="Clear list parent"]')).toBeNull();
    expect(p.q('rows')!.textContent).not.toMatch(/Change|Re-pick/);
    expect(p.q('rows-exclusions')).toBeNull();
    expect(p.q('list-exclude-input')).toBeNull();

    const { within: _w, withinCount: _c, ...bare } = item;
    const none = renderPanel({ ...proposed, proposal: null, draft: withTable(proposed.draft, { item: bare }) });
    expect(none.qa('stack-level').map((l) => l.dataset.level)).toEqual(['item']);
  });

  it('lists the exclusions of the confirmed item read-only', async () => {
    const { proposed } = await hostStates();
    const item = {
      selectors: [{ strategy: 'role' as const, value: 'article', stability: 'stable' as const, count: 22 }],
      exclude: [{ strategy: 'css' as const, value: '.sponsored', stability: 'medium' as const, count: 2 }],
      count: 22,
      total: 24,
    };
    const p = renderPanel({ ...proposed, proposal: null, draft: withTable(proposed.draft, { item }) });
    const rows = p.q('rows-exclusions')!.querySelectorAll('[data-ws="list-exclusion"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector('.ws-num')!.textContent).toBe('2');
    expect(rows[0]!.querySelector('button')).toBeNull();
    expect(p.q('list-exclude-input')).toBeNull();
  });

  it('does not confirm while typing in the exclusion input', async () => {
    const { proposed } = await hostStates();
    const p = renderPanel(proposed);
    fireEvent.keyDown(p.q('list-exclude-input')!, { key: 'Enter' });
    expect(p.sent.filter((m) => m.kind === 'draft.confirmItems')).toEqual([]);
  });
});

describe('editing the confirmed item container in the panel', () => {
  it('offers Edit on the item summary and sends draft.editItem', async () => {
    const { confirmed } = await confirmedState();
    const panel = renderPanel(confirmed);
    expect(panel.q('rows-zero')).toBeNull();
    fireEvent.click(panel.q('rows-edit')!);
    expect(panel.sent).toEqual([{ kind: 'draft.editItem' }]);
  });

  it('shows a zero-match notice and no Edit when the item container matches nothing', async () => {
    const { confirmed } = await confirmedState();
    const panel = renderPanel({ ...confirmed, draft: withTable(confirmed.draft, { item: { ...confirmed.draft.tables[0]!.item!, count: 0, total: 0 } }) });
    expect(panel.q('rows-edit')).toBeNull();
    expect(panel.q('rows-zero')!.textContent).toMatch(/matches nothing/);
    expect(panel.q('rows-remove')).not.toBeNull();
    expect(panel.q('rows')!.textContent).not.toMatch(/Change|Re-pick|Pick/);
  });

  it('offers no Remove once the list has a field', async () => {
    const { t } = await confirmedState();
    const title = t.controller.state.draft.tables[0]!.item!;
    expect(title.count).toBe(24);
    const price = byClass(t.page, 'product-price', 0);
    await t.pick(price, cardPath(price));
    await t.send({ kind: 'draft.addField', patch: {} });
    const panel = renderPanel(t.controller.state);
    expect(panel.q('rows-edit')).not.toBeNull();
    expect(panel.q('rows-remove')).toBeNull();
    expect(panel.q('table-kind')!.textContent).toBe('List · 24 rows');
  });

  it('opens the edit variant of the list setup and locks the field Edit buttons (05d)', async () => {
    const { t } = await confirmedState();
    const price = byClass(t.page, 'product-price', 0);
    await t.pick(price, cardPath(price));
    await t.send({ kind: 'draft.addField', patch: { name: 'price' } });
    await t.send({ kind: 'draft.editItem' });
    await t.send({ kind: 'draft.setLevel', level: 'item', by: 'selector', selector: '.product-title' });
    const panel = renderPanel(t.controller.state);
    const setup = panel.q('list-setup')!;
    expect(setup.dataset.origin).toBe('edit');
    expect(setup.textContent).toContain('Edit list');
    expect(panel.q('list-was')!.textContent).toContain('was 24');
    expect(panel.q('list-your-pick')).toBeNull();
    expect(panel.q('list-field-preview-broken')!.textContent).toBe('1 field would read nothing');
    expect(panel.qa('list-field-preview-row').map((r) => [r.dataset.name, r.textContent!.replace(r.dataset.name!, '')])).toEqual([['price', '0/24']]);
    expect(panel.q('list-accept')!.textContent).toContain('Update list');
    // The setup takes over the content: no tabs, table menu, Rows actions, or field edits.
    expect(panel.q('rows-edit')).toBeNull();
    expect(panel.q('table-menu')).toBeNull();
    expect(panel.q('tabs')).toBeNull();
    expect(panel.qa('field-edit')).toHaveLength(0);
    expect(panel.q('panel-mode')!.dataset.mode).toBe('editing');
    fireEvent.click(panel.q('list-accept')!);
    fireEvent.click(panel.q('list-cancel')!);
    expect(panel.sent).toEqual([{ kind: 'draft.confirmItems' }, { kind: 'draft.cancelItems' }]);
  });

  it('attaches the page snapshot to draft.editItem', async () => {
    const html = render(dataset, { tier: 0, seed: 1 });
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
    const { confirmed } = await confirmedState();
    const sent: PageMessage[] = [];
    (window as unknown as Record<string, unknown>)[HOST_BINDING] = async (msg: PageMessage) => {
      sent.push(msg);
      return { kind: 'draft.state', state: confirmed };
    };
    const layer = document.createElement('div');
    document.body.appendChild(layer);
    const overlay = new Overlay(layer);
    const runtime = new Runtime({ win: window, overlay });
    runtime.store.setHost(confirmed);
    await runtime.send({ kind: 'draft.editItem' });
    expect(sent.at(-1)).toMatchObject({ kind: 'draft.editItem', snapshot: { tag: 'html' } });
    runtime.dispose();
    overlay.dispose();
  });
});
