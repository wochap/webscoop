import type { Draft } from '@webscoop/core/page';

/** Whether the draft saves no table: its only table is still empty and it has flows or captures, so the recipe only runs those. */
export function flowsOnly(draft: Pick<Draft, 'tables' | 'flows'> & { captures?: readonly unknown[] }): boolean {
  const only = draft.tables.length === 1 ? draft.tables[0]! : null;
  return (draft.flows.length > 0 || (draft.captures?.length ?? 0) > 0) && only !== null && only.fields.length === 0 && only.item === null;
}
