import { MockLlm, type MockResponse } from '@webscoop/llm';
import { describe, expect, it, vi } from 'vitest';
import { loadRecipe, recordEvents, RunEmitter, Runner, RunWindows, runFlow, type LlmPort, type PageInfo, type RecipeInput, type StepReport } from '../src';
import { runAgent, type AgentLoopOptions } from '../src/agent/loop';
import { FakeBrowser, h, type FakeInteractiveSession, type FakePage } from '../src/testing';

const START = 'https://docs.test/report';
const pdf = { download: { url: '/q3.pdf', name: 'q3.pdf', bytes: 9 } };

const body = (...children: unknown[]) => h('html', {}, h('head', {}, h('title', {}, 'Report')), h('body', {}, ...(children as never[])));

/** A page whose Export button reveals a PDF link, which downloads. */
const exportPage = (): FakePage => ({
  dom: body(h('button', { id: 'export' }, 'Export')),
  on: {
    click: (el) => {
      if (el?.attrs.id === 'export') return body(h('button', { id: 'export' }, 'Export'), h('a', { id: 'pdf', href: '#' }, 'PDF'));
      if (el?.attrs.id === 'pdf') return pdf;
      return undefined;
    },
  },
});

const say = (action: Record<string, unknown>, extra: Partial<MockResponse> = {}): MockResponse => ({ reply: JSON.stringify(action), ...extra });

async function open(pages: Record<string, FakePage> = { [START]: exportPage() }) {
  const browser = new FakeBrowser(pages);
  const session = (await browser.open('/p', { downloadDir: '/dl' })) as FakeInteractiveSession;
  await session.goto(START, { timeoutMs: 1000 });
  return { browser, session };
}

async function agent(llm: LlmPort, extra: Partial<AgentLoopOptions> = {}, pages?: Record<string, FakePage>) {
  const { browser, session } = await open(pages);
  const result = await runAgent({ llm, session, windows: new RunWindows(session), goal: 'Download the PDF', maxTurns: 20, until: 'download', timeoutMs: 1000, sleep: async () => {}, ...extra });
  return { browser, session, result };
}

describe('agent loop', () => {
  it('reaches a download in two turns without asking again', async () => {
    const llm = new MockLlm({ responses: [say({ action: 'click', ref: 'e1', reason: 'open export' }), say({ action: 'click', ref: 'e2', reason: 'take the pdf' })] });
    const { result } = await agent(llm);
    expect(result.ok).toBe(true);
    expect(result.report.end).toBe('download');
    expect(result.report.turns).toBe(2);
    expect(llm.requests).toHaveLength(2);
    expect(result.report.actions).toEqual([
      expect.objectContaining({ turn: 1, action: 'click', ref: 'e1', target: '[e1] button "Export"', reason: 'open export' }),
      expect.objectContaining({ turn: 2, action: 'click', ref: 'e2', target: '[e2] link "PDF" href=#', reason: 'take the pdf' }),
    ]);
    // The request carries the system message, the goal, the URL, and the outline.
    const first = llm.requests[0]!;
    expect(first.messages[0]!.role).toBe('system');
    expect(first.prompt).toContain('Goal: Download the PDF');
    expect(first.prompt).toContain(START);
    expect(first.prompt).toContain('[e1] button "Export"');
    expect(first.opts).toMatchObject({ temperature: 0, json: true });
    expect(llm.requests[1]!.prompt).toContain('[e2] link "PDF"');
  });

  it('trims old turns to fit a small context, keeping the latest outline', async () => {
    const waits = Array.from({ length: 12 }, (_, i) => say({ action: 'wait', ms: 1, reason: `step-${i + 1}-end` }));
    const llm = new MockLlm({ responses: waits, contextTokens: 600, maxOutputTokens: 100 });
    const { result } = await agent(llm, { maxTurns: 12 });
    expect(result.report.end).toBe('max-turns');
    const last = llm.requests.at(-1)!;
    expect(last.messages[0]!.role).toBe('system');
    expect(last.prompt).toContain('Goal: Download the PDF');
    expect(last.prompt).toContain('[e1] button "Export"');
    expect(last.prompt).toContain('step-11-end');
    expect(last.prompt).not.toContain('step-1-end');
    expect(llm.estimateTokens(last.prompt)).toBeLessThanOrEqual(600 - 100 + last.messages.length);
    // Older results shrink to their first line; only the latest carries an outline.
    expect(last.messages.filter((m) => m.content.includes('Outline:'))).toHaveLength(1);
  });

  it('fails a second done without a download as done-unmet', async () => {
    const llm = new MockLlm({ responses: [say({ action: 'done', reason: 'finished' }), say({ action: 'done', reason: 'really' })] });
    const { result } = await agent(llm);
    expect(result).toMatchObject({ ok: false, report: { end: 'done-unmet', turns: 2 } });
    expect(llm.requests[1]!.prompt).toContain('No download has been saved yet');
  });

  it('ends ok on done when the step has no until', async () => {
    const llm = new MockLlm({ responses: [say({ action: 'done', reason: 'nothing to do' })] });
    const { result } = await agent(llm, { until: undefined });
    expect(result).toMatchObject({ ok: true, report: { end: 'done', turns: 1 } });
  });

  it('stops at the turn cap', async () => {
    const llm = new MockLlm({ responses: [say({ action: 'scroll', direction: 'down', reason: 'look' }, { repeat: true })] });
    const { result } = await agent(llm, { maxTurns: 3 });
    expect(result).toMatchObject({ ok: false, report: { end: 'max-turns', turns: 3 } });
    expect(llm.requests).toHaveLength(3);
  });

  it('fails on give_up with its reason', async () => {
    const llm = new MockLlm({ responses: [say({ action: 'give_up', reason: 'no pdf here' })] });
    const { result } = await agent(llm);
    expect(result).toMatchObject({ ok: false, why: 'no pdf here', report: { end: 'gave-up' } });
  });

  it('fails on an adapter error', async () => {
    const llm = new MockLlm({ responses: [{ reply: new Error('boom') }] });
    const { result } = await agent(llm);
    expect(result).toMatchObject({ ok: false, report: { end: 'llm-error', turns: 1 } });
    expect(result.why).toContain('boom');
  });

  it('answers an invalid action with the valid ones and fails after three in a row', async () => {
    const llm = new MockLlm({ responses: [say({ action: 'tap', ref: 'e2' }, { repeat: true })] });
    const { result } = await agent(llm);
    expect(result).toMatchObject({ ok: false, report: { end: 'invalid-answers', turns: 3 } });
    expect(llm.requests[1]!.prompt).toContain('the action "tap" is unknown');
    expect(llm.requests[1]!.prompt).toContain('"action":"give_up"');
  });

  it('resets the invalid count after a valid answer', async () => {
    const bad = say({ action: 'tap' });
    const llm = new MockLlm({ responses: [bad, bad, say({ action: 'wait', ms: 1 }), bad, bad, say({ action: 'done' }), say({ action: 'done' })] });
    const { result } = await agent(llm);
    expect(result.report.end).toBe('done-unmet');
  });
});

describe('agent step in a flow', () => {
  const input = (step: Record<string, unknown>, extra: Partial<RecipeInput> = {}): RecipeInput =>
    ({ schemaVersion: 2, name: 'grab-pdf', url: '{url}', vars: [{ name: 'url', type: 'string', raw: true }], flows: [{ name: 'grab', steps: [step] }], sequence: [{ flow: 'grab' }], ...extra }) as RecipeInput;

  const run = async (step: Record<string, unknown>, opts: { llmFor?: (name?: string) => LlmPort; pages?: Record<string, FakePage>; extra?: Partial<RecipeInput> } = {}) => {
    const browser = new FakeBrowser(opts.pages ?? { [START]: exportPage() });
    const emitter = new RunEmitter();
    const log = recordEvents(emitter);
    const runner = new Runner({
      recipe: loadRecipe(input(step, opts.extra)),
      browser,
      profileDir: '/p',
      emitter,
      vars: { url: START },
      openOptions: { downloadDir: '/dl' },
      ...(opts.llmFor ? { llmFor: opts.llmFor } : {}),
    });
    return { browser, log, result: await runner.run() };
  };

  const clicks = () => new MockLlm({ responses: [say({ action: 'click', ref: 'e1', reason: 'open' }), say({ action: 'click', ref: 'e2', reason: 'pdf' })] });

  it('ends ok with the downloaded file as a step download, and reports the transcript', async () => {
    const llm = clicks();
    const { result, log, browser } = await run({ kind: 'agent', goal: 'Download the PDF at {url}', until: 'download', value: 'report.pdf' }, { llmFor: () => llm });
    expect(result.ok).toBe(true);
    expect(llm.requests[0]!.prompt).toContain(`Goal: Download the PDF at ${START}`);
    expect(result.report.steps[0]).toMatchObject({
      kind: 'agent',
      outcome: 'ok',
      download: { file: '/dl/report.pdf', name: 'report.pdf' },
      agent: { turns: 2, end: 'download', actions: [{ turn: 1, action: 'click', ref: 'e1' }, { turn: 2, action: 'click', ref: 'e2' }] },
    });
    expect(log.of('step.replayed')[0]!.step.agent?.end).toBe('download');
    expect(log.of('agent.action').map((e) => e.turn.action)).toEqual(['click', 'click']);
    expect(log.of('agent.ended')).toEqual([{ page: 1, flow: 'grab', index: 0, turns: 2, end: 'download' }]);
    expect(log.of('download.saved')).toEqual([expect.objectContaining({ file: '/dl/report.pdf', step: { flow: 'grab', index: 0 } })]);
    expect(result.report.downloads).toHaveLength(1);
    expect([...browser.files.keys()]).toEqual(['/dl/report.pdf']);
  });

  it('uses the step-named entry over the default one', async () => {
    const smart = clicks();
    const fast = new MockLlm({ responses: [] });
    const llmFor = vi.fn((name?: string): LlmPort => (name === 'smart' ? smart : fast));
    const { result } = await run({ kind: 'agent', goal: 'Get it', until: 'download', llm: 'smart' }, { llmFor });
    expect(result.ok).toBe(true);
    expect(llmFor).toHaveBeenCalledWith('smart');
    expect(smart.requests.length).toBeGreaterThan(0);
    expect(fast.requests).toHaveLength(0);
    const plain = vi.fn((): LlmPort => clicks());
    await run({ kind: 'agent', goal: 'Get it', until: 'download' }, { llmFor: plain });
    expect(plain).toHaveBeenCalledWith(undefined);
  });

  it('fails the run as missing-required when a required step does not reach its goal', async () => {
    const llm = new MockLlm({ responses: [say({ action: 'done' }, { repeat: true })] });
    const { result, log } = await run({ kind: 'agent', goal: 'Get it', until: 'download', label: 'grab' }, { llmFor: () => llm });
    expect(result).toMatchObject({ ok: false, reason: 'missing-required', fields: ['grab'] });
    expect(result.ok ? '' : result.message).toContain('done-unmet');
    expect(result.report.steps[0]).toMatchObject({ outcome: 'failed', agent: { end: 'done-unmet' } });
    expect(log.of('agent.ended')[0]).toMatchObject({ end: 'done-unmet' });
  });

  it('skips an optional step that gives up and goes on', async () => {
    const llm = new MockLlm({ responses: [say({ action: 'give_up', reason: 'none' })] });
    const { result, log } = await run({ kind: 'agent', goal: 'Get it', optional: true }, { llmFor: () => llm });
    expect(result.ok).toBe(true);
    expect(result.report.steps[0]).toMatchObject({ outcome: 'skipped', agent: { end: 'gave-up' } });
    expect(log.of('step.skipped')[0]!.step.agent?.end).toBe('gave-up');
  });

  it('cannot run without a model: required fails, optional is skipped, nothing is asked', async () => {
    const required = await run({ kind: 'agent', goal: 'Get it', until: 'download' });
    expect(required.result).toMatchObject({ ok: false, reason: 'missing-required' });
    expect(required.result.ok ? '' : required.result.message).toContain('--no-llm');
    expect(required.result.report.steps[0]!.agent).toEqual({ turns: 0, end: 'no-llm', actions: [] });
    const unavailable: LlmPort = { available: false, contextTokens: 8000, complete: vi.fn(), estimateTokens: (t) => t.length };
    const optional = await run({ kind: 'agent', goal: 'Get it', optional: true }, { llmFor: () => unavailable });
    expect(optional.result.ok).toBe(true);
    expect(optional.result.report.steps[0]).toMatchObject({ outcome: 'skipped', agent: { end: 'no-llm' } });
    expect(unavailable.complete).not.toHaveBeenCalled();
  });

  it('hands pages the step navigated to to the guards and goes on', async () => {
    const pages = { [START]: { dom: body(h('a', { href: '#top' }, 'Top')) }, [`${START}#top`]: { dom: body(h('p', {}, 'Top of the page')) } };
    const browser = new FakeBrowser(pages);
    const session = await browser.open('/p');
    await session.goto(START, { timeoutMs: 1000 });
    const seen: PageInfo[] = [];
    const llm = new MockLlm({ responses: [say({ action: 'click', ref: 'e1' }), say({ action: 'done' })] });
    const recipe = loadRecipe(input({ kind: 'agent', goal: 'Look' }));
    const reports: StepReport[] = [];
    const flowResult = await runFlow(recipe, recipe.flows[0]!, session, {
      page: 1,
      windows: new RunWindows(session),
      timeoutMs: 1000,
      cache: new Map(),
      vars: { url: START },
      llmFor: () => llm,
      onEvent: (r) => reports.push(r),
      onNavigated: async (info) => {
        seen.push(info);
        return info;
      },
    });
    expect(seen.map((i) => i.url)).toEqual([`${START}#top`]);
    expect(flowResult.info?.url).toBe(`${START}#top`);
    expect(reports[0]).toMatchObject({ outcome: 'ok', agent: { end: 'done', turns: 2 } });
    // The second request sees the page after the guard check.
    expect(llm.requests[1]!.prompt).toContain('Top of the page');
  });
});
