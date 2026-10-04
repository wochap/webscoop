type Selectable = HTMLInputElement | HTMLTextAreaElement;

interface PanelFocus {
  el: HTMLElement;
  selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null;
}

function selectionOf(el: HTMLElement): PanelFocus['selection'] {
  const input = el as Selectable;
  try {
    if (typeof input.selectionStart !== 'number' || typeof input.selectionEnd !== 'number') return null;
    return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection ?? 'none' };
  } catch {
    // Inputs like checkboxes throw on selection access.
    return null;
  }
}

/**
 * Keeps focus in the panel while the user types there. Pages that move focus to
 * their own search box on any key (from capture listeners, or by checking
 * `document.activeElement`, which is the recorder host) get focus taken back in a
 * microtask, before the key's default action inserts the character. A pointer
 * press on the page or Tab in the panel lets the next focus move stand.
 */
export class FocusGuard {
  private last: PanelFocus | null = null;
  /** The user aimed at the page: a pointer press outside the recorder, or Tab in the panel. */
  private pageGesture = false;
  /** The user pressed inside the panel: focus may fall to the body without a page gesture. */
  private panelPress = false;
  private readonly hosts: Element[];

  constructor(private readonly win: Window, private readonly shadows: ShadowRoot[]) {
    this.hosts = shadows.map((s) => s.host);
    win.addEventListener('focusin', this.onFocusIn, { capture: true });
    win.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    for (const s of shadows) {
      s.addEventListener('focusin', this.onPanelFocusIn, { capture: true });
      s.addEventListener('focusout', this.onPanelFocusOut, { capture: true });
      s.addEventListener('keydown', this.onPanelKey, { capture: true });
    }
  }

  dispose(): void {
    this.win.removeEventListener('focusin', this.onFocusIn, { capture: true });
    this.win.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    for (const s of this.shadows) {
      s.removeEventListener('focusin', this.onPanelFocusIn, { capture: true });
      s.removeEventListener('focusout', this.onPanelFocusOut, { capture: true });
      s.removeEventListener('keydown', this.onPanelKey, { capture: true });
    }
    this.last = null;
  }

  private inRecorder(e: Event): boolean {
    const path = e.composedPath();
    return this.hosts.some((h) => path.includes(h));
  }

  private onPanelFocusIn = (e: Event): void => {
    const el = e.target as HTMLElement;
    this.last = { el, selection: selectionOf(el) };
    this.pageGesture = false;
    this.panelPress = false;
  };

  private onPanelFocusOut = (event: Event): void => {
    const e = event as FocusEvent;
    if (this.last?.el === e.target) this.last.selection = selectionOf(this.last.el);
    // A `blur()` from the page drops focus to the body with no `focusin` to react to.
    if (e.relatedTarget === null) queueMicrotask(() => {
      const active = this.win.document.activeElement;
      if (!active || active === this.win.document.body) this.restore();
    });
  };

  private onPanelKey = (e: Event): void => {
    if ((e as KeyboardEvent).key === 'Tab') this.pageGesture = true;
  };

  private onPointerDown = (e: Event): void => {
    if (this.inRecorder(e)) this.panelPress = true;
    else this.pageGesture = true;
  };

  private onFocusIn = (e: Event): void => {
    if (this.inRecorder(e)) return;
    queueMicrotask(() => this.restore());
  };

  private restore(): void {
    const last = this.last;
    if (!last || this.pageGesture || !last.el.isConnected) return;
    const active = this.win.document.activeElement;
    if (active && this.hosts.includes(active)) return;
    if ((!active || active === this.win.document.body) && this.panelPress) return;
    last.el.focus({ preventScroll: true });
    if (last.selection) {
      try {
        (last.el as Selectable).setSelectionRange(last.selection.start, last.selection.end, last.selection.direction);
      } catch {
        // The element no longer takes a selection.
      }
    }
  }
}
