import { describe, expect, it } from 'vitest';
import { describeUrlDiff, encodeValue, fillTemplate, fillText, inlineVariable, MissingVariableError, renameVariable, retemplateUrl, templateParts, templateProblem, templateVariables, urlDiff } from '../src';

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
    expect(retemplateUrl('https://shop.test/search?q=red+shoes&page=2', [{ name: 'query', value: 'red shoes' }])).toEqual({
      url: 'https://shop.test/search?q={query}&page=2',
      raw: [],
    });
    expect(retemplateUrl('https://x.test/?a=top%20llms', [{ name: 'q', value: 'top llms' }]).url).toBe('https://x.test/?a={q}');
    // Two matches leave the URL literal; longer values claim their span first.
    expect(retemplateUrl('https://x.test/1/1', [{ name: 'n', value: '1' }]).url).toBe('https://x.test/1/1');
    expect(retemplateUrl('https://x.test/?a=shoes&b=red%20shoes', [{ name: 's', value: 'shoes' }, { name: 'r', value: 'red shoes' }]).url).toBe(
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

describe('raw variables', () => {
  const str = (name: string) => ({ name, type: 'string' as const });
  const raw = (name: string) => ({ name, type: 'string' as const, raw: true });

  it('encodes by the declaration', () => {
    expect(encodeValue(true, 'a/b')).toBe('a/b');
    expect(encodeValue(false, 'a/b')).toBe('a%2Fb');
  });

  it('inserts a raw value unchanged and URL-encodes the rest', () => {
    expect(fillTemplate('https://www.google.com/search?q={q}', [raw('q')], { q: 'a+sentence+with+plus' })).toBe('https://www.google.com/search?q=a+sentence+with+plus');
    expect(fillTemplate('https://h.test/{p}', [raw('p')], { p: '100%/a' })).toBe('https://h.test/100%/a');
    expect(fillTemplate('https://h.test/d/{path}', [str('path')], { path: 'ID/edit' })).toBe('https://h.test/d/ID%2Fedit');
    expect(fillTemplate('https://h.test/d/{path}', [raw('path')], { path: 'ID/edit?usp=drive_link' })).toBe('https://h.test/d/ID/edit?usp=drive_link');
    expect(fillText('{x}', [raw('x')], { x: 'a/b c' })).toBe('a/b c');
  });

  it('refuses the {+name} syntax', () => {
    expect(templateProblem('https://h.test/d/{+path}')).toMatch(/unmatched/);
    expect(templateProblem('https://h.test/d/{+path}')).not.toContain('or {+name}');
    expect(templateVariables('https://h.test/{+x}')).toEqual([]);
    expect(templateParts('https://h.test/{p}?q=1')).toEqual([{ text: 'https://h.test/' }, { name: 'p' }, { text: '?q=1' }]);
    expect(renameVariable('https://h.test/{path}?q={path}', 'path', 'p')).toBe('https://h.test/{p}?q={p}');
    expect(inlineVariable('https://h.test/{path}', 'path', 'ID/edit', false)).toBe('https://h.test/ID/edit');
  });

  it('re-templates by the unchanged value and reports what it marked raw', () => {
    expect(retemplateUrl('https://h.test/d/ID/edit?usp=sharing', [{ name: 'path', value: 'ID/edit' }])).toEqual({ url: 'https://h.test/d/{path}?usp=sharing', raw: ['path'] });
    expect(retemplateUrl('https://h.test/d/ID/edit#top', [{ name: 'path', value: 'ID/edit', raw: true }])).toEqual({ url: 'https://h.test/d/{path}#top', raw: [] });
    // A raw variable tries only its unchanged value.
    expect(retemplateUrl('https://x.test/?a=top%20llms', [{ name: 'q', value: 'top llms', raw: true }]).url).toBe('https://x.test/?a=top%20llms');
    // A variable bound outside the recipe is never marked raw.
    expect(retemplateUrl('https://h.test/d/ID/edit', [{ name: 'path', value: 'ID/edit', origin: 'cli' }])).toEqual({ url: 'https://h.test/d/ID/edit', raw: [] });
  });
});
