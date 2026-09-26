import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, saveRecipe, type RecipeInput, type RunReport, type StepReport } from '@webscoop/core';
import { FakeBrowser, h, type FakePage } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { formatStep, stepsFromFlags, summary } from '../src/commands/run';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/c/shoes';
const sel = (strategy: 'css' | 'testid', value: string) => ({ strategy, value, stability: strategy === 'testid' ? ('stable' as const) : ('medium' as const) });

function recipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 1,
    name: 'shop',
    url: PAGE,
    item: { selectors: [sel('testid', 'card')] },
    fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [sel('css', 'h2')] }],
    steps: [
      { kind: 'click', target: { selectors: [sel('css', '#accept')] } },
      { kind: 'click', target: { selectors: [sel('css', '#newsletter-close')] }, optional: true },
    ],
    ...overrides,
  };
}

const shop = (n: number) => h('html', {}, h('body', {}, Array.from({ length: n }, (_, i) => h('div', { 'data-testid': 'card' }, h('h2', {}, `Shoe ${i}`)))));
/** Products behind a cookie banner, until its button is clicked. */
const gated = (): FakePage => ({
  dom: h('html', {}, h('body', {}, h('div', { id: 'modal' }, h('button', { id: 'accept' }, 'Accept all')))),
  on: { click: (el) => (el?.attrs.id === 'accept' ? shop(3) : undefined) },
});

async function home(recipes: RecipeInput[] = [recipe()]) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  for (const r of recipes) await writeFile(join(dir, 'recipes', `${r.name}.json`), saveRecipe(loadRecipe(r)));
  return dir;
}

const report = (extra: Partial<StepReport> = {}): StepReport => ({
  index: 0,
  kind: 'click',
  page: 1,
  outcome: 'ok',
  heal: { kind: 'candidate', index: 0 },
  candidate: sel('css', '#accept'),
  ...extra,
});

describe('step flags and logs', () => {
  it('maps --skip-steps to disabled steps', () => {
    expect(stepsFromFlags({})).toEqual({ enabled: true });
    expect(stepsFromFlags({ skipSteps: true })).toEqual({ enabled: false });
  });

  it('formats one line per replayed or skipped step', () => {
    expect(formatStep(report())).toBe('step 0 (click) on page 1: ok, candidate 0: css=#accept');
    expect(formatStep(report({ index: 2, label: 'consent', page: 3, outcome: 'healed', heal: { kind: 'fuzzy', score: 0.83 } }))).toBe(
      'step 2 "consent" (click) on page 3: healed, fuzzy 0.83: css=#accept',
    );
    expect(formatStep(report({ outcome: 'skipped', heal: { kind: 'unresolved' }, candidate: null, notes: ['found no element'] }))).toBe(
      'step 0 (click) on page 1: skipped (found no element)',
    );
    expect(formatStep(report({ kind: 'wait', heal: null, candidate: null }))).toBe('step 0 (wait) on page 1: ok');
  });

  it('mentions skipped steps in the summary', () => {
    const base = { recipe: 'shop', durationMs: 1000, pageCount: 1, rowCount: 3, tables: [], healed: 0, guards: [], duplicateCount: 0 } as unknown as RunReport;
    expect(summary({ ...base, steps: [report()] })).toBe('3 rows from 1 page in 1.00s (shop)');
    expect(summary({ ...base, steps: [report(), report({ index: 1, outcome: 'skipped' })] })).toBe('3 rows from 1 page, 1 step skipped in 1.00s (shop)');
  });
});

describe('webscoop run and test with steps', () => {
  it('replays the steps, logs each one, and extracts behind the banner', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: gated() }) });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Ok);
    expect(JSON.parse(t.out())).toHaveLength(3);
    expect(t.err()).toContain('step 0 (click) on page 1: ok, candidate 0: css=#accept');
    expect(t.err()).toContain('step 1 (click) on page 1: skipped (found no element)');
    expect(t.err()).toContain('3 rows from 1 page, 1 step skipped in');
  });

  it('replays no step with --skip-steps, so the fields behind the banner are missing (exit 3)', async () => {
    const dir = await home();
    const browser = new FakeBrowser({ [PAGE]: gated() });
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--skip-steps', '--no-guards'], t)).toBe(ExitCode.Unresolved);
    expect(browser.clicks).toEqual([]);
    expect(t.err()).not.toContain('step 0');
  });

  it('replays steps in test by default and exits 0', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: gated() }) });
    expect(await main(['test', 'shop'], t)).toBe(ExitCode.Ok);
    expect(t.err()).toContain('step 0 (click) on page 1: ok');
    expect(t.err()).toContain('1 step skipped');
  });

  it('exits 3 naming a required step whose element is gone', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shop(2) }) });
    expect(await main(['run', 'shop', '--no-guards'], t)).toBe(ExitCode.Unresolved);
    expect(t.err()).toContain('run failed (missing-required): required step 0 (click) found no element');
  });

  it('asks for a step variable before opening the browser', async () => {
    const dir = await home([recipe({ vars: [{ name: 'q', type: 'string' }], steps: [{ kind: 'type', target: { selectors: [sel('css', 'input')] }, value: '{q}' }] })]);
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shop(2) }) });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain('pass --var q=<value>');
    expect(t.browserCreated()).toBe(0);
  });

  it('lists --skip-steps in run and test help', async () => {
    for (const command of ['run', 'test']) {
      const t = testIo({});
      await main([command, '--help'], t);
      expect(t.out()).toContain('--skip-steps');
    }
  });
});
