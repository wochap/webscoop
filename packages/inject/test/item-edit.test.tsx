// @vitest-environment jsdom
import { cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { hostStates, renderPanel, withTable } from './panel';

afterEach(cleanup);

async function confirmedState() {
  const { t } = await hostStates();
  await t.send({ kind: 'draft.confirmItems', level: 'proposed' });
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

  it('labels the proposal card for editing and locks the field Edit buttons', async () => {
    const { t } = await confirmedState();
    await t.send({ kind: 'draft.editItem' });
    const panel = renderPanel(t.controller.state);
    const card = panel.q('items-card')!;
    expect(card.textContent).toContain('Edit items');
    expect(panel.q('item-summary')).toBeNull();
    expect(panel.q('confirm-items')!.textContent).toContain('Update items');
    expect(panel.q('cancel-items')!.textContent).toBe('Cancel');
    const edits = panel.qa('field-edit');
    expect(edits.length).toBeGreaterThan(0);
    for (const button of edits) expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(panel.q('field-summary')!);
    fireEvent.click(panel.q('confirm-items')!);
    fireEvent.click(panel.q('cancel-items')!);
    expect(panel.sent).toEqual([{ kind: 'draft.confirmItems', level: 'proposed' }, { kind: 'draft.cancelItems' }]);
  });

  it('keeps the first inference labels when not editing', async () => {
    const { proposed } = await hostStates();
    const panel = renderPanel(proposed);
    expect(panel.q('items-card')!.textContent).toContain('Repeating items found');
    expect(panel.q('confirm-items')!.textContent).toContain('Use these 24 items');
    expect(panel.q('cancel-items')!.textContent).toBe('Not a list');
  });
});
