import { describe, expect, it } from 'vitest';
import {
  annotate,
  descendantsOf,
  draftFromRecipe,
  draftToRecipe,
  emptyDraft,
  loadRecipe,
  reduceDraft,
  selectionOf,
  type Draft,
  type HostMessage,
  type ProtocolCandidate,
} from '../src';
import { h } from '../src/testing';
import { harness, referenceRecipe } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

const SEARCH = 'http://127.0.0.1:4777/catalog?gate=search';
const input: ProtocolCandidate = { strategy: 'css', value: 'input[name="q"]', stability: 'medium', count: 1 };
const accept: ProtocolCandidate = { strategy: 'role', value: 'button|Accept all', stability: 'stable', count: 1 };

function withFields(): Draft {
  return draftFromRecipe(referenceRecipe());
}

const steps = (draft: Draft, flow = 0) => draft.flows[flow]!.steps;

describe('draft reducer flows and steps', () => {
  it('creates a called flow with the first step, makes it active, and puts it in the default sequence', () => {
    const draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'click', target: { selectors: [accept] } } });
    expect(draft.flows.map((f) => f.name)).toEqual(['setup']);
    expect(draft.activeFlow).toBe(0);
    expect(draft.sequence).toEqual({ custom: false, blocks: [{ flow: 'setup' }, { extract: 'items' }] });
    expect(draftToRecipe(draft).sequence).toEqual([{ flow: 'setup' }, { extract: 'items' }]);
  });

  it('adds, edits, reorders, and removes steps of a flow', () => {
    let draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'click', target: { selectors: [accept] } } });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'fill', target: { selectors: [input] }, value: 'mouse' } });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'press', value: 'Enter' } });
    expect(steps(draft).map((s) => [s.kind, s.window, s.optional])).toEqual([
      ['click', 'same', false],
      ['fill', 'same', false],
      ['press', 'same', false],
    ]);
    expect(draft.dirty).toBe(true);
    draft = reduceDraft(draft, { type: 'updateStep', flow: 0, index: 0, patch: { optional: true, window: 'popup', label: 'consent' } });
    expect(steps(draft)[0]).toMatchObject({ optional: true, window: 'popup', label: 'consent' });
    draft = reduceDraft(draft, { type: 'moveStep', flow: 0, from: 2, to: 0 });
    expect(steps(draft).map((s) => s.kind)).toEqual(['press', 'click', 'fill']);
    draft = reduceDraft(draft, { type: 'removeStep', flow: 0, index: 0 });
    expect(steps(draft).map((s) => s.kind)).toEqual(['click', 'fill']);
    expect(steps(draft).every((s) => s.error === undefined)).toBe(true);
  });

  it('replaces the value when the same input is filled again', () => {
    let draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'fill', target: { selectors: [input] }, value: 'mou' } });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'fill', target: { selectors: [input] }, value: 'mouse' } });
    expect(steps(draft)).toHaveLength(1);
    expect(steps(draft)[0]!.value).toBe('mouse');
  });

  it('declares variables used in fill values and flags steps that fail validation', () => {
    let draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'fill', target: { selectors: [input] }, value: 'mouse' } });
    draft = reduceDraft(draft, { type: 'updateStep', flow: 0, index: 0, patch: { value: '{q}' } });
    expect(draft.vars.map((v) => v.name)).toEqual(['port', 'tier', 'q']);
    draft = reduceDraft(draft, { type: 'setVar', name: 'q', value: 'mouse' });
    expect(draftToRecipe(draft).vars!.at(-1)).toEqual({ name: 'q', type: 'string', default: 'mouse' });
    draft = reduceDraft(draft, { type: 'updateStep', flow: 0, index: 0, patch: { value: 'plain' } });
    expect(draft.vars.map((v) => v.name)).toEqual(['port', 'tier']);
    draft = reduceDraft(draft, { type: 'updateStep', flow: 0, index: 0, patch: { kind: 'press', value: null } });
    expect(steps(draft)[0]!.error).toMatch(/needs a value/);
  });

  it('round-trips flows through draftToRecipe, loadRecipe, and draftFromRecipe', () => {
    let draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'click', target: { selectors: [accept] }, optional: true } });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'fill', target: { selectors: [input] }, value: '{q}', window: 'popup' } });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'await-user', target: { selectors: [accept] }, until: 'disappears' } });
    draft = reduceDraft(draft, { type: 'updateStep', flow: 0, index: 2, patch: { label: 'Log in', timeoutMs: 60000 } });
    const recipe = loadRecipe(draftToRecipe(draft));
    expect(recipe.flows[0]!.steps).toEqual([
      { kind: 'click', target: { selectors: [{ strategy: 'role', value: 'button|Accept all', stability: 'stable' }] }, window: 'same', optional: true },
      { kind: 'fill', target: { selectors: [{ strategy: 'css', value: 'input[name="q"]', stability: 'medium' }] }, value: '{q}', window: 'popup', optional: false },
      { kind: 'await-user', target: { selectors: [{ strategy: 'role', value: 'button|Accept all', stability: 'stable' }] }, until: 'disappears', timeoutMs: 60000, window: 'same', optional: false, label: 'Log in' },
    ]);
    const back = draftFromRecipe(recipe, { q: 'mouse' });
    expect(back.vars.at(-1)).toEqual({ name: 'q', value: 'mouse' });
    expect(back.flows[0]!.steps.map((s) => s.count)).toEqual([null, null, null]);
    expect(back.sequence.custom).toBe(false);
    expect(loadRecipe(draftToRecipe(draftFromRecipe(recipe)))).toEqual(recipe);
  });

  it('starts without flows', () => {
    const draft = emptyDraft({ name: 'x', url: SEARCH, vars: [] });
    expect(draft.flows).toEqual([]);
    expect(draft.activeFlow).toBeNull();
  });

  it('adds, renames, duplicates, selects, and removes flows, keeping the active flow and the sequence', () => {
    let draft = reduceDraft(withFields(), { type: 'addFlow', name: 'setup' });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'click', target: { selectors: [accept] } } });
    draft = reduceDraft(draft, { type: 'addFlow', name: 'search' });
    expect(draft.activeFlow).toBe(1);
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'press', value: 'Enter' } });
    expect(draft.flows.map((f) => [f.name, f.steps.length])).toEqual([
      ['setup', 1],
      ['search', 1],
    ]);
    draft = reduceDraft(draft, { type: 'updateFlow', index: 1, patch: { name: 'find' } });
    expect(draft.sequence.blocks).toEqual([{ flow: 'setup' }, { flow: 'find' }, { extract: 'items' }]);
    expect(reduceDraft(draft, { type: 'updateFlow', index: 1, patch: { name: 'setup' } })).toBe(draft);
    draft = reduceDraft(draft, { type: 'duplicateFlow', index: 0 });
    expect(draft.flows.map((f) => f.name)).toEqual(['setup', 'setup-copy', 'find']);
    expect(draft.activeFlow).toBe(1);
    draft = reduceDraft(draft, { type: 'selectFlow', index: 2 });
    draft = reduceDraft(draft, { type: 'removeFlow', index: 0 });
    expect(draft.flows.map((f) => f.name)).toEqual(['setup-copy', 'find']);
    expect(draft.activeFlow).toBe(1);
  });

  it('makes a flow reactive with a trigger, which takes it out of the sequence, and called again', () => {
    let draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'click', target: { selectors: [accept] } } });
    draft = reduceDraft(draft, { type: 'setTrigger', index: 0, trigger: { selectors: [accept] } });
    expect(draft.sequence.blocks).toEqual([{ extract: 'items' }]);
    draft = reduceDraft(draft, { type: 'updateFlow', index: 0, patch: { maxRetries: 3, recover: true } });
    expect(draftToRecipe(draft).flows![0]).toMatchObject({ trigger: { appears: { selectors: [{ strategy: 'role', value: 'button|Accept all' }] } }, maxRetries: 3, recover: true });
    draft = reduceDraft(draft, { type: 'updateFlow', index: 0, patch: { trigger: null } });
    expect(draft.flows[0]!.trigger).toBeUndefined();
    expect(draft.flows[0]!.maxRetries).toBeUndefined();
    expect(draft.sequence.blocks).toEqual([{ flow: 'setup' }, { extract: 'items' }]);
  });
});

describe('draft sequence', () => {
  const tables = (draft: Draft, ...names: string[]) => names.reduce((d, name) => reduceDraft(d, { type: 'addTable', name }), draft);

  it('follows the draft while default: a new table is extracted at the end', () => {
    const draft = tables(withFields(), 'details');
    expect(draft.sequence).toEqual({ custom: false, blocks: [{ extract: 'items' }, { extract: 'details' }] });
  });

  it('wraps the driving table and the tables after it in the paginate block', () => {
    let draft = tables(withFields(), 'details');
    draft = reduceDraft(draft, { type: 'setPagination', pagination: { kind: 'next', target: { selectors: [accept] }, limit: 'all', stopRules: [], delayMs: 0, table: 'items' } });
    expect(draft.sequence.blocks).toEqual([{ paginate: { do: [{ extract: 'items' }, { extract: 'details' }] } }]);
    expect(draftToRecipe(draft).sequence).toEqual([
      { paginate: { kind: 'next', target: { selectors: [{ strategy: 'role', value: 'button|Accept all', stability: 'stable' }] }, limit: 'all', stopRules: [], delayMs: 0, table: 'items', do: [{ extract: 'items' }, { extract: 'details' }] } },
    ]);
  });

  it('becomes custom on a move, reports errors on the offending blocks, and resets to the default', () => {
    let draft = tables(withFields(), 'summary');
    draft = reduceDraft(draft, { type: 'setPagination', pagination: { kind: 'next', target: { selectors: [accept] }, limit: 'all', stopRules: [], delayMs: 0, table: 'items' } });
    // items, then summary inside the paginate block; move summary before it.
    draft = reduceDraft(draft, { type: 'moveBlock', from: [0, 1], to: [0] });
    expect(draft.sequence).toEqual({ custom: true, blocks: [{ extract: 'summary' }, { paginate: { do: [{ extract: 'items' }] } }] });
    expect(draft.sequenceErrors).toEqual([]);
    // A second extract of summary inside the paginate block is a duplicate.
    draft = { ...draft, sequence: { custom: true, blocks: [{ extract: 'summary' }, { paginate: { do: [{ extract: 'items' }, { extract: 'summary' }] } }] } };
    draft = reduceDraft(draft, { type: 'setName', name: draft.name });
    expect(draft.sequenceErrors).toEqual([{ path: [1, 1], message: expect.stringContaining('"summary" is extracted more than once') }]);
    draft = reduceDraft(draft, { type: 'resetSequence' });
    expect(draft.sequence.custom).toBe(false);
    expect(draft.sequenceErrors).toEqual([]);
  });

  it('keeps a custom sequence in step with table and flow renames and removals', () => {
    let draft = reduceDraft(tables(withFields(), 'details'), { type: 'addStep', step: { kind: 'click', target: { selectors: [accept] } } });
    draft = reduceDraft(draft, { type: 'customizeSequence' });
    draft = reduceDraft(draft, { type: 'renameTable', name: 'more-details' });
    draft = reduceDraft(draft, { type: 'updateFlow', index: 0, patch: { name: 'consent' } });
    expect(draft.sequence.blocks).toEqual([{ flow: 'consent' }, { extract: 'items' }, { extract: 'more-details' }]);
    draft = reduceDraft(draft, { type: 'removeTable' });
    draft = reduceDraft(draft, { type: 'removeFlow', index: 0 });
    expect(draft.sequence).toEqual({ custom: true, blocks: [{ extract: 'items' }] });
    expect(draft.sequenceErrors).toEqual([]);
  });

  it('saves no table for a draft that only runs flows', () => {
    const draft = reduceDraft(emptyDraft({ name: 'submit', url: SEARCH, vars: [] }), { type: 'addStep', step: { kind: 'click', target: { selectors: [accept] } } });
    const recipe = draftToRecipe(draft);
    expect(recipe.fields).toBeUndefined();
    expect(recipe.tables).toBeUndefined();
    expect(recipe.sequence).toEqual([{ flow: 'setup' }]);
    expect(loadRecipe(recipe).flows).toHaveLength(1);
  });
});

/** A search page: a form over an empty list. */
function searchPage() {
  return h(
    'html',
    {},
    h('body', {}, h('main', {}, h('form', { method: 'get', role: 'search' }, h('input', { name: 'q', type: 'search', 'aria-label': 'Search' }), h('button', { type: 'submit' }, 'Search')), h('ul', {}))),
  );
}

describe('RecorderController flows', () => {
  it('records a picked element as a click step of the active flow without clicking it', async () => {
    const t = await harness(tier0Snapshot(), withFields());
    const link = descendantsOf(t.page).find((n) => n.tag === 'a')!;
    await t.pick(link);
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' } });
    const [step] = steps(t.controller.draft);
    expect(step).toMatchObject({ kind: 'click', window: 'same', optional: false });
    expect(step!.target!.selectors[0]!.count).toBeGreaterThan(0);
    expect(step!.target!.fingerprint?.tag).toBe('a');
    expect(t.session.dispatched.filter((m) => (m as { kind: string }).kind === 'click')).toEqual([]);
    expect(t.events.find((e) => e.name === 'recorder.stepAdded')?.payload).toMatchObject({ flow: 'setup', index: 0, kind: 'click' });
  });

  it('adds a pick as an await-user step', async () => {
    const t = await harness(tier0Snapshot(), withFields());
    await t.pick(descendantsOf(t.page).find((n) => n.tag === 'a')!);
    await t.send({ kind: 'draft.addStep', step: { kind: 'await-user', until: 'disappears' } });
    expect(steps(t.controller.draft)[0]).toMatchObject({ kind: 'await-user', until: 'disappears' });
  });

  it('adds a browse-mode step from the page selection and a key press without a target', async () => {
    const t = await harness(searchPage(), emptyDraft({ name: 'search', url: SEARCH, vars: [] }), SEARCH);
    const box = descendantsOf(t.page).find((n) => n.tag === 'input')!;
    const selection = selectionOf(box);
    selection.candidates = selection.candidates.map((c) => ({ ...c, count: 1 }));
    await t.send({ kind: 'draft.addStep', step: { kind: 'fill', value: 'mouse' }, selection });
    await t.send({ kind: 'draft.addStep', step: { kind: 'press', value: 'Enter' }, selection: null });
    expect(steps(t.controller.draft).map((s) => [s.kind, s.value, s.target ? 'target' : 'none'])).toEqual([
      ['fill', 'mouse', 'target'],
      ['press', 'Enter', 'none'],
    ]);
  });

  it('records into the flow the message names, and into the active flow otherwise', async () => {
    const t = await harness(searchPage(), withFields());
    await t.send({ kind: 'draft.addFlow', name: 'consent' });
    await t.send({ kind: 'draft.addFlow', name: 'search' });
    await t.send({ kind: 'draft.addStep', step: { kind: 'press', value: 'Enter' }, selection: null });
    await t.send({ kind: 'draft.addStep', step: { kind: 'press', value: 'Escape' }, selection: null, flow: 0 });
    expect(t.controller.draft.flows.map((f) => [f.name, f.steps.map((s) => s.value)])).toEqual([
      ['consent', ['Escape']],
      ['search', ['Enter']],
    ]);
  });

  it('counts step targets on recount and re-picks a step target', async () => {
    const t = await harness(searchPage(), emptyDraft({ name: 'search', url: SEARCH, vars: [] }), SEARCH);
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' }, selection: { ...selectionOf(descendantsOf(t.page).find((n) => n.tag === 'input')!), candidates: [{ strategy: 'css', value: '.gone', stability: 'medium' }] } });
    await t.controller.recount();
    expect(steps(t.controller.draft)[0]!.count).toBe(0);
    await t.send({ kind: 'draft.repickTarget', target: 'step', index: 0 });
    expect(t.controller.state.repickStep).toEqual({ flow: 0, index: 0 });
    await t.pick(descendantsOf(t.page).find((n) => n.tag === 'button')!);
    expect(t.controller.state.repickStep).toBeNull();
    expect(steps(t.controller.draft)[0]!.count).toBe(1);
    expect(steps(t.controller.draft)[0]!.target!.fingerprint?.tag).toBe('button');
  });

  it('sets a trigger from the trigger editor pick', async () => {
    const t = await harness(searchPage(), withFields());
    await t.send({ kind: 'draft.addStep', step: { kind: 'press', value: 'Enter' }, selection: null });
    await t.send({ kind: 'draft.pickTrigger', index: 0 });
    expect(t.controller.state.pickTrigger).toBe(0);
    await t.pick(descendantsOf(t.page).find((n) => n.tag === 'button')!);
    expect(t.controller.state.pickTrigger).toBeNull();
    expect(t.controller.draft.flows[0]!.trigger!.selectors[0]).toMatchObject({ value: expect.stringContaining('Search') });
    expect(t.controller.draft.sequence.blocks).toEqual([{ extract: 'items' }]);
  });

  it('replays one step and a whole flow on the live page and reports them', async () => {
    const box = descendantsOf(annotate(searchPage())).find((n) => n.tag === 'input')!;
    const ready = await harness(searchPage(), withFields());
    await ready.send({ kind: 'draft.addStep', step: { kind: 'fill', value: '{q}' }, selection: selectionOf(box) });
    await ready.send({ kind: 'draft.setVar', name: 'q', value: 'mouse' });
    const ok = (await ready.send({ kind: 'draft.replayStep', index: 0 })) as HostMessage & { kind: 'step.replayResult' };
    expect(ok).toMatchObject({ ok: true, message: 'replayed step 1 (fill)' });
    const [live] = await ready.session.resolve({ strategy: 'css', value: 'input', stability: 'medium' });
    expect(await ready.session.read(live!, { attr: 'value', mode: 'text' })).toBe('mouse');
    expect(ready.events.find((e) => e.name === 'recorder.stepReplayed')?.payload).toEqual({ flow: 'setup', index: 0, kind: 'fill', ok: true, message: 'replayed step 1 (fill)' });
    const flow = (await ready.send({ kind: 'draft.replayFlow', index: 0 })) as HostMessage & { kind: 'step.replayResult' };
    expect(flow).toMatchObject({ ok: true, message: 'replayed flow setup (1 step)' });
  });

  it('reports a failed replay without throwing', async () => {
    const t = await harness(searchPage(), withFields());
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' }, selection: { ...selectionOf(descendantsOf(t.page).find((n) => n.tag === 'button')!), candidates: [{ strategy: 'css', value: '.gone', stability: 'medium' }] } });
    const reply = (await t.send({ kind: 'draft.replayStep', index: 0 })) as HostMessage & { kind: 'step.replayResult' };
    expect(reply.ok).toBe(false);
    expect(reply.message).toMatch(/step 1 failed: .*found no element/);
  });

  it('replays the flows before a table so a gated field counts again', async () => {
    const gate = h('html', {}, h('body', {}, h('button', { id: 'accept' }, 'Accept all')));
    const t = await harness(gate, withFields(), undefined, { on: { click: () => tier0Snapshot() } });
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' }, selection: selectionOf(descendantsOf(annotate(gate)).find((n) => n.tag === 'button')!) });
    await t.controller.recount();
    expect(t.controller.draft.tables[0]!.fields[0]!.count).toBe(0);
    const reply = (await t.send({ kind: 'draft.replayFlowsBefore', table: 0 })) as HostMessage & { kind: 'step.replayResult' };
    expect(reply).toMatchObject({ ok: true, message: 'replayed setup' });
    expect(t.controller.draft.tables[0]!.fields[0]!.count).toBeGreaterThan(0);
  });

  it('marks pagination into a paginate block driven by the active table', async () => {
    const dom = h('html', {}, h('body', {}, h('main', {}, h('h1', {}, 'x')), h('nav', {}, h('a', { class: 'next', href: '/catalog?page=2' }, 'Next'))));
    const t = await harness(dom, withFields());
    await t.pick(descendantsOf(t.page).find((n) => n.tag === 'a')!);
    await t.send({ kind: 'draft.markPagination' });
    expect(t.controller.draft.pagination).toMatchObject({ kind: 'next', table: 'items' });
    expect(t.controller.draft.sequence.blocks).toEqual([{ paginate: { do: [{ extract: 'items' }] } }]);
    expect(t.controller.state.panel.collapsed.sequence).toBe(false);
  });

  it('moves blocks, customizes, and resets the sequence through messages', async () => {
    const t = await harness(searchPage(), withFields());
    await t.send({ kind: 'draft.addStep', step: { kind: 'press', value: 'Enter' }, selection: null });
    await t.send({ kind: 'sequence.move', from: [0], to: [1] });
    expect(t.controller.draft.sequence).toEqual({ custom: true, blocks: [{ extract: 'items' }, { flow: 'setup' }] });
    await t.send({ kind: 'sequence.reset' });
    expect(t.controller.draft.sequence.custom).toBe(false);
    await t.send({ kind: 'sequence.customize' });
    expect(t.controller.draft.sequence).toEqual({ custom: true, blocks: [{ flow: 'setup' }, { extract: 'items' }] });
  });
});

describe('RecorderController windows', () => {
  const MAIN = 'http://127.0.0.1:4777/catalog?tier=0';
  const LOGIN = 'http://127.0.0.1:4777/spa/login';
  const main = () => h('html', {}, h('body', {}, h('button', { id: 'login' }, 'Log in')));
  const popupDom = () => h('html', {}, h('body', {}, h('input', { id: 'user', name: 'user' })));

  async function withPopup() {
    const t = await harness(main(), withFields(), MAIN, { on: { click: () => ({ popup: '/spa/login' }) } }, { [LOGIN]: { dom: popupDom() } });
    await t.session.click((await t.session.resolve({ strategy: 'id', value: 'login', stability: 'stable' }))[0]!);
    await t.controller.idle();
    return { ...t, popup: t.browser.popups[0]! };
  }

  it('gives the panel to a popup when it opens and the rail to the main window', async () => {
    const t = await withPopup();
    expect(t.controller.state).toMatchObject({ panelMode: 'owner', popup: true, url: LOGIN });
    expect(t.session.dispatchedOf('panel.mode').at(-1)).toEqual({ kind: 'panel.mode', mode: 'rail', popup: false });
    expect(t.popup.dispatchedOf('draft.state').length).toBeGreaterThan(0);
    // The main window is answered with its mode, not the draft.
    expect(await t.send({ kind: 'draft.addFlow' })).toEqual({ kind: 'panel.mode', mode: 'rail', popup: false });
    expect(t.controller.draft.flows).toEqual([]);
  });

  it('records steps in the popup with window popup', async () => {
    const t = await withPopup();
    const user = descendantsOf(annotate(popupDom())).find((n) => n.tag === 'input')!;
    await t.popup.callHost({ kind: 'draft.addStep', step: { kind: 'fill', value: 'u' }, selection: selectionOf(user) });
    expect(steps(t.controller.draft)[0]).toMatchObject({ kind: 'fill', value: 'u', window: 'popup' });
  });

  it('hands the panel back to the opener when the popup closes', async () => {
    const t = await withPopup();
    await t.popup.userClose();
    await t.controller.idle();
    expect(t.controller.state).toMatchObject({ panelMode: 'owner', popup: false, url: MAIN });
    const user = descendantsOf(annotate(main())).find((n) => n.tag === 'button')!;
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' }, selection: selectionOf(user) });
    expect(steps(t.controller.draft)[0]).toMatchObject({ window: 'same' });
  });

  it('moves the panel on a real press in another window', async () => {
    const t = await withPopup();
    const reply = (await t.send({ kind: 'window.activity' })) as HostMessage;
    expect(reply.kind).toBe('draft.state');
    expect(t.controller.state.popup).toBe(false);
    expect(t.popup.dispatchedOf('panel.mode').at(-1)).toEqual({ kind: 'panel.mode', mode: 'strip', popup: true });
    await t.popup.callHost({ kind: 'window.activity' });
    expect(t.controller.state.popup).toBe(true);
  });
});
