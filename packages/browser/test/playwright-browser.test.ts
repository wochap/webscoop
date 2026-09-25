import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotate, descendantsOf, refForNode, TimeoutError, xpathFor, type SelectorCandidate, type SerializedElement, type Session } from '@webscoop/core';
import { FakeBrowser } from '@webscoop/core/testing';
import { dataset, startPlayground, type Playground } from '@webscoop/playground';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightBrowser } from '../src';

const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

const c = (strategy: SelectorCandidate['strategy'], value: string): SelectorCandidate => ({
  strategy,
  value,
  stability: 'medium',
});

describe.skipIf(!hasDisplay)('PlaywrightBrowser title (integration)', () => {
  it('sets the document title before the first navigation', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'webscoop-browser-'));
    const session = await new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined }).open(profileDir);
    try {
      await session.setTitle('webscoop');
      const page = (session as unknown as { page: import('playwright').Page }).page;
      expect(page.url()).toBe('about:blank');
      expect(await page.evaluate(() => document.title)).toBe('webscoop');
    } finally {
      await session.close();
      await rm(profileDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasDisplay)('PlaywrightBrowser (integration)', () => {
  let playground: Playground;
  let profileDir: string;
  let session: Session;

  beforeAll(async () => {
    playground = await startPlayground({ port: 0 });
    profileDir = await mkdtemp(join(tmpdir(), 'webscoop-browser-'));
    const browser = new PlaywrightBrowser({ executablePath: process.env.WEBSCOOP_CHROMIUM || undefined });
    session = await browser.open(profileDir);
  });

  afterAll(async () => {
    await session?.close();
    await playground?.stop();
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
  });

  const catalog = () => `${playground.url}/catalog?tier=0`;

  async function texts(candidate: SelectorCandidate, within?: Parameters<Session['resolve']>[1]) {
    const refs = await session.resolve(candidate, within);
    return Promise.all(refs.map(async (r) => (await session.read(r, { mode: 'text' })).trim()));
  }

  it('opens the playground without advertising automation', async () => {
    const info = await session.goto(catalog(), { timeoutMs: 10_000 });
    expect(info.status).toBe(200);
    expect(info.url).toBe(catalog());
    const page = (session as unknown as { page: import('playwright').Page }).page;
    expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
  });

  it('reads the visible page text and brings the window to the front', async () => {
    await session.goto(catalog(), { timeoutMs: 10_000 });
    const text = await session.pageText();
    expect(text).toContain(dataset[0]!.title);
    expect(text).not.toMatch(/\s{2}/);
    expect(text.length).toBeLessThanOrEqual(4000);
    await session.focus();
  });

  it('waits for a slow page within the timeout', async () => {
    const info = await session.goto(`${playground.url}/catalog?tier=0&delayMs=1500`, { timeoutMs: 10_000 });
    expect(info.status).toBe(200);
  });

  it('fails with a TimeoutError when the page is slower than the timeout', async () => {
    await expect(
      session.goto(`${playground.url}/catalog?tier=0&delayMs=1500`, { timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('resolves the tier 0 title by role, testid, css, and xpath', async () => {
    await session.goto(catalog(), { timeoutMs: 10_000 });
    const first = dataset[0]!.title;
    expect(await texts(c('role', `heading|${first}`))).toEqual([first]);
    expect(await session.resolve(c('testid', 'product-card'))).toHaveLength(24);
    expect(await texts(c('css', 'article.product-card h2.product-title'))).toHaveLength(24);
    expect(await texts(c('xpath', `//h2[text()='${first}']`))).toEqual([first]);
    expect(await texts(c('id', 'product-p02'))).toHaveLength(1);
    expect(await texts(c('text', dataset[2]!.title))).toEqual([dataset[2]!.title]);
  });

  it('resolves a bare role and a class candidate, inside a list parent too', async () => {
    await session.goto(catalog(), { timeoutMs: 10_000 });
    const [list] = await session.resolve(c('role', 'list'));
    expect(list).toBeDefined();
    expect(await session.resolve(c('role', 'listitem'))).toHaveLength(24);
    expect(await session.resolve(c('role', 'listitem'), list)).toHaveLength(24);
    expect(await texts(c('class', 'ul.product-list h2.product-title'))).toHaveLength(24);
    expect(await texts(c('class', 'h2.product-title'), (await session.resolve(c('role', 'listitem')))[1])).toEqual([dataset[1]!.title]);
  });

  it('scopes a field inside one container and reads attributes and html', async () => {
    await session.goto(catalog(), { timeoutMs: 10_000 });
    const cards = await session.resolve(c('testid', 'product-card'));
    const third = cards[2]!;
    expect(await texts(c('role', 'heading'), third)).toEqual([dataset[2]!.title]);
    expect(await texts(c('xpath', '//h2'), third)).toEqual([dataset[2]!.title]);
    const [link] = await session.resolve(c('css', 'a'), third);
    expect(await session.read(link!, { attr: 'href', mode: 'text' })).toBe(dataset[2]!.url);
    const [price] = await session.resolve(c('testid', 'price'), third);
    expect(await session.read(price!, { mode: 'html' })).toBe('$34.50');
    expect(await session.same(cards[0]!, cards[0]!)).toBe(true);
    expect(await session.same(cards[0]!, cards[1]!)).toBe(false);
  });

  it('produces a snapshot the FakeBrowser resolves the same way', async () => {
    await session.goto(catalog(), { timeoutMs: 10_000 });
    const snapshot = (await session.snapshot()) as SerializedElement;
    expect(snapshot.tag).toBe('html');
    const fake = await new FakeBrowser({ [catalog()]: snapshot }).open('/fake');
    await fake.goto(catalog(), { timeoutMs: 1000 });
    const candidates = [
      c('role', `heading|${dataset[0]!.title}`),
      c('testid', 'price'),
      c('css', 'a.product-link'),
      c('xpath', '//ul/li[5]//h2'),
      c('text', dataset[7]!.title),
      c('role', 'listitem'),
      c('class', 'article.product-card h2.product-title'),
    ];
    for (const candidate of candidates) {
      const live = await texts(candidate);
      const fakeRefs = await fake.resolve(candidate);
      const offline = await Promise.all(fakeRefs.map(async (r) => (await fake.read(r, { mode: 'text' })).trim()));
      expect(offline, `${candidate.strategy}=${candidate.value}`).toEqual(live);
    }
    const [card] = await session.resolve(c('testid', 'product-card'));
    const sub = (await session.snapshot(card)) as SerializedElement;
    expect(sub.attrs['data-testid']).toBe('product-card');
  });

  it('scopes css combinators strictly inside the scope element, and a leading // xpath below it, like the FakeBrowser', async () => {
    const results = `${playground.url}/results`;
    await session.goto(results, { timeoutMs: 10_000 });
    const fake = await new FakeBrowser({ [results]: (await session.snapshot()) as SerializedElement }).open('/fake');
    await fake.goto(results, { timeoutMs: 1000 });
    const cases: [SelectorCandidate, number][] = [
      // A combinator never reaches the scope element or its ancestors.
      [c('css', 'div.main div.Mjj4Yd'), 0],
      [c('css', 'div#rso > div'), 0],
      [c('css', 'div > div.Mjj4Yd'), 8],
      [c('class', 'div.Mjj4Yd'), 8],
      // A leading `//` becomes `.//`: it searches below the scope, never from the document root.
      [c('xpath', "//div[@id='rso']/div[1]/div[1]"), 0],
      [c('xpath', "//div[@class='Mjj4Yd']"), 8],
      [c('xpath', './div[1]/div[1]'), 1],
    ];
    const [rso] = await session.resolve(c('id', 'rso'));
    const [fakeRso] = await fake.resolve(c('id', 'rso'));
    for (const [candidate, expected] of cases) {
      const label = `${candidate.strategy}=${candidate.value}`;
      expect((await session.resolve(candidate, rso)).length, label).toBe(expected);
      expect((await fake.resolve(candidate, fakeRso)).length, `fake ${label}`).toBe(expected);
    }
  });

  it('measures every element in snapshots, and positional xpaths address the same element', async () => {
    await session.goto(catalog(), { timeoutMs: 10_000 });
    const root = annotate((await session.snapshot()) as SerializedElement);
    const cards = descendantsOf(root).filter((n) => n.attrs['data-testid'] === 'product-card');
    expect(cards).toHaveLength(24);
    for (const card of cards) {
      expect(card.bbox!.w).toBeGreaterThan(0);
      expect(card.bbox!.h).toBeGreaterThan(0);
    }
    const prices = descendantsOf(root).filter((n) => n.attrs['data-testid'] === 'price');
    const byXpath = await refForNode(session, prices[6]!);
    const byTestid = (await session.resolve(c('testid', 'price')))[6]!;
    expect(xpathFor(prices[6]!)).toBe('/html[1]/body[1]/main[1]/ul[1]/li[7]/article[1]/p[1]');
    expect(await session.same(byXpath!, byTestid)).toBe(true);

    const fake = await new FakeBrowser({ [catalog()]: (await session.snapshot()) as SerializedElement }).open('/fake');
    await fake.goto(catalog(), { timeoutMs: 1000 });
    const fakeRef = await refForNode(fake, prices[6]!);
    expect(await fake.read(fakeRef!, { mode: 'text' })).toBe(await session.read(byXpath!, { mode: 'text' }));

    const [card] = await session.resolve(c('testid', 'product-card'));
    const sub = annotate((await session.snapshot(card)) as SerializedElement);
    const title = descendantsOf(sub).find((n) => n.tag === 'h2')!;
    expect(xpathFor(title)).toBe('./h2[1]');
    expect((await session.read((await refForNode(session, title, card))!, { mode: 'text' })).trim()).toBe(dataset[0]!.title);
  });

  it('clicks the playground Next link and settles on page 2', async () => {
    const first = `${playground.url}/catalog?paginate=url&tier=0`;
    await session.goto(first, { timeoutMs: 10_000 });
    const [next] = await session.resolve(c('role', 'link|Next'));
    await session.click(next!);
    const info = await session.settle({ timeoutMs: 10_000, previousUrl: first });
    expect(info.url).toBe(`${playground.url}/catalog?paginate=url&tier=0&page=2`);
    expect(info.status).toBe(200);
    expect(await session.url()).toBe(info.url);
    expect(await texts(c('testid', 'product-card'))).toHaveLength(8);
    expect((await texts(c('role', 'heading')))[1]).toBe(dataset[8]!.title);
  });

  it('settles after a click that redirects back to the same URL', async () => {
    const url = `${playground.url}/catalog?paginate=next&tier=0`;
    await session.goto(url, { timeoutMs: 10_000 });
    await session.click((await session.resolve(c('role', 'link|Next')))[0]!);
    const info = await session.settle({ timeoutMs: 10_000, previousUrl: url });
    expect(info.url).toBe(url);
    expect((await texts(c('role', 'heading')))[1]).toBe(dataset[8]!.title);
  });

  it('grows the list on a load-more click and on scrolling to the bottom', async () => {
    await session.goto(`${playground.url}/catalog?paginate=more&tier=1`, { timeoutMs: 10_000 });
    const cards = () => session.resolve(c('role', 'article'));
    expect(await cards()).toHaveLength(8);
    await session.click((await session.resolve(c('role', 'button|Load more')))[0]!);
    await expect.poll(async () => (await cards()).length).toBe(16);

    await session.goto(`${playground.url}/catalog?paginate=scroll&tier=0`, { timeoutMs: 10_000 });
    expect(await cards()).toHaveLength(8);
    await session.scrollToBottom();
    await expect.poll(async () => (await cards()).length).toBe(16);
    const settled = await session.settle({ timeoutMs: 10_000 });
    expect(settled.url).toBe(`${playground.url}/catalog?paginate=scroll&tier=0`);
  });

  it('fills the playground search form and submits it with Enter', async () => {
    const url = `${playground.url}/catalog?gate=search&tier=0`;
    await session.goto(url, { timeoutMs: 10_000 });
    expect(await session.resolve(c('testid', 'product-card'))).toHaveLength(0);
    const [input] = await session.resolve(c('css', 'input[name="q"]'));
    await session.fill(input!, 'mouse');
    await session.press('Enter', input);
    const info = await session.settle({ timeoutMs: 10_000, previousUrl: url });
    expect(new URL(info.url).searchParams.get('q')).toBe('mouse');
    const titles = await texts(c('css', '.product-title'));
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title.toLowerCase()).toContain('mouse');
    const [kept] = await session.resolve(c('css', 'input[name="q"]'));
    const page = (session as unknown as { page: import('playwright').Page }).page;
    expect(await page.locator('input[name="q"]').inputValue()).toBe('mouse');
    expect(kept).toBeDefined();
  });

  it('selects an option by value or label and fails fast on a missing one', async () => {
    await session.goto(catalog(), { timeoutMs: 10_000 });
    const page = (session as unknown as { page: import('playwright').Page }).page;
    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<select id="sort"><option value="a">Name</option><option value="p">Price</option></select>');
    });
    const [select] = await session.resolve(c('id', 'sort'));
    await session.selectOption(select!, 'Price');
    expect(await page.locator('#sort').inputValue()).toBe('p');
    await session.selectOption(select!, 'a');
    expect(await page.locator('#sort').inputValue()).toBe('a');
    await expect(session.selectOption(select!, 'Rating')).rejects.toThrow(/no option/);
  });
});
