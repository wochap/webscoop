import { OVERLAY_CSS, PANEL_WIDTH } from './overlay';

/** Width of the rail a main window shows while another window owns the panel. */
export const RAIL_WIDTH = 30;
/** Height of the strip a popup shows while another window owns the panel. */
export const STRIP_HEIGHT = 22;
/** Height of the compact bar of a narrow owner window. */
export const BAR_HEIGHT = 34;
import css from './styles.css';

export { PANEL_WIDTH };

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
  /** Give the page the room the panel does not use: the full panel, the rail, the strip, the compact bar, or nothing. */
  setLayout(layout: 'panel' | 'rail' | 'strip' | 'bar' | 'none'): void;
  /** Take the hosts out of the page and give the page its margin back. */
  unmount(): void;
}

/**
 * User input events stopped at each recorder shadow root in the bubble phase,
 * so page bubble listeners (focus-stealing search boxes, click trackers) never
 * see panel input. Recorder handlers inside the tree and window capture
 * listeners run first and are unaffected.
 */
export const ISOLATED_EVENTS = [
  'keydown', 'keyup', 'keypress',
  'beforeinput', 'input', 'change',
  'compositionstart', 'compositionupdate', 'compositionend',
  'copy', 'cut', 'paste',
  'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointercancel',
  'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout',
  'click', 'dblclick', 'auxclick', 'contextmenu',
  'wheel',
  'focusin', 'focusout',
] as const;

const stop = (e: Event) => e.stopPropagation();

function isolate(shadow: ShadowRoot): void {
  for (const type of ISOLATED_EVENTS) shadow.addEventListener(type, stop, type === 'wheel' ? { passive: true } : undefined);
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
  isolate(shadow);
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
  /** The page margins each layout takes: right for the panel and the rail, top for the strip and the bar. */
  const MARGINS = { panel: [`${PANEL_WIDTH}px`, ''], rail: [`${RAIL_WIDTH}px`, ''], strip: ['', `${STRIP_HEIGHT}px`], bar: ['', `${BAR_HEIGHT}px`], none: ['', ''] } as const;
  let margins: readonly [string, string] = MARGINS.panel;
  const applyMargins = () => {
    for (const [prop, value] of [['margin-right', margins[0]], ['margin-top', margins[1]]] as const) {
      if (value === '') {
        if (root.style.getPropertyValue(prop) !== '') root.style.removeProperty(prop);
      } else if (root.style.getPropertyValue(prop) !== value) {
        root.style.setProperty(prop, value, 'important');
      }
    }
  };
  applyMargins();

  const observer = new MutationObserver(() => {
    for (const h of hosts) if (h.parentNode !== root) root.appendChild(h);
    applyMargins();
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
    setLayout(layout) {
      margins = MARGINS[layout];
      panel.el.dataset.layout = layout;
      applyMargins();
    },
    setDrawerSpace(open) {
      if (open) root.style.setProperty('padding-bottom', '40vh', 'important');
      else root.style.removeProperty('padding-bottom');
    },
    unmount() {
      observer.disconnect();
      for (const h of hosts) h.remove();
      root.style.removeProperty('margin-right');
      root.style.removeProperty('margin-top');
      root.style.removeProperty('padding-bottom');
      if (root.getAttribute('style') === '') root.removeAttribute('style');
    },
  };
}
