// @vitest-environment jsdom
import { dataset, render } from '@webscoop/playground';
import { beforeEach, describe, expect, it } from 'vitest';
import { describeSelection, elementAt, pathOfElement, resolveLocal } from '../src/dom';
import { isTypingTarget } from '../src/keyboard';

beforeEach(() => {
  const html = render(dataset, { tier: 0, seed: 1 });
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/, '').replace(/<\/html>\s*$/, '');
});

describe('in-page selection', () => {
  it('generates the tier 0 title candidates with dom-accessibility-api', () => {
    const title = document.querySelectorAll('h2.product-title')[1]!;
    const { selection, snapshot } = describeSelection(title, []);
    expect(selection.tag).toBe('h2');
    expect(selection.role).toBe('heading');
    expect(selection.name).toBe(dataset[1]!.title);
    expect(selection.candidates.map((c) => `${c.strategy}=${c.value}`)).toEqual([
      `role=heading|${dataset[1]!.title}`,
      `text=${dataset[1]!.title}`,
      'css=h2.product-title',
      "xpath=//article[@id='product-p02']/h2[1]",
    ]);
    expect(selection.fingerprint).toMatchObject({ tag: 'h2', role: 'heading', name: dataset[1]!.title });
    expect(selection.fingerprint.ancestors.slice(0, 3)).toEqual(['article', 'listitem', 'list']);
    expect(selection.ancestors.map((c) => c.label)).toEqual(['body', 'main.catalog', 'list.product-list', 'listitem.product-item', 'article.product-card', 'heading.product-title']);
    expect(selection.containerPath).toBeNull();
    expect(snapshot.tag).toBe('html');
    expect(elementAt(selection.path)).toBe(title);
  });

  it('reports the containing item and skips recorder hosts in paths', () => {
    const host = document.createElement('webscoop-root');
    document.documentElement.insertBefore(host, document.body);
    const price = document.querySelectorAll('[data-testid="price"]')[3]!;
    const cards = resolveLocal({ strategy: 'testid', value: 'product-card', stability: 'stable' });
    expect(cards).toHaveLength(24);
    const { selection, snapshot } = describeSelection(price, cards);
    expect(selection.containerPath).toEqual(pathOfElement(cards[3]!));
    expect(elementAt(selection.path)).toBe(price);
    expect(JSON.stringify(snapshot)).not.toContain('webscoop-root');
  });

  it('resolves candidates locally for highlighting', () => {
    expect(resolveLocal({ strategy: 'css', value: 'a.product-link', stability: 'medium' })).toHaveLength(24);
    expect(resolveLocal({ strategy: 'xpath', value: "//article[@id='product-p02']/h2[1]", stability: 'fragile' })).toHaveLength(1);
    expect(resolveLocal({ strategy: 'role', value: 'heading', stability: 'stable' })).toHaveLength(25);
    expect(resolveLocal({ strategy: 'text', value: dataset[5]!.title, stability: 'fragile' })).toHaveLength(1);
    expect(resolveLocal({ strategy: 'css', value: '::nonsense(', stability: 'medium' })).toEqual([]);
    const card = resolveLocal({ strategy: 'id', value: 'product-p03', stability: 'stable' })[0]!;
    expect(resolveLocal({ strategy: 'xpath', value: './h2[1]', stability: 'fragile' }, card)[0]!.textContent).toBe(dataset[2]!.title);
  });

  it('knows typing targets', () => {
    const input = document.createElement('input');
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(box)).toBe(false);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
  });
});
