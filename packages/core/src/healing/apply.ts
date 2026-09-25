import type { Recipe } from '../recipe/schema';
import type { Promotion } from './promote';

/**
 * A copy of the recipe with each promoted target's selectors and fingerprint
 * replaced. Everything else is a structural clone of the input, so writing it
 * back changes the file only where a target healed.
 */
export function applyPromotions(recipe: Recipe, promotions: readonly Promotion[]): Recipe {
  const out = structuredClone(recipe);
  for (const p of promotions) {
    const patch = { selectors: p.selectors.map((s) => ({ ...s })), ...(p.fingerprint ? { fingerprint: structuredClone(p.fingerprint) } : {}) };
    switch (p.target.kind) {
      case 'item':
        if (out.item) out.item = { ...out.item, ...patch };
        break;
      case 'within':
        if (out.item) out.item = { ...out.item, within: patch.selectors, ...(patch.fingerprint ? { withinFingerprint: patch.fingerprint } : {}) };
        break;
      case 'field': {
        const field = out.fields[p.target.index];
        if (field) out.fields[p.target.index] = { ...field, ...patch };
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
  return out;
}
