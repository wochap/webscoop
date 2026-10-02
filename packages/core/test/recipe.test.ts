import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { draftFromRecipe, draftToRecipe, isReactive, loadRecipe, maxRetriesOf, paginationOf, RecipeError, saveRecipe, tablesOf, validateRecipe, type RecipeInput } from '../src';
import { tablesRecipe } from './helpers';

const referencePath = fileURLToPath(new URL('../../cli/fixtures/playground-catalog.json', import.meta.url));

function base(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 2,
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
    sequence: [{ extract: 'items' }],
    ...overrides,
  };
}

function errorsOf(input: unknown) {
  const result = validateRecipe(input);
  expect(result.ok).toBe(false);
  return result.errors;
}

describe('recipe versioning', () => {
  it('loads a valid version 2 recipe', () => {
    const recipe = loadRecipe(JSON.stringify(base()), '/r/shop.json');
    expect(recipe.name).toBe('shop');
  });

  it('rejects a version 1 recipe with rewrite guidance, naming the file', () => {
    const v1 = { ...base(), schemaVersion: 1, steps: [{ kind: 'click', target: { selectors: [{ strategy: 'css', value: 'b', stability: 'medium' }] } }] };
    const error = (() => {
      try {
        loadRecipe(v1, '/r/shop.json');
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(RecipeError);
    expect(error!.message).toContain('/r/shop.json');
    expect(error!.message).toMatch(/called flows/);
    expect(error!.message).toMatch(/type and select steps into fill/);
    expect(error!.message).toMatch(/paginate/);
  });

  it('rejects top level steps and pagination in version 2, naming the key', () => {
    const errors = errorsOf({ ...base(), steps: [], pagination: { kind: 'none' } });
    expect(errors.map((e) => e.path)).toEqual(['$.steps', '$.pagination']);
    expect(errors[1]!.message).toContain('paginate block');
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

  it('accepts a list parent with its fingerprint and keeps it through load', () => {
    const within = [
      { strategy: 'role' as const, value: 'list', stability: 'stable' as const },
      { strategy: 'css' as const, value: 'ul.product-list', stability: 'medium' as const },
    ];
    const withinFingerprint = { tag: 'ul', role: 'list', textSample: '', attrs: {}, ancestors: ['main'], bbox: { x: 0, y: 0, w: 0, h: 0 } };
    const recipe = loadRecipe(
      base({
        item: { selectors: [{ strategy: 'role', value: 'listitem', stability: 'stable' }], within, withinFingerprint },
        fields: [itemField],
      }),
    );
    expect(recipe.item!.within).toEqual(within);
    expect(recipe.item!.withinFingerprint).toEqual(withinFingerprint);
  });

  it('rejects an empty list parent', () => {
    const errors = errorsOf(base({ item: { selectors: [{ strategy: 'testid', value: 'card', stability: 'stable' }], within: [] }, fields: [itemField] }));
    expect(errors[0]!.path).toBe('$.item.within');
  });

  it('leaves within absent on a recipe without one', () => {
    const recipe = loadRecipe(base({ item: { selectors: [{ strategy: 'testid', value: 'card', stability: 'stable' }] }, fields: [itemField] }));
    expect(recipe.item).toEqual({ selectors: [{ strategy: 'testid', value: 'card', stability: 'stable' }] });
    expect('within' in recipe.item!).toBe(false);
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
    expect(recipe.fields![0]!.optional).toBe(false);
  });

  it('defaults fallback to false and leaves it out on save', () => {
    const recipe = loadRecipe(base());
    expect(recipe.fields![0]!.fallback).toBe(false);
    const saved = JSON.parse(saveRecipe(recipe));
    expect(saved.fields[0]).not.toHaveProperty('fallback');
    expect(loadRecipe(saved).fields![0]!.fallback).toBe(false);
  });

  it('keeps fallback true through a round-trip', () => {
    const recipe = loadRecipe(base({ fields: [field('a', { fallback: true })] as RecipeInput['fields'] }));
    expect(recipe.fields![0]!.fallback).toBe(true);
    const once = saveRecipe(recipe);
    expect(JSON.parse(once).fields[0].fallback).toBe(true);
    expect(saveRecipe(loadRecipe(once))).toBe(once);
  });

  it('leaves false fallback out of table fields on save', () => {
    const saved = JSON.parse(saveRecipe(loadRecipe(tablesRecipe())));
    for (const table of saved.tables) for (const f of table.fields) expect(f).not.toHaveProperty('fallback');
  });

  it('defaults hover to false and leaves it out on save', () => {
    const recipe = loadRecipe(base());
    expect(recipe.fields![0]!.hover).toBe(false);
    const saved = JSON.parse(saveRecipe(recipe));
    expect(saved.fields[0]).not.toHaveProperty('hover');
    for (const table of JSON.parse(saveRecipe(loadRecipe(tablesRecipe()))).tables) for (const f of table.fields) expect(f).not.toHaveProperty('hover');
  });

  it('keeps hover true through a round-trip, with the other flags', () => {
    const recipe = loadRecipe(base({ fields: [field('a', { hover: true, fallback: true, optional: true })] as RecipeInput['fields'] }));
    expect(recipe.fields![0]!.hover).toBe(true);
    const once = saveRecipe(recipe);
    expect(JSON.parse(once).fields[0]).toMatchObject({ hover: true, fallback: true, optional: true });
    expect(saveRecipe(loadRecipe(once))).toBe(once);
  });

  it('rejects a hover flag that is not a boolean, naming it', () => {
    const errors = errorsOf(base({ fields: [field('a', { hover: 'yes' })] as unknown as RecipeInput['fields'] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.fields[0].hover');
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

describe('tables', () => {
  const table = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    fields: [{ name: 'title', type: 'text', selectors: [{ strategy: 'css', value: 'h1', stability: 'medium' }] }],
    ...extra,
  });
  const withTables = (tables: unknown[]): RecipeInput => {
    const { fields: _fields, ...rest } = base();
    const names = tables.flatMap((t) => (typeof (t as { name?: unknown }).name === 'string' ? [(t as { name: string }).name] : []));
    return { ...rest, tables, sequence: [...new Set(names)].map((extract) => ({ extract })) } as RecipeInput;
  };

  it('accepts a page table and a list table, with scopes defaulting from the table', () => {
    const recipe = loadRecipe(tablesRecipe());
    const [page, products, questions] = tablesOf(recipe);
    expect([page!.name, products!.name, questions!.name]).toEqual(['page', 'products', 'questions']);
    expect(page!.item).toBeUndefined();
    expect(page!.fields[0]!.scope).toBe('page');
    expect(products!.fields.map((f) => f.scope)).toEqual(['item', 'item']);
    expect(recipe.fields).toBeUndefined();
  });

  it('reads the shorthand as one table named items', () => {
    const recipe = loadRecipe(base());
    expect(tablesOf(recipe)).toEqual([{ name: 'items', fields: recipe.fields }]);
    expect(recipe.tables).toBeUndefined();
  });

  it('accepts a single table in the tables form', () => {
    expect(validateRecipe(withTables([table('results')])).ok).toBe(true);
  });

  it('defaults scope to item in a table with an item block, and to page in the shorthand without one', () => {
    const recipe = loadRecipe(withTables([table('results', { item: { selectors: [{ strategy: 'css', value: 'li', stability: 'medium' }] } })]));
    expect(tablesOf(recipe)[0]!.fields[0]!.scope).toBe('item');
    const { scope: _scope, ...unscoped } = base().fields![0]!;
    expect(loadRecipe(base({ fields: [unscoped] })).fields![0]!.scope).toBe('page');
  });

  it('rejects tables together with top level fields, naming both', () => {
    const errors = errorsOf({ ...base(), tables: [table('results')], sequence: [{ extract: 'results' }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.tables');
    expect(errors[0]!.message).toMatch(/tables.*fields/);
  });

  it('accepts a recipe with neither tables nor fields that only runs flows', () => {
    const { fields: _fields, ...bare } = base();
    const flows = [{ name: 'submit', steps: [{ kind: 'click', target: { selectors: [{ strategy: 'css', value: 'button', stability: 'medium' }] } }] }];
    const recipe = loadRecipe({ ...bare, flows, sequence: [{ flow: 'submit' }] });
    expect(tablesOf(recipe)).toEqual([]);
  });

  it('rejects duplicate table names, naming the table', () => {
    const errors = errorsOf(withTables([table('results'), table('results')]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.tables[1].name');
    expect(errors[0]!.message).toContain('results');
  });

  it('rejects an item scoped field in a table without an item block, naming the table and the field', () => {
    const errors = errorsOf(
      withTables([table('page', { fields: [{ name: 'heading', type: 'text', scope: 'item', selectors: [{ strategy: 'css', value: 'h1', stability: 'medium' }] }] })]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.tables[0].fields[0].scope');
    expect(errors[0]!.message).toContain('"page"');
    expect(errors[0]!.message).toContain('"heading"');
  });

  it('accepts a framed table and a framed shorthand, and reads the shorthand frame into its table', () => {
    const frame = { selectors: [{ strategy: 'id' as const, value: 'iframeApplication', stability: 'stable' as const }] };
    const item = { selectors: [{ strategy: 'css', value: 'li', stability: 'medium' }] };
    expect(validateRecipe(withTables([table('results', { frame, item })])).ok).toBe(true);
    const recipe = loadRecipe(base({ frame }));
    expect(tablesOf(recipe)[0]!.frame).toEqual(frame);
  });

  it('rejects a frame inside a frame, naming the table', () => {
    const frame = { selectors: [{ strategy: 'id', value: 'outer', stability: 'stable' }], frame: { selectors: [{ strategy: 'id', value: 'inner', stability: 'stable' }] } };
    const errors = errorsOf(withTables([table('results', { frame })]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.tables[0].frame.frame');
    expect(errors[0]!.message).toContain('"results"');
  });

  it('accepts the same field name in two tables', () => {
    expect(validateRecipe(withTables([table('page'), table('products')])).ok).toBe(true);
  });

  it('rejects duplicate field names and two keys within one table', () => {
    const field = (name: string, key = false) => ({ name, type: 'text', selectors: [{ strategy: 'css', value: 'x', stability: 'fragile' }], ...(key ? { key } : {}) });
    const dup = errorsOf(withTables([table('results', { fields: [field('price'), field('price')] })]));
    expect(dup.map((e) => e.path)).toEqual(['$.tables[0].fields[1].name']);
    expect(dup[0]!.message).toContain('price');
    const keys = errorsOf(withTables([table('results', { fields: [field('a', true), field('b', true)] })]));
    expect(keys.map((e) => e.path)).toEqual(['$.tables[0].fields[1].key']);
  });

  it('rejects a table name that is not kebab-case', () => {
    expect(errorsOf(withTables([table('My Table')]))[0]!.path).toBe('$.tables[0].name');
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

  it('accepts a class candidate', () => {
    const recipe = loadRecipe(
      base({
        fields: [
          { name: 'price', type: 'text', scope: 'page', selectors: [{ strategy: 'class', value: 'span.price.kXeqYt', stability: 'fragile' }] },
        ],
      }),
    );
    expect(recipe.fields![0]!.selectors[0]).toEqual({ strategy: 'class', value: 'span.price.kXeqYt', stability: 'fragile' });
  });

  it('rejects an unknown strategy and names it', () => {
    const input = base();
    (input.fields![0]!.selectors[0] as { strategy: string }).strategy = 'magic';
    const errors = errorsOf(input);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.fields[0].selectors[0].strategy');
    expect(errors[0]!.message).toContain('magic');
  });
});

describe('reserved blocks', () => {
  it('fills defaults when optional blocks are absent', () => {
    const recipe = loadRecipe(base());
    expect(recipe.flows).toEqual([]);
    expect(recipe.guards).toEqual([
      { kind: 'login', enabled: true },
      { kind: 'captcha', enabled: true },
      { kind: 'zero-fields', enabled: true },
    ]);
    expect(recipe.healing).toEqual({ fuzzyThreshold: 0.7, llm: true });
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

describe('paginate block', () => {
  const next = { selectors: [{ strategy: 'role' as const, value: 'link|Next', stability: 'stable' as const }] };

  it('accepts a url paginate block with defaults filled in', () => {
    const recipe = loadRecipe(
      base({
        url: 'https://example.com/c/{category}?page={n}',
        vars: [
          { name: 'category', type: 'string' },
          { name: 'n', type: 'string', default: '1' },
        ],
        sequence: [{ paginate: { kind: 'url', param: { name: 'n', start: 1, step: 1 }, limit: 3, do: [{ extract: 'items' }] } }],
      }),
    );
    expect(paginationOf(recipe)).toEqual({ kind: 'url', param: { name: 'n', start: 1, step: 1 }, limit: 3, stopRules: [], delayMs: 0 });
  });

  it('reads no paginate block as kind none, one page', () => {
    expect(paginationOf(loadRecipe(base()))).toEqual({ kind: 'none', limit: 1, stopRules: [], delayMs: 0 });
  });

  it('accepts limit "all" and stop rules', () => {
    const result = validateRecipe(base({ sequence: [{ paginate: { kind: 'next', target: next, limit: 'all', stopRules: ['no-new-items', 'target-missing'], do: [{ extract: 'items' }] } }] }));
    expect(result.ok).toBe(true);
  });

  it('rejects next without a target, naming the paginate block', () => {
    const errors = errorsOf(base({ sequence: [{ paginate: { kind: 'next', do: [{ extract: 'items' }] } }] }));
    expect(errors.map((e) => e.path)).toEqual(['$.sequence[0].paginate.target']);
  });

  it('checks the driving table: known, with an item block, extracted in do', () => {
    const item = { selectors: [{ strategy: 'css' as const, value: 'li', stability: 'medium' as const }] };
    const fields = [{ name: 'title', type: 'text' as const, selectors: [{ strategy: 'css' as const, value: 'h2', stability: 'medium' as const }] }];
    const { fields: _f, ...rest } = base();
    const input = (table: string, inDo: string[]): RecipeInput => ({
      ...rest,
      tables: [{ name: 'page', fields }, { name: 'products', item, fields }],
      sequence: [...['page', 'products'].filter((t) => !inDo.includes(t)).map((extract) => ({ extract })), { paginate: { kind: 'scroll', table, do: inDo.map((extract) => ({ extract })) } }],
    });
    expect(validateRecipe(input('products', ['page', 'products'])).ok).toBe(true);
    expect(errorsOf(input('nope', ['page', 'products']))[0]!.message).toContain('not a table');
    expect(errorsOf(input('page', ['page', 'products']))[0]!.message).toContain('no item block');
    expect(errorsOf(input('products', ['page']))[0]!.message).toContain("not extracted in the paginate block's do");
  });
});

describe('flows', () => {
  const accept = { selectors: [{ strategy: 'role' as const, value: 'button|Accept', stability: 'stable' as const }] };
  const login = { selectors: [{ strategy: 'role' as const, value: 'button|Log in', stability: 'stable' as const }] };
  const withFlows = (flows: unknown[], sequence: unknown[] = [{ extract: 'items' }], extra: Partial<RecipeInput> = {}) =>
    ({ ...base(extra), flows, sequence }) as RecipeInput;

  it('accepts a called flow and a reactive flow, with the reactive defaults', () => {
    const recipe = loadRecipe(
      withFlows(
        [
          { name: 'reach-report', steps: [{ kind: 'click', target: accept }, { kind: 'wait', value: '100' }, { kind: 'click', target: accept, optional: true }] },
          { name: 'login-wall', trigger: { appears: login }, steps: [{ kind: 'click', target: login }] },
        ],
        [{ flow: 'reach-report' }, { extract: 'items' }],
      ),
    );
    expect(recipe.flows.map((f) => isReactive(f))).toEqual([false, true]);
    expect(maxRetriesOf(recipe.flows[1]!)).toBe(2);
    expect(recipe.flows[1]!.recover).toBeUndefined();
    expect(recipe.flows[0]!.steps[0]).toEqual({ kind: 'click', target: accept, window: 'same', optional: false });
  });

  it('rejects duplicate flow names, naming the flow', () => {
    const flow = { name: 'setup', steps: [{ kind: 'click', target: accept }] };
    const errors = errorsOf(withFlows([flow, flow], [{ flow: 'setup' }, { extract: 'items' }]));
    expect(errors.map((e) => e.path)).toEqual(['$.flows[1].name']);
    expect(errors[0]!.message).toContain('setup');
  });

  it('rejects maxRetries and recover on a called flow', () => {
    const errors = errorsOf(withFlows([{ name: 'setup', maxRetries: 3, recover: true, steps: [{ kind: 'click', target: accept }] }], [{ flow: 'setup' }, { extract: 'items' }]));
    expect(errors.map((e) => e.path)).toEqual(['$.flows[0].maxRetries', '$.flows[0].recover']);
  });

  it('rejects a fill step without a target, naming the flow and the step index', () => {
    const errors = errorsOf(withFlows([{ name: 'search', steps: [{ kind: 'fill', value: 'mouse' }] }], [{ flow: 'search' }, { extract: 'items' }]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.flows[0].steps[0].target');
    expect(errors[0]!.message).toContain('"search"');
    expect(errors[0]!.message).toContain('step 0');
  });

  it('applies the per-kind rules', () => {
    const errors = errorsOf(
      withFlows(
        [
          {
            name: 'setup',
            steps: [
              { kind: 'fill', target: accept },
              { kind: 'press' },
              { kind: 'wait', value: 'soon' },
              { kind: 'await-user', target: login },
              { kind: 'click', target: accept, until: 'appears' },
            ],
          },
        ],
        [{ flow: 'setup' }, { extract: 'items' }],
      ),
    );
    expect(errors.map((e) => e.path)).toEqual(['$.flows[0].steps[0].value', '$.flows[0].steps[1].value', '$.flows[0].steps[2]', '$.flows[0].steps[3].until', '$.flows[0].steps[4].until']);
  });

  it('accepts await-user with until and a timeout, and popup steps', () => {
    const recipe = loadRecipe(
      withFlows([{ name: 'login', steps: [{ kind: 'click', target: login }, { kind: 'await-user', target: login, until: 'disappears', timeoutMs: 60000, window: 'popup', label: 'Log in to SOL' }] }], [{ flow: 'login' }, { extract: 'items' }]),
    );
    expect(recipe.flows[0]!.steps[1]).toMatchObject({ kind: 'await-user', until: 'disappears', timeoutMs: 60000, window: 'popup' });
  });

  it('rejects an undeclared variable in a fill value and names it', () => {
    const errors = errorsOf(withFlows([{ name: 'search', steps: [{ kind: 'fill', target: accept, value: '{query}' }] }], [{ flow: 'search' }, { extract: 'items' }]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.flows[0].steps[0].value');
    expect(errors[0]!.message).toContain('query');
  });

  it('leaves an empty flows list out on save and round-trips flows', () => {
    expect(JSON.parse(saveRecipe(loadRecipe(base()))).flows).toBeUndefined();
    const input = withFlows([{ name: 'search', steps: [{ kind: 'fill', target: accept, value: '{q}', label: 'search' }] }], [{ flow: 'search' }, { extract: 'items' }], {
      vars: [{ name: 'category', type: 'string' }, { name: 'q', type: 'string' }],
    });
    const once = saveRecipe(loadRecipe(input));
    expect(saveRecipe(loadRecipe(once))).toBe(once);
    expect(JSON.parse(once).flows[0].steps[0].value).toBe('{q}');
  });
});

describe('sequence', () => {
  const step = { kind: 'click', target: { selectors: [{ strategy: 'css' as const, value: 'button', stability: 'medium' as const }] } };
  const item = { selectors: [{ strategy: 'css' as const, value: 'li', stability: 'medium' as const }] };
  const fields = [{ name: 'title', type: 'text' as const, selectors: [{ strategy: 'css' as const, value: 'h2', stability: 'medium' as const }] }];
  const recipeWith = (sequence: unknown[], flows: unknown[] = [{ name: 'reach-report', steps: [step] }, { name: 'open-detail', steps: [step] }]) => {
    const { fields: _f, ...rest } = base();
    return { ...rest, tables: [{ name: 'summary', fields }, { name: 'results', item, fields }], flows, sequence } as RecipeInput;
  };

  it('accepts the typical sequence', () => {
    const result = validateRecipe(
      recipeWith([
        { flow: 'reach-report' },
        { extract: 'summary' },
        { flow: 'open-detail' },
        { paginate: { kind: 'next', target: step.target, table: 'results', do: [{ extract: 'results' }] } },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a table extracted twice, naming it', () => {
    const errors = errorsOf(recipeWith([{ flow: 'reach-report' }, { flow: 'open-detail' }, { extract: 'summary' }, { paginate: { kind: 'scroll', do: [{ extract: 'summary' }, { extract: 'results' }] } }]));
    expect(errors.map((e) => e.path)).toEqual(['$.sequence[3].paginate.do[0]']);
    expect(errors[0]!.message).toContain('"summary"');
  });

  it('rejects a reactive flow in the sequence, saying it is reactive', () => {
    const flows = [{ name: 'login-wall', trigger: { appears: step.target }, steps: [step] }];
    const errors = errorsOf(recipeWith([{ flow: 'login-wall' }, { extract: 'summary' }, { extract: 'results' }], flows));
    expect(errors.map((e) => e.path)).toEqual(['$.sequence[0]']);
    expect(errors[0]!.message).toContain('"login-wall" is reactive');
  });

  it('rejects unknown flows and tables, nested and second paginate blocks, and unused tables and flows', () => {
    expect(errorsOf(recipeWith([{ flow: 'nope' }, { flow: 'reach-report' }, { flow: 'open-detail' }, { extract: 'summary' }, { extract: 'results' }]))[0]!.message).toContain('unknown flow "nope"');
    expect(errorsOf(recipeWith([{ flow: 'reach-report' }, { flow: 'open-detail' }, { extract: 'summary' }, { extract: 'results' }, { extract: 'nope' }]))[0]!.message).toContain('unknown table "nope"');
    const twice = errorsOf(
      recipeWith([{ flow: 'reach-report' }, { flow: 'open-detail' }, { paginate: { kind: 'scroll', do: [{ extract: 'summary' }] } }, { paginate: { kind: 'scroll', do: [{ extract: 'results' }] } }]),
    );
    expect(twice.map((e) => e.message)).toEqual(['a sequence has at most one paginate block']);
    const nested = errorsOf(recipeWith([{ flow: 'reach-report' }, { flow: 'open-detail' }, { extract: 'summary' }, { paginate: { kind: 'scroll', do: [{ extract: 'results' }, { paginate: { kind: 'scroll', do: [] } }] } }]));
    expect(nested.map((e) => e.path)).toContain('$.sequence[3].paginate.do[1]');
    const unused = errorsOf(recipeWith([{ flow: 'reach-report' }, { extract: 'summary' }]));
    expect(unused.map((e) => e.message)).toEqual(['table "results" is never extracted; add an extract block for it', 'called flow "open-detail" is never used; add a flow block for it or give it a trigger']);
  });

  it('lets a flow appear in more than one block', () => {
    expect(validateRecipe(recipeWith([{ flow: 'reach-report' }, { flow: 'open-detail' }, { extract: 'summary' }, { flow: 'reach-report' }, { extract: 'results' }])).ok).toBe(true);
  });

  it('requires a non-empty sequence', () => {
    expect(errorsOf(base({ sequence: [] })).map((e) => e.path)).toContain('$.sequence');
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
    input.fields![0]!.fingerprint = fingerprint;
    const saved = JSON.parse(saveRecipe(loadRecipe(input)));
    expect(saved.fields[0].fingerprint).toEqual(fingerprint);
  });

  it('rejects more than six ancestors', () => {
    const input = base();
    input.fields![0]!.fingerprint = {
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
    (input.fields![0] as { type: string }).type = 'money';
    const errors = errorsOf(input);
    expect(errors).toHaveLength(2);
    expect(new Set(errors.map((e) => e.path))).toEqual(new Set(['$.url', '$.fields[0].type']));
  });

  it('exposes every error on RecipeError', () => {
    const input = base({ vars: [] });
    (input.fields![0] as { type: string }).type = 'money';
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

describe('recipe browser block', () => {
  it('validates a proxy, timezone, and locale', () => {
    const browser = { proxy: { server: 'http://proxy-b:8080', bypass: ['localhost', '*.lan'] }, timezone: 'Europe/Madrid', locale: 'es-ES', humanize: true };
    const result = validateRecipe(base({ browser }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.recipe.browser).toEqual(browser);
    expect(result.ok && result.recipe.schemaVersion).toBe(2);
  });

  it('accepts a valid profile pin and rejects a path, naming browser.profile', () => {
    const ok = validateRecipe(base({ browser: { profile: 'acme.main_2' } }));
    expect(ok.ok && ok.recipe.browser).toEqual({ profile: 'acme.main_2' });
    expect(errorsOf(base({ browser: { profile: '../other' } })).map((e) => e.path)).toEqual(['$.browser.profile']);
  });

  it('rejects a non-boolean humanize, naming the path', () => {
    const errors = errorsOf(base({ browser: { humanize: 'yes' as unknown as boolean } }));
    expect(errors.map((e) => e.path)).toEqual(['$.browser.humanize']);
  });

  it('rejects credentials in the proxy server, naming the path', () => {
    const errors = errorsOf(base({ browser: { proxy: { server: 'http://user:pass@proxy-b:8080' } } }));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe('$.browser.proxy.server');
    expect(errors[0]!.message).toContain('credentials are not allowed in recipes');
  });

  it('rejects an unknown scheme, timezone, and locale', () => {
    const errors = errorsOf(base({ browser: { proxy: { server: 'ftp://proxy:21' }, timezone: 'Mars/Base', locale: 'not a locale' } }));
    expect(errors.map((e) => e.path)).toEqual(['$.browser.proxy.server', '$.browser.timezone', '$.browser.locale']);
    expect(errors[1]!.message).toContain('Mars/Base');
  });

  it('accepts a recipe without the block', () => {
    const result = validateRecipe(base());
    expect(result.ok).toBe(true);
    expect(result.ok && result.recipe.browser).toBeUndefined();
  });

  it('keeps the block through a save', () => {
    const browser = { timezone: 'America/New_York', locale: 'en-US' };
    const saved = JSON.parse(saveRecipe(loadRecipe(JSON.stringify(base({ browser })), '/r/shop.json')));
    expect(saved.browser).toEqual(browser);
  });
});

describe('recipe browser block in the recorder', () => {
  it('survives an edit session', () => {
    const browser = { proxy: { server: 'socks5://127.0.0.1:1080' }, locale: 'en-US' };
    const recipe = loadRecipe(JSON.stringify(base({ browser })), '/r/shop.json');
    expect(draftToRecipe(draftFromRecipe(recipe, { category: 'books' })).browser).toEqual(browser);
  });
});

describe('descriptions', () => {
  const described = (): RecipeInput => {
    const { fields: _fields, ...rest } = base();
    return {
      ...rest,
      sequence: [{ extract: 'results' }],
      description: 'Bing web search results for a query',
      vars: [{ name: 'category', type: 'string', description: 'search terms' }],
      tables: [
        {
          name: 'results',
          description: 'table of search results\none row per organic result',
          fields: [{ name: 'title', type: 'text', selectors: [{ strategy: 'css', value: 'h1', stability: 'medium' }] }],
        },
      ],
    } as RecipeInput;
  };

  it('accepts recipe, table, and variable descriptions and keeps them through a save', () => {
    const result = validateRecipe(described());
    expect(result.ok).toBe(true);
    const saved = JSON.parse(saveRecipe(loadRecipe(JSON.stringify(described()), '/r/shop.json')));
    expect(saved.description).toBe('Bing web search results for a query');
    expect(saved.tables[0].description).toBe('table of search results\none row per organic result');
    expect(saved.vars[0].description).toBe('search terms');
  });

  it('rejects an empty table description, naming the table', () => {
    const input = described();
    input.tables![0]!.description = '';
    expect(errorsOf(input).map((e) => e.path)).toEqual(['$.tables[0].description']);
  });

  it('rejects a multiline variable description, naming the variable', () => {
    const input = described();
    input.vars![0]!.description = 'search\nterms';
    expect(errorsOf(input).map((e) => e.path)).toEqual(['$.vars[0].description']);
  });

  it('rejects a description over the limit', () => {
    expect(errorsOf({ ...described(), description: 'x'.repeat(2001) }).map((e) => e.path)).toEqual(['$.description']);
  });

  it('accepts a recipe without descriptions unchanged', () => {
    const result = validateRecipe(base());
    expect(result.ok).toBe(true);
    expect(result.ok && result.recipe.description).toBeUndefined();
  });
});
