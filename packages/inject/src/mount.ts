import { OVERLAY_CSS } from './overlay';
import css from './styles.css';

export const PANEL_WIDTH = 400;

export interface Mounted {
  panelHost: HTMLElement;
  overlayHost: HTMLElement;
  drawerHost: HTMLElement;
  /** `#ws-root` inside the panel's closed shadow root. */
  panel: HTMLElement;
  /** `#ws-overlay` inside the overlay's closed shadow root. */
  overlay: HTMLElement;
  /** Container the results drawer portals into. */
  drawer: HTMLElement;
  shadows: ShadowRoot[];
  /** Reserve room for the results drawer at the bottom of the page, or release it. */
  setDrawerSpace(open: boolean): void;
  /** Take the hosts out of the page and give the page its margin back. */
  unmount(): void;
}

function styleShadow(shadow: ShadowRoot, text: string): void {
  const doc = shadow.ownerDocument;
  const View = doc.defaultView as (Window & typeof globalThis) | null;
  if (View && 'adoptedStyleSheets' in shadow && typeof View.CSSStyleSheet?.prototype.replaceSync === 'function') {
    try {
      const sheet = new View.CSSStyleSheet();
      sheet.replaceSync(text);
      shadow.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // Fall back to a style element.
    }
  }
  const style = doc.createElement('style');
  style.textContent = text;
  shadow.appendChild(style);
}

/** Inline declarations host stylesheets cannot override on our host elements. */
function pin(host: HTMLElement): void {
  for (const [prop, value] of [
    ['display', 'block'],
    ['position', 'static'],
    ['visibility', 'visible'],
    ['opacity', '1'],
    ['transform', 'none'],
    ['filter', 'none'],
    ['clip-path', 'none'],
    ['contain', 'none'],
  ] as const) {
    host.style.setProperty(prop, value, 'important');
  }
}

function host(doc: Document, tag: string, text: string, inner: string): { host: HTMLElement; shadow: ShadowRoot; el: HTMLElement } {
  const el = doc.createElement(tag);
  pin(el);
  const shadow = el.attachShadow({ mode: 'closed' });
  styleShadow(shadow, text);
  const child = doc.createElement('div');
  if (inner) child.id = inner;
  shadow.appendChild(child);
  return { host: el, shadow, el: child };
}

/**
 * Mount the recorder: hosts appended to `<html>` (not `<body>`, which pages
 * restyle), each with a closed shadow root, and the page pushed left by the
 * panel width. Hosts that the page removes are put back.
 */
export function mount(doc: Document = document): Mounted {
  const root = doc.documentElement;
  const panel = host(doc, 'webscoop-root', css, 'ws-root');
  const overlay = host(doc, 'webscoop-overlay', OVERLAY_CSS, 'ws-overlay');
  const drawer = host(doc, 'webscoop-drawer', css, '');
  const hosts = [overlay.host, panel.host, drawer.host];
  root.append(...hosts);
  root.style.setProperty('margin-right', `${PANEL_WIDTH}px`, 'important');

  const observer = new MutationObserver(() => {
    for (const h of hosts) if (h.parentNode !== root) root.appendChild(h);
    if (root.style.getPropertyValue('margin-right') !== `${PANEL_WIDTH}px`) {
      root.style.setProperty('margin-right', `${PANEL_WIDTH}px`, 'important');
    }
  });
  observer.observe(root, { childList: true, attributes: true, attributeFilter: ['style'] });

  return {
    panelHost: panel.host,
    overlayHost: overlay.host,
    drawerHost: drawer.host,
    panel: panel.el,
    overlay: overlay.el,
    drawer: drawer.el,
    shadows: [panel.shadow, overlay.shadow, drawer.shadow],
    setDrawerSpace(open) {
      if (open) root.style.setProperty('padding-bottom', '40vh', 'important');
      else root.style.removeProperty('padding-bottom');
    },
    unmount() {
      observer.disconnect();
      for (const h of hosts) h.remove();
      root.style.removeProperty('margin-right');
      root.style.removeProperty('padding-bottom');
      if (root.getAttribute('style') === '') root.removeAttribute('style');
    },
  };
}
