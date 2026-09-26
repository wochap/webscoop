import type { Recipe } from '../recipe/schema';
import { tablesOf, withTables } from '../recipe/tables';
import type { Promotion } from './promote';

/**
 * A copy of the recipe with each promoted target's selectors and fingerprint
 * replaced. Everything else is a structural clone of the input, so writing it
 * back changes the file only where a target healed. Item, list parent, and
 * field targets are addressed by table (the first one when the target names
 * none), and the recipe keeps the form it was loaded in.
 */
export function applyPromotions(recipe: Recipe, promotions: readonly Promotion[]): Recipe {
  const out = structuredClone(recipe);
  const tables = tablesOf(out);
  const tableOf = (name: string | undefined) => (name === undefined ? tables[0] : tables.find((t) => t.name === name));
  for (const p of promotions) {
    const patch = { selectors: p.selectors.map((s) => ({ ...s })), ...(p.fingerprint ? { fingerprint: structuredClone(p.fingerprint) } : {}) };
    switch (p.target.kind) {
      case 'item': {
        const table = tableOf(p.target.table);
        if (table?.item) table.item = { ...table.item, ...patch };
        break;
      }
      case 'within': {
        const table = tableOf(p.target.table);
        if (table?.item) table.item = { ...table.item, within: patch.selectors, ...(patch.fingerprint ? { withinFingerprint: patch.fingerprint } : {}) };
        break;
      }
      case 'field': {
        const table = tableOf(p.target.table);
        const field = table?.fields[p.target.index];
        if (table && field) table.fields[p.target.index] = { ...field, ...patch };
        break;
      }
      case 'pagination':
        if (out.pagination.target) out.pagination.target = { ...out.pagination.target, ...patch };
        break;
      case 'step': {
        const step = out.steps[p.target.index];
        if (step?.target) out.steps[p.target.index] = { ...step, target: { ...step.target, ...patch } };
        break;
      }
    }
  }
  return withTables(out, tables);
}
