import { PAGE_GLOBAL } from '@webscoop/core/page';
import { createRoot } from 'react-dom/client';
import { loadFonts } from './fonts';
import { mount } from './mount';
import { Overlay } from './overlay';
import { Picker } from './picker';
import { Runtime } from './runtime';
import { installTestHook } from './testhook';
import { RecorderProvider } from './ui/context';
import { ScoopRoot } from './ui/App';

type PageGlobal = { dispatch(msg: unknown): void };

/** Boot the recorder in the top frame of an http(s) page, once per document. */
function boot(win: Window & typeof globalThis): void {
  const globals = win as unknown as Record<string, PageGlobal | undefined>;
  if (globals[PAGE_GLOBAL] || win.top !== win || !/^https?:$/.test(win.location.protocol)) return;

  let runtime: Runtime | null = null;
  const pending: unknown[] = [];
  globals[PAGE_GLOBAL] = { dispatch: (msg) => (runtime ? runtime.dispatch(msg) : void pending.push(msg)) };

  // Registered now, before page scripts run, so host handlers never see picking clicks.
  new Picker(win, {
    isActive: () => runtime?.picking ?? false,
    onHover: (el) => runtime?.hover(el),
    onPick: (el) => runtime?.pick(el),
    onCancel: () => runtime?.cancelPicking(),
  });

  const start = () => {
    loadFonts(win.document);
    const mounted = mount(win.document);
    const overlay = new Overlay(mounted.overlay);
    runtime = new Runtime({ win, overlay, setDrawerSpace: mounted.setDrawerSpace });
    createRoot(mounted.panel).render(
      <RecorderProvider store={runtime.store} actions={runtime} drawerHost={mounted.drawer}>
        <ScoopRoot />
      </RecorderProvider>,
    );
    if (__WEBSCOOP_E2E__) installTestHook(win, runtime, mounted, overlay);
    for (const msg of pending.splice(0)) runtime.dispatch(msg);
    void runtime.start();
  };
  if (win.document.body) start();
  else win.document.addEventListener('DOMContentLoaded', start, { once: true });
}

boot(window);
