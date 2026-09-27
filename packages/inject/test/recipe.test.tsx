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
      steps: [
        { kind: 'click', when: 'first-page', optional: false, count: null },
        { kind: 'type', value: '{email} {category}', when: 'first-page', optional: false, count: null },
      ],
      vars: [
        { name: 'category', value: 'shoes' },
        { name: 'email', value: 'me@acme.dev' },
        { name: 'later', value: '', added: true },
      ],
    };
    const p = renderPanel(baseState(draft));
    expect(p.q('var-usage-category')!.textContent).toBe('used in URL · used in step 2');
    expect(p.q('var-usage-email')!.textContent).toBe('used in step 2 · not in URL');
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
    const p = renderPanel({ ...baseState(draft), panel: { collapsed: { recipe: true, steps: false, pagination: true } } });
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
    const p = renderPanel({ ...baseState(draft), panel: { collapsed: { recipe: true, steps: false, pagination: true } } });
    const summary = p.q('section-recipe')!.querySelector('[data-ws="section-summary"]')!;
    expect(summary.querySelector('[data-ws="recipe-summary-url"]')!.textContent).toBe('https://www.google.com/search?q=querytop llms&hl=langen');
    expect(summary.querySelector('[data-ws="recipe-summary-var-lang"] .ws-chip-value')!.textContent).toBe('en');
    expect(summary.querySelector('[data-ws="recipe-summary-var-email"]')).toBeNull();
  });
});
