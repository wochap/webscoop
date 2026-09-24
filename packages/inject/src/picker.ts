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

/** An action the user performed on the page while browsing. */
export type ObservedAction =
  | { kind: 'click'; el: Element }
  | { kind: 'type'; el: Element; value: string }
  | { kind: 'select'; el: Element; value: string }
  | { kind: 'press'; el: Element; value: string };

export interface ObserverHooks {
  isActive(): boolean;
  /** Called synchronously, before the page's own handlers and default action, so a navigation cannot lose it. */
  onAction(action: ObservedAction): void;
}

/** Elements a recorded click lands on: the click is attributed to the nearest one around the target. */
const ACTIONABLE =
  'button, a, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"]';

/** Input types that take typed text. */
const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** Whether the element is a place the user types text into. */
export function isTextEntry(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') return TEXT_INPUTS.has(((el as HTMLInputElement).getAttribute('type') ?? '').toLowerCase());
  return (el as HTMLElement).isContentEditable === true;
}

/** The nearest actionable element at or above the target, or null when the click landed on nothing a user acts on. */
export function actionableAncestor(target: Element): Element | null {
  return target.closest(ACTIONABLE);
}

function valueOf(el: Element): string {
  return 'value' in el && typeof (el as HTMLInputElement).value === 'string' ? (el as HTMLInputElement).value : (el.textContent ?? '');
}

/**
 * Browse mode's passive listeners: capture-phase, never preventing anything,
 * so the page behaves as without the recorder. Clicks on actionable elements,
 * the final text typed into an input (flushed on blur, Enter, a click
 * elsewhere, or leaving the page), select changes, and Enter presses become
 * actions. Recorder-owned nodes are ignored.
 */
export class BrowseObserver {
  /** Typing not yet reported: the input and its latest value. */
  private pending: { el: Element; value: string } | null = null;
  /** Form an Enter press is submitting in this task; its synthetic click on the submit button is not a step. */
  private submitting: HTMLFormElement | null = null;

  constructor(
    private readonly win: Window,
    private readonly hooks: ObserverHooks,
  ) {
    const opts = { capture: true } as const;
    win.addEventListener('click', this.onClick, opts);
    win.addEventListener('input', this.onInput, opts);
    win.addEventListener('change', this.onChange, opts);
    win.addEventListener('keydown', this.onKey, opts);
    win.addEventListener('focusout', this.onBlur, opts);
    win.addEventListener('pagehide', this.flush, opts);
  }

  dispose(): void {
    const opts = { capture: true } as const;
    this.win.removeEventListener('click', this.onClick, opts);
    this.win.removeEventListener('input', this.onInput, opts);
    this.win.removeEventListener('change', this.onChange, opts);
    this.win.removeEventListener('keydown', this.onKey, opts);
    this.win.removeEventListener('focusout', this.onBlur, opts);
    this.win.removeEventListener('pagehide', this.flush, opts);
    this.pending = null;
  }

  /** Report pending typing now, for example when browse mode ends. */
  readonly flush = (): void => {
    const pending = this.pending;
    this.pending = null;
    if (pending && this.hooks.isActive()) this.hooks.onAction({ kind: 'type', el: pending.el, value: pending.value });
  };

  private target(e: Event): Element | null {
    const raw = e.target as Element | null;
    if (!this.hooks.isActive() || !raw || raw.nodeType !== 1 || isOwn(raw)) return null;
    return raw;
  }

  private readonly onClick = (e: MouseEvent) => {
    const raw = this.target(e);
    if (!raw) return;
    const el = actionableAncestor(raw);
    if (!el) return;
    // Focusing a text box or opening a select is not a step; typing and choosing are.
    if (isTextEntry(el) || el.tagName.toLowerCase() === 'select') return;
    if (e.detail === 0 && this.submitting && (el as HTMLButtonElement).form === this.submitting) return;
    if (this.pending && this.pending.el !== el) this.flush();
    this.hooks.onAction({ kind: 'click', el });
  };

  private readonly onInput = (e: Event) => {
    const el = this.target(e);
    if (!el || !isTextEntry(el)) return;
    if (this.pending && this.pending.el !== el) this.flush();
    this.pending = { el, value: valueOf(el) };
  };

  private readonly onChange = (e: Event) => {
    const el = this.target(e);
    if (!el || el.tagName.toLowerCase() !== 'select') return;
    this.flush();
    this.hooks.onAction({ kind: 'select', el, value: (el as HTMLSelectElement).value });
  };

  private readonly onKey = (e: KeyboardEvent) => {
    const el = this.target(e);
    if (!el || e.key !== 'Enter' || !isTextEntry(el) || el.tagName.toLowerCase() === 'textarea') return;
    if (this.pending?.el === el) this.flush();
    this.hooks.onAction({ kind: 'press', el, value: 'Enter' });
    const form = (el as HTMLInputElement).form ?? null;
    if (form) {
      this.submitting = form;
      this.win.setTimeout(() => (this.submitting = null), 0);
    }
  };

  private readonly onBlur = (e: FocusEvent) => {
    const el = this.target(e);
    if (el && this.pending?.el === el) this.flush();
  };
}
