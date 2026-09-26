import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, saveRecipe, type RecipeInput } from '@webscoop/core';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { describeOutcome } from '../src/commands/run';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/c/shoes';
const css = (value: string) => ({ strategy: 'css' as const, value, stability: 'medium' as const });

/** The price's only selector is dead and it has no fingerprint, so only the model can find it. */
const recipe: RecipeInput = {
  schemaVersion: 1,
  name: 'shop',
  url: PAGE,
  item: { selectors: [{ strategy: 'testid', value: 'card', stability: 'stable' }] },
  fields: [
    { name: 'title', type: 'text', scope: 'item', selectors: [css('h2')] },
    { name: 'price', type: 'number', scope: 'item', selectors: [css('.old-price')] },
  ],
};

const page = h(
  'html',
  {},
  h(
    'body',
    {},
    Array.from({ length: 3 }, (_, i) => h('div', { 'data-testid': 'card' }, h('h2', {}, `Shoe ${i}`), h('span', { class: 'cost' }, `$${i + 1}.00`))),
  ),
);

async function setup(script: unknown) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  await writeFile(join(dir, 'recipes', 'shop.json'), saveRecipe(loadRecipe(recipe)));
  await writeFile(join(dir, 'script.json'), JSON.stringify(script));
  const io = () => testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_LLM_MOCK: join(dir, 'script.json') }, browser: new FakeBrowser({ [PAGE]: page }) });
  return { dir, io };
}

const PICK_PRICE = [{ match: 'Field: price', pick: '"\\$\\d', reason: 'price with currency' }];

describe('model rung in the CLI', () => {
  it('describes a model outcome with its reason', () => {
    expect(describeOutcome({ kind: 'model', rationale: 'price with currency' }, css('span.cost'))).toBe('model: css=span.cost (price with currency)');
    expect(describeOutcome({ kind: 'model', rationale: '' }, css('span.cost'))).toBe('model: css=span.cost');
  });

  it('logs the healed field with the reason, reports it, and writes the recipe back', async () => {
    const { dir, io } = await setup(PICK_PRICE);
    const t = io();
    expect(await main(['run', 'shop', '--report'], t)).toBe(ExitCode.Ok);
    expect((JSON.parse(t.out()) as { price: number }[]).map((r) => r.price)).toEqual([1, 2, 3]);
    expect(t.err()).toMatch(/webscoop: healed price: model: \S+ \(price with currency\) \(was css=\.old-price\)\n/);
    const report = JSON.parse(t.err().slice(t.err().indexOf('{'), t.err().lastIndexOf('}') + 1)) as { fields: { name: string; outcome: unknown }[] };
    expect(report.fields.find((f) => f.name === 'price')!.outcome).toEqual({ kind: 'model', rationale: 'price with currency' });
    const saved = loadRecipe(await readFile(join(dir, 'recipes', 'shop.json'), 'utf8'));
    expect(saved.fields![1]!.selectors[0]).not.toEqual(css('.old-price'));
  });

  it('logs the model reason for a refused field in run and test', async () => {
    const { io } = await setup([{ match: 'Field: price', reply: { index: null, confidence: 0.9, reason: 'no price on the card' }, repeat: true }]);
    const t = io();
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Unresolved);
    expect(t.err()).toContain('field price: missing, unresolved (model: no pick (no price on the card))');
    const check = io();
    expect(await main(['test', 'shop', '--json'], check)).toBe(ExitCode.Unresolved);
    const rows = JSON.parse(check.out()) as { name: string; notes?: string[] }[];
    expect(rows.find((r) => r.name === 'price')!.notes).toEqual(['model: no pick (no price on the card)']);
  });

  it('skips the model with --no-llm', async () => {
    const { io } = await setup(PICK_PRICE);
    const t = io();
    expect(await main(['run', 'shop', '--no-llm'], t)).toBe(ExitCode.Unresolved);
    expect(t.err()).not.toContain('healed price');
    expect(t.err()).toContain('field price: missing, unresolved\n');
    const check = io();
    expect(await main(['test', 'shop', '--no-llm'], check)).toBe(ExitCode.Unresolved);
    expect(await main(['test', 'shop'], io())).toBe(ExitCode.Ok);
  });

  it('logs one line when the endpoint fails and goes on without the model', async () => {
    const { io } = await setup([{ error: 'connect ECONNREFUSED 127.0.0.1:11434' }]);
    const t = io();
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Unresolved);
    const lines = t.err().split('\n').filter((l) => l.includes('language model failed'));
    expect(lines).toEqual(['webscoop: language model failed on price, skipping the model for the rest of this run: connect ECONNREFUSED 127.0.0.1:11434']);
  });

  it('runs without the model when no endpoint is configured', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'recipes'), { recursive: true });
    await writeFile(join(dir, 'recipes', 'shop.json'), saveRecipe(loadRecipe(recipe)));
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: page }) });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Unresolved);
    expect(t.err()).not.toContain('language model');
  });
});
