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
  /** Pagination controls rendered after the product list. Default none. */
  pager?: Pager | null;
  /** Put the product list behind an action. Default none. */
  gate?: Gate | null;
  /** Heading for the page. Default the first product's category, `Catalog` for none. */
  category?: string;
  /** Interleave dissimilar blocks, thumbnails on some cards, and an ad card. Default false. */
  mixed?: boolean;
  /** Group the cards N per `div.product-row` wrapper. Default none. */
  rows?: number | null;
}

export const GATE_KINDS = ['cookie', 'search', 'tabs'] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/**
 * What stands between the page load and the product list. `cookie` and `tabs`
 * keep the list in a `template` until a click clones it in, so nothing in it
 * resolves before the action; `search` renders a form above the list the
 * server already filtered by `query`.
 */
export type Gate =
  | { kind: 'cookie' }
  | { kind: 'tabs' }
  | {
      kind: 'search';
      /** Form action, the catalog path. */
      action: string;
      /** The submitted query, empty for none. */
      query: string;
      /** Other query parameters the form carries as hidden inputs, in order. */
      params: [name: string, value: string][];
    };

export const PAGINATE_KINDS = ['url', 'next', 'more', 'scroll'] as const;
export type PaginateKind = (typeof PAGINATE_KINDS)[number];

/** Pagination controls after the product list. */
export interface Pager {
  kind: PaginateKind;
  /** Numbered page links (`url` kind). */
  links?: { page: number; href: string; current: boolean }[];
  /** The `Next` link: its `href`, null for a disabled link, absent for none. */
  next?: string | null;
  /** Whether the `Next` link carries `rel="next"`. Default true. */
  rel?: boolean;
  /** What the `more` and `scroll` script fetches from `/catalog/more`. */
  more?: { after: number; total: number; tier: number; seed: number; disappear: boolean };
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
  /** Pagination controls; `catalogPage` renders them after the list. */
  pager: Pager | null;
  /** Gate around the list; `catalogPage` renders it, so tier churn renames its tokens too. */
  gate: Gate | null;
  category: string | undefined;
  /**
   * A `questions` block after every fourth card, a `product-thumb` image on
   * cards with an odd dataset index, and `mixed-ad` on the first card.
   */
  mixed: boolean;
  /** Cards per `div.product-row` wrapper, or null for a flat list. */
  rows: number | null;
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

function page(title: string, body: string, style = ''): string {
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
${style}</style>
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

/** How a catalog page's elements are spelled. Tiers 0 to 2 use `DEFAULT_MARKUP`. */
export interface Markup {
  cardTag: 'article' | 'div' | 'section';
  /** `div-heading` is a `div` with `role="heading"`. */
  titleTag: 'h2' | 'h3' | 'div-heading';
  priceTag: 'p' | 'span';
  /** Label rendered in a sibling `span` before the price, so the price element's own text stays the price. */
  priceLabel: '' | 'Cost:' | 'Now:';
  testidAttr: 'data-testid' | 'data-qa';
  /** Attribute carrying the rating's description. */
  ratingAttr: 'aria-label' | 'title';
  linkText: string;
  /** Whether cards have a rating element at all. */
  rating: boolean;
}

export const DEFAULT_MARKUP: Readonly<Markup> = Object.freeze({
  cardTag: 'article',
  titleTag: 'h2',
  priceTag: 'p',
  priceLabel: '',
  testidAttr: 'data-testid',
  ratingAttr: 'aria-label',
  linkText: 'View details',
  rating: true,
});

/** Position of a product in the full dataset, from its id (`p01` is 0). */
function datasetIndex(p: Product): number {
  return Number(p.id.replace(/\D/g, '')) - 1;
}

/** A block that shares the list with the cards but holds no product: a heading and three buttons. */
function questionsBlock(markup: Markup): string {
  const options = ['Which one ships fastest?', 'Is there a warranty?', 'Can I return it?'];
  return `<li class="product-item">
<${markup.cardTag} class="mixed-questions">
<h3 class="questions-title">People also ask</h3>
${options.map((o) => `<button class="questions-option" type="button">${o}</button>`).join('\n')}
</${markup.cardTag}>
</li>`;
}

/** The list's entries: cards, questions blocks after every fourth card when mixed, grouped in rows when asked. */
function listEntries(ctx: RenderContext, cards: readonly string[], markup: Markup): string {
  const groups: string[][] = [];
  cards.forEach((card, i) => {
    if (ctx.rows === null || i % ctx.rows === 0) groups.push([]);
    const group = groups.at(-1)!;
    group.push(card);
    if (ctx.mixed && (i + 1) % 4 === 0) group.push(questionsBlock(markup));
  });
  if (ctx.rows === null) return groups.flat().join('\n');
  return groups.map((g) => `<div class="product-row">\n${g.join('\n')}\n</div>`).join('\n');
}

function catalogPage(ctx: RenderContext, layout: Layout, markup: Markup = DEFAULT_MARKUP): string {
  const { products } = ctx;
  const category = ctx.category ?? products[0]?.category ?? 'Catalog';
  const testid = markup.testidAttr;
  const cards = layout.order
    .map((productIndex, position) => ({ p: products[productIndex]!, position, s: sponsoredAttrs(ctx, position) }))
    .map(({ p, position, s }) => {
      const [titleOpen, titleClose] =
        markup.titleTag === 'div-heading' ? ['div role="heading" aria-level="2"', 'div'] : [markup.titleTag, markup.titleTag];
      const title = `<${titleOpen.replace(/^(\w+)/, '$1 class="product-title"')}>${escapeHtml(p.title)}</${titleClose}>`;
      const label = markup.priceLabel ? `<span class="price-label">${markup.priceLabel}</span>\n` : '';
      const price = `${label}<${markup.priceTag} class="product-price" ${testid}="price">${formatPrice(p.price)}</${markup.priceTag}>`;
      const rating = markup.rating
        ? `\n<p class="product-rating" ${testid}="rating" ${markup.ratingAttr}="Rated ${p.rating} out of 5">${p.rating}</p>`
        : '';
      const thumb = ctx.mixed && datasetIndex(p) % 2 === 1 ? `<img class="product-thumb" src="${escapeHtml(p.image)}" alt="" width="48" height="48">\n` : '';
      const ad = ctx.mixed && position === 0 ? ' mixed-ad' : '';
      let content = `${thumb}<img class="product-image" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" width="220" height="140">
${layout.priceFirst(position) ? `${price}\n${title}` : `${title}\n${price}`}${rating}
<a class="product-link" href="${escapeHtml(p.url)}">${escapeHtml(markup.linkText)}</a>`;
      for (let depth = layout.wrappers(position) - 1; depth >= 0; depth--) {
        content = `<div class="${WRAPPER_CLASSES[depth % WRAPPER_CLASSES.length]}">\n${content}\n</div>`;
      }
      return `<li class="product-item">
<${markup.cardTag} class="product-card${s.cls}${ad}" id="product-${p.id}" ${testid}="product-card" data-product-id="${p.id}"${s.attrs}>
${content}
</${markup.cardTag}>
</li>`;
    });
  const list = `<ul class="product-list" ${testid}="product-list">
${listEntries(ctx, cards, markup)}
</ul>`;
  return page(
    `${category} | Playground`,
    `<main id="catalog" class="catalog">
<h1 class="category-heading" id="category" ${testid}="category">${escapeHtml(category)}</h1>
${ctx.gate ? gateHtml(ctx.gate, list) : list}${ctx.pager ? `\n${pagerHtml(ctx.pager)}` : ''}
</main>`,
    ctx.gate ? GATE_STYLES[ctx.gate.kind] : '',
  );
}

/** Class rules each gate adds to the page stylesheet; tier churn renames them with the markup. */
const GATE_STYLES: Record<GateKind, string> = {
  cookie: `.consent-backdrop { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; }
.consent-modal { background: #fff; padding: 2rem; max-width: 420px; border-radius: 8px; }
`,
  search: `.search-form { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
`,
  tabs: `.tab-list { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
.tab[aria-selected="true"] { font-weight: 700; }
`,
};

/**
 * The gate markup around the product list, with its script. Scripts find
 * elements by role, ARIA label, and structure, which tier churn leaves alone.
 */
function gateHtml(gate: Gate, list: string): string {
  if (gate.kind === 'search') {
    const hidden = gate.params.map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`);
    return `<form class="search-form" role="search" method="get" action="${escapeHtml(gate.action)}">
${hidden.map((h) => `${h}\n`).join('')}<label class="search-label">Search <input class="search-input" type="search" name="q" value="${escapeHtml(gate.query)}" placeholder="Search products"></label>
<button class="search-button" type="submit">Search</button>
</form>
${list}`;
  }
  if (gate.kind === 'cookie') {
    // The script runs while the page parses, so a stored consent never shows the modal.
    return `<template class="gated-list">
${list}
</template>
<div class="consent-backdrop" id="consent-backdrop">
<div class="consent-modal" role="dialog" aria-modal="true" aria-label="Consent preferences">
<p class="consent-title"><strong>We value your privacy</strong></p>
<p class="consent-text">Accept cookies to browse the catalog.</p>
<button class="consent-button btn-primary" id="consent-accept" type="button">Accept all</button>
</div>
</div>
<script>
(function () {
  var dialog = document.querySelector('[role="dialog"][aria-label="Consent preferences"]');
  var template = document.querySelector('main template');
  function reveal() {
    dialog.parentElement.remove();
    template.replaceWith(template.content.cloneNode(true));
  }
  if (localStorage.getItem('ws_consent') === '1') return reveal();
  dialog.querySelector('button').addEventListener('click', function () {
    localStorage.setItem('ws_consent', '1');
    reveal();
  });
})();
</script>`;
  }
  // Tabs: nothing persists, so every load starts on About with the list in its template.
  return `<div class="tabs">
<div class="tab-list" role="tablist" aria-label="Catalog sections">
<button class="tab" id="tab-about" type="button" role="tab" aria-selected="true">About</button>
<button class="tab" id="tab-products" type="button" role="tab" aria-selected="false">Products</button>
</div>
<div class="tab-panel" id="panel-about" role="tabpanel" aria-label="About">
<p class="about-text">Everything on this shelf ships in two days. Open the Products tab to browse it.</p>
</div>
<div class="tab-panel" id="panel-products" role="tabpanel" aria-label="Products" hidden>
<template class="gated-list">
${list}
</template>
</div>
</div>
<script>
(function () {
  var tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
  var panels = document.querySelectorAll('[role="tabpanel"]');
  Array.prototype.forEach.call(tabs, function (tab, i) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(tabs, function (other, j) {
        other.setAttribute('aria-selected', String(i === j));
        panels[j].hidden = i !== j;
      });
      var template = panels[i].querySelector('template');
      if (template) template.replaceWith(template.content.cloneNode(true));
    });
  });
})();
</script>`;
}

/**
 * Runs in the page for `more` and `scroll`: appends the next cards from
 * `/catalog/more`. It finds elements by attributes tier churn leaves alone.
 */
function pagerScript(kind: 'more' | 'scroll', more: NonNullable<Pager['more']>): string {
  return `<script>
(function () {
  var cfg = ${JSON.stringify({ kind, ...more })};
  var busy = false;
  function load(done) {
    // Looked up per load: behind a gate the list only exists once the gate is passed.
    var list = document.querySelector('main ul');
    if (!list || busy || cfg.after >= cfg.total) return;
    busy = true;
    fetch('/catalog/more?after=' + cfg.after + '&tier=' + cfg.tier + '&seed=' + cfg.seed)
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (html) {
        list.insertAdjacentHTML('beforeend', html);
        cfg.after = Math.min(cfg.total, cfg.after + 8);
        busy = false;
        if (done) done();
      });
  }
  if (cfg.kind === 'more') {
    var button = document.querySelector('button[data-more]');
    button.addEventListener('click', function () {
      load(function () {
        if (cfg.disappear || cfg.after >= cfg.total) button.remove();
      });
    });
  } else {
    // Without scroll anchoring, appending cards never scrolls by itself, so one scroll loads one batch.
    document.documentElement.style.overflowAnchor = 'none';
    window.addEventListener('scroll', function () {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40) load();
    });
  }
})();
</script>`;
}

export function pagerHtml(pager: Pager): string {
  if (pager.kind === 'more' || pager.kind === 'scroll') {
    const more = pager.more ?? { after: 8, total: 24, tier: 0, seed: 1, disappear: false };
    const control =
      pager.kind === 'more'
        ? `<div class="pager">\n<button class="load-more" type="button" data-more="true">Load more</button>\n</div>`
        : // Keeps the document taller than the window, so scrolling to the bottom always scrolls.
          `<div class="scroll-spacer" style="height: 120vh" aria-hidden="true"></div>`;
    return `${control}\n${pagerScript(pager.kind, more)}`;
  }
  const links = (pager.links ?? []).map(
    (l) => `<a class="pager-link${l.current ? ' current' : ''}" href="${escapeHtml(l.href)}"${l.current ? ' aria-current="page"' : ''}>${l.page}</a>`,
  );
  if (pager.next !== undefined) {
    const rel = pager.rel === false ? '' : ' rel="next"';
    links.push(
      pager.next === null
        ? `<a class="pager-next" aria-disabled="true">Next</a>`
        : `<a class="pager-next" href="${escapeHtml(pager.next)}"${rel}>Next</a>`,
    );
  }
  return `<nav class="pager" aria-label="Pagination">\n${links.join('\n')}\n</nav>`;
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

/** Tier 2's structural churn, drawn from the rng: wrappers, price position, card order. */
function churnedLayout(ctx: RenderContext): Layout {
  const count = ctx.products.length;
  const wrappers = Array.from({ length: count }, () => 1 + Math.floor(ctx.rng() * 2));
  const priceFirst = Array.from({ length: count }, () => ctx.rng() < 0.5);
  const order = shuffled(count, ctx.rng);
  return { wrappers: (i) => wrappers[i]!, priceFirst: (i) => priceFirst[i]!, order };
}

/**
 * Tier 2: tier 1 plus structural churn. Each card's content sits in one or
 * two extra `div` wrappers, the price moves above or below the title, and the
 * cards are shuffled, all by seed. Every card keeps its own content.
 */
const tier2: TierRenderer = (ctx) => churnTokens(catalogPage(ctx, churnedLayout(ctx)), ctx);

const choose = <T>(rng: () => number, options: readonly T[]): T => options[Math.floor(rng() * options.length)]!;

/** Tier 3's semantic churn, one choice per page drawn from the rng. */
function semanticMarkup(ctx: RenderContext): Markup {
  return {
    cardTag: choose(ctx.rng, ['div', 'section'] as const),
    titleTag: choose(ctx.rng, ['h3', 'div-heading'] as const),
    priceTag: 'span',
    priceLabel: choose(ctx.rng, ['Cost:', 'Now:'] as const),
    testidAttr: 'data-qa',
    ratingAttr: 'title',
    linkText: 'See product',
    rating: true,
  };
}

/**
 * Tier 3: tier 2 plus semantic churn. Cards become `div` or `section`, the
 * title an `h3` or a `div` with `role="heading"`, the price a `span` after a
 * `Cost:` or `Now:` label, `data-testid` becomes `data-qa`, the rating is
 * described by `title` instead of `aria-label`, and the link reads "See
 * product". Every value stays extractable.
 */
const tier3: TierRenderer = (ctx) => {
  const layout = churnedLayout(ctx);
  return churnTokens(catalogPage(ctx, layout, semanticMarkup(ctx)), ctx);
};

/** Tier 4: tier 3 with the rating element removed from every card. */
const tier4: TierRenderer = (ctx) => {
  const layout = churnedLayout(ctx);
  return churnTokens(catalogPage(ctx, layout, { ...semanticMarkup(ctx), rating: false }), ctx);
};

/** Tier registry. */
export const tiers: Partial<Record<number, TierRenderer>> = {
  0: tier0,
  1: tier1,
  2: tier2,
  3: tier3,
  4: tier4,
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
    pager: opts.pager ?? null,
    gate: opts.gate ?? null,
    category: opts.category,
    mixed: opts.mixed ?? false,
    rows: opts.rows ?? null,
  };
  return applyChrome(renderer(ctx), ctx.chrome);
}

/** Results per group wrapper on the results page. */
export const RESULTS_PER_GROUP = 4;

/**
 * A search results page shaped like Google's: the results sit under
 * `div#rso`, a list parent with a stable `id` but a hashed class, nested in
 * wrappers with hashed classes below an anchored `div.main`. Each result is a
 * plain `div` with hashed classes, two levels below `div#rso` in group
 * wrappers of `RESULTS_PER_GROUP`, and one dissimilar "People also ask" block
 * sits among them at the same depth.
 */
export function renderResults(products: readonly Product[], query = 'electronics'): string {
  const result = (p: Product) => `<div class="Mjj4Yd">
<div class="yuRUbf"><a href="${escapeHtml(p.url)}"><h3 class="LC20lb">${escapeHtml(p.title)}</h3></a></div>
<div class="VwiC3b"><span>${escapeHtml(p.category)} · ${formatPrice(p.price)} · rated ${p.rating} out of 5</span></div>
</div>`;
  const questions = `<div class="hlcw0c">
<div class="Wt5Tfe">
<div class="kno2x"><span>People also ask</span></div>
${['Which one ships fastest?', 'Is there a warranty?', 'Can I return it?'].map((q) => `<div class="related9q"><span>${q}</span></div>`).join('\n')}
</div>
</div>`;
  const groups: string[] = [];
  for (let i = 0; i < products.length; i += RESULTS_PER_GROUP) {
    groups.push(`<div class="hlcw0c">\n${products.slice(i, i + RESULTS_PER_GROUP).map(result).join('\n')}\n</div>`);
    if (i === 0) groups.push(questions);
  }
  return page(
    `${query} - Search | Playground`,
    `<div class="searchform" id="searchform"><form role="search" action="/results"><input class="gLFyf" type="search" name="q" value="${escapeHtml(query)}"></form></div>
<div class="main" id="main">
<div class="GyAeWb">
<div class="s6JM6d" id="center_col">
<div class="dURPMd" id="rso">
${groups.join('\n')}
</div>
</div>
</div>
</div>`,
  );
}

/**
 * The product cards alone (the `<li>` elements of the list), rendered as
 * `render` renders them with the same tier and seed, so class and id tokens
 * match the page they are appended to.
 */
export function renderCards(products: readonly Product[], opts: Pick<RenderOptions, 'tier' | 'seed'>): string {
  if (products.length === 0) return '';
  const html = render(products, { tier: opts.tier, seed: opts.seed });
  const open = html.indexOf('>', html.indexOf('<ul ')) + 1;
  return `${html.slice(open, html.lastIndexOf('</ul>')).trim()}\n`;
}
