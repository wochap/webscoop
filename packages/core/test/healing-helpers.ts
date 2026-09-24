import { dataset, render } from '@webscoop/playground';
import { annotate, descendantsOf, fingerprint, type AnnotatedNode, type Recipe } from '../src';
import { referenceRecipe } from './recorder-helpers';
import { snapshotFromHtml } from './snapshot';

export const catalogSnapshot = (tier: number, seed = 3) => snapshotFromHtml(render(dataset, { tier, seed }));

const first = (root: AnnotatedNode, test: (n: AnnotatedNode) => boolean): AnnotatedNode => descendantsOf(root).find(test)!;
const hasClass = (cls: string) => (n: AnnotatedNode) => (n.attrs.class ?? '').split(' ').includes(cls);

/** Nodes of the first product card on tier 0, by field name, plus the card and the heading. */
export function tier0Nodes(root: AnnotatedNode = annotate(catalogSnapshot(0))): Record<string, AnnotatedNode> {
  return {
    item: first(root, hasClass('product-card')),
    title: first(root, hasClass('product-title')),
    price: first(root, hasClass('product-price')),
    url: first(root, hasClass('product-link')),
    image: first(root, hasClass('product-image')),
    rating: first(root, hasClass('product-rating')),
    category: first(root, hasClass('category-heading')),
  };
}

/** The reference recipe with fingerprints for the item and every field, captured on tier 0 by the host. */
export function fingerprintedRecipe(): Recipe {
  const recipe = referenceRecipe();
  const nodes = tier0Nodes();
  return {
    ...recipe,
    item: { ...recipe.item!, fingerprint: fingerprint(nodes.item!) },
    fields: recipe.fields.map((f) => ({ ...f, fingerprint: fingerprint(nodes[f.name]!) })),
  };
}
