import type { Recipe, Step } from '../recipe/schema';
import { paginateOf } from '../recipe/sequence';
import { tablesOf, withTables } from '../recipe/tables';
import type { Promotion } from './promote';

/**
 * A copy of the recipe with each promoted target's selectors and fingerprint
 * replaced. Everything else is a structural clone of the input, so writing it
 * back changes the file only where a target healed. Item, list parent, and
 * field targets, and table frames, are addressed by table (the first one when the target names
 * none), steps by flow name and index, the pagination target is the paginate
 * block's, and the recipe keeps the form it was loaded in.
 */
export function applyPromotions(recipe: Recipe, promotions: readonly Promotion[]): Recipe {
  const out = structuredClone(recipe);
  const tables = tablesOf(out);
  const tableOf = (name: string | undefined) => (name === undefined ? tables[0] : tables.find((t) => t.name === name));
  const paginate = paginateOf(out);
  const updateStep = (flow: string, index: number, update: (step: Step) => Step) => {
    const steps = out.flows.find((f) => f.name === flow)?.steps;
    const step = steps?.[index];
    if (steps && step) steps[index] = update(step);
  };
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
        if (paginate?.target) paginate.target = { ...paginate.target, ...patch };
        break;
      case 'step':
        updateStep(p.target.flow, p.target.index, (step) => (step.target ? { ...step, target: { ...step.target, ...patch } } : step));
        break;
      case 'frame': {
        if (p.target.of === 'table') {
          const table = tableOf(p.target.table);
          if (table?.frame) table.frame = { ...table.frame, ...patch };
        } else if (p.target.of === 'step') {
          updateStep(p.target.flow, p.target.index, (step) => (step.target?.frame ? { ...step, target: { ...step.target, frame: { ...step.target.frame, ...patch } } } : step));
        } else if (paginate?.target?.frame) {
          paginate.target = { ...paginate.target, frame: { ...paginate.target.frame, ...patch } };
        }
        break;
      }
    }
  }
  return withTables(out, tables);
}
