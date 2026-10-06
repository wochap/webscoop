import { describe, expect, it } from 'vitest';
import { draftFromRecipe, draftToRecipe, emptyDraft, loadRecipe, reduceDraft, type Draft } from '../src';
import { CATALOG, harness } from './recorder-helpers';
import { tier0Snapshot } from './snapshot';

const GOOGLE = 'https://www.google.com/search?q={query}';

function google(value = 'top llms'): Draft {
  return emptyDraft({ name: 'google', url: GOOGLE, vars: [{ name: 'query', value }] });
}

function catalog(): Draft {
  return emptyDraft({ name: 'shop-catalog', url: 'http://127.0.0.1:4777/catalog?tier={tier}', vars: [{ name: 'tier', value: '0' }] });
}

const typeStep = (value: string) => ({ type: 'addStep' as const, step: { kind: 'fill' as const, value } });

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

  it('renames a variable in the template and in fill step values', () => {
    let draft = emptyDraft({ name: 'login', url: 'https://shop.test/login', vars: [] });
    draft = reduceDraft(draft, typeStep('{login_email}'));
    draft = reduceDraft(draft, { type: 'setVar', name: 'login_email', value: 'me@acme.dev' });
    draft = reduceDraft(draft, { type: 'renameVar', from: 'login_email', to: 'email' });
    expect(draft.flows[0]!.steps[0]!.value).toBe('{email}');
    expect(draft.vars).toEqual([{ name: 'email', value: 'me@acme.dev' }]);
  });

  it('refuses a rename to an invalid or taken name', () => {
    let draft = reduceDraft(google(), { type: 'setUrl', url: `${GOOGLE}&hl={lang}` });
    expect(reduceDraft(draft, { type: 'renameVar', from: 'query', to: 'lang' })).toBe(draft);
    expect(reduceDraft(draft, { type: 'renameVar', from: 'query', to: '1q' })).toBe(draft);
    draft = reduceDraft(draft, { type: 'renameVar', from: 'query', to: 'q' });
    expect(draft.url).toBe('https://www.google.com/search?q={q}&hl={lang}');
  });

  it('renames and removes a raw variable', () => {
    let draft = emptyDraft({ name: 'h', url: 'https://h.test/d/{path}', vars: [{ name: 'path', value: 'ID/edit', raw: true }] });
    const renamed = reduceDraft(draft, { type: 'renameVar', from: 'path', to: 'p' });
    expect(renamed.url).toBe('https://h.test/d/{p}');
    expect(renamed.vars).toEqual([{ name: 'p', value: 'ID/edit', raw: true }]);
    draft = reduceDraft(draft, { type: 'removeVar', name: 'path' });
    expect(draft.url).toBe('https://h.test/d/ID/edit');
  });

  it('round-trips a raw variable through the draft and save', () => {
    const recipe = loadRecipe({ schemaVersion: 2, name: 'search', url: 'https://www.google.com/search?q={q}', vars: [{ name: 'q', type: 'string', raw: true, default: 'a+b' }], flows: [{ name: 'f', steps: [{ kind: 'fill', target: { selectors: [{ strategy: 'css', value: '#p', stability: 'medium' }] }, value: 'x' }] }], sequence: [{ flow: 'f' }] });
    const draft = draftFromRecipe(recipe);
    expect(draft.vars).toEqual([{ name: 'q', value: 'a+b', raw: true }]);
    expect(draftToRecipe(draft).vars).toEqual([{ name: 'q', type: 'string', raw: true, default: 'a+b' }]);
  });

  it('keeps one kind per variable', () => {
    let draft = emptyDraft({ name: 'h', url: 'https://h.test/?q={q}', vars: [{ name: 'q', value: 'a+b' }] });
    draft = reduceDraft(draft, { type: 'setVarKind', name: 'q', raw: true });
    expect(draft.vars[0]).toEqual({ name: 'q', value: 'a+b', raw: true });
    draft = reduceDraft(draft, { type: 'setVarKind', name: 'q', secret: true });
    expect(draft.vars[0]!.secret).toBe(true);
    expect(draft.vars[0]!.raw).toBeUndefined();
    draft = reduceDraft(draft, { type: 'setVarKind', name: 'q', secret: false, varType: 'string', raw: true });
    expect(draft.vars[0]!.raw).toBe(true);
    draft = reduceDraft(draft, { type: 'setVarKind', name: 'q', secret: false, varType: 'path', raw: false });
    expect(draft.vars[0]!.type).toBe('path');
    expect(draft.vars[0]!.raw).toBeUndefined();
  });


  it('removes a used variable by writing its value in place', () => {
    let draft = emptyDraft({ name: 'shop', url: 'https://shop.test/c/{category}', vars: [{ name: 'category', value: 'shoes' }] });
    draft = reduceDraft(draft, typeStep('{category}'));
    draft = reduceDraft(draft, { type: 'setVar', name: 'category', value: 'red shoes' });
    draft = reduceDraft(draft, { type: 'removeVar', name: 'category' });
    expect(draft.url).toBe('https://shop.test/c/red%20shoes');
    expect(draft.flows[0]!.steps[0]!.value).toBe('red shoes');
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

  it('opens a raw value unchanged and marks a variable raw from the current page URL', async () => {
    const t = await harness(tier0Snapshot(), catalog());
    await t.send({ kind: 'draft.setVarKind', name: 'tier', raw: true });
    await t.send({ kind: 'draft.setVar', name: 'tier', value: 'a+b' });
    await t.send({ kind: 'draft.reopen' });
    expect(t.controller.state.openedUrl).toBe('http://127.0.0.1:4777/catalog?tier=a+b');
    await t.send({ kind: 'draft.setVarKind', name: 'tier', raw: false });
    await t.send({ kind: 'draft.setVar', name: 'tier', value: 'ID/edit' });
    await t.send({ kind: 'session.ready', url: 'http://127.0.0.1:4777/d/ID/edit?usp=sharing' });
    await t.send({ kind: 'draft.useCurrentUrl' });
    expect(t.controller.draft.url).toBe('http://127.0.0.1:4777/d/{tier}?usp=sharing');
    expect(t.controller.draft.vars).toEqual([{ name: 'tier', value: 'ID/edit', raw: true }]);
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

describe('descriptions', () => {
  const field = { name: 'title', type: 'text' as const, scope: 'page' as const, selectors: [{ strategy: 'css' as const, value: 'h1', stability: 'medium' as const }], optional: false, key: false, count: null, sample: null };
  const withField = (draft: Draft): Draft => ({ ...draft, tables: draft.tables.map((t, i) => (i === 0 ? { ...t, fields: [field] } : t)) });

  it('sets, trims, and removes recipe, table, and variable descriptions', () => {
    let draft = withField(google());
    draft = reduceDraft(draft, { type: 'setDescription', target: { kind: 'recipe' }, text: '  Google results\n one row per result  ' });
    draft = reduceDraft(draft, { type: 'setDescription', target: { kind: 'table', index: 0 }, text: 'search results' });
    draft = reduceDraft(draft, { type: 'setDescription', target: { kind: 'var', name: 'query' }, text: ' search terms ' });
    expect(draft.description).toBe('Google results\n one row per result');
    expect(draft.tables[0]!.description).toBe('search results');
    expect(draft.vars[0]!.description).toBe('search terms');
    expect(draft.dirty).toBe(true);
    draft = reduceDraft(draft, { type: 'setDescription', target: { kind: 'recipe' }, text: '   ' });
    expect('description' in draft).toBe(false);
    expect(draftToRecipe(draft).description).toBeUndefined();
  });

  it('keeps a variable description through a rename and on save', () => {
    let draft = withField(google());
    draft = reduceDraft(draft, { type: 'setDescription', target: { kind: 'var', name: 'query' }, text: 'search terms' });
    draft = reduceDraft(draft, { type: 'renameVar', from: 'query', to: 'q' });
    expect(draft.vars).toEqual([{ name: 'q', value: 'top llms', description: 'search terms' }]);
    expect(draftToRecipe(draft).vars).toEqual([{ name: 'q', type: 'string', default: 'top llms', description: 'search terms' }]);
  });

  it('refuses a description over the limit into descriptionError and keeps the previous one', async () => {
    const t = await harness(tier0Snapshot(), catalog());
    await t.send({ kind: 'draft.setDescription', target: { kind: 'table', index: 0 }, text: 'products' });
    await t.send({ kind: 'draft.setDescription', target: { kind: 'table', index: 0 }, text: 'x'.repeat(2001) });
    expect(t.controller.state.descriptionError).toEqual({ key: 'table:0', message: 'a description is at most 2000 characters' });
    expect(t.controller.state.draft.tables[0]!.description).toBe('products');
    await t.send({ kind: 'draft.setDescription', target: { kind: 'table', index: 0 }, text: 'cards' });
    expect(t.controller.state.descriptionError).toBeNull();
    expect(t.controller.state.draft.tables[0]!.description).toBe('cards');
  });
});
