import { roleOf } from './dom';
import { SANS, MONO } from './fonts';

export type BoxVariant = 'hover' | 'selected' | 'sibling' | 'container' | 'excluded';

export const OVERLAY_CSS = `
:host { all: initial; }
#ws-overlay { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; contain: strict; }
.ws-box { position: fixed; box-sizing: border-box; border-radius: 3px; pointer-events: none; }
.ws-box-hover { border: 2px solid #9184d9; background: rgba(145, 132, 217, 0.16); }
.ws-box-selected { border: 2px solid #b5abfc; background: rgba(145, 132, 217, 0.12); }
.ws-box-sibling { border: 1px dashed #9184d9; background: rgba(145, 132, 217, 0.13); border-radius: 5px; }
.ws-box-container { border: 1px dashed #c9ccd9; border-radius: 5px; }
.ws-box-excluded { border: 1px dashed #f0a9a9; background: rgba(240, 169, 169, 0.10); border-radius: 5px; }
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
  el: Element;
  box: HTMLDivElement;
  variant: BoxVariant;
  light: boolean;
}

/**
 * Imperative highlight layer: plain elements positioned from
 * `getBoundingClientRect`, updated at most once per animation frame.
 */
export class Overlay {
  private hover: Tracked | null = null;
  private selected: Tracked | null = null;
  private groups: Tracked[] = [];
  private readonly tag: HTMLDivElement;
  private tagText = '';
  private frame = 0;

  constructor(private readonly layer: HTMLElement) {
    this.tag = layer.ownerDocument.createElement('div');
    this.tag.className = 'ws-tag';
    this.tag.style.display = 'none';
    layer.appendChild(this.tag);
    const schedule = () => this.schedule();
    const win = layer.ownerDocument.defaultView!;
    win.addEventListener('scroll', schedule, { capture: true, passive: true });
    win.addEventListener('resize', schedule, { passive: true });
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

  /** Hover highlight with its tag, or null to clear. */
  setHover(el: Element | null, text = ''): void {
    if (this.hover?.el === el) return;
    this.drop(this.hover);
    this.hover = el ? this.make(el, 'hover') : null;
    if (el) {
      const role = roleOf(el);
      const tag = el.tagName.toLowerCase();
      this.tagText = `<b>${escape(tag)}</b>${role ? ` ${escape(role)}` : ''}${text ? ` <i>${escape(text)}</i>` : ''}`;
    }
    this.schedule();
  }

  setSelected(el: Element | null): void {
    if (this.selected?.el === el) return;
    this.drop(this.selected);
    this.selected = el ? this.make(el, 'selected') : null;
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

  clear(): void {
    this.setHover(null);
    this.setSelected(null);
    this.setItems([], 'sibling');
  }

  /** Current boxes, for tests and the e2e hook. */
  boxes(): { variant: BoxVariant; light: boolean; el: Element }[] {
    return [this.hover, this.selected, ...this.groups]
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
    for (const t of [this.hover, this.selected, ...this.groups]) if (t) place(t);
    this.placeTag();
  }

  private placeTag(): void {
    const hover = this.hover;
    if (!hover) {
      this.tag.style.display = 'none';
      return;
    }
    const r = hover.el.getBoundingClientRect();
    this.tag.innerHTML = this.tagText;
    this.tag.style.display = 'block';
    const height = 20;
    const above = r.top - height - 4;
    // Flip below when the space above is off screen or covered by a fixed host header.
    const flip = above < 0 || coveredByFixed(hover.el.ownerDocument, r.left + 4, above + height / 2, hover.el);
    this.tag.style.top = `${Math.round(flip ? r.bottom + 4 : above)}px`;
    this.tag.style.left = `${Math.round(Math.max(0, r.left))}px`;
    this.tag.dataset.flipped = String(flip);
  }
}

function place(t: Tracked): void {
  const r = t.el.getBoundingClientRect();
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
