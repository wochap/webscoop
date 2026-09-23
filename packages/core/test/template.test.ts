import { describe, expect, it } from 'vitest';
import { fillTemplate, MissingVariableError, templateVariables } from '../src';

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
