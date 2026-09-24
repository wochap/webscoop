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

/** How a catalog page varies from tier 0. */
interface Layout {
  /** Extra `div` wrappers around a card's content (0 for tier 0). */
  wrappers(index: number): number;
  /** Whether the price comes before the title. */
  priceFirst(index: number): boolean;
  /** Display order of the products, as dataset indices. */
  order: readonly number[];
}

const TIER0_LAYOUT = (count: number): Layout => ({
  wrappers: () => 0,
  priceFirst: () => false,
  order: Array.from({ length: count }, (_, i) => i),
});

const WRAPPER_CLASSES = ['card-body', 'card-inner'];

function catalogPage(ctx: RenderContext, layout: Layout): string {
  const { products } = ctx;
  const category = products[0]?.category ?? 'Catalog';
  const items = layout.order
    .map((productIndex, position) => ({ p: products[productIndex]!, position, s: sponsoredAttrs(ctx, position) }))
    .map(({ p, position, s }) => {
      const title = `<h2 class="product-title">${escapeHtml(p.title)}</h2>`;
      const price = `<p class="product-price" data-testid="price">${formatPrice(p.price)}</p>`;
      let content = `<img class="product-image" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" width="220" height="140">
${layout.priceFirst(position) ? `${price}\n${title}` : `${title}\n${price}`}
<p class="product-rating" data-testid="rating" aria-label="Rated ${p.rating} out of 5">${p.rating}</p>
<a class="product-link" href="${escapeHtml(p.url)}">View details</a>`;
      for (let depth = layout.wrappers(position) - 1; depth >= 0; depth--) {
        content = `<div class="${WRAPPER_CLASSES[depth % WRAPPER_CLASSES.length]}">\n${content}\n</div>`;
      }
      return `<li class="product-item">
<article class="product-card${s.cls}" id="product-${p.id}" data-testid="product-card" data-product-id="${p.id}"${s.attrs}>
${content}
</article>
</li>`;
    })
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
}

/** Tier 0: stable markup with ids, `data-testid` attributes, semantic roles, readable classes. */
const tier0: TierRenderer = (ctx) => catalogPage(ctx, TIER0_LAYOUT(ctx.products.length));

function stringHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Replace every class name and every `id` and `data-testid` value with a
 * hash-like token: `x` plus 6 base36 characters, one of them a digit, stable
 * for a token within a seed. Class selectors in the page's own stylesheet are
 * renamed too, so the layout does not change.
 */
function churnTokens(html: string, ctx: RenderContext): string {
  const salt = Math.floor(ctx.rng() * 0x100000000);
  const tokens = new Map<string, string>();
  const used = new Set<string>();
  const tokenFor = (original: string): string => {
    let token = tokens.get(original);
    if (token) return token;
    for (let attempt = 0; !token || used.has(token); attempt++) {
      const next = createRng((salt ^ stringHash(`${original}#${attempt}`)) >>> 0);
      const chars = Array.from({ length: 6 }, () => Math.floor(next() * 36).toString(36));
      chars[1] = String(Math.floor(next() * 10));
      token = `x${chars.join('')}`;
    }
    used.add(token);
    tokens.set(original, token);
    return token;
  };
  const body = html.replace(/\s(class|id|data-testid)="([^"]*)"/g, (_, name: string, value: string) => {
    const mapped = name === 'class' ? value.split(/\s+/).filter(Boolean).map(tokenFor).join(' ') : tokenFor(value);
    return ` ${name}="${mapped}"`;
  });
  return body.replace(/(<style>)([\s\S]*?)(<\/style>)/, (_, open: string, css: string, close: string) => {
    return open + css.replace(/\.([A-Za-z][\w-]*)/g, (match, cls: string) => (tokens.has(cls) ? `.${tokens.get(cls)!}` : match)) + close;
  });
}

/** Tier 1: tier 0 with hashed class names and renamed ids and test ids; roles, text, and nesting unchanged. */
const tier1: TierRenderer = (ctx) => churnTokens(tier0(ctx), ctx);

/** Seeded Fisher-Yates shuffle of `0..n-1`. */
function shuffled(n: number, rng: () => number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Tier 2: tier 1 plus structural churn. Each card's content sits in one or
 * two extra `div` wrappers, the price moves above or below the title, and the
 * cards are shuffled, all by seed. Every card keeps its own content.
 */
const tier2: TierRenderer = (ctx) => {
  const count = ctx.products.length;
  const wrappers = Array.from({ length: count }, () => 1 + Math.floor(ctx.rng() * 2));
  const priceFirst = Array.from({ length: count }, () => ctx.rng() < 0.5);
  const order = shuffled(count, ctx.rng);
  const layout: Layout = { wrappers: (i) => wrappers[i]!, priceFirst: (i) => priceFirst[i]!, order };
  return churnTokens(catalogPage(ctx, layout), ctx);
};

/** Tier registry. Tiers 3 and 4 arrive with later changes. */
export const tiers: Partial<Record<number, TierRenderer>> = {
  0: tier0,
  1: tier1,
  2: tier2,
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
