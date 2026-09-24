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

describe('draft reducer steps', () => {
  it('adds, edits, reorders, and removes steps', () => {
    let draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'click', target: { selectors: [accept] } } });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'type', target: { selectors: [input] }, value: 'mouse' } });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'press', value: 'Enter' } });
    expect(draft.steps.map((s) => [s.kind, s.when, s.optional])).toEqual([
      ['click', 'first-page', false],
      ['type', 'first-page', false],
      ['press', 'first-page', false],
    ]);
    expect(draft.dirty).toBe(true);
    draft = reduceDraft(draft, { type: 'updateStep', index: 0, patch: { optional: true, when: 'every-page', label: 'consent' } });
    expect(draft.steps[0]).toMatchObject({ optional: true, when: 'every-page', label: 'consent' });
    draft = reduceDraft(draft, { type: 'moveStep', from: 2, to: 0 });
    expect(draft.steps.map((s) => s.kind)).toEqual(['press', 'click', 'type']);
    draft = reduceDraft(draft, { type: 'removeStep', index: 0 });
    expect(draft.steps.map((s) => s.kind)).toEqual(['click', 'type']);
    expect(draft.steps.every((s) => s.error === undefined)).toBe(true);
  });

  it('replaces the value when the same input is typed into again', () => {
    let draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'type', target: { selectors: [input] }, value: 'mou' } });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'type', target: { selectors: [input] }, value: 'mouse' } });
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]!.value).toBe('mouse');
  });

  it('declares variables used in step values and flags steps that fail validation', () => {
    let draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'type', target: { selectors: [input] }, value: 'mouse' } });
    draft = reduceDraft(draft, { type: 'updateStep', index: 0, patch: { value: '{q}' } });
    expect(draft.vars.map((v) => v.name)).toEqual(['port', 'tier', 'q']);
    draft = reduceDraft(draft, { type: 'setVar', name: 'q', value: 'mouse' });
    expect(draftToRecipe(draft).vars!.at(-1)).toEqual({ name: 'q', type: 'string', default: 'mouse' });
    draft = reduceDraft(draft, { type: 'updateStep', index: 0, patch: { value: 'plain' } });
    expect(draft.vars.map((v) => v.name)).toEqual(['port', 'tier']);
    draft = reduceDraft(draft, { type: 'updateStep', index: 0, patch: { kind: 'select', value: null } });
    expect(draft.steps[0]!.error).toMatch(/needs a value/);
  });

  it('round-trips steps through draftToRecipe, loadRecipe, and draftFromRecipe', () => {
    let draft = reduceDraft(withFields(), { type: 'addStep', step: { kind: 'click', target: { selectors: [accept] }, optional: true } });
    draft = reduceDraft(draft, { type: 'addStep', step: { kind: 'type', target: { selectors: [input] }, value: '{q}', when: 'every-page' } });
    const recipe = loadRecipe(draftToRecipe(draft));
    expect(recipe.steps).toEqual([
      { kind: 'click', target: { selectors: [{ strategy: 'role', value: 'button|Accept all', stability: 'stable' }] }, when: 'first-page', optional: true },
      { kind: 'type', target: { selectors: [{ strategy: 'css', value: 'input[name="q"]', stability: 'medium' }] }, value: '{q}', when: 'every-page', optional: false },
    ]);
    const back = draftFromRecipe(recipe, { q: 'mouse' });
    expect(back.vars.at(-1)).toEqual({ name: 'q', value: 'mouse' });
    expect(back.steps.map((s) => s.count)).toEqual([null, null]);
    expect(loadRecipe(draftToRecipe(draftFromRecipe(recipe)))).toEqual(recipe);
  });

  it('starts empty', () => {
    expect(emptyDraft({ name: 'x', url: SEARCH, vars: [] }).steps).toEqual([]);
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

describe('RecorderController steps', () => {
  it('records a picked element as a click step without clicking it', async () => {
    const t = await harness(tier0Snapshot(), withFields());
    const link = descendantsOf(t.page).find((n) => n.tag === 'a')!;
    await t.pick(link);
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' } });
    const [step] = t.controller.draft.steps;
    expect(step).toMatchObject({ kind: 'click', when: 'first-page', optional: false });
    expect(step!.target!.selectors[0]!.count).toBeGreaterThan(0);
    expect(step!.target!.fingerprint?.tag).toBe('a');
    expect(t.session.dispatched.filter((m) => (m as { kind: string }).kind === 'click')).toEqual([]);
    expect(t.events.find((e) => e.name === 'recorder.stepAdded')?.payload).toMatchObject({ index: 0, kind: 'click' });
  });

  it('adds a browse-mode step from the page selection and a key press without a target', async () => {
    const t = await harness(searchPage(), emptyDraft({ name: 'search', url: SEARCH, vars: [] }), SEARCH);
    const box = descendantsOf(t.page).find((n) => n.tag === 'input')!;
    const selection = selectionOf(box);
    selection.candidates = selection.candidates.map((c) => ({ ...c, count: 1 }));
    await t.send({ kind: 'draft.addStep', step: { kind: 'type', value: 'mouse' }, selection });
    await t.send({ kind: 'draft.addStep', step: { kind: 'press', value: 'Enter' }, selection: null });
    expect(t.controller.draft.steps.map((s) => [s.kind, s.value, s.target ? 'target' : 'none'])).toEqual([
      ['type', 'mouse', 'target'],
      ['press', 'Enter', 'none'],
    ]);
  });

  it('counts step targets on recount and re-picks a step target', async () => {
    const t = await harness(searchPage(), emptyDraft({ name: 'search', url: SEARCH, vars: [] }), SEARCH);
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' }, selection: { ...selectionOf(descendantsOf(t.page).find((n) => n.tag === 'input')!), candidates: [{ strategy: 'css', value: '.gone', stability: 'medium' }] } });
    await t.controller.recount();
    expect(t.controller.draft.steps[0]!.count).toBe(0);
    await t.send({ kind: 'draft.repickTarget', target: 'step', index: 0 });
    expect(t.controller.state.repickStep).toBe(0);
    await t.pick(descendantsOf(t.page).find((n) => n.tag === 'button')!);
    expect(t.controller.state.repickStep).toBeNull();
    expect(t.controller.draft.steps[0]!.count).toBe(1);
    expect(t.controller.draft.steps[0]!.target!.fingerprint?.tag).toBe('button');
  });

  it('replays one step on the live page and reports it', async () => {
    const t = await harness(searchPage(), emptyDraft({ name: 'search', url: SEARCH, vars: [] }), SEARCH);
    const box = descendantsOf(annotate(searchPage())).find((n) => n.tag === 'input')!;
    await t.send({ kind: 'draft.addStep', step: { kind: 'type', value: 'mouse' }, selection: selectionOf(box) });
    await t.send({ kind: 'draft.addField', patch: {} }).catch(() => {});
    const reply = (await t.send({ kind: 'draft.replayStep', index: 0 })) as HostMessage & { kind: 'step.replayResult' };
    expect(reply).toMatchObject({ kind: 'step.replayResult', index: 0 });
    // The draft has no field yet, so it does not validate: the step is not replayed.
    expect(reply.ok).toBe(false);

    const ready = await harness(searchPage(), withFields());
    await ready.send({ kind: 'draft.addStep', step: { kind: 'type', value: '{q}' }, selection: selectionOf(box) });
    await ready.send({ kind: 'draft.setVar', name: 'q', value: 'mouse' });
    const ok = (await ready.send({ kind: 'draft.replayStep', index: 0 })) as HostMessage & { kind: 'step.replayResult' };
    expect(ok).toMatchObject({ ok: true, message: 'replayed step 1 (type)' });
    const [live] = await ready.session.resolve({ strategy: 'css', value: 'input', stability: 'medium' });
    expect(await ready.session.read(live!, { attr: 'value', mode: 'text' })).toBe('mouse');
    expect(ready.events.find((e) => e.name === 'recorder.stepReplayed')?.payload).toEqual({ index: 0, kind: 'type', ok: true, message: 'replayed step 1 (type)' });
  });

  it('reports a failed replay without throwing', async () => {
    const t = await harness(searchPage(), withFields());
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' }, selection: { ...selectionOf(descendantsOf(t.page).find((n) => n.tag === 'button')!), candidates: [{ strategy: 'css', value: '.gone', stability: 'medium' }] } });
    const reply = (await t.send({ kind: 'draft.replayStep', index: 0 })) as HostMessage & { kind: 'step.replayResult' };
    expect(reply.ok).toBe(false);
    expect(reply.message).toMatch(/step 1 failed: .*found no element/);
  });
});
