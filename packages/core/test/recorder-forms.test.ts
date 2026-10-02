import { describe, expect, it } from 'vitest';
import {
  annotate,
  descendantsOf,
  draftFromRecipe,
  draftToRecipe,
  emptyDraft,
  loadRecipe,
  reduceDraft,
  RecorderController,
  selectionOf,
  uniqueVarName,
  type FilePort,
  type HostMessage,
  type RecorderState,
} from '../src';
import { FakeBrowser, h } from '../src/testing';
import { MemoryStorage } from './recorder-helpers';

const URL_ = 'http://127.0.0.1:4777/forms';

function formPage() {
  return h(
    'html',
    {},
    h(
      'body',
      {},
      h(
        'form',
        {},
        h('input', { type: 'email', name: 'email', id: 'email' }),
        h('input', { type: 'password', name: 'pass', id: 'Password' }),
        h('input', { type: 'file', name: 'video', id: 'video' }),
        h('button', { id: 'pick', type: 'button' }, 'Select file'),
      ),
    ),
  );
}

async function setup(files?: FilePort) {
  const dom = formPage();
  const browser = new FakeBrowser({ [URL_]: { dom } });
  const session = await browser.open('/profile');
  const storage = new MemoryStorage();
  const controller = new RecorderController({ session, storage, bundle: '', draft: emptyDraft({ name: 'login', url: URL_, vars: [] }), ...(files ? { files } : {}) });
  await controller.start();
  const page = annotate(dom);
  const send = async (msg: unknown) => (await session.callHost(msg)) as HostMessage;
  const selection = (id: string) => {
    const node = descendantsOf(page).find((n) => n.attrs.id === id)!;
    const s = selectionOf(node);
    return { ...s, candidates: s.candidates.map((c) => ({ ...c, count: 1 })) };
  };
  return { controller, storage, send, selection };
}

const stateOf = (reply: HostMessage) => (reply as { state: RecorderState }).state;

describe('recorder fills with variables', () => {
  it('turns a typed password into a secret variable, kept on the host only, and saves no value', async () => {
    const t = await setup();
    const reply = await t.send({ kind: 'draft.addStep', step: { kind: 'fill', value: 'hunter2', variable: { name: 'Password', secret: true } }, selection: t.selection('Password') });
    const [step] = t.controller.draft.flows[0]!.steps;
    expect(step!.value).toBe('{password}');
    expect(t.controller.draft.vars).toEqual([{ name: 'password', value: 'hunter2', added: true, secret: true }]);
    // The page sees only that a value is set.
    expect(stateOf(reply).draft.vars[0]).toMatchObject({ name: 'password', value: '', secret: true, set: true });
    expect(JSON.stringify(reply)).not.toContain('hunter2');
    // Typing it again updates the same variable.
    await t.send({ kind: 'draft.addStep', step: { kind: 'fill', value: 'hunter3', variable: { name: 'Password', secret: true } }, selection: t.selection('Password') });
    expect(t.controller.draft.vars.map((v) => [v.name, v.value])).toEqual([['password', 'hunter3']]);
    expect(t.controller.draft.flows[0]!.steps).toHaveLength(1);
    const recipe = draftToRecipe(t.controller.draft);
    expect(recipe.vars).toEqual([{ name: 'password', type: 'string', secret: true }]);
    expect(JSON.stringify(recipe)).not.toContain('hunter');
  });

  it('turns a file input into an empty path variable and checks typed paths on the host', async () => {
    const files: FilePort = { resolve: (p) => `/home/me/${p}`, readable: async (p) => p === '/home/me/a.mp4' };
    const t = await setup(files);
    await t.send({ kind: 'draft.addStep', step: { kind: 'fill', variable: { name: 'video', type: 'path' } }, selection: t.selection('video') });
    expect(t.controller.draft.flows[0]!.steps[0]!.value).toBe('{video}');
    expect(t.controller.draft.vars).toEqual([{ name: 'video', value: '', added: true, type: 'path' }]);
    const reply = await t.send({ kind: 'draft.setVar', name: 'video', value: 'a.mp4:b.mp4' });
    expect(stateOf(reply).pathChecks.video).toEqual({ value: 'a.mp4:b.mp4', paths: [{ path: 'a.mp4', exists: true }, { path: 'b.mp4', exists: false }] });
    expect(draftToRecipe(t.controller.draft).vars).toEqual([{ name: 'video', type: 'path', default: 'a.mp4:b.mp4' }]);
  });

  it('drops the click that opened a file chooser', async () => {
    const t = await setup();
    await t.send({ kind: 'draft.addStep', step: { kind: 'click' }, selection: t.selection('pick') });
    await t.send({ kind: 'draft.addStep', step: { kind: 'fill', variable: { name: 'video', type: 'path' }, replacesClick: true }, selection: t.selection('pick') });
    expect(t.controller.draft.flows[0]!.steps.map((s) => [s.kind, s.value])).toEqual([['fill', '{video}']]);
  });

  it('makes a literal value a variable with the name given', async () => {
    const t = await setup();
    await t.send({ kind: 'draft.addStep', step: { kind: 'fill', value: 'dev@example.test', variable: { name: 'email' } }, selection: t.selection('email') });
    expect(t.controller.draft.flows[0]!.steps[0]!.value).toBe('{email}');
    expect(draftToRecipe(t.controller.draft).vars).toEqual([{ name: 'email', type: 'string', default: 'dev@example.test' }]);
  });
});

describe('variable kinds in the draft', () => {
  const recipe = () =>
    loadRecipe({
      schemaVersion: 2,
      name: 'sunat-menu',
      url: 'https://x.test/{period}',
      vars: [
        { name: 'period', type: 'string', default: '2026-09' },
        { name: 'pass', type: 'string', secret: true },
        { name: 'video', type: 'path', default: '~/clips/demo.mp4' },
      ],
      flows: [{ name: 'login', steps: [{ kind: 'fill', target: { selectors: [{ strategy: 'css', value: '#p', stability: 'medium' }] }, value: '{pass}{video}' }] }],
      sequence: [{ flow: 'login' }],
    });

  it('loads kinds and origins, keeps external values read-only, and saves the recipe default for external values and nothing for secrets', () => {
    let draft = draftFromRecipe(recipe(), { pass: 's3cret', period: '2026-10' }, { pass: 'config', period: 'cli' });
    expect(draft.vars.map((v) => [v.name, v.type ?? 'text', v.secret ?? false, v.origin ?? null])).toEqual([
      ['period', 'text', false, 'cli'],
      ['pass', 'text', true, 'config'],
      ['video', 'path', false, null],
    ]);
    draft = reduceDraft(draft, { type: 'setVar', name: 'pass', value: 'other' });
    expect(draft.vars[1]!.value).toBe('s3cret');
    draft = reduceDraft(draft, { type: 'setVarKind', name: 'period', secret: true });
    expect(draft.vars[0]!.secret).toBeUndefined();
    const saved = draftToRecipe(draft);
    expect(saved.vars).toEqual([
      { name: 'period', type: 'string', default: '2026-09' },
      { name: 'pass', type: 'string', secret: true },
      { name: 'video', type: 'path', default: '~/clips/demo.mp4' },
    ]);
  });

  it('marks a text variable secret and switches types', () => {
    let draft = draftFromRecipe(recipe());
    draft = reduceDraft(draft, { type: 'setVarKind', name: 'period', secret: true });
    expect(draft.vars[0]).toMatchObject({ secret: true, value: '2026-09' });
    expect(draftToRecipe(draft).vars![0]).toEqual({ name: 'period', type: 'string', secret: true });
    draft = reduceDraft(draft, { type: 'setVarKind', name: 'pass', varType: 'path' });
    expect(draft.vars[1]).toMatchObject({ type: 'path' });
    expect(draft.vars[1]!.secret).toBeUndefined();
  });

  it('inlines nothing when a secret variable is removed', () => {
    let draft = draftFromRecipe(recipe(), { pass: 's3cret' });
    draft = reduceDraft(draft, { type: 'removeVar', name: 'pass' });
    expect(draft.flows[0]!.steps[0]!.value).toBe('{video}');
  });

  it('names variables from a hint, uniquely', () => {
    const draft = { vars: [{ name: 'password', value: '' }] };
    expect(uniqueVarName(draft, 'Password', 'password')).toBe('password_2');
    expect(uniqueVarName(draft, 'Correo electrónico', 'value')).toBe('correo_electronico');
    expect(uniqueVarName(draft, '123', 'file')).toBe('file');
  });
});
