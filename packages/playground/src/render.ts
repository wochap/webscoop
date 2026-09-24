import type { Product } from './dataset';
import { createRng } from './prng';

export const CHROME_MODES = ['hostile'] as const;
export type ChromeMode = (typeof CHROME_MODES)[number];

export interface RenderOptions {
  tier: number;
  seed: number;
  /** Wrap the page in adversarial chrome. Default none. */
  chrome?: ChromeMode | null;
  /** Mark the first N product cards as sponsored. Default 0. */
  sponsored?: number;
}

export interface RenderContext {
  products: readonly Product[];
  seed: number;
  /** Seeded PRNG; any randomized mutation must draw from it. */
  rng: () => number;
  /** Number of leading products to mark sponsored; every tier honours it through `sponsoredAttrs`. */
  sponsored: number;
  /** Page chrome mode; applied by `render` around the tier output. */
  chrome: ChromeMode | null;
}

/** Class and attribute markup for a sponsored card, empty for a regular one. */
export function sponsoredAttrs(ctx: RenderContext, index: number): { cls: string; attrs: string } {
  return index < ctx.sponsored ? { cls: ' sponsored', attrs: ' data-sponsored="true"' } : { cls: '', attrs: '' };
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
const tier0: TierRenderer = (ctx) => {
  const { products } = ctx;
  const category = products[0]?.category ?? 'Catalog';
  const items = products
    .map((p, i) => ({ p, s: sponsoredAttrs(ctx, i) }))
    .map(
      ({ p, s }) => `<li class="product-item">
<article class="product-card${s.cls}" id="product-${p.id}" data-testid="product-card" data-product-id="${p.id}"${s.attrs}>
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

const HOSTILE_STYLE = `<style id="hostile-style">
html, body { background: #fbf7ee !important; color: #1d1d1d !important; font-family: Georgia, "Times New Roman", serif !important; font-size: 18px !important; }
body { padding-top: 104px !important; }
h1, h2, h3, h4 { font-family: "Times New Roman", serif !important; color: #5a0f0f !important; letter-spacing: 0.04em !important; text-transform: uppercase !important; }
a, a:visited { color: #c00 !important; text-decoration: underline wavy !important; font-weight: 700 !important; }
button { font: italic 700 20px/1 Georgia, serif !important; background: #ffd400 !important; color: #000 !important; border: 3px solid #000 !important; border-radius: 0 !important; padding: 10px 18px !important; }
div, span, p { line-height: 2 !important; }
* { box-sizing: content-box !important; }
#hostile-header { position: fixed; top: 0; left: 0; width: 100vw; height: 64px; z-index: 99; background: #fff; border-bottom: 2px solid #5a0f0f; display: flex; align-items: center; padding: 0 24px; }
#promo-bar { position: fixed; top: 66px; left: 0; width: 100vw; height: 32px; z-index: 98; background: #ffd400; text-align: center; font-weight: 700; }
#cookie-backdrop { position: fixed; inset: 0; z-index: 2147483000; background: rgba(20, 10, 0, 0.55); display: flex; align-items: center; justify-content: center; }
#cookie-modal { background: #fff; padding: 32px; max-width: 420px; box-shadow: 0 10px 40px rgba(0,0,0,.4); }
</style>`;

const HOSTILE_BODY = `<header id="hostile-header" data-hostile="header"><strong>MEGA SHOP</strong>&nbsp;<nav><a href="/catalog">Home</a> <a href="/catalog">Deals</a></nav></header>
<div id="promo-bar" data-hostile="promo">FREE SHIPPING ON EVERYTHING TODAY ONLY</div>
<div id="cookie-backdrop" data-hostile="cookie-backdrop"><div id="cookie-modal" role="dialog" aria-label="Cookie consent"><h2>We value your privacy</h2><p>We use cookies to improve your experience.</p><button id="cookie-accept" type="button">Accept all</button></div></div>
<script id="hostile-script">
window.__hostClicks = [];
document.addEventListener('click', function (e) {
  var t = e.target;
  window.__hostClicks.push({ tag: t && t.tagName ? t.tagName.toLowerCase() : '', id: (t && t.id) || '', at: Date.now() });
}, true);
document.getElementById('cookie-accept').addEventListener('click', function () {
  document.getElementById('cookie-backdrop').remove();
});
</script>`;

/** Wrap a rendered page in the chosen chrome. */
function applyChrome(html: string, chrome: ChromeMode | null): string {
  if (chrome !== 'hostile') return html;
  return html.replace('</head>', `${HOSTILE_STYLE}\n</head>`).replace('<body>', `<body>\n${HOSTILE_BODY}`);
}

export function render(products: readonly Product[], opts: RenderOptions): string {
  const renderer = tiers[opts.tier];
  if (!renderer) throw new UnimplementedTierError(opts.tier);
  const ctx: RenderContext = {
    products,
    seed: opts.seed,
    rng: createRng(opts.seed),
    sponsored: Math.max(0, opts.sponsored ?? 0),
    chrome: opts.chrome ?? null,
  };
  return applyChrome(renderer(ctx), ctx.chrome);
}
