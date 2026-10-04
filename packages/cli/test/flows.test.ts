import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, saveRecipe, type RecipeInput, type RunReport, type StepReport } from '@webscoop/core';
import { FakeBrowser, h, type FakePage } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { flowsFromFlags, formatStep, summary } from '../src/commands/run';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/c/shoes';
const sel = (strategy: 'css' | 'testid', value: string) => ({ strategy, value, stability: strategy === 'testid' ? ('stable' as const) : ('medium' as const) });

function recipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 2,
    name: 'shop',
    url: PAGE,
    item: { selectors: [sel('testid', 'card')] },
    fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [sel('css', 'h2')] }],
    flows: [
      {
        name: 'setup',
        steps: [
          { kind: 'click', target: { selectors: [sel('css', '#accept')] } },
          { kind: 'click', target: { selectors: [sel('css', '#newsletter-close')] }, optional: true },
        ],
      },
    ],
    sequence: [{ flow: 'setup' }, { extract: 'items' }],
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
  flow: 'setup',
  index: 0,
  kind: 'click',
  page: 1,
  outcome: 'ok',
  heal: { kind: 'candidate', index: 0 },
  candidate: sel('css', '#accept'),
  ...extra,
});

describe('secret variables', () => {
  it('keeps a secret value out of stderr, the report, and hook stdin when its fill step fails', async () => {
    const dir = await home([
      recipe({
        vars: [{ name: 'pass', type: 'string', secret: true }],
        flows: [{ name: 'setup', steps: [{ kind: 'fill', target: { selectors: [sel('css', '#password')] }, value: 'x{pass}x', label: 'type {pass}' }] }],
      }),
    ]);
    const payload = join(dir, 'payload');
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { 'run.start': `cat > ${payload}`, 'run.failed': `cat >> ${payload}` } }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, PATH: process.env.PATH }, browser: new FakeBrowser({ [PAGE]: shop(1) }) });
    const code = await main(['run', 'shop', '--report', '--var-command', 'pass=echo hunter2'], io);
    expect(code).not.toBe(ExitCode.Ok);
    expect(io.err()).toContain('required step 0 (fill) of flow "setup" found no element (value from variable pass)');
    expect(io.err()).not.toContain('hunter2');
    const text = await readFile(payload, 'utf8');
    expect(text).toContain('run.failed');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('"pass"');
  });
});

describe('flow flags and logs', () => {
  it('maps --skip-flows to disabled flows', () => {
    expect(flowsFromFlags({})).toEqual({ enabled: true });
    expect(flowsFromFlags({ skipFlows: true })).toEqual({ enabled: false });
  });

  it('formats one line per replayed or skipped step', () => {
    expect(formatStep(report())).toBe('setup step 0 (click) on page 1: ok, candidate 0: css=#accept');
    expect(formatStep(report({ index: 2, label: 'consent', page: 3, outcome: 'healed', heal: { kind: 'fuzzy', score: 0.83 } }))).toBe(
      'setup step 2 "consent" (click) on page 3: healed, fuzzy 0.83: css=#accept',
    );
    expect(formatStep(report({ outcome: 'skipped', heal: { kind: 'unresolved' }, candidate: null, notes: ['found no element'] }))).toBe(
      'setup step 0 (click) on page 1: skipped (found no element)',
    );
    expect(formatStep(report({ kind: 'wait', heal: null, candidate: null }))).toBe('setup step 0 (wait) on page 1: ok');
  });

  it('mentions skipped steps and reactive firings in the summary', () => {
    const base = { recipe: 'shop', durationMs: 1000, pageCount: 1, rowCount: 3, tables: [], healed: 0, guards: [], duplicateCount: 0, flows: [], downloads: [] } as unknown as RunReport;
    expect(summary({ ...base, steps: [report()] })).toBe('3 rows from 1 page in 1.00s (shop)');
    expect(summary({ ...base, steps: [report(), report({ index: 1, outcome: 'skipped' })] })).toBe('3 rows from 1 page, 1 step skipped in 1.00s (shop)');
    const fired = { name: 'cookie-banner', kind: 'reactive' as const, page: 1, outcome: 'ok' as const, steps: [] };
    expect(summary({ ...base, steps: [], flows: [fired, fired] })).toBe('3 rows from 1 page, reactive flows fired 2 times in 1.00s (shop)');
  });
});

describe('webscoop run and test with flows', () => {
  it('runs the flow, logs it and each step, and extracts behind the banner', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: gated() }) });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Ok);
    expect(JSON.parse(t.out())).toHaveLength(3);
    expect(t.err()).toContain('flow setup (called) on page 1');
    expect(t.err()).toContain('setup step 0 (click) on page 1: ok, candidate 0: css=#accept');
    expect(t.err()).toContain('setup step 1 (click) on page 1: skipped (found no element)');
    expect(t.err()).toContain('3 rows from 1 page, 1 step skipped in');
  });

  it('runs no flow with --skip-flows, so the fields behind the banner are missing (exit 3)', async () => {
    const dir = await home();
    const browser = new FakeBrowser({ [PAGE]: gated() });
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--skip-flows', '--no-guards'], t)).toBe(ExitCode.Unresolved);
    expect(browser.clicks).toEqual([]);
    expect(t.err()).not.toContain('flow setup');
  });

  it('runs flows in test by default and exits 0', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: gated() }) });
    expect(await main(['test', 'shop'], t)).toBe(ExitCode.Ok);
    expect(t.err()).toContain('setup step 0 (click) on page 1: ok');
    expect(t.err()).toContain('1 step skipped');
  });

  it('exits 3 naming a required step whose element is gone', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shop(2) }) });
    expect(await main(['run', 'shop', '--no-guards'], t)).toBe(ExitCode.Unresolved);
    expect(t.err()).toContain('run failed (missing-required): required step 0 (click) of flow "setup" found no element');
  });

  it('asks for a step variable before opening the browser', async () => {
    const dir = await home([recipe({ vars: [{ name: 'q', type: 'string' }], flows: [{ name: 'setup', steps: [{ kind: 'fill', target: { selectors: [sel('css', 'input')] }, value: '{q}' }] }] })]);
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: shop(2) }) });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain('pass --var q=<value>');
    expect(t.browserCreated()).toBe(0);
  });

  it('lists --skip-flows in run and test help', async () => {
    for (const command of ['run', 'test']) {
      const t = testIo({});
      await main([command, '--help'], t);
      expect(t.out()).toContain('--skip-flows');
      expect(t.out()).not.toContain('--skip-steps');
    }
  });

  it('fails with exit 1 on a flow loop and on lost pagination, keeping the rows of pagination-lost', async () => {
    const loginButton = { selectors: [sel('css', '#login')] };
    const looping = recipe({
      flows: [
        { name: 'setup', steps: [{ kind: 'wait', value: '1' }, { kind: 'wait', value: '1' }] },
        { name: 'login-wall', trigger: { appears: loginButton }, steps: [{ kind: 'click', target: loginButton }] },
      ],
    });
    const dir = await home([looping]);
    const stuck = h('html', {}, h('body', {}, h('button', { id: 'login' }, 'Log in'), h('div', { 'data-testid': 'card' }, h('h2', {}, 'x'))));
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: { dom: stuck } }) });
    expect(await main(['run', 'shop', '--no-guards'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain('run failed (flow-loop)');
    expect(t.err()).toContain('flow login-wall (reactive) on page 1');
  });
});
