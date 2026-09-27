import { describe, expect, it } from 'vitest';
import { describeUrlDiff, fillTemplate, inlineVariable, MissingVariableError, renameVariable, retemplateUrl, templateProblem, templateVariables, urlDiff } from '../src';

describe('URL template', () => {
  it('lists variables in order of first use', () => {
    expect(templateVariables('/c/{category}?p={n}&again={category}')).toEqual(['category', 'n']);
  });

  it('URL-encodes values', () => {
    const vars = [{ name: 'category', type: 'string' as const }];
    expect(fillTemplate('/c/{category}', vars, { category: 'running shoes' })).toBe('/c/running%20shoes');
  });

  it('falls back to declared defaults and lets given values win', () => {
    const vars = [{ name: 'n', type: 'string' as const, default: '1' }];
    expect(fillTemplate('/p?n={n}', vars)).toBe('/p?n=1');
    expect(fillTemplate('/p?n={n}', vars, { n: '4' })).toBe('/p?n=4');
  });

  it('reports every missing variable by name', () => {
    const vars = [
      { name: 'category', type: 'string' as const },
      { name: 'sort', type: 'string' as const },
    ];
    try {
      fillTemplate('/c/{category}?sort={sort}', vars);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MissingVariableError);
      expect((error as MissingVariableError).names).toEqual(['category', 'sort']);
      expect((error as Error).message).toContain('category');
    }
  });
});

describe('template helpers', () => {
  it('reports template problems with the CLI messages', () => {
    expect(templateProblem('https://shop.test/c/{category}')).toBeNull();
    expect(templateProblem('https://shop.test/c/{category')).toMatch(/unmatched "\{"/);
    expect(templateProblem('/relative')).toMatch(/not an absolute URL/);
    expect(templateProblem('ftp://x/{a}')).toMatch(/only http and https/);
  });

  it('renames and inlines only exact variable tokens', () => {
    expect(renameVariable('{a} {ab} {a}', 'a', 'b')).toBe('{b} {ab} {b}');
    expect(inlineVariable('/c/{category}?x={other}', 'category', 'red shoes', true)).toBe('/c/red%20shoes?x={other}');
    expect(inlineVariable('{email}', 'email', 'a+b@x', false)).toBe('a+b@x');
  });

  it('re-templates a page URL on an exact single match', () => {
    expect(retemplateUrl('https://shop.test/search?q=red+shoes&page=2', [{ name: 'query', value: 'red shoes' }])).toBe(
      'https://shop.test/search?q={query}&page=2',
    );
    expect(retemplateUrl('https://x.test/?a=top%20llms', [{ name: 'q', value: 'top llms' }])).toBe('https://x.test/?a={q}');
    // Two matches leave the URL literal; longer values claim their span first.
    expect(retemplateUrl('https://x.test/1/1', [{ name: 'n', value: '1' }])).toBe('https://x.test/1/1');
    expect(retemplateUrl('https://x.test/?a=shoes&b=red%20shoes', [{ name: 's', value: 'shoes' }, { name: 'r', value: 'red shoes' }])).toBe(
      'https://x.test/?a={s}&b={r}',
    );
  });

  it('describes how two URLs differ', () => {
    const diff = urlDiff('https://www.google.com/search?q=top%20llms', 'https://www.google.com/search?q=top%20llms&hl=en');
    expect(diff).toEqual({ from: '', to: '&hl=en' });
    expect(describeUrlDiff(diff!)).toBe('&hl=en added');
    expect(describeUrlDiff(urlDiff('https://x/a?q=1', 'https://x/a')!)).toBe('?q=1 removed');
    expect(describeUrlDiff(urlDiff('https://x/c/red', 'https://x/c/blue')!)).toBe('red → blue');
    expect(urlDiff('https://x', 'https://x')).toBeNull();
  });
});
