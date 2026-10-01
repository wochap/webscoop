// @vitest-environment jsdom
import { HOST_BINDING, type PageMessage, type RecorderState } from '@webscoop/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathOfElement } from '../src/dom';
import { crossOriginFrames, frameDocument, FrameWatcher } from '../src/frames';
import { pageRect, type Overlay } from '../src/overlay';
import { BrowseObserver, Picker, type ObservedAction } from '../src/picker';
import { Runtime } from '../src/runtime';
import { baseState } from './panel';

/** Add a same-origin iframe with the given body. */
function addFrame(id: string, body: string): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.id = id;
  document.body.appendChild(frame);
  frame.contentDocument!.body.innerHTML = body;
  return frame;
}

beforeEach(() => {
  document.body.innerHTML = '<h1 class="portal">Portal</h1>';
});

let watcher: FrameWatcher | null = null;
afterEach(() => {
  watcher?.dispose();
  watcher = null;
});

describe('frame watcher', () => {
  it('attaches to iframes present and added later, and detaches when their window goes away', async () => {
    const first = addFrame('one', '<p>1</p>');
    const attached: Window[] = [];
    let detached = 0;
    watcher = new FrameWatcher(window, (win) => {
      attached.push(win);
      return () => detached++;
    });
    expect(attached).toEqual([first.contentWindow]);
    const second = addFrame('two', '<p>2</p>');
    await expect.poll(() => attached.length).toBe(2);
    expect(attached[1]).toBe(second.contentWindow);
    expect(watcher.windows()).toHaveLength(2);
    watcher.dispose();
    expect(detached).toBe(2);
    expect(frameDocument(first)).toBe(first.contentDocument);
    expect(frameDocument(document.querySelector('h1'))).toBeNull();
    expect(crossOriginFrames(document)).toEqual([]);
  });

  it('picks and records inside an iframe through listeners on its window', () => {
    const frame = addFrame('app', '<button id="go">Go</button>');
    const picked: Element[] = [];
    const actions: ObservedAction[] = [];
    let picking = true;
    watcher = new FrameWatcher(window, (win) => {
      const picker = new Picker(win, { isActive: () => picking, onHover: () => {}, onPick: (el) => picked.push(el), onCancel: () => {} });
      const observer = new BrowseObserver(win, { isActive: () => !picking, onAction: (a) => actions.push(a) });
      return () => {
        picker.dispose();
        observer.dispose();
      };
    });
    const button = frame.contentDocument!.getElementById('go')!;
    button.dispatchEvent(new (frame.contentWindow as Window & typeof globalThis).MouseEvent('click', { bubbles: true }));
    expect(picked).toEqual([button]);
    picking = false;
    button.dispatchEvent(new (frame.contentWindow as Window & typeof globalThis).MouseEvent('click', { bubbles: true }));
    expect(actions).toEqual([{ kind: 'click', el: button }]);
  });
});

describe('page rects', () => {
  it('offsets an element inside an iframe by the iframe position, for overlay boxes', () => {
    const frame = addFrame('app', '<button id="go">Go</button>');
    const button = frame.contentDocument!.getElementById('go')!;
    const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
    frame.getBoundingClientRect = rect(300, 50, 600, 400);
    button.getBoundingClientRect = rect(10, 20, 80, 30);
    expect(pageRect(button)).toMatchObject({ left: 310, top: 70, width: 80, height: 30, right: 390, bottom: 100 });
    expect(pageRect(frame)).toMatchObject({ left: 300, top: 50 });
  });
});

describe('runtime picks inside an iframe', () => {
  function setup(state: RecorderState = baseState()) {
    const selected: (Element | null)[] = [];
    const overlay = {
      setSelected: (el: Element | null) => selected.push(el),
      setList: () => {},
      setHover: () => {},
      setStrip: () => {},
      setMatches: () => {},
      setShields: () => {},
      setOutlines: () => {},
      setItems: () => {},
    } as unknown as Overlay;
    const sent: PageMessage[] = [];
    (window as unknown as Record<string, unknown>)[HOST_BINDING] = async (msg: PageMessage) => {
      sent.push(msg);
      return { kind: 'draft.state', state };
    };
    const runtime = new Runtime({ win: window, overlay });
    runtime.store.setHost(state);
    return { runtime, sent, selected };
  }

  it('sends the iframe path and its candidates with a path and snapshot inside the iframe document', async () => {
    const frame = addFrame('app', '<main><h2 class="title">Inner</h2></main>');
    const { runtime, sent } = setup();
    const title = frame.contentDocument!.querySelector('h2')!;
    runtime.pick(title);
    await expect.poll(() => sent.length).toBe(1);
    const msg = sent[0] as Extract<PageMessage, { kind: 'picker.select' }>;
    expect(msg.selection.framePath).toEqual(pathOfElement(frame));
    expect(msg.selection.frame!.selectors[0]).toMatchObject({ strategy: 'id', value: 'app' });
    expect(msg.selection.path).toEqual(pathOfElement(title));
    expect(JSON.stringify(msg.snapshot)).toContain('Inner');
    expect(JSON.stringify(msg.snapshot)).not.toContain('Portal');
  });

  it('records a click inside an iframe with the iframe as its frame', async () => {
    const frame = addFrame('app', '<button id="go">Go</button>');
    const { runtime, sent } = setup();
    runtime.record({ kind: 'click', el: frame.contentDocument!.getElementById('go')! });
    await expect.poll(() => sent.length).toBe(1);
    const msg = sent[0] as Extract<PageMessage, { kind: 'draft.addStep' }>;
    expect(msg.step.kind).toBe('click');
    expect(msg.selection!.framePath).toEqual(pathOfElement(frame));
    expect(msg.selection!.frame!.selectors[0]).toMatchObject({ strategy: 'id', value: 'app' });
  });

  it('reads host paths in the iframe document the state names', async () => {
    const frame = addFrame('app', '<main><h2 class="title">Inner</h2></main>');
    const base = baseState();
    const h2 = frame.contentDocument!.querySelector('h2')!;
    const state: RecorderState = { ...base, frame: { path: null, selectors: [{ strategy: 'id', value: 'app', stability: 'stable' }] }, pendingSelect: { path: pathOfElement(h2) } };
    const { runtime, selected, sent } = setup(base);
    runtime.dispatch({ kind: 'draft.state', state });
    await expect.poll(() => selected.includes(h2)).toBe(true);
    expect((sent[0] as Extract<PageMessage, { kind: 'picker.select' }>).selection.framePath).toEqual(pathOfElement(frame));
  });
});
