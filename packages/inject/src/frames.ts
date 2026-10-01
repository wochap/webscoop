import { isOwn } from './dom';

/** The document of a same-origin iframe, or null for a cross-origin one or another element. */
export function frameDocument(el: Element | null | undefined): Document | null {
  if (!el || el.tagName.toLowerCase() !== 'iframe') return null;
  try {
    return (el as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

/** The `<iframe>` element in the top document holding a document, or null for the top document itself. */
export function frameElementOf(doc: Document, top: Document): Element | null {
  if (doc === top) return null;
  try {
    return doc.defaultView?.frameElement ?? null;
  } catch {
    return null;
  }
}

/** The top document's iframes whose documents cannot be reached: they stay opaque. */
export function crossOriginFrames(top: Document): Element[] {
  return Array.from(top.querySelectorAll('iframe')).filter((el) => !isOwn(el) && frameDocument(el) === null);
}

/**
 * Calls `attach` for the window of every same-origin iframe of the top
 * document, now and whenever an iframe is added or loads a new document.
 * Only one level: iframes inside iframes are not followed. `attach` returns
 * the function that undoes it; a window that goes away is simply dropped.
 */
export class FrameWatcher {
  private readonly attached = new Map<Window, () => void>();
  private readonly watched = new WeakSet<Element>();
  private readonly observer: MutationObserver;

  constructor(
    private readonly top: Window,
    private readonly attach: (win: Window) => () => void,
  ) {
    this.observer = new (top as Window & typeof globalThis).MutationObserver(() => this.scan());
    this.observer.observe(top.document, { childList: true, subtree: true });
    this.scan();
  }

  /** Windows currently attached. */
  windows(): Window[] {
    return [...this.attached.keys()];
  }

  /** Attach to iframes not seen yet, and to iframes whose document changed. */
  scan(): void {
    for (const el of Array.from(this.top.document.querySelectorAll('iframe'))) {
      if (isOwn(el)) continue;
      if (!this.watched.has(el)) {
        this.watched.add(el);
        el.addEventListener('load', () => this.connect(el));
      }
      this.connect(el);
    }
  }

  private connect(el: Element): void {
    const doc = frameDocument(el);
    const win = doc?.defaultView;
    if (!win || this.attached.has(win)) return;
    this.attached.set(win, this.attach(win));
    win.addEventListener('pagehide', () => this.detach(win), { once: true });
  }

  private detach(win: Window): void {
    const off = this.attached.get(win);
    this.attached.delete(win);
    try {
      off?.();
    } catch {
      // The window is gone; its listeners went with it.
    }
  }

  dispose(): void {
    this.observer.disconnect();
    for (const win of [...this.attached.keys()]) this.detach(win);
  }
}
