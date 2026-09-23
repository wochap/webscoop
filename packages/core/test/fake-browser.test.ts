import { describe, expect, it } from 'vitest';
import type { SelectorCandidate, Session } from '../src';
import { FakeBrowser, h } from '../src/testing';
import { catalog, cards, PAGE } from './helpers';

async function open(dom = catalog(cards(3))): Promise<Session> {
  const session = await new FakeBrowser({ [PAGE]: dom }).open('/profile');
  await session.goto(PAGE, { timeoutMs: 1000 });
  return session;
}

const c = (strategy: SelectorCandidate['strategy'], value: string): SelectorCandidate => ({
  strategy,
  value,
  stability: 'medium',
});

async function texts(session: Session, candidate: SelectorCandidate) {
  const refs = await session.resolve(candidate);
  return Promise.all(refs.map((r) => session.read(r, { mode: 'text' })));
}

describe('FakeBrowser strategies', () => {
  it('resolves role with and without a name', async () => {
    const session = await open();
    expect(await texts(session, c('role', 'heading|Product 2'))).toEqual(['Product 2']);
    expect(await texts(session, c('role', 'heading'))).toHaveLength(4);
    expect(await texts(session, c('role', 'link|View details'))).toHaveLength(3);
  });

  it('resolves testid, id, and exact text', async () => {
    const session = await open();
    expect(await session.resolve(c('testid', 'product-card'))).toHaveLength(3);
    expect(await texts(session, c('id', 'p1'))).toEqual(['Product 2$2.00View details']);
    expect(await texts(session, c('text', 'Product 3'))).toEqual(['Product 3']);
    expect(await session.resolve(c('text', 'Product'))).toHaveLength(0);
  });

  it('resolves css selectors', async () => {
    const session = await open();
    expect(await texts(session, c('css', 'li:first-child h2.product-title'))).toEqual(['Product 1']);
    expect(await texts(session, c('css', 'ul > li > article [data-testid="price"]'))).toEqual([
      '$1.00',
      '$2.00',
      '$3.00',
    ]);
    expect(await session.resolve(c('css', 'a[href^="/p/"], h1'))).toHaveLength(4);
    expect(await texts(session, c('css', 'li:nth-of-type(2) h2'))).toEqual(['Product 2']);
  });

  it('resolves xpath, absolute and scoped', async () => {
    const session = await open();
    expect(await texts(session, c('xpath', '//ul/li[2]//h2'))).toEqual(['Product 2']);
    expect(await texts(session, c('xpath', "//a[@class='product-link' and contains(@href, '/2')]"))).toEqual([
      'View details',
    ]);
    expect(await texts(session, c('xpath', "//h2[text()='Product 1']"))).toEqual(['Product 1']);
    const [second] = await session.resolve(c('testid', 'product-card'));
    const scoped = await session.resolve(c('xpath', '//h2'), second);
    expect(await session.read(scoped[0]!, { mode: 'text' })).toBe('Product 1');
    expect(scoped).toHaveLength(1);
  });

  it('scopes resolution inside a container and reads attributes and html', async () => {
    const session = await open();
    const containers = await session.resolve(c('testid', 'product-card'));
    const [link] = await session.resolve(c('css', 'a'), containers[2]);
    expect(await session.read(link!, { attr: 'href', mode: 'text' })).toBe('/p/2');
    expect(await session.read(link!, { attr: 'missing', mode: 'text' })).toBe('');
    const [title] = await session.resolve(c('css', 'h2'), containers[0]);
    expect(await session.read(title!, { mode: 'html' })).toBe('Product 1');
    expect(await session.same(containers[0]!, containers[0]!)).toBe(true);
    expect(await session.same(containers[0]!, containers[1]!)).toBe(false);
  });

  it('times out navigation slower than the timeout', async () => {
    const browser = new FakeBrowser({ [PAGE]: { dom: h('html'), delayMs: 500 } });
    const session = await browser.open('/p');
    await expect(session.goto(PAGE, { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
});
