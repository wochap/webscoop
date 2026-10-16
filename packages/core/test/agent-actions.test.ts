import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src';
import { AgentActions, HISTORY_MAX, invalidAnswerResult, parseAction, type AgentAction } from '../src/agent/actions';
import { buildOutline, type Outline } from '../src/agent/outline';
import { RunWindows } from '../src/flows/windows';
import type { AgentScope } from '../src/recipe/schema';
import { FakeBrowser, h, type FakeInteractiveSession } from '../src/testing';

const START = 'https://h.test/report';

const page = (...body: unknown[]) => h('html', {}, h('head', {}, h('title', {}, 'Report')), h('body', {}, ...(body as never[])));

async function setup(pages: ConstructorParameters<typeof FakeBrowser>[0], scope: AgentScope = 'page') {
  const browser = new FakeBrowser(pages);
  const session = (await browser.open('/p', { downloadDir: '/dl' })) as FakeInteractiveSession;
  await session.goto(START, { timeoutMs: 1000 });
  const windows = new RunWindows(session);
  let stopped = false;
  const history = [START];
  const actions = new AgentActions({ session, windows, timeoutMs: 1000, scope, history, sleep: async () => {}, stop: () => stopped });
  const outline = async (): Promise<Outline> => buildOutline(await session.snapshot(), 5000, estimateTokens);
  const run = async (action: AgentAction, at?: Outline) => actions.run(action, at ?? (await outline()));
  return { browser, session, windows, run, outline, history, stop: () => (stopped = true) };
}

const click = (ref: string): AgentAction => ({ action: 'click', ref, reason: '' });

describe('agent actions', () => {
  it('parses valid actions and names the problem of invalid ones', () => {
    expect(parseAction({ action: 'click', ref: '[e3]', reason: 'go' })).toEqual({ ok: true, action: { action: 'click', ref: 'e3', reason: 'go' } });
    expect(parseAction({ action: 'wait', ms: 100 })).toMatchObject({ ok: true });
    const tap = parseAction({ action: 'tap', ref: 'e2' });
    expect(tap).toEqual({ ok: false, problem: 'the action "tap" is unknown' });
    expect(invalidAnswerResult((tap as { problem: string }).problem)).toMatch(/unknown[\s\S]*"action":"click"[\s\S]*"action":"give_up"/);
    expect(parseAction({ action: 'wait', ms: 9000 })).toMatchObject({ ok: false });
    expect(parseAction({ action: 'fill', ref: 'e1' })).toMatchObject({ ok: false });
    expect(parseAction('click')).toMatchObject({ ok: false });
  });

  it('reports a URL and title change for a click inside the scope', async () => {
    const { run, session } = await setup({ [START]: page(h('a', { href: '#downloads' }, 'Downloads')), [`${START}#downloads`]: page(h('p', {}, 'Downloads')) });
    const result = await run(click('e1'));
    expect(result.text).toContain('Clicked e1');
    expect(result.text).toContain(`${START}#downloads`);
    expect(await session.url()).toBe(`${START}#downloads`);
  });

  it('undoes a navigation to another page', async () => {
    const { run, session } = await setup({ [START]: page(h('a', { href: '/about' }, 'About')), 'https://h.test/about': page(h('p', {}, 'About us')) });
    const result = await run(click('e1'));
    expect(result.text).toContain('https://h.test/about');
    expect(result.text).toContain("outside this step's scope");
    expect(result.text).toContain('restored');
    expect(await session.url()).toBe(START);
  });

  it('leaves a popup that only started a download and reports the file', async () => {
    const browser = new FakeBrowser();
    const session = (await browser.open('/p', { downloadDir: '/dl' })) as FakeInteractiveSession;
    browser.setPage(START, {
      dom: page(h('button', {}, 'Export')),
      on: {
        click: () => {
          const popup = session.openPopup('about:blank');
          popup.startDownload('https://h.test/r.pdf', { name: 'r.pdf', bytes: 5 });
          void popup.userClose();
        },
      },
    });
    await session.goto(START, { timeoutMs: 1000 });
    const actions = new AgentActions({ session, windows: new RunWindows(session), timeoutMs: 1000, scope: 'page', history: [START], sleep: async () => {}, stop: () => false });
    const result = await actions.run(click('e1'), buildOutline(await session.snapshot(), 5000, estimateTokens));
    expect(result.text).toContain('A download was saved as r.pdf');
    expect(result.text).not.toContain('popup was closed');
    expect(await session.url()).toBe(START);
  });

  it('closes a popup that loaded a document', async () => {
    const browser = new FakeBrowser({ 'https://h.test/doc': page(h('p', {}, 'Doc')) });
    const session = (await browser.open('/p')) as FakeInteractiveSession;
    browser.setPage(START, { dom: page(h('button', {}, 'Open')), on: { click: () => ({ popup: '/doc' }) } });
    await session.goto(START, { timeoutMs: 1000 });
    const actions = new AgentActions({ session, windows: new RunWindows(session), timeoutMs: 1000, scope: 'page', history: [START], sleep: async () => {}, stop: () => false });
    const result = await actions.run(click('e1'), buildOutline(await session.snapshot(), 5000, estimateTokens));
    expect(result.text).toContain('popup at https://h.test/doc');
    expect(result.text).toContain('closed');
    expect(browser.popups[0]!.isClosed()).toBe(true);
  });

  it('answers a stale ref without acting', async () => {
    const { run, session, browser } = await setup({ [START]: page(h('button', {}, 'Export')) });
    const outline = await (async () => buildOutline(await session.snapshot(), 5000, estimateTokens))();
    session.replaceDom(page(h('p', {}, 'Gone')));
    const result = await run(click('e1'), outline);
    expect(result.text).toContain('e1 is stale');
    expect(browser.clicks).toHaveLength(0);
    const unknown = await run(click('e9'));
    expect(unknown.text).toContain('e9 is stale');
  });

  it('executes a repeated click and says it was already done', async () => {
    const { run, browser } = await setup({ [START]: page(h('button', {}, 'Export')) });
    const first = await run(click('e1'));
    expect(first.text).not.toContain('already');
    const second = await run(click('e1'));
    expect(second.text).toContain('already did exactly this');
    expect(browser.clicks).toHaveLength(2);
  });

  it('fills, presses, scrolls, waits, finds, and shows html', async () => {
    const { run, browser } = await setup({ [START]: page(h('input', { type: 'text', placeholder: 'Email' }), h('a', { href: '#x' }, 'Get PDF')) });
    expect((await run({ action: 'fill', ref: 'e1', value: 'a@b.c', reason: '' })).text).toContain('Filled e1');
    expect(browser.actions).toContainEqual({ kind: 'fill', target: expect.any(String), value: 'a@b.c' });
    expect((await run({ action: 'press', key: 'Enter', ref: 'e1', reason: '' })).text).toContain('Pressed Enter on e1');
    expect((await run({ action: 'scroll', direction: 'down', reason: '' })).text).toContain('Scrolled down');
    expect((await run({ action: 'wait', ms: 50, reason: '' })).text).toBe('waited 50 ms');
    expect((await run({ action: 'find', text: 'pdf', reason: '' })).text).toContain('[e2] link "Get PDF"');
    expect((await run({ action: 'find', text: 'zzz', reason: '' })).text).toContain('no line contains');
    expect((await run({ action: 'html', ref: 'e2', reason: '' })).text).toBe('<a href="#x">Get PDF</a>');
  });

  it('stops at once when the end condition holds', async () => {
    const { run, stop } = await setup({ [START]: page(h('a', { href: '/about' }, 'About')), 'https://h.test/about': page() });
    stop();
    const result = await run(click('e1'));
    expect(result.stopped).toBe(true);
  });

  it('keeps a same-origin navigation under site scope and records it', async () => {
    const { run, session, history } = await setup({ [START]: page(h('a', { href: '/contact/thanks' }, 'Send')), 'https://h.test/contact/thanks': page(h('p', {}, 'Thanks')) }, 'site');
    const result = await run(click('e1'));
    expect(result.text).toContain('The page URL is now https://h.test/contact/thanks');
    expect(result.text).not.toContain('restored');
    expect(await session.url()).toBe('https://h.test/contact/thanks');
    expect(history).toEqual([START, 'https://h.test/contact/thanks']);
  });

  it('undoes another origin under site scope to the latest entry, not the start', async () => {
    const { run, session, history } = await setup(
      {
        [START]: page(h('a', { href: '/cart' }, 'Cart')),
        'https://h.test/cart': page(h('a', { href: 'https://pay.other.test/' }, 'Pay')),
        'https://pay.other.test/': page(h('p', {}, 'Pay')),
      },
      'site',
    );
    await run(click('e1'));
    const result = await run(click('e1'));
    expect(result.text).toContain("https://pay.other.test/, which is outside this step's scope");
    expect(result.text).toContain('restored');
    expect(await session.url()).toBe('https://h.test/cart');
    expect(history).toEqual([START, 'https://h.test/cart']);
  });

  it('keeps page scope unchanged: the history never grows', async () => {
    const { run, history } = await setup({ [START]: page(h('a', { href: '/about' }, 'About')), 'https://h.test/about': page() });
    await run(click('e1'));
    expect(history).toEqual([START]);
    expect((await run({ action: 'back', reason: '' })).text).toContain('no earlier page');
  });

  it('goes back to the previous document', async () => {
    const { run, session, history } = await setup(
      {
        [START]: page(h('a', { href: '/search?q=lamp' }, 'Search')),
        'https://h.test/search?q=lamp': page(h('a', { href: '/item/7' }, 'Lamp')),
        'https://h.test/item/7': page(h('p', {}, 'Lamp')),
      },
      'site',
    );
    await run(click('e1'));
    await run(click('e1'));
    const result = await run({ action: 'back', reason: '' });
    expect(result.text).toContain('Went back to https://h.test/search?q=lamp');
    expect(result.text).toContain('loaded again from its URL');
    expect(await session.url()).toBe('https://h.test/search?q=lamp');
    expect(history.at(-1)).toBe('https://h.test/search?q=lamp');
  });

  it('answers back on the first page without acting', async () => {
    const { run, session, browser } = await setup({ [START]: page(h('p', {}, 'Hi')) }, 'site');
    const result = await run({ action: 'back', reason: '' });
    expect(result.text).toContain('there is no earlier page');
    expect(await session.url()).toBe(START);
    expect(browser.clicks).toHaveLength(0);
  });

  it('caps the history and keeps the start URL', async () => {
    const pages: Record<string, ReturnType<typeof page>> = {};
    const count = HISTORY_MAX + 5;
    pages[START] = page(h('a', { href: '/p/1' }, 'Next'));
    for (let n = 1; n <= count; n++) pages[`https://h.test/p/${n}`] = page(h('a', { href: `/p/${n + 1}` }, 'Next'));
    const { run, history } = await setup(pages, 'site');
    for (let n = 1; n <= count; n++) await run(click('e1'));
    expect(history).toHaveLength(HISTORY_MAX);
    expect(history[0]).toBe(START);
    expect(history.at(-1)).toBe(`https://h.test/p/${count}`);
  });

  it('does not push a fragment change', async () => {
    const { run, history } = await setup({ [START]: page(h('a', { href: '#downloads' }, 'Downloads')), [`${START}#downloads`]: page(h('p', {}, 'Downloads')) }, 'site');
    await run(click('e1'));
    expect(history).toEqual([START]);
  });
});
