// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { HOST_BINDING, type PageMessage } from '@webscoop/core';
import { dataset, render } from '@webscoop/playground';
import { afterEach, describe, expect, it } from 'vitest';
import { byClass, cardPath } from '../../core/test/recorder-helpers';
import { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';
import { hostStates, renderPanel, withTable } from './panel';

afterEach(cleanup);

async function confirmedState() {
  const { t } = await hostStates();
  await t.send({ kind: 'draft.confirmItems' });
  await t.send({ kind: 'selection.clear' });
  return { t, confirmed: t.controller.state };
}

describe('editing the confirmed item container in the panel', () => {
  it('offers Edit on the item summary and sends draft.editItem', async () => {
    const { confirmed } = await confirmedState();
    const panel = renderPanel(confirmed);
    expect(panel.q('item-zero')).toBeNull();
    fireEvent.click(panel.q('edit-item')!);
    expect(panel.sent).toEqual([{ kind: 'draft.editItem' }]);
  });

  it('shows a zero-match notice and no Edit when the item container matches nothing', async () => {
    const { confirmed } = await confirmedState();
    const panel = renderPanel({ ...confirmed, draft: withTable(confirmed.draft, { item: { ...confirmed.draft.tables[0]!.item!, count: 0, total: 0 } }) });
    expect(panel.q('edit-item')).toBeNull();
    expect(panel.q('item-zero')!.textContent).toMatch(/matches nothing/);
    expect(panel.q('clear-item')).not.toBeNull();
    expect(panel.q('within-repick')).not.toBeNull();
  });

  it('offers no Remove once the list has a field', async () => {
    const { t } = await confirmedState();
    const title = t.controller.state.draft.tables[0]!.item!;
    expect(title.count).toBe(24);
    const price = byClass(t.page, 'product-price', 0);
    await t.pick(price, cardPath(price));
    await t.send({ kind: 'draft.addField', patch: {} });
    const panel = renderPanel(t.controller.state);
    expect(panel.q('edit-item')).not.toBeNull();
    expect(panel.q('clear-item')).toBeNull();
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
    expect(panel.q('items-was')!.textContent).toContain('was 24');
    expect(panel.q('setup-pick')).toBeNull();
    expect(panel.q('field-preview-broken')!.textContent).toBe('1 field would read nothing');
    expect(panel.qa('field-preview-row').map((r) => [r.dataset.name, r.textContent!.replace(r.dataset.name!, '')])).toEqual([['price', '0/24']]);
    expect(panel.q('confirm-items')!.textContent).toContain('Update list');
    // The setup takes over the content: no tabs, table menu, Rows actions, or field edits.
    expect(panel.q('edit-item')).toBeNull();
    expect(panel.q('tab-menu')).toBeNull();
    expect(panel.q('tables')).toBeNull();
    expect(panel.qa('field-edit')).toHaveLength(0);
    expect(panel.q('mode')!.dataset.mode).toBe('editing');
    fireEvent.click(panel.q('confirm-items')!);
    fireEvent.click(panel.q('cancel-items')!);
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
