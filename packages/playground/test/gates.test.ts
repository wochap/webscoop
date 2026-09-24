import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { dataset, render, startPlayground, type Playground } from '../src';

const running: Playground[] = [];
async function start() {
  const pg = await startPlayground({ port: 0 });
  running.push(pg);
  return pg;
}
afterEach(async () => {
  await Promise.all(running.splice(0).map((pg) => pg.stop()));
});

/** Parsed without running scripts, as the page looks before any action. */
const doc = (html: string) => new JSDOM(html).window.document;
const ids = (root: ParentNode) => Array.from(root.querySelectorAll('[data-product-id]')).map((el) => el.getAttribute('data-product-id'));
const titles = (root: ParentNode) => Array.from(root.querySelectorAll('h2')).map((el) => el.textContent);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `p${String(from + i).padStart(2, '0')}`);

async function get(pg: Playground, path: string) {
  const res = await fetch(`${pg.url}${path}`, { redirect: 'manual' });
  return { res, html: await res.text() };
}

describe('cookie gate', () => {
  it('keeps the list in a template behind a consent modal', async () => {
    const pg = await start();
    const { res, html } = await get(pg, '/catalog?gate=cookie&tier=0');
    expect(res.status).toBe(200);
    const d = doc(html);
    expect(ids(d)).toEqual([]);
    const template = d.querySelector('main template') as HTMLTemplateElement;
    expect(ids(template.content)).toEqual(range(1, 24));
    const dialog = d.querySelector('[role="dialog"]')!;
    expect(dialog.parentElement!.className).toBe('consent-backdrop');
    const accept = d.getElementById('consent-accept')!;
    expect(accept.tagName).toBe('BUTTON');
    expect(accept.textContent).toBe('Accept all');
    expect(accept.className).toBe('consent-button btn-primary');
    expect(html).toContain("localStorage.getItem('ws_consent') === '1'");
    expect(html).toContain("localStorage.setItem('ws_consent', '1')");
  });

  it('renames the modal tokens with the tier and keeps pagination outside the template', () => {
    const html = render(dataset.slice(0, 8), { tier: 1, seed: 3, gate: { kind: 'cookie' }, pager: { kind: 'url', next: '/n' } });
    const d = doc(html);
    const accept = d.querySelector('[role="dialog"] button')!;
    expect(accept.textContent).toBe('Accept all');
    expect(accept.id).not.toBe('consent-accept');
    expect(accept.className).not.toContain('consent');
    expect(html).toContain(`.${accept.parentElement!.parentElement!.className} { position: fixed;`);
    expect(ids((d.querySelector('main template') as HTMLTemplateElement).content)).toHaveLength(8);
    expect(d.querySelector('a[rel="next"]')!.getAttribute('href')).toBe('/n');
  });
});

describe('search gate', () => {
  it('renders the form and no products without a query', async () => {
    const pg = await start();
    for (const path of ['/catalog?gate=search', '/catalog?gate=search&q=']) {
      const d = doc((await get(pg, path)).html);
      expect(ids(d)).toEqual([]);
      const form = d.querySelector('form[method="get"]') as HTMLFormElement;
      expect(form.getAttribute('action')).toBe('/catalog');
      expect(form.querySelector<HTMLInputElement>('input[name="q"]')!.value).toBe('');
      expect(form.querySelector('button[type="submit"]')).not.toBeNull();
      expect(d.querySelector('h1')!.textContent).toBe('Electronics');
    }
  });

  it('filters by title case-insensitively in dataset order and keeps the query', async () => {
    const pg = await start();
    const d = doc((await get(pg, '/catalog?gate=search&tier=0&q=mouse')).html);
    expect(titles(d)).toEqual(['Wireless Mouse']);
    expect(d.querySelector<HTMLInputElement>('input[name="q"]')!.value).toBe('mouse');
    const wireless = doc((await get(pg, '/catalog?gate=search&tier=0&q=WIRELESS')).html);
    expect(titles(wireless)).toEqual(['Wireless Mouse', 'Wireless Charger']);
  });

  it('escapes the query and carries the other parameters but page', async () => {
    const pg = await start();
    const d = doc((await get(pg, '/catalog?gate=search&tier=0&paginate=url&page=2&q=%22%3Cb%3E')).html);
    expect(d.querySelector<HTMLInputElement>('input[name="q"]')!.value).toBe('"<b>');
    expect(d.querySelector('b')).toBeNull();
    const hidden = Array.from(d.querySelectorAll<HTMLInputElement>('form input[type="hidden"]')).map((i) => [i.name, i.value]);
    expect(hidden).toEqual([
      ['gate', 'search'],
      ['tier', '0'],
      ['paginate', 'url'],
    ]);
  });

  it('paginates the matches', async () => {
    const pg = await start();
    const d = doc((await get(pg, '/catalog?gate=search&tier=0&paginate=url&q=e')).html);
    const matches = dataset.filter((p) => p.title.toLowerCase().includes('e')).map((p) => p.id);
    expect(ids(d)).toEqual(matches.slice(0, 8));
  });
});

describe('tabs gate', () => {
  it('renders About active and the list in a template in the hidden Products panel', async () => {
    const pg = await start();
    const d = doc((await get(pg, '/catalog?gate=tabs&tier=0')).html);
    expect(ids(d)).toEqual([]);
    const tabs = Array.from(d.querySelectorAll('div[role="tablist"] > button[role="tab"]'));
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['About', 'true'],
      ['Products', 'false'],
    ]);
    const [about, products] = Array.from(d.querySelectorAll<HTMLElement>('div[role="tabpanel"]'));
    expect(about!.hidden).toBe(false);
    expect(about!.querySelector('template, [data-product-id]')).toBeNull();
    expect(about!.textContent!.trim()).not.toBe('');
    expect(products!.hidden).toBe(true);
    expect(ids((products!.querySelector('template') as HTMLTemplateElement).content)).toEqual(range(1, 24));
  });

  it('composes with url pagination, keeping the pager outside the panels', async () => {
    const pg = await start();
    const d = doc((await get(pg, '/catalog?gate=tabs&tier=0&paginate=url&page=2')).html);
    expect(ids(d)).toEqual([]);
    expect(ids((d.querySelector('template') as HTMLTemplateElement).content)).toEqual(range(9, 16));
    const next = d.querySelector('nav[aria-label="Pagination"] a[rel="next"]')!;
    expect(next.getAttribute('href')).toBe('/catalog?gate=tabs&tier=0&paginate=url&page=3');
    expect(next.closest('[role="tabpanel"]')).toBeNull();
  });
});

describe('gate parameter', () => {
  it('rejects an unknown gate and leaves ungated pages alone', async () => {
    const pg = await start();
    expect((await get(pg, '/catalog?gate=modal')).res.status).toBe(400);
    const plain = (await get(pg, '/catalog?tier=0')).html;
    for (const marker of ['<template', 'consent', 'role="tab', 'role="search"']) expect(plain).not.toContain(marker);
  });
});
