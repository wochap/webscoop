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
  const picker = new Picker(win, {
    isActive: () => runtime?.picking ?? false,
    onHover: (el) => runtime?.hover(el),
    onPick: (el) => runtime?.pick(el),
    onCancel: () => runtime?.cancelPicking(),
  });

  const start = () => {
    loadFonts(win.document);
    const mounted = mount(win.document);
    const overlay = new Overlay(mounted.overlay);
    const onDetach = () => {
      reactRoot.unmount();
      overlay.dispose();
      picker.dispose();
      mounted.unmount();
      runtime = null;
      // A later injection boots the recorder again from scratch.
      delete globals[PAGE_GLOBAL];
      if (__WEBSCOOP_E2E__) delete (win as unknown as Record<string, unknown>).__webscoopTest;
    };
    runtime = new Runtime({ win, overlay, setDrawerSpace: mounted.setDrawerSpace, onDetach });
    const reactRoot = createRoot(mounted.panel);
    reactRoot.render(
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
