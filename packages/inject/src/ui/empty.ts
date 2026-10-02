import type { Draft } from '@webscoop/core/page';

/** Whether the draft saves no table: its only table is still empty and it has flows, so the recipe only runs flows. */
export function flowsOnly(draft: Pick<Draft, 'tables' | 'flows'>): boolean {
  const only = draft.tables.length === 1 ? draft.tables[0]! : null;
  return draft.flows.length > 0 && only !== null && only.fields.length === 0 && only.item === null;
}
