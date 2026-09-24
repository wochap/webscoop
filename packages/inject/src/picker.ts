import { isOwn, pickable } from './dom';

export interface PickerHooks {
  isActive(): boolean;
  onHover(el: Element | null): void;
  onPick(el: Element): void;
  onCancel(): void;
}

/** Events swallowed while picking so host handlers never see them. */
const BLOCKED = [
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
  'touchend',
  'submit',
] as const;

/** Whether an element belongs to a fixed or sticky layer covering more than half the viewport. */
export function inLargeFixedLayer(el: Element): boolean {
  const win = el.ownerDocument.defaultView!;
  const viewport = win.innerWidth * win.innerHeight;
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const position = win.getComputedStyle(cur).position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    const r = cur.getBoundingClientRect();
    const visible = Math.max(0, Math.min(r.right, win.innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0));
    if (visible > viewport * 0.5) return true;
  }
  return false;
}

/** The element under the point, looking through recorder hosts and large fixed overlays such as modal backdrops. */
export function elementThrough(doc: Document, x: number, y: number): Element | null {
  for (const el of doc.elementsFromPoint(x, y)) {
    if (isOwn(el)) continue;
    if (el === doc.documentElement || el === doc.body) return el;
    if (inLargeFixedLayer(el)) continue;
    return el;
  }
  return null;
}

/**
 * Capture-phase listeners on `window`, registered once at injection time so
 * they run before any host handler. While picking, pointer events on the
 * page are stopped; the click selects. Alt picks through overlays.
 */
export class Picker {
  private last: Element | null = null;

  constructor(
    private readonly win: Window,
    private readonly hooks: PickerHooks,
  ) {
    const opts = { capture: true, passive: false } as const;
    win.addEventListener('mousemove', this.onMove, opts);
    for (const type of BLOCKED) win.addEventListener(type, this.onBlocked, opts);
    win.addEventListener('keydown', this.onKey, opts);
  }

  /** Remove every listener, so the page gets its events back. */
  dispose(): void {
    const opts = { capture: true } as const;
    this.win.removeEventListener('mousemove', this.onMove, opts);
    for (const type of BLOCKED) this.win.removeEventListener(type, this.onBlocked, opts);
    this.win.removeEventListener('keydown', this.onKey, opts);
    this.last = null;
  }

  private target(e: MouseEvent): Element | null {
    const doc = this.win.document;
    const raw = e.altKey ? elementThrough(doc, e.clientX, e.clientY) : (e.target as Element | null);
    if (!raw || raw.nodeType !== 1 || isOwn(raw)) return null;
    return pickable(raw);
  }

  private readonly onMove = (e: MouseEvent) => {
    if (!this.hooks.isActive()) return;
    if (isOwn(e.target as Node)) {
      if (this.last) this.hooks.onHover((this.last = null));
      return;
    }
    const el = this.target(e);
    if (el !== this.last) this.hooks.onHover((this.last = el));
  };

  private readonly onBlocked = (e: Event) => {
    if (!this.hooks.isActive() || isOwn(e.target as Node)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const el = this.target(e as MouseEvent);
    if (!el) return;
    this.last = null;
    this.hooks.onPick(el);
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.hooks.isActive() || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.last = null;
    this.hooks.onCancel();
  };
}
