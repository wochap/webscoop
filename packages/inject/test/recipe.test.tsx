// @vitest-environment jsdom
import { cleanup, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { baseState, newDraft, renderPanel } from './panel';
import { emptyDraft } from '@webscoop/core';

afterEach(cleanup);

describe('recipe bar', () => {
  const GOOGLE = 'https://www.google.com/search?q={query}';
  const google = (value = 'top llms', opened = 'https://www.google.com/search?q=top%20llms') =>
    baseState(emptyDraft({ name: 'google', url: GOOGLE, vars: [{ name: 'query', value }] }), opened);

  it('edits a value in the variables table and reopens', () => {
    const p = renderPanel(baseState());
    const input = p.q('var-input-category') as HTMLInputElement;
    expect(input.value).toBe('shoes');
    fireEvent.change(input, { target: { value: 'boots' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sent).toContainEqual({ kind: 'draft.setVar', name: 'category', value: 'boots' });
    fireEvent.click(p.q('recipe-reopen')!);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.reopen' });
  });

  it('toggles humanized input from the draft browser block', () => {
    const p = renderPanel(baseState());
    const toggle = p.q('recipe-humanize')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(p.q('recipe-humanize-hint')!.textContent).toContain('bot protection');
    fireEvent.click(toggle);
    expect(p.sent).toEqual([{ kind: 'draft.setHumanize', on: true }]);
    cleanup();
    const on = renderPanel(baseState({ ...newDraft(), browser: { humanize: true } }));
    expect(on.q('recipe-humanize')!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(on.q('recipe-humanize')!);
    expect(on.sent).toEqual([{ kind: 'draft.setHumanize', on: false }]);
  });

  it('renames the recipe on Enter and shows a refused name inline', () => {
    const p = renderPanel(baseState());
    const name = p.q('recipe-name') as HTMLInputElement;
    expect(name.value).toBe('shop-catalog');
    expect(p.q('recipe-name-error')).toBeNull();
    fireEvent.change(name, { target: { value: ' shoe-catalog ' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(p.sent).toEqual([{ kind: 'draft.setName', name: 'shoe-catalog' }]);
    cleanup();
    const refused = renderPanel(baseState({ ...newDraft(), name: 'Bad Name', nameError: 'name must be kebab-case' }));
    expect(refused.q('recipe-name')!.className).toContain('ws-invalid');
    expect(refused.q('recipe-name-error')!.textContent).toBe('name must be kebab-case');
  });

  it('commits the template on Enter, restores it on Esc, and mirrors it in the backdrop', () => {
    const p = renderPanel(google());
    const input = p.q('recipe-url') as HTMLInputElement;
    expect(p.q('recipe-url-backdrop')!.textContent).toBe(input.value);
    expect(p.q('recipe-url-backdrop')!.querySelector('.ws-token')!.textContent).toBe('{query}');
    fireEvent.change(input, { target: { value: `${GOOGLE}&hl={lang}` } });
    expect(p.q('recipe-url-backdrop')!.textContent).toBe(`${GOOGLE}&hl={lang}`);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.setUrl', url: `${GOOGLE}&hl={lang}` });
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe(GOOGLE);
    fireEvent.blur(input);
    expect(p.sent).toHaveLength(1);
  });

  it('shows the template error under the input', () => {
    const p = renderPanel({ ...google(), urlError: 'invalid URL template "x": unmatched "{"' });
    expect(p.q('recipe-url-error')!.textContent).toMatch(/unmatched/);
  });

  it('renders the encoded URL', () => {
    const p = renderPanel(google());
    expect(p.q('recipe-rendered-url')!.getAttribute('title')).toBe('https://www.google.com/search?q=top%20llms');
    expect(p.q('recipe-rendered-url')!.textContent).toBe('↳www.google.com/search?q=top%20llms');
    expect(p.q('recipe-rendered-url')!.querySelector('.ws-rendered-value')!.textContent).toBe('top%20llms');
  });

  it('flags Reopen and the template when the rendered URL differs from the opened one', () => {
    const same = renderPanel(google());
    expect(same.q('recipe-reopen-dot')).toBeNull();
    expect(same.q('recipe-url-edited')).toBeNull();
    expect(same.q('recipe-open-differs')).toBeNull();
    same.unmount();
    const draft = emptyDraft({ name: 'google', url: `${GOOGLE}&hl=en`, vars: [{ name: 'query', value: 'top llms' }] });
    const p = renderPanel(baseState(draft, 'https://www.google.com/search?q=top%20llms'));
    expect(p.q('recipe-reopen-dot')).not.toBeNull();
    expect(p.q('recipe-url-edited')!.textContent).toBe('edited');
    expect(p.q('recipe-open-differs')!.textContent).toBe('Open page differs: &hl=en added');
    expect(p.q('recipe-open-differs')!.title).toContain('https://www.google.com/search?q=top%20llms&hl=en');
  });

  it('sends Use current page URL', () => {
    const p = renderPanel(google());
    fireEvent.click(p.q('recipe-use-current')!);
    expect(p.sent).toEqual([{ kind: 'draft.useCurrentUrl' }]);
  });

  it('shows every usage hint', () => {
    let draft = emptyDraft({ name: 'shop', url: 'https://shop.test/c/{category}', vars: [{ name: 'category', value: 'shoes' }] });
    draft = {
      ...draft,
      flows: [
        {
          name: 'login',
          steps: [
            { kind: 'click', window: 'same', optional: false, count: null },
            { kind: 'fill', value: '{email} {category}', window: 'same', optional: false, count: null },
          ],
        },
      ],
      vars: [
        { name: 'category', value: 'shoes' },
        { name: 'email', value: 'me@acme.dev' },
        { name: 'later', value: '', added: true },
      ],
    };
    const p = renderPanel(baseState(draft));
    expect(p.q('var-usage-category')!.textContent).toBe('used in URL · used in login step 2');
    expect(p.q('var-usage-email')!.textContent).toBe('used in login step 2 · not in URL');
    expect(p.q('var-usage-later')!.textContent).toBe('not used');
  });

  it('confirms before removing a used variable, and removes an unused one at once', () => {
    const draft = emptyDraft({ name: 'google', url: GOOGLE, vars: [{ name: 'query', value: 'x' }] });
    const p = renderPanel(baseState({ ...draft, vars: [...draft.vars, { name: 'spare', value: '', added: true }] }));
    fireEvent.click(p.q('var-remove-spare')!);
    expect(p.sent).toEqual([{ kind: 'draft.removeVar', name: 'spare' }]);
    fireEvent.click(p.q('var-remove-query')!);
    expect(p.sent).toHaveLength(1);
    expect(p.q('var-confirm-query')!.textContent).toContain('Used in URL — replace with its value?');
    fireEvent.click(within(p.q('var-confirm-query')!).getByText('Cancel'));
    expect(p.q('var-confirm-query')).toBeNull();
    fireEvent.click(p.q('var-remove-query')!);
    fireEvent.click(within(p.q('var-confirm-query')!).getByText('Remove'));
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.removeVar', name: 'query' });
  });

  it('renames a variable, shows a refused name inline, and adds one', () => {
    const p = renderPanel({ ...google(), varError: { name: 'query', message: 'a variable named "q" already exists' } });
    const name = p.q('var-name-query') as HTMLInputElement;
    expect(name.className).toContain('ws-invalid');
    expect(p.q('var-row-query')!.nextElementSibling!.textContent).toBe('a variable named "q" already exists');
    fireEvent.change(name, { target: { value: 'q' } });
    fireEvent.blur(name);
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.renameVar', from: 'query', to: 'q' });
    fireEvent.click(p.q('var-add')!);
    const add = p.q('var-add-input') as HTMLInputElement;
    fireEvent.change(add, { target: { value: 'email' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    expect(p.sent.at(-1)).toEqual({ kind: 'draft.addVar', name: 'email' });
  });
});

describe('collapsed recipe', () => {
  it('shows the collapsed recipe as one line with the name and the URL with its variable values', () => {
    const draft = { ...newDraft(), name: 'google-com-search', url: 'https://www.google.com/search?q={query}', vars: [{ name: 'query', value: 'top llms' }] };
    const p = renderPanel({ ...baseState(draft), panel: { collapsed: { recipe: true, flows: false, sequence: true } } });
    const summary = p.q('section-recipe')!.querySelector('[data-ws="section-summary"]')!;
    expect(summary.querySelector('[data-ws="recipe-summary-name"]')!.textContent).toBe('google-com-search');
    expect(summary.querySelector('[data-ws="recipe-summary-url"]')!.textContent).toBe('https://www.google.com/search?q=querytop llms');
    expect(summary.querySelector('[data-ws="recipe-summary-var-query"] .ws-chip-value')!.textContent).toBe('top llms');
    fireEvent.click(p.q('section-recipe')!.querySelector('[data-ws="section-toggle"]')!);
    expect(p.sent).toEqual([{ kind: 'panel.setCollapsed', section: 'recipe', collapsed: false }]);
  });

  it('reflects an edited template in the collapsed recipe and leaves unused variables out', () => {
    const draft = {
      ...newDraft(),
      name: 'google-com-search',
      url: 'https://www.google.com/search?q={query}&hl={lang}',
      vars: [
        { name: 'query', value: 'top llms' },
        { name: 'lang', value: 'en' },
        { name: 'email', value: 'me@acme.dev', added: true as const },
      ],
    };
    const p = renderPanel({ ...baseState(draft), panel: { collapsed: { recipe: true, flows: false, sequence: true } } });
    const summary = p.q('section-recipe')!.querySelector('[data-ws="section-summary"]')!;
    expect(summary.querySelector('[data-ws="recipe-summary-url"]')!.textContent).toBe('https://www.google.com/search?q=querytop llms&hl=langen');
    expect(summary.querySelector('[data-ws="recipe-summary-var-lang"] .ws-chip-value')!.textContent).toBe('en');
    expect(summary.querySelector('[data-ws="recipe-summary-var-email"]')).toBeNull();
  });
});

describe('descriptions', () => {
  it('commits the recipe description on blur, trimmed by the host, and shows a refused one inline', () => {
    const p = renderPanel(baseState({ ...newDraft(), description: 'Shoes' }));
    const input = p.q('recipe-description') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.value).toBe('Shoes');
    fireEvent.change(input, { target: { value: 'Shoe catalog\none row per product' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sent).toEqual([]);
    fireEvent.blur(input);
    expect(p.sent).toEqual([{ kind: 'draft.setDescription', target: { kind: 'recipe' }, text: 'Shoe catalog\none row per product' }]);
    cleanup();
    const refused = renderPanel({ ...baseState(), descriptionError: { key: 'recipe', message: 'a description is at most 2000 characters' } });
    expect(refused.q('recipe-description-error')!.textContent).toContain('2000');
  });

  it('edits the active table description under the tab bar', () => {
    const draft = newDraft();
    const p = renderPanel(baseState({ ...draft, tables: [{ ...draft.tables[0]!, description: 'products' }] }));
    const input = p.q('table-description') as HTMLTextAreaElement;
    expect(input.value).toBe('products');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(p.sent).toEqual([{ kind: 'draft.setDescription', target: { kind: 'table', index: 0 }, text: '' }]);
  });

  it('edits a variable description in its row as a single line', () => {
    const p = renderPanel(baseState());
    const input = p.q('var-description-category') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    fireEvent.change(input, { target: { value: 'product category' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.sent).toEqual([{ kind: 'draft.setDescription', target: { kind: 'var', name: 'category' }, text: 'product category' }]);
  });
});

describe('variable kinds', () => {
  const draft = () =>
    emptyDraft({
      name: 'portal',
      url: 'https://portal.test/reports?period={period}',
      vars: [
        { name: 'period', value: '2026-09' },
        { name: 'password', value: '', secret: true, set: true, added: true },
        { name: 'video', value: '~/clips/demo.mp4', type: 'path', added: true },
        { name: 'api_token', value: '', secret: true, origin: 'config', added: true },
        { name: 'region', value: 'EU-West', origin: 'cli', added: true },
      ],
    });

  it('shows each variable as text, secret, path, or external, with notes', () => {
    const state = { ...baseState(draft()), pathChecks: { video: { value: '~/clips/demo.mp4', paths: [{ path: '~/clips/demo.mp4', exists: true }] } } };
    const p = renderPanel(state);
    expect((p.q('var-kind-period') as HTMLSelectElement).value).toBe('text');
    expect((p.q('var-kind-password') as HTMLSelectElement).value).toBe('secret');
    expect((p.q('var-kind-video') as HTMLSelectElement).value).toBe('path');
    expect(p.q('var-kind-api_token')!.textContent).toBe('external');
    const secret = p.q('var-input-password') as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(secret.value).toBe('');
    expect(secret.placeholder).toBe('••••••••');
    expect(p.q('var-kind-note-password')!.textContent).toBe('secret · never saved');
    expect(p.q('var-kind-note-video')!.textContent).toBe('default saved · file exists');
    expect(p.q('var-kind-note-api_token')!.textContent).toBe('from config · read-only here');
    expect(p.q('var-kind-note-region')!.textContent).toBe('from CLI · read-only here');
    const external = p.q('var-input-region') as HTMLInputElement;
    expect(external.readOnly).toBe(true);
    expect((p.q('var-input-api_token') as HTMLInputElement).value).toBe('••••••••');
  });

  it('marks a variable secret, changes its type, and asks the host to check a path', () => {
    const p = renderPanel(baseState(draft()));
    fireEvent.change(p.q('var-kind-period')!, { target: { value: 'secret' } });
    expect(p.sent).toContainEqual({ kind: 'draft.setVarKind', name: 'period', secret: true, type: 'string' });
    fireEvent.change(p.q('var-kind-period')!, { target: { value: 'path' } });
    expect(p.sent).toContainEqual({ kind: 'draft.setVarKind', name: 'period', secret: false, type: 'path' });
    expect(p.sent).toContainEqual({ kind: 'vars.checkPath', name: 'video' });
  });

  it('shows the paths not found', () => {
    const state = { ...baseState(draft()), pathChecks: { video: { value: '~/clips/demo.mp4', paths: [{ path: '~/clips/demo.mp4', exists: false }] } } };
    const p = renderPanel(state);
    expect(p.q('var-path-check-video')!.textContent).toContain('not found: ~/clips/demo.mp4');
  });
});
