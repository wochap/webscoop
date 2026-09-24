import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRecipe, RecipeError, saveRecipe, validateRecipe, type RecipeInput } from '../src';

const referencePath = fileURLToPath(new URL('../../cli/fixtures/playground-catalog.json', import.meta.url));

function base(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 1,
    name: 'shop',
    url: 'https://example.com/c/{category}',
    vars: [{ name: 'category', type: 'string' }],
    fields: [
      {
        name: 'title',
        type: 'text',
        scope: 'page',
        selectors: [{ strategy: 'css', value: 'h1', stability: 'medium' }],
      },
    ],
    ...overrides,
  };
}

function errorsOf(input: unknown) {
  const result = validateRecipe(input);
  expect(result.ok).toBe(false);
  return result.errors;
}

describe('recipe versioning', () => {
  it('loads a valid version 1 recipe', () => {
    const recipe = loadRecipe(JSON.stringify(base()), '/r/shop.json');
    expect(recipe.name).toBe('shop');
  });

  it('rejects an unknown version, naming the file and the value', () => {
    expect(() => loadRecipe({ ...base(), schemaVersion: 7 }, '/r/shop.json')).toThrowError(
      /\/r\/shop\.json.*7/,
    );
  });

  it('rejects a missing version', () => {
    const { schemaVersion: _, ...rest } = base();
    expect(() => loadRecipe(rest, '/r/shop.json')).toThrowError(/\/r\/shop\.json.*missing/);
  });

  it('reports invalid JSON with the file', () => {
    expect(() => loadRecipe('{ nope', '/r/bad.json')).toThrowError(/\/r\/bad\.json: invalid JSON/);
  });
});

describe('identity and URL template', () => {
  it('accepts declared variables', () => {
    const result = validateRecipe(
      base({
        url: 'https://example.com/c/{category}?page={n}',
        vars: [
          { name: 'category', type: 'string' },
          { name: 'n', type: 'string', default: '1' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an undeclared variable and names it', () => {
    const errors = errorsOf(base({ vars: [] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.url');
    expect(errors[0]!.message).toContain('category');
  });

  it('rejects a name that is not kebab-case', () => {
    const errors = errorsOf(base({ name: 'My Shop' }));
    expect(errors[0]!.path).toBe('$.name');
  });
});

describe('item container', () => {
  const itemField = {
    name: 'title',
    type: 'text' as const,
    scope: 'item' as const,
    selectors: [{ strategy: 'css' as const, value: 'h2', stability: 'medium' as const }],
  };

  it('accepts item fields with an item block and exclusions', () => {
    const result = validateRecipe(
      base({
        item: {
          selectors: [{ strategy: 'testid', value: 'card', stability: 'stable' }],
          exclude: [{ strategy: 'css', value: '.ad', stability: 'medium' }],
        },
        fields: [itemField],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an item scoped field without an item block, naming the field', () => {
    const errors = errorsOf(base({ fields: [itemField] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.fields[0].scope');
    expect(errors[0]!.message).toContain('title');
  });
});

describe('fields', () => {
  const field = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    type: 'text',
    scope: 'page',
    selectors: [{ strategy: 'css', value: 'x', stability: 'fragile' }],
    ...extra,
  });

  it('requires at least one field', () => {
    const errors = errorsOf(base({ fields: [] }));
    expect(errors[0]!.path).toBe('$.fields');
  });

  it('defaults optional to false', () => {
    const recipe = loadRecipe(base());
    expect(recipe.fields[0]!.optional).toBe(false);
  });

  it('rejects duplicate field names, naming the field', () => {
    const errors = errorsOf(base({ fields: [field('price'), field('price')] as RecipeInput['fields'] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.fields[1].name');
    expect(errors[0]!.message).toContain('price');
  });

  it('rejects two dedup keys', () => {
    const errors = errorsOf(
      base({ fields: [field('a', { key: true }), field('b', { key: true })] as RecipeInput['fields'] }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.fields[1].key');
  });

  it('rejects an empty selector list', () => {
    const errors = errorsOf(base({ fields: [field('a', { selectors: [] })] as RecipeInput['fields'] }));
    expect(errors[0]!.path).toBe('$.fields[0].selectors');
  });
});

describe('selector candidates', () => {
  it('accepts a role candidate with a name', () => {
    const result = validateRecipe(
      base({
        fields: [
          {
            name: 'title',
            type: 'text',
            scope: 'page',
            selectors: [{ strategy: 'role', value: 'heading|Wireless Mouse', stability: 'stable' }],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown strategy and names it', () => {
    const input = base();
    (input.fields[0]!.selectors[0] as { strategy: string }).strategy = 'magic';
    const errors = errorsOf(input);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.fields[0].selectors[0].strategy');
    expect(errors[0]!.message).toContain('magic');
  });
});

describe('reserved blocks', () => {
  it('fills defaults when optional blocks are absent', () => {
    const recipe = loadRecipe(base());
    expect(recipe.pagination).toEqual({ kind: 'none', limit: 1, stopRules: [], delayMs: 0 });
    expect(recipe.guards).toEqual([
      { kind: 'login', enabled: true },
      { kind: 'captcha', enabled: true },
      { kind: 'zero-fields', enabled: true },
    ]);
    expect(recipe.healing).toEqual({ fuzzyThreshold: 0.7, llm: true });
  });

  it('accepts a url pagination block', () => {
    const recipe = loadRecipe(
      base({
        url: 'https://example.com/c/{category}?page={n}',
        vars: [
          { name: 'category', type: 'string' },
          { name: 'n', type: 'string', default: '1' },
        ],
        pagination: { kind: 'url', param: { name: 'n', start: 1, step: 1 }, limit: 3 },
      }),
    );
    expect(recipe.pagination.kind).toBe('url');
    expect(recipe.pagination.limit).toBe(3);
  });

  it('accepts limit "all" and stop rules', () => {
    const result = validateRecipe(
      base({
        pagination: {
          kind: 'next',
          target: { selectors: [{ strategy: 'role', value: 'link|Next', stability: 'stable' }] },
          limit: 'all',
          stopRules: ['no-new-items', 'target-missing'],
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a fuzzy threshold outside 0..1', () => {
    const errors = errorsOf(base({ healing: { fuzzyThreshold: 1.5 } }));
    expect(errors[0]!.path).toBe('$.healing.fuzzyThreshold');
  });

  it('rejects an unknown guard kind', () => {
    const errors = errorsOf(base({ guards: [{ kind: 'paywall' as 'login', enabled: true }] }));
    expect(errors[0]!.path).toBe('$.guards[0].kind');
  });
});

describe('steps', () => {
  const accept = { selectors: [{ strategy: 'role' as const, value: 'button|Accept', stability: 'stable' as const }] };

  it('defaults to an empty list', () => {
    expect(loadRecipe(base()).steps).toEqual([]);
    expect(JSON.parse(saveRecipe(loadRecipe(base()))).steps).toBeUndefined();
  });

  it('accepts a click step and defaults when to first-page', () => {
    const recipe = loadRecipe(base({ steps: [{ kind: 'click', target: accept, optional: true }] }));
    expect(recipe.steps[0]).toEqual({ kind: 'click', target: accept, optional: true, when: 'first-page' });
  });

  it('rejects a type step without a target, naming the step index', () => {
    const errors = errorsOf(base({ steps: [{ kind: 'type', value: 'mouse' }] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.steps[0].target');
    expect(errors[0]!.message).toContain('step 0');
  });

  it('requires values for type, select, and press', () => {
    const errors = errorsOf(base({ steps: [{ kind: 'select', target: accept }, { kind: 'press' }] }));
    expect(errors.map((e) => e.path)).toEqual(['$.steps[0].value', '$.steps[1].value']);
  });

  it('requires a target or milliseconds for wait', () => {
    expect(errorsOf(base({ steps: [{ kind: 'wait', value: 'soon' }] }))[0]!.path).toBe('$.steps[0]');
    expect(validateRecipe(base({ steps: [{ kind: 'wait', value: '500' }, { kind: 'wait', target: accept }] })).ok).toBe(true);
  });

  it('rejects an undeclared variable in a type value and names it', () => {
    const errors = errorsOf(base({ steps: [{ kind: 'type', target: accept, value: '{query}' }] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.steps[0].value');
    expect(errors[0]!.message).toContain('query');
  });

  it('round-trips steps through save and load', () => {
    const input = base({
      vars: [{ name: 'category', type: 'string' }, { name: 'q', type: 'string' }],
      steps: [{ kind: 'type', target: accept, value: '{q}', when: 'every-page', label: 'search' }],
    });
    const once = saveRecipe(loadRecipe(input));
    expect(saveRecipe(loadRecipe(once))).toBe(once);
    expect(JSON.parse(once).steps[0].value).toBe('{q}');
  });
});

describe('fingerprints and round-trip', () => {
  it('preserves a fingerprint through load and save', () => {
    const fingerprint = {
      tag: 'h2',
      role: 'heading',
      name: 'Wireless Mouse',
      textSample: 'Wireless Mouse',
      attrs: { class: 'product-title', 'data-x': '1' },
      ancestors: ['article', 'li', 'ul', 'main', 'body', 'html'],
      bbox: { x: 1, y: 2.5, w: 300, h: 20 },
    };
    const input = base();
    input.fields[0]!.fingerprint = fingerprint;
    const saved = JSON.parse(saveRecipe(loadRecipe(input)));
    expect(saved.fields[0].fingerprint).toEqual(fingerprint);
  });

  it('rejects more than six ancestors', () => {
    const input = base();
    input.fields[0]!.fingerprint = {
      tag: 'h2',
      textSample: '',
      attrs: {},
      ancestors: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      bbox: { x: 0, y: 0, w: 0, h: 0 },
    };
    expect(errorsOf(input)[0]!.path).toBe('$.fields[0].fingerprint.ancestors');
  });

  it('round-trips the reference recipe', () => {
    const text = readFileSync(referencePath, 'utf8');
    const once = saveRecipe(loadRecipe(text, referencePath));
    expect(JSON.parse(once)).toEqual(JSON.parse(text));
    expect(saveRecipe(loadRecipe(once))).toBe(once);
  });
});

describe('error collection', () => {
  it('reports an undeclared variable and an unknown field type together', () => {
    const input = base({ vars: [] });
    (input.fields[0] as { type: string }).type = 'money';
    const errors = errorsOf(input);
    expect(errors).toHaveLength(2);
    expect(new Set(errors.map((e) => e.path))).toEqual(new Set(['$.url', '$.fields[0].type']));
  });

  it('exposes every error on RecipeError', () => {
    const input = base({ vars: [] });
    (input.fields[0] as { type: string }).type = 'money';
    try {
      loadRecipe(input, 'x.json');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RecipeError);
      const recipeError = error as RecipeError;
      expect(recipeError.errors).toHaveLength(2);
      expect(recipeError.format()).toContain('$.fields[0].type');
    }
  });
});
