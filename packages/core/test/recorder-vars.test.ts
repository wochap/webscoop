import { describe, expect, it } from 'vitest';
import { draftToRecipe, emptyDraft, reduceDraft, type Draft } from '../src';
import { CATALOG, harness } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

const GOOGLE = 'https://www.google.com/search?q={query}';

function google(value = 'top llms'): Draft {
  return emptyDraft({ name: 'google', url: GOOGLE, vars: [{ name: 'query', value }] });
}

function catalog(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}

const typeStep = (value: string) => ({ type: 'addStep' as const, step: { kind: 'type' as const, value } });

describe('draft variable actions', () => {
  it('edits the template and adds a variable with an empty value', () => {
    const draft = reduceDraft(google(), { type: 'setUrl', url: `${GOOGLE}&hl={lang}` });
    expect(draft.url).toBe(`${GOOGLE}&hl={lang}`);
    expect(draft.vars).toEqual([
      { name: 'query', value: 'top llms' },
      { name: 'lang', value: '' },
    ]);
    expect(draft.dirty).toBe(true);
  });

  it('leaves the draft unchanged for an invalid template', () => {
    const draft = google();
    expect(reduceDraft(draft, { type: 'setUrl', url: 'https://shop.test/c/{category' })).toBe(draft);
  });

  it('renames a variable in the template and in type step values', () => {
    let draft = emptyDraft({ name: 'login', url: 'https://shop.test/login', vars: [] });
    draft = reduceDraft(draft, typeStep('{login_email}'));
    draft = reduceDraft(draft, { type: 'setVar', name: 'login_email', value: 'me@acme.dev' });
    draft = reduceDraft(draft, { type: 'renameVar', from: 'login_email', to: 'email' });
    expect(draft.steps[0]!.value).toBe('{email}');
    expect(draft.vars).toEqual([{ name: 'email', value: 'me@acme.dev' }]);
  });

  it('refuses a rename to an invalid or taken name', () => {
    let draft = reduceDraft(google(), { type: 'setUrl', url: `${GOOGLE}&hl={lang}` });
    expect(reduceDraft(draft, { type: 'renameVar', from: 'query', to: 'lang' })).toBe(draft);
    expect(reduceDraft(draft, { type: 'renameVar', from: 'query', to: '1q' })).toBe(draft);
    draft = reduceDraft(draft, { type: 'renameVar', from: 'query', to: 'q' });
    expect(draft.url).toBe('https://www.google.com/search?q={q}&hl={lang}');
  });

  it('removes a used variable by writing its value in place', () => {
    let draft = emptyDraft({ name: 'shop', url: 'https://shop.test/c/{category}', vars: [{ name: 'category', value: 'shoes' }] });
    draft = reduceDraft(draft, typeStep('{category}'));
    draft = reduceDraft(draft, { type: 'setVar', name: 'category', value: 'red shoes' });
    draft = reduceDraft(draft, { type: 'removeVar', name: 'category' });
    expect(draft.url).toBe('https://shop.test/c/red%20shoes');
    expect(draft.steps[0]!.value).toBe('red shoes');
    expect(draft.vars).toEqual([]);
  });

  it('keeps an added variable nothing uses, and does not save it', () => {
    let draft = reduceDraft(google(), { type: 'addVar', name: 'email' });
    draft = reduceDraft(draft, { type: 'setVar', name: 'email', value: 'me@acme.dev' });
    draft = reduceDraft(draft, { type: 'setUrl', url: `${GOOGLE}&hl={lang}` });
    expect(draft.vars.map((v) => v.name)).toEqual(['query', 'lang', 'email']);
    expect(draft.vars[2]).toEqual({ name: 'email', value: 'me@acme.dev', added: true });
    expect(draftToRecipe(draft).vars!.map((v) => v.name)).toEqual(['query', 'lang']);
    // Once a step uses it, it is declared like any other variable.
    draft = reduceDraft(draft, typeStep('{email}'));
    expect(draftToRecipe(draft).vars).toContainEqual({ name: 'email', type: 'string', default: 'me@acme.dev' });
    expect(reduceDraft(draft, { type: 'addVar', name: 'email' })).toBe(draft);
  });
});

describe('recorder variable messages', () => {
  it('records the opened URL at start and on reopen, not on navigation', async () => {
    const t = await harness(tier0Snapshot(), catalog());
    expect(t.controller.state.openedUrl).toBe(CATALOG);
    await t.send({ kind: 'session.ready', url: 'http://127.0.0.1:4777/product/1' });
    expect(t.controller.state.openedUrl).toBe(CATALOG);
    await t.send({ kind: 'draft.setVar', name: 'tier', value: '1' });
    expect(t.controller.state.openedUrl).toBe(CATALOG);
    await t.send({ kind: 'draft.reopen' });
    expect(t.controller.state.openedUrl).toBe('http://127.0.0.1:4777/catalog?tier=1');
  });

  it('refuses an invalid template into urlError and clears it on the next accepted edit', async () => {
    const t = await harness(tier0Snapshot(), catalog());
    await t.send({ kind: 'draft.setUrl', url: 'http://127.0.0.1:4777/catalog?tier={tier' });
    expect(t.controller.state.urlError).toMatch(/unmatched "\{"/);
    expect(t.controller.draft.url).toBe('http://127.0.0.1:4777/catalog?tier={tier}');
    await t.send({ kind: 'draft.setUrl', url: 'http://127.0.0.1:4777/catalog?tier={tier}&sort={sort}' });
    expect(t.controller.state.urlError).toBeNull();
    expect(t.controller.draft.vars.map((v) => v.name)).toEqual(['tier', 'sort']);
  });

  it('refuses bad variable names into varError', async () => {
    const t = await harness(tier0Snapshot(), catalog());
    await t.send({ kind: 'draft.addVar', name: 'tier' });
    expect(t.controller.state.varError).toEqual({ name: 'tier', message: 'a variable named "tier" already exists' });
    await t.send({ kind: 'draft.renameVar', from: 'tier', to: 'bad name' });
    expect(t.controller.state.varError?.name).toBe('tier');
    expect(t.controller.state.varError?.message).toMatch(/letter or _/);
    await t.send({ kind: 'draft.renameVar', from: 'tier', to: 'level' });
    expect(t.controller.state.varError).toBeNull();
    expect(t.controller.draft.url).toBe('http://127.0.0.1:4777/catalog?tier={level}');
    await t.send({ kind: 'draft.removeVar', name: 'level' });
    expect(t.controller.draft.url).toBe(CATALOG);
  });

  it('uses the current page URL, putting back variables found once', async () => {
    const t = await harness(tier0Snapshot(), catalog());
    await t.send({ kind: 'draft.setVar', name: 'tier', value: 'gold plus' });
    await t.send({ kind: 'session.ready', url: 'http://127.0.0.1:4777/catalog?tier=gold+plus&page=2' });
    await t.send({ kind: 'draft.useCurrentUrl' });
    expect(t.controller.draft.url).toBe('http://127.0.0.1:4777/catalog?tier={tier}&page=2');
    // A value found more than once stays literal and drops out of the template.
    await t.send({ kind: 'draft.setVar', name: 'tier', value: '0' });
    await t.send({ kind: 'session.ready', url: CATALOG });
    await t.send({ kind: 'draft.useCurrentUrl' });
    expect(t.controller.draft.url).toBe(CATALOG);
    expect(t.controller.draft.vars).toEqual([]);
  });
});
