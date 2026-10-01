import { roleOf } from './dom';
import { SANS, MONO } from './fonts';
import { DIM, LEVEL_COLORS, MAX_DIM_CONTAINERS, MUTED_OUTLINE, WARN } from './levels';

export type BoxVariant =
  | 'hover'
  | 'selected'
  | 'sibling'
  | 'container'
  | 'excluded'
  | 'list'
  | 'blocked'
  | 'match'
  | 'list-parent'
  | 'item'
  | 'other-list'
  | 'start'
  | 'dim'
  /** A transparent cover over a cross-origin iframe while picking, so the top page gets its pointer events. */
  | 'shield';

/** The hover walk parts of the tag: steps above the start element, similar siblings at the target's level, the target's size. */
export interface HoverWalkInfo {
  start: Element;
  depth: number;
  similar: number;
  size: { w: number; h: number };
}

/** Key hints of the pick strip. */
export const STRIP_HINTS: readonly [string, string][] = [
  ['↑ ↓', 'parent / child'],
  ['click', 'to pick'],
  ['Alt+click', 'through overlays'],
  ['Esc', 'cancel'],
];

/** Where the hovered element sits while picking in a list table. */
export type HoverPlace = { kind: 'item'; index: number; of: number } | { kind: 'outside'; table: string };

/** What to outline while picking in a list table: the active list parent and containers, and other lists' containers. */
export interface ListOutlines {
  /** Name of the active list table, for its label. */
  table?: string;
  parent: Element | null;
  items: readonly Element[];
  others: readonly { table: string; items: readonly Element[] }[];
}

/** Width of the panel docked at the right of the page; the page is pushed left by it. */
export const PANEL_WIDTH = 400;

export const OVERLAY_CSS = `
:host { all: initial; }
#ws-overlay { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; contain: strict; }
.ws-box { position: fixed; box-sizing: border-box; border-radius: 3px; pointer-events: none; }
.ws-box-hover { border: 2px solid #9184d9; background: rgba(145, 132, 217, 0.16); }
.ws-box-selected { border: 2px solid #b5abfc; background: rgba(145, 132, 217, 0.12); }
.ws-box-sibling { border: 1px dashed #9184d9; background: rgba(145, 132, 217, 0.13); border-radius: 5px; }
.ws-box-container { border: 1px dashed #c9ccd9; border-radius: 5px; }
.ws-box-excluded { border: 1px dashed #f0a9a9; background: rgba(240, 169, 169, 0.10); border-radius: 5px; }
.ws-box-list { outline: 2px dotted #e6c98f; outline-offset: 3px; border-radius: 6px; }
.ws-box-blocked { border: 2px dashed #f0a9a9; background: rgba(240, 169, 169, 0.08); }
.ws-box-match { border: 1px solid #9fdcbc; background: rgba(159, 220, 188, 0.12); }
.ws-box-shield { pointer-events: auto; background: transparent; }
.ws-box-list-parent { border: 2px solid ${LEVEL_COLORS.list}; border-radius: 6px; }
.ws-box-item { border: 1.5px dashed ${LEVEL_COLORS.item}; border-radius: 5px; }
.ws-box-other-list { border: 1px dashed ${MUTED_OUTLINE}; border-radius: 5px; }
.ws-list-label { position: absolute; top: -16px; right: -1px; padding: 0 5px; border-radius: 3px 3px 0 0; background: ${MUTED_OUTLINE}; color: #161826; font: 500 9.5px/15px '${MONO}', ui-monospace, monospace; white-space: nowrap; }
.ws-box-list-parent .ws-list-label { background: ${LEVEL_COLORS.item}; }
.ws-box-dim { inset: 0; background: ${DIM}; border-radius: 0; }
.ws-box-hover.ws-outside { border-color: ${WARN}; background: rgba(230, 201, 143, 0.12); }
.ws-halo-dark.ws-box-hover, .ws-halo-dark.ws-box-sibling { box-shadow: 0 0 0 1px rgba(14, 15, 24, 0.9), inset 0 0 0 1px rgba(14, 15, 24, 0.6); }
.ws-halo-light.ws-box-hover, .ws-halo-light.ws-box-sibling { box-shadow: 0 0 0 1px rgba(243, 245, 254, 0.95), inset 0 0 0 1px rgba(243, 245, 254, 0.7); }
.ws-halo-dark.ws-box-selected { box-shadow: 0 0 0 1px rgba(14, 15, 24, 0.9), 0 0 0 4px rgba(181, 171, 252, 0.25); }
.ws-halo-light.ws-box-selected { box-shadow: 0 0 0 1px rgba(243, 245, 254, 0.95), 0 0 0 4px rgba(145, 132, 217, 0.3); }
.ws-halo-dark.ws-box-container, .ws-halo-dark.ws-box-excluded { box-shadow: 0 0 0 1px rgba(14, 15, 24, 0.8); }
.ws-halo-light.ws-box-container, .ws-halo-light.ws-box-excluded { box-shadow: 0 0 0 1px rgba(243, 245, 254, 0.9); }
.ws-index { position: absolute; top: -1px; left: -1px; padding: 0 4px; border-radius: 3px 0 3px 0; background: #9184d9; color: #161826; font: 500 9px/13px '${MONO}', ui-monospace, monospace; }
.ws-tag { position: fixed; padding: 2px 6px; border-radius: 4px; background: #161826; color: #e9e9ed; font: 500 10px/14px '${MONO}', ui-monospace, monospace; box-shadow: 0 0 0 1px #9184d9; white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
.ws-tag b { color: #b5abfc; font-weight: 500; }
.ws-tag i { color: #b2b6ca; font-style: normal; font-family: '${SANS}', system-ui, sans-serif; }
.ws-tag em { color: ${WARN}; font-style: normal; }
.ws-tag em.ws-in-item { color: ${LEVEL_COLORS.item}; }
.ws-tag em.ws-likely { color: #9fdcbc; }
.ws-tag em.ws-refused { color: #f0a9a9; }
.ws-tag em.ws-walk { padding: 0 3px; border-radius: 2px; background: #423a6a; color: #d2cefd; }
.ws-tag span.ws-similar { color: #9fdcbc; }
.ws-tag span.ws-size { color: #7e8298; }
.ws-box-start { border: 1px dashed #b2b6ca; border-radius: 3px; }
.ws-box-start .ws-list-label { top: 50%; right: auto; left: 100%; margin-left: 6px; transform: translateY(-50%); border-radius: 3px; background: #161826; color: #b5abfc; box-shadow: 0 0 0 1px #796cbf; }
.ws-strip { position: fixed; left: calc((100% - ${PANEL_WIDTH}px) / 2); bottom: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-radius: 8px; background: #161826; color: #e9e9ed; box-shadow: 0 0 0 1px #3a3d55, 0 8px 24px rgba(0, 0, 0, 0.35); font: 500 11px/16px '${SANS}', system-ui, sans-serif; white-space: nowrap; pointer-events: none; }
.ws-strip b { display: inline-flex; align-items: center; gap: 6px; color: #e9e9ed; font-weight: 500; }
.ws-strip b::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #9184d9; }
.ws-strip span { color: #b2b6ca; }
.ws-strip kbd { display: inline-block; margin-right: 4px; padding: 0 4px; border-radius: 3px; background: #2a2d40; color: #e9e9ed; font: 500 10px/14px '${MONO}', ui-monospace, monospace; }
`;

/** Relative luminance of an `rgb()`/`rgba()` color, or null when transparent or unparsable. */
export function luminance(color: string): number | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(color);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  if (alpha < 0.5) return null;
  const lin = (v: string) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(m[1]!) + 0.7152 * lin(m[2]!) + 0.0722 * lin(m[3]!);
}

/** Whether the host background behind an element is bright, sampled up the ancestor chain. */
export function isLightHost(el: Element): boolean {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const value = luminance(getComputedStyle(cur).backgroundColor);
    if (value !== null) return value > 0.4;
  }
  // Browsers paint an unstyled canvas white.
  return true;
}

interface Tracked {
  /** The element the box follows; the page root for the dim. */
  el: Element;
  box: HTMLDivElement;
  variant: BoxVariant;
  light: boolean;
}

/** A viewport box in the top page's coordinates. */
export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

/**
 * The element's box in the top page's viewport: `getBoundingClientRect`
 * plus the content-box offset of each iframe it sits in.
 */
export function pageRect(el: Element): PageRect {
  const r = el.getBoundingClientRect();
  let left = r.left;
  let top = r.top;
  for (let win: Window | null = el.ownerDocument.defaultView; win && win.parent !== win; win = win.parent) {
    let frame: Element | null;
    try {
      frame = win.frameElement;
    } catch {
      break;
    }
    if (!frame) break;
    const f = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView!.getComputedStyle(frame);
    left += f.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0);
    top += f.top + frame.clientTop + (parseFloat(style.paddingTop) || 0);
  }
  return { left, top, width: r.width, height: r.height, right: left + r.width, bottom: top + r.height };
}

/**
 * Imperative highlight layer: plain elements positioned from
 * `getBoundingClientRect` (offset by the iframes an element sits in),
 * updated at most once per animation frame.
 */
export class Overlay {
  private hover: Tracked | null = null;
  /** The element under the pointer while the hover target is walked up. */
  private start: Tracked | null = null;
  private strip: HTMLDivElement | null = null;
  private selected: Tracked | null = null;
  private list: Tracked | null = null;
  private groups: Tracked[] = [];
  private matches: Tracked[] = [];
  private outlines: Tracked[] = [];
  private dim: Tracked | null = null;
  private shields: Tracked[] = [];
  /** Containers cut out of the dim. */
  private holes: Element[] = [];
  private readonly tag: HTMLDivElement;
  private tagText = '';
  private frame = 0;
  private readonly onViewport = () => this.schedule();

  constructor(private readonly layer: HTMLElement) {
    this.tag = layer.ownerDocument.createElement('div');
    this.tag.className = 'ws-tag';
    this.tag.style.display = 'none';
    layer.appendChild(this.tag);
    const win = layer.ownerDocument.defaultView!;
    win.addEventListener('scroll', this.onViewport, { capture: true, passive: true });
    win.addEventListener('resize', this.onViewport, { passive: true });
  }

  /** Reposition boxes when an iframe's window scrolls or resizes too. Returns an unsubscribe function. */
  watch(win: Window): () => void {
    win.addEventListener('scroll', this.onViewport, { capture: true, passive: true });
    win.addEventListener('resize', this.onViewport, { passive: true });
    this.schedule();
    return () => {
      win.removeEventListener('scroll', this.onViewport, { capture: true });
      win.removeEventListener('resize', this.onViewport);
    };
  }

  /** Cover these iframes (cross-origin ones while picking) so pointer events over them reach the top page; empty removes the covers. */
  setShields(frames: readonly Element[]): void {
    if (frames.length === this.shields.length && frames.every((el, i) => this.shields[i]!.el === el)) return;
    for (const t of this.shields) t.box.remove();
    this.shields = frames.map((el) => this.make(el, 'shield'));
    this.schedule();
  }

  /** The covered iframe under a point of the top viewport, or null. */
  shieldAt(x: number, y: number): Element | null {
    for (const t of this.shields) {
      const r = pageRect(t.el);
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return t.el;
    }
    return null;
  }

  /** Remove every box and stop listening to the page. */
  dispose(): void {
    this.clear();
    this.setShields([]);
    const win = this.layer.ownerDocument.defaultView!;
    win.removeEventListener('scroll', this.onViewport, { capture: true });
    win.removeEventListener('resize', this.onViewport);
    if (this.frame) win.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private make(el: Element, variant: BoxVariant, index?: number): Tracked {
    const box = this.layer.ownerDocument.createElement('div');
    const light = isLightHost(el);
    box.className = `ws-box ws-box-${variant} ${light ? 'ws-halo-light' : 'ws-halo-dark'}`;
    box.dataset.variant = variant;
    if (index !== undefined) {
      const label = this.layer.ownerDocument.createElement('span');
      label.className = 'ws-index';
      label.textContent = String(index + 1);
      box.appendChild(label);
    }
    this.layer.appendChild(box);
    return { el, box, variant, light };
  }

  private drop(t: Tracked | null): void {
    t?.box.remove();
  }

  /**
   * Hover highlight with its tag, or null to clear. A score (while
   * re-picking) is appended to the tag; a refusal reason (while picking a
   * list level) marks the element as not selectable.
   */
  setHover(el: Element | null, text = '', score?: { value: number; likely: boolean }, refused?: string, place?: HoverPlace, walk?: HoverWalkInfo): void {
    const placeKey = place ? (place.kind === 'item' ? `item:${place.index}/${place.of}` : `outside:${place.table}`) : '';
    const key = `${placeKey}|${walk ? `${walk.depth}/${walk.similar}/${walk.size.w}x${walk.size.h}` : ''}|${refused ?? ''}|${score ? score.value : ''}`;
    const startEl = el && walk && walk.depth > 0 ? walk.start : null;
    if (this.hover?.el === el && this.hover.variant === (refused ? 'blocked' : 'hover') && this.hoverKey === key && (this.start?.el ?? null) === startEl) return;
    this.drop(this.hover);
    this.drop(this.start);
    this.hoverKey = key;
    this.hover = el ? this.make(el, refused ? 'blocked' : 'hover') : null;
    this.start = null;
    if (startEl) {
      this.start = this.make(startEl, 'start');
      this.label(this.start, `${startEl.tagName.toLowerCase()} · start`);
    }
    if (this.hover && place?.kind === 'outside') this.hover.box.classList.add('ws-outside');
    if (el) {
      const role = roleOf(el);
      const tag = el.tagName.toLowerCase();
      const suffix = refused
        ? ` <em class="ws-refused">${escape(refused)}</em>`
        : score
          ? ` <em class="ws-score${score.likely ? ' ws-likely' : ''}">${score.value.toFixed(2)}${score.likely ? ' likely' : ''}</em>`
          : place?.kind === 'item'
            ? ` <em class="ws-in-item">item ${place.index + 1} of ${place.of}</em>`
            : place?.kind === 'outside'
              ? ` <em class="ws-outside">outside ${escape(place.table)} list</em>`
              : '';
      const walked = walk
        ? `${walk.depth > 0 ? ` <em class="ws-walk">↑${walk.depth}</em>` : ''}${walk.similar >= 2 ? ` <span class="ws-similar">${walk.similar} similar siblings</span>` : ''}${
            walk.depth > 0 ? ` <span class="ws-size">${walk.size.w}×${walk.size.h}</span>` : ''
          }`
        : '';
      this.tagText = `<b>${escape(tag)}</b>${role ? ` ${escape(role)}` : ''}${text ? ` <i>${escape(text)}</i>` : ''}${walked}${suffix}`;
    }
    this.schedule();
  }

  private hoverKey = '';

  /**
   * While picking in a list table: the list parent and each container in
   * their level colors, other lists' containers muted with a label, and a
   * light dim over the rest of the page (skipped for very many containers).
   * Null clears them.
   */
  setOutlines(lists: ListOutlines | null): void {
    const same =
      lists !== null &&
      this.outlines.length === (lists.parent ? 1 : 0) + lists.items.length + lists.others.reduce((n, o) => n + o.items.length, 0) &&
      [...(lists.parent ? [lists.parent] : []), ...lists.items, ...lists.others.flatMap((o) => o.items)].every((el, i) => this.outlines[i]!.el === el);
    if (same && Boolean(this.dim) === lists.items.length <= MAX_DIM_CONTAINERS && lists.items.length > 0) return;
    for (const t of this.outlines) t.box.remove();
    this.drop(this.dim);
    this.dim = null;
    this.outlines = [];
    this.holes = [];
    if (lists) {
      if (lists.items.length > 0 && lists.items.length <= MAX_DIM_CONTAINERS) {
        this.dim = this.make(this.layer.ownerDocument.documentElement, 'dim');
        this.holes = [...lists.items];
      }
      if (lists.parent) {
        const t = this.make(lists.parent, 'list-parent');
        if (lists.table) this.label(t, `${lists.table} · list · ${lists.items.length}`);
        this.outlines.push(t);
      }
      for (const el of lists.items) this.outlines.push(this.make(el, 'item'));
      for (const other of lists.others) {
        other.items.forEach((el, i) => {
          const t = this.make(el, 'other-list');
          if (i === 0) this.label(t, `${other.table} · list · ${other.items.length}`);
          this.outlines.push(t);
        });
      }
    }
    this.schedule();
  }

  private label(t: Tracked, text: string): void {
    const label = this.layer.ownerDocument.createElement('span');
    label.className = 'ws-list-label';
    label.textContent = text;
    t.box.appendChild(label);
  }

  /**
   * The pick hint strip at the bottom of the viewport: the title ("Picking",
   * "Picking in results") and the key hints. Null removes it.
   */
  setStrip(title: string | null): void {
    if (title === null) {
      this.strip?.remove();
      this.strip = null;
      return;
    }
    if (this.strip?.dataset.title === title) return;
    const doc = this.layer.ownerDocument;
    this.strip ??= this.layer.appendChild(doc.createElement('div'));
    this.strip.className = 'ws-strip';
    this.strip.dataset.title = title;
    this.strip.innerHTML = `<b>${escape(title)}</b>${STRIP_HINTS.map(([k, v]) => `<span><kbd>${escape(k)}</kbd>${escape(v)}</span>`).join('')}`;
  }

  /** Current strip text, for tests; empty when there is none. */
  get stripText(): string {
    return this.strip?.textContent ?? '';
  }

  /** Current tag markup, for tests. */
  get tagMarkup(): string {
    return this.hover ? this.tagText : '';
  }

  setSelected(el: Element | null): void {
    if (this.selected?.el === el) return;
    this.drop(this.selected);
    this.selected = el ? this.make(el, 'selected') : null;
    this.schedule();
  }

  /** Outline of the list parent, or null to clear. */
  setList(el: Element | null): void {
    if (this.list?.el === el) return;
    this.drop(this.list);
    this.list = el ? this.make(el, 'list') : null;
    this.schedule();
  }

  /** Item highlights: siblings of a proposal or confirmed containers, plus excluded ones. */
  setItems(items: readonly Element[], variant: 'sibling' | 'container', excluded: readonly Element[] = []): void {
    for (const t of this.groups) t.box.remove();
    const excludedSet = new Set(excluded);
    this.groups = items.map((el, i) =>
      excludedSet.has(el) ? this.make(el, 'excluded') : this.make(el, variant, variant === 'sibling' ? i : undefined),
    );
    this.schedule();
  }

  /** Matches of the field being edited. */
  setMatches(els: readonly Element[]): void {
    if (els.length === this.matches.length && els.every((el, i) => this.matches[i]!.el === el)) return;
    for (const t of this.matches) t.box.remove();
    this.matches = els.map((el) => this.make(el, 'match'));
    this.schedule();
  }

  clear(): void {
    this.setHover(null);
    this.setSelected(null);
    this.setList(null);
    this.setItems([], 'sibling');
    this.setMatches([]);
    this.setOutlines(null);
    this.setStrip(null);
  }

  /** Current boxes, for tests and the e2e hook. */
  boxes(): { variant: BoxVariant; light: boolean; el: Element }[] {
    return [this.dim, ...this.outlines, this.hover, this.start, this.selected, this.list, ...this.groups, ...this.matches]
      .filter((t): t is Tracked => t !== null)
      .map(({ variant, light, el }) => ({ variant, light, el }));
  }

  schedule(): void {
    if (this.frame) return;
    const win = this.layer.ownerDocument.defaultView!;
    this.frame = win.requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  /** Reposition every box now. */
  update(): void {
    for (const t of [...this.shields, ...this.outlines, this.hover, this.start, this.selected, this.list, ...this.groups, ...this.matches]) if (t) place(t);
    if (this.dim) this.placeDim(this.dim);
    this.placeTag();
  }

  /** The dim covers the viewport with the active containers cut out, one path per frame. */
  private placeDim(dim: Tracked): void {
    const win = this.layer.ownerDocument.defaultView!;
    const w = win.innerWidth;
    const h = win.innerHeight;
    const s = dim.box.style;
    s.top = '0px';
    s.left = '0px';
    s.width = `${w}px`;
    s.height = `${h}px`;
    s.display = 'block';
    let path = `M0 0H${w}V${h}H0Z`;
    for (const el of this.holes) {
      const r = pageRect(el);
      if (r.width === 0 && r.height === 0) continue;
      path += `M${Math.round(r.left)} ${Math.round(r.top)}h${Math.round(r.width)}v${Math.round(r.height)}h${-Math.round(r.width)}Z`;
    }
    s.clipPath = `path(evenodd, '${path}')`;
  }

  private placeTag(): void {
    const hover = this.hover;
    if (!hover) {
      this.tag.style.display = 'none';
      return;
    }
    const r = pageRect(hover.el);
    this.tag.innerHTML = this.tagText;
    this.tag.style.display = 'block';
    const height = 20;
    const above = r.top - height - 4;
    // Flip below when the space above is off screen or covered by a fixed host header.
    const top = hover.el.ownerDocument === this.layer.ownerDocument;
    const flip = above < 0 || (top && coveredByFixed(hover.el.ownerDocument, r.left + 4, above + height / 2, hover.el));
    this.tag.style.top = `${Math.round(flip ? r.bottom + 4 : above)}px`;
    this.tag.style.left = `${Math.round(Math.max(0, r.left))}px`;
    this.tag.dataset.flipped = String(flip);
  }
}

function place(t: Tracked): void {
  const r = pageRect(t.el);
  const s = t.box.style;
  s.top = `${r.top}px`;
  s.left = `${r.left}px`;
  s.width = `${r.width}px`;
  s.height = `${r.height}px`;
  s.display = r.width === 0 && r.height === 0 ? 'none' : 'block';
}

function coveredByFixed(doc: Document, x: number, y: number, subject: Element): boolean {
  const hit = doc.elementFromPoint(x, y);
  if (!hit || hit === subject || subject.contains(hit) || hit.contains(subject)) return false;
  for (let cur: Element | null = hit; cur; cur = cur.parentElement) {
    const position = getComputedStyle(cur).position;
    if (position === 'fixed' || position === 'sticky') return !cur.tagName.toLowerCase().startsWith('webscoop-');
  }
  return false;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
