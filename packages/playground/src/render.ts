import type { Product } from './dataset';
import { createRng } from './prng';

export interface RenderContext {
  products: readonly Product[];
  seed: number;
  /** Seeded PRNG; any randomized mutation must draw from it. */
  rng: () => number;
}

export type TierRenderer = (ctx: RenderContext) => string;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatPrice(price: number): string {
  return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; }
.product-list { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
.product-card { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; }
.product-image { width: 100%; height: auto; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** Tier 0: stable markup with ids, `data-testid` attributes, semantic roles, readable classes. */
const tier0: TierRenderer = ({ products }) => {
  const category = products[0]?.category ?? 'Catalog';
  const items = products
    .map(
      (p) => `<li class="product-item">
<article class="product-card" id="product-${p.id}" data-testid="product-card" data-product-id="${p.id}">
<img class="product-image" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" width="220" height="140">
<h2 class="product-title">${escapeHtml(p.title)}</h2>
<p class="product-price" data-testid="price">${formatPrice(p.price)}</p>
<p class="product-rating" data-testid="rating" aria-label="Rated ${p.rating} out of 5">${p.rating}</p>
<a class="product-link" href="${escapeHtml(p.url)}">View details</a>
</article>
</li>`,
    )
    .join('\n');
  return page(
    `${category} | Playground`,
    `<main id="catalog" class="catalog">
<h1 class="category-heading" id="category" data-testid="category">${escapeHtml(category)}</h1>
<ul class="product-list" data-testid="product-list">
${items}
</ul>
</main>`,
  );
};

/** Tier registry. Tiers 1 to 4 arrive with later changes. */
export const tiers: Partial<Record<number, TierRenderer>> = {
  0: tier0,
};

export const MAX_TIER = 4;

export class UnimplementedTierError extends Error {
  constructor(readonly tier: number) {
    super(`tier ${tier} is not implemented yet`);
    this.name = 'UnimplementedTierError';
  }
}

export function render(products: readonly Product[], opts: { tier: number; seed: number }): string {
  const renderer = tiers[opts.tier];
  if (!renderer) throw new UnimplementedTierError(opts.tier);
  return renderer({ products, seed: opts.seed, rng: createRng(opts.seed) });
}
