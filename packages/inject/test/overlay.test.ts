// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyDraft, HOST_BINDING, type PageMessage, type RecorderState } from '@webscoop/core';
import { dataset, render } from '@webscoop/playground';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptList, byClass, harness, openList } from '../../core/test/recorder-helpers';
import { tier0Snapshot } from '../../core/test/snapshot';
import { LEVEL_COLORS, MAX_DIM_CONTAINERS } from '../src/levels';
import { Overlay } from '../src/overlay';
import { Runtime } from '../src/runtime';

const MIXED = 'http://127.0.0.1:4777/catalog?mixed=1';

describe('level colors', () => {
  it('equal the --ws-level-* tokens of the panel', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8');
    const token = (name: string): string => {
      const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)![1]!.trim();
      const ref = /^var\(--([\w-]+)\)$/.exec(value);
      return ref ? token(ref[1]!) : value;
    };
    for (const level of ['list', 'item', 'field', 'page'] as const) expect(LEVEL_COLORS[level], level).toBe(token(`ws-level-${level}`));
  });
});

/** The mixed catalog in the document, and host states with `products` active and `questions` as a second list. */
async function lists(): Promise<{ state: RecorderState; page: RecorderState }> {
  const html = render(dataset, { tier: 0, seed: 1, mixed: true });
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
  const t = await harness(tier0Snapshot({ mixed: true }), emptyDraft({ name: 'shop-catalog', url: MIXED, vars: [] }), MIXED);
  await openList(t, byClass(t.page, 'product-title', 0));
  await acceptList(t);
  await t.send({ kind: 'draft.renameTable', name: 'products' });
  await t.send({ kind: 'draft.addTable', name: 'questions' });
  await openList(t, byClass(t.page, 'questions-title', 0));
  const own = t.controller.state.proposal!.proposed.selectors.findIndex((c) => c.value === 'article.mixed-questions');
  await t.send({ kind: 'draft.setPrimary', level: 'item', index: own });
  await acceptList(t);
  await t.send({ kind: 'draft.addTable', name: 'summary' });
  const page = t.controller.state;
  await t.send({ kind: 'draft.selectTable', index: 0 });
  return { state: t.controller.state, page };
}

function setup(state: RecorderState) {
  (window as unknown as Record<string, unknown>)[HOST_BINDING] = async (_msg: PageMessage) => ({ kind: 'draft.state', state });
  const layer = document.createElement('div');
  document.body.appendChild(layer);
  const overlay = new Overlay(layer);
  const runtime = new Runtime({ win: window, overlay });
  runtime.store.setHost(state);
  return { runtime, overlay };
}

const count = (overlay: Overlay) => {
  const out: Record<string, number> = {};
  for (const b of overlay.boxes()) out[b.variant] = (out[b.variant] ?? 0) + 1;
  return out;
};

describe('list outlines while picking', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('outlines the active list parent and containers, mutes other lists with a label, and dims the page', async () => {
    const { state } = await lists();
    expect(state.otherLists).toHaveLength(1);
    const { runtime, overlay } = setup(state);
    dispose = () => {
      runtime.dispose();
      overlay.dispose();
    };
    expect(count(overlay)['item']).toBeUndefined();
    runtime.startPicking();
    const boxes = count(overlay);
    expect(boxes).toMatchObject({ 'list-parent': 1, item: 24, 'other-list': 6, dim: 1 });
    const labels = Array.from(document.querySelectorAll('.ws-list-label')).map((l) => l.textContent);
    expect(labels).toEqual(['products · list · 24', 'questions · list · 6']);
    runtime.cancelPicking();
    expect(count(overlay)['item']).toBeUndefined();
    expect(count(overlay)['dim']).toBeUndefined();
  });

  it('says which item the hover is in, or that it is outside the list', async () => {
    const { state } = await lists();
    const { runtime, overlay } = setup(state);
    dispose = () => {
      runtime.dispose();
      overlay.dispose();
    };
    runtime.startPicking();
    const cards = Array.from(document.querySelectorAll('[data-testid="product-card"]'));
    runtime.hover(cards[2]!.querySelector('h2')!);
    expect(overlay.tagMarkup).toContain('item 3 of 24');
    runtime.hover(document.querySelector('.category-heading')!);
    expect(overlay.tagMarkup).toContain('<em class="ws-outside">outside products list</em>');
    expect(document.querySelector('.ws-box-hover.ws-outside')).not.toBeNull();
  });

  it('looks as before while picking in a page table or a table with no mode', async () => {
    const { page } = await lists();
    const { runtime, overlay } = setup(page);
    dispose = () => {
      runtime.dispose();
      overlay.dispose();
    };
    runtime.startPicking();
    expect(count(overlay)).not.toHaveProperty('item');
    expect(count(overlay)).not.toHaveProperty('dim');
    runtime.hover(document.querySelector('.category-heading')!);
    expect(overlay.tagMarkup).not.toContain('outside');
    expect(overlay.tagMarkup).not.toContain('item ');
  });

  it('skips the dim above the container limit and keeps the outlines', () => {
    const layer = document.createElement('div');
    document.body.appendChild(layer);
    const overlay = new Overlay(layer);
    const items = Array.from({ length: MAX_DIM_CONTAINERS + 1 }, () => document.body.appendChild(document.createElement('div')));
    overlay.setOutlines({ parent: null, items, others: [] });
    expect(count(overlay)).toEqual({ item: MAX_DIM_CONTAINERS + 1 });
    overlay.setOutlines({ parent: null, items: items.slice(0, 3), others: [] });
    expect(count(overlay)).toEqual({ dim: 1, item: 3 });
    overlay.dispose();
  });
});
