import type { Mounted } from './mount';
import type { Overlay } from './overlay';
import type { Runtime } from './runtime';
import { modeOf } from './store';

/**
 * Test-only access to the closed shadow roots. Compiled into the e2e bundle
 * only; the user bundle has no trace of it.
 */
export function installTestHook(win: Window, runtime: Runtime, mounted: Mounted, overlay: Overlay): void {
  const roots = () => [mounted.shadows[0]!, mounted.shadows[2]!];
  const all = (selector: string): HTMLElement[] => roots().flatMap((r) => Array.from(r.querySelectorAll<HTMLElement>(selector)));
  const one = (selector: string, index = 0): HTMLElement => {
    const el = all(selector)[index];
    if (!el) throw new Error(`no panel element matches ${selector} at ${index}`);
    return el;
  };
  const setValue = (el: HTMLElement, value: string) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  const info = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      text: el.textContent ?? '',
      value: (el as HTMLInputElement).value,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      fontFamily: style.fontFamily,
      color: style.color,
      backgroundColor: style.backgroundColor,
      disabled: (el as HTMLButtonElement).disabled === true,
      attrs: Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value])),
    };
  };
  (win as unknown as { __webscoopTest: unknown }).__webscoopTest = {
    state: () => {
      const snap = runtime.store.get();
      return { host: snap.host, ui: snap.ui, mode: modeOf(snap) };
    },
    count: (selector: string) => all(selector).length,
    query: (selector: string, index = 0) => {
      const el = all(selector)[index];
      return el ? info(el) : null;
    },
    texts: (selector: string) => all(selector).map((el) => el.textContent ?? ''),
    click: (selector: string, index = 0) => one(selector, index).click(),
    focus: (selector: string, index = 0) => one(selector, index).focus(),
    fill: (selector: string, value: string, index = 0) => {
      const el = one(selector, index);
      el.focus();
      setValue(el, value);
      el.blur();
    },
    submit: (selector: string, value: string, index = 0) => {
      const el = one(selector, index);
      el.focus();
      setValue(el, value);
      (el as HTMLInputElement).form?.requestSubmit();
    },
    boxes: () =>
      overlay.boxes().map(({ variant, light, el }) => {
        const r = el.getBoundingClientRect();
        return { variant, light, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
      }),
    fontsReady: async () => {
      await win.document.fonts.ready;
      return Array.from(win.document.fonts).filter((f) => f.family.includes('Webscoop') && f.status === 'loaded').length;
    },
  };
}
