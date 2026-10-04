import { BLANK_GLOBAL, PAGE_GLOBAL } from '@webscoop/core/page';
import { createRoot } from 'react-dom/client';
import { loadFonts } from './fonts';
import { FrameWatcher } from './frames';
import { mount } from './mount';
import { Overlay } from './overlay';
import { isMenuTarget, isTypingTarget } from './keyboard';
import { BrowseObserver, Picker } from './picker';
import { Runtime } from './runtime';
import { installTestHook } from './testhook';
import { RecorderProvider } from './ui/context';
import { ScoopRoot } from './ui/App';

type PageGlobal = { dispatch(msg: unknown): void };

/** Boot the recorder in the top frame of an http(s) page, or of a blank page the host asked for, once per document. */
function boot(win: Window & typeof globalThis): void {
  const globals = win as unknown as Record<string, PageGlobal | undefined>;
  const blank = win.location.href === 'about:blank' && (win as unknown as Record<string, unknown>)[BLANK_GLOBAL] === true;
  if (globals[PAGE_GLOBAL] || win.top !== win || !(blank || /^https?:$/.test(win.location.protocol))) return;

  let runtime: Runtime | null = null;
  const pending: unknown[] = [];
  globals[PAGE_GLOBAL] = { dispatch: (msg) => (runtime ? runtime.dispatch(msg) : void pending.push(msg)) };

  // Registered now, before page scripts run, so host handlers never see picking clicks.
  const pickerHooks = {
    isActive: () => runtime?.picking ?? false,
    onHover: (el: Element | null, walk?: Parameters<Runtime['hover']>[1]) => runtime?.hover(el, walk),
    onPick: (el: Element) => runtime?.pick(el),
    onCancel: () => runtime?.cancelPicking(),
    onKey: (e: KeyboardEvent) => runtime?.pageKey(e),
    isPanelTyping: () => shadows.some((s) => isTypingTarget(s.activeElement) || isMenuTarget(s.activeElement)),
  };
  const picker = new Picker(win, { ...pickerHooks, shieldAt: (x, y) => overlay?.shieldAt(x, y) ?? null });
  let shadows: ShadowRoot[] = [];
  let overlay: Overlay | null = null;
  const observerHooks = {
    isActive: () => (runtime?.browsing ?? false) && !runtime?.picking,
    onAction: (action: Parameters<Runtime['record']>[0]) => runtime?.record(action),
  };
  const observer = new BrowseObserver(win, observerHooks);
  // Same-origin iframes get the same picker and browse listeners; the panel and overlay stay in the top window.
  const frameObservers = new Map<Window, BrowseObserver>();
  const frameScrolls = new Map<Window, () => void>();
  const frames = new FrameWatcher(win, (frameWin) => {
    const framePicker = new Picker(frameWin, pickerHooks);
    const frameObserver = new BrowseObserver(frameWin, observerHooks);
    frameObservers.set(frameWin, frameObserver);
    if (overlay) frameScrolls.set(frameWin, overlay.watch(frameWin));
    runtime?.framesChanged();
    return () => {
      framePicker.dispose();
      frameObserver.dispose();
      frameObservers.delete(frameWin);
      frameScrolls.get(frameWin)?.();
      frameScrolls.delete(frameWin);
      runtime?.framesChanged();
    };
  });
  const flushBrowse = () => {
    observer.flush();
    for (const o of frameObservers.values()) o.flush();
  };

  const start = () => {
    loadFonts(win.document);
    const mounted = mount(win.document);
    shadows = mounted.shadows;
    const layer = new Overlay(mounted.overlay);
    overlay = layer;
    for (const frameWin of frames.windows()) frameScrolls.set(frameWin, layer.watch(frameWin));
    const onDetach = () => {
      reactRoot.unmount();
      layer.dispose();
      overlay = null;
      picker.dispose();
      observer.dispose();
      frames.dispose();
      mounted.unmount();
      runtime = null;
      // A later injection boots the recorder again from scratch.
      delete globals[PAGE_GLOBAL];
      if (__WEBSCOOP_E2E__) delete (win as unknown as Record<string, unknown>).__webscoopTest;
    };
    runtime = new Runtime({ win, overlay: layer, setDrawerSpace: mounted.setDrawerSpace, setLayout: mounted.setLayout, onDetach, flushBrowse });
    const reactRoot = createRoot(mounted.panel);
    reactRoot.render(
      <RecorderProvider store={runtime.store} actions={runtime} drawerHost={mounted.drawer}>
        <ScoopRoot />
      </RecorderProvider>,
    );
    if (__WEBSCOOP_E2E__) installTestHook(win, runtime, mounted, layer);
    for (const msg of pending.splice(0)) runtime.dispatch(msg);
    void runtime.start();
  };
  if (win.document.body) start();
  else win.document.addEventListener('DOMContentLoaded', start, { once: true });
}

boot(window);
