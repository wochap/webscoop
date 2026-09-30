// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ISOLATED_EVENTS, mount, type Mounted } from '../src/mount';

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('panel event isolation', () => {
  it('stops panel input events before page bubble listeners, after listeners inside the shadow tree', () => {
    mounted = mount(document);
    const input = document.createElement('input');
    mounted.panel.appendChild(input);
    for (const target of [input, mounted.overlay, mounted.drawer]) {
      for (const type of ISOLATED_EVENTS) {
        const seen: string[] = [];
        const inner = () => seen.push('inner');
        const docCapture = () => seen.push('document-capture');
        const docBubble = () => seen.push('document');
        const winBubble = () => seen.push('window');
        target.addEventListener(type, inner);
        document.addEventListener(type, docCapture, true);
        document.addEventListener(type, docBubble);
        window.addEventListener(type, winBubble);
        const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
        target.dispatchEvent(event);
        expect(seen, type).toEqual(['document-capture', 'inner']);
        expect(event.defaultPrevented, type).toBe(false);
        target.removeEventListener(type, inner);
        document.removeEventListener(type, docCapture, true);
        document.removeEventListener(type, docBubble);
        window.removeEventListener(type, winBubble);
      }
    }
  });

  it('leaves page events alone', () => {
    mounted = mount(document);
    let seen = 0;
    const count = () => seen++;
    document.addEventListener('keydown', count);
    document.body.dispatchEvent(new Event('keydown', { bubbles: true }));
    document.removeEventListener('keydown', count);
    expect(seen).toBe(1);
  });
});
