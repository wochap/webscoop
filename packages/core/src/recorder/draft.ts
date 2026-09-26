import { parseNumber } from '../convert';
import { templateVariables } from '../template';
import type { FieldScope, FieldType, Recipe, RecipeInput, SelectorCandidate, StepKind } from '../recipe/schema';
import { tablesOf } from '../recipe/tables';
import { validateRecipe } from '../recipe/validate';
import type {
  Draft,
  DraftField,
  DraftItem,
  DraftPagination,
  DraftStep,
  FieldPatch,
  PaginationPatch,
  ProtocolCandidate,
  StepPatch,
  VarValue,
} from './protocol';

/** Strip host-only data (match counts) from a candidate. */
export function bare(candidate: ProtocolCandidate): SelectorCandidate {
  return { strategy: candidate.strategy, value: candidate.value, stability: candidate.stability };
}

/** A field name from free text: lowercase identifier, at most 32 characters. */
export function slugName(text: string): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
  if (!slug) return 'field';
  return /^[0-9]/.test(slug) ? `f_${slug}` : slug;
}

export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}_${i}`)) return `${base}_${i}`;
}

/** Text that is a number, possibly with a currency sign or unit, such as `$24.99` or `4.5`. */
export function isNumericText(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[^\dA-Za-z]{0,3}\s?-?\d[\d,]*(?:\.\d+)?\s?[^\dA-Za-z]{0,3}$/.test(trimmed)) return false;
  return parseNumber(trimmed) !== null;
}

export interface PickedElement {
  tag: string;
  attrs: Record<string, string>;
  role?: string;
  name?: string;
  text: string;
}

export interface FieldDefaults {
  name: string;
  type: FieldType;
  attr?: string;
}

/**
 * Defaults for a new field: a unique name from the accessible name or text,
 * type `url` for links, `image` for images, `number` for numeric text, else
 * `text`, with the matching attribute.
 */
export function fieldDefaults(el: PickedElement, taken: readonly string[]): FieldDefaults {
  const name = uniqueName(slugName(el.name || el.text || el.attrs.alt || el.tag), taken);
  if (el.tag === 'a' && 'href' in el.attrs) return { name, type: 'url', attr: 'href' };
  if (el.tag === 'img') return { name, type: 'image', attr: 'src' };
  if (isNumericText(el.text)) return { name, type: 'number' };
  return { name, type: 'text' };
}

/** Variables the draft uses: those of the URL template, then those of `type` step values, in order of first use. */
export function draftVariables(draft: Pick<Draft, 'url' | 'steps'>): string[] {
  const names = templateVariables(draft.url);
  for (const step of draft.steps) {
    if (step.kind !== 'type' || !step.value) continue;
    for (const name of templateVariables(step.value)) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The draft's variable list after its URL or steps changed: one entry per used variable, keeping entered values. */
function syncVars(draft: Draft): Draft {
  const names = draftVariables(draft);
  const vars = names.map((name) => draft.vars.find((v) => v.name === name) ?? { name, value: '' });
  const same = vars.length === draft.vars.length && vars.every((v, i) => v === draft.vars[i]);
  return same ? draft : { ...draft, vars };
}

export function emptyDraft(opts: { name: string; url: string; vars: VarValue[] }): Draft {
  return validateDraft({
    name: opts.name,
    url: opts.url,
    vars: opts.vars,
    item: null,
    fields: [],
    steps: [],
    pagination: null,
    dirty: false,
    errors: [],
  });
}

export const DEFAULT_PAGINATION: DraftPagination = {
  kind: 'none',
  limit: 1,
  stopRules: [],
  delayMs: 0,
};

/** Build the recipe document the draft describes, before validation. */
export function draftToRecipe(draft: Draft): RecipeInput {
  const declared = draftVariables(draft);
  const recipe: RecipeInput = {
    schemaVersion: 1,
    name: draft.name,
    url: draft.url,
    vars: draft.vars
      .filter((v) => declared.includes(v.name))
      .map((v) => ({ name: v.name, type: 'string' as const, ...(v.value !== '' ? { default: v.value } : {}) })),
    fields: draft.fields.map((f) => ({
      name: f.name,
      type: f.type,
      scope: f.scope,
      selectors: f.selectors.map(bare),
      ...(f.attr ? { attr: f.attr } : {}),
      optional: f.optional,
      ...(f.key ? { key: true } : {}),
      ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}),
    })),
  };
  if (draft.steps.length > 0) {
    recipe.steps = draft.steps.map((s) => ({
      kind: s.kind,
      ...(s.target ? { target: { selectors: s.target.selectors.map(bare), ...(s.target.fingerprint ? { fingerprint: s.target.fingerprint } : {}) } } : {}),
      ...(s.value !== undefined ? { value: s.value } : {}),
      when: s.when,
      optional: s.optional,
      ...(s.label ? { label: s.label } : {}),
    }));
  }
  if (draft.item) {
    recipe.item = {
      selectors: draft.item.selectors.map(bare),
      ...(draft.item.within && draft.item.within.length > 0 ? { within: draft.item.within.map(bare) } : {}),
      ...(draft.item.within && draft.item.withinFingerprint ? { withinFingerprint: draft.item.withinFingerprint } : {}),
      exclude: draft.item.exclude.map(bare),
      ...(draft.item.fingerprint ? { fingerprint: draft.item.fingerprint } : {}),
    };
  }
  const p = draft.pagination ?? DEFAULT_PAGINATION;
  recipe.pagination = {
    kind: p.kind,
    ...(p.target ? { target: { selectors: p.target.selectors.map(bare), ...(p.target.fingerprint ? { fingerprint: p.target.fingerprint } : {}) } } : {}),
    ...(p.param ? { param: p.param } : {}),
    limit: p.limit,
    stopRules: p.stopRules,
    delayMs: p.delayMs,
  };
  if (draft.guards) recipe.guards = draft.guards;
  if (draft.healing) recipe.healing = draft.healing;
  return recipe;
}

/** Recompute per-field, name, and global validation errors. */
export function validateDraft(draft: Draft): Draft {
  const result = validateRecipe(draftToRecipe(draft));
  const fieldErrors = new Map<number, string>();
  const stepErrors = new Map<number, string>();
  let nameError: string | undefined;
  const errors: Draft['errors'] = [];
  for (const error of result.errors) {
    const field = /^\$\.fields\[(\d+)\]/.exec(error.path);
    const step = /^\$\.steps\[(\d+)\]/.exec(error.path);
    if (field) {
      const index = Number(field[1]);
      if (!fieldErrors.has(index)) fieldErrors.set(index, error.message);
    } else if (step) {
      const index = Number(step[1]);
      if (!stepErrors.has(index)) stepErrors.set(index, error.message);
    } else if (error.path === '$.name') nameError ??= error.message;
    else errors.push(error);
  }
  const fields = draft.fields.map((f, i) => {
    const { error: _old, ...rest } = f;
    const error = fieldErrors.get(i);
    return error ? { ...rest, error } : rest;
  });
  const steps = draft.steps.map((s, i) => {
    const { error: _old, ...rest } = s;
    const error = stepErrors.get(i);
    return error ? { ...rest, error } : rest;
  });
  const { nameError: _oldName, ...rest } = draft;
  return { ...rest, ...(nameError ? { nameError } : {}), fields, steps, errors };
}

/** A draft for editing an existing recipe; counts are unknown until the page is counted. */
export function draftFromRecipe(recipe: Recipe, values: Readonly<Record<string, string>> = {}): Draft {
  // The recorder edits one table; multi-table recipes are refused before a session starts.
  const table = tablesOf(recipe)[0]!;
  const steps: DraftStep[] = recipe.steps.map((s) => ({
    kind: s.kind,
    ...(s.target ? { target: { selectors: s.target.selectors.map(bare), ...(s.target.fingerprint ? { fingerprint: s.target.fingerprint } : {}) } } : {}),
    ...(s.value !== undefined ? { value: s.value } : {}),
    when: s.when,
    optional: s.optional,
    ...(s.label ? { label: s.label } : {}),
    count: null,
  }));
  const vars = draftVariables({ url: recipe.url, steps }).map((name) => ({
    name,
    value: values[name] ?? recipe.vars.find((v) => v.name === name)?.default ?? '',
  }));
  const fields: DraftField[] = table.fields.map((f) => ({
    name: f.name,
    type: f.type,
    scope: f.scope,
    selectors: f.selectors.map(bare),
    ...(f.attr ? { attr: f.attr } : {}),
    optional: f.optional,
    key: f.key ?? false,
    ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}),
    count: null,
    sample: null,
  }));
  const item: DraftItem | null = table.item
    ? {
        selectors: table.item.selectors.map(bare),
        ...(table.item.within ? { within: table.item.within.map(bare), withinCount: null } : {}),
        ...(table.item.withinFingerprint ? { withinFingerprint: table.item.withinFingerprint } : {}),
        exclude: (table.item.exclude ?? []).map(bare),
        ...(table.item.fingerprint ? { fingerprint: table.item.fingerprint } : {}),
        count: null,
        total: null,
      }
    : null;
  const p = recipe.pagination;
  const pagination: DraftPagination | null =
    p.kind === 'none' && !p.target && !p.param && p.limit === 1 && p.stopRules.length === 0 && p.delayMs === 0
      ? null
      : {
          kind: p.kind,
          ...(p.target ? { target: { selectors: p.target.selectors.map(bare), ...(p.target.fingerprint ? { fingerprint: p.target.fingerprint } : {}) } } : {}),
          ...(p.param ? { param: p.param } : {}),
          limit: p.limit,
          stopRules: p.stopRules,
          delayMs: p.delayMs,
        };
  return validateDraft({
    name: recipe.name,
    url: recipe.url,
    vars,
    item,
    fields,
    steps,
    pagination,
    guards: recipe.guards,
    healing: recipe.healing,
    ...(recipe.tables ? { table: table.name } : {}),
    dirty: false,
    errors: [],
  });
}

/** The validated recipe in the form the draft was loaded in: one entry `tables` when it came that way, else the shorthand. */
export function inDraftForm(draft: Pick<Draft, 'table'>, recipe: Recipe): Recipe {
  if (draft.table === undefined || recipe.tables) return recipe;
  const { item, fields, ...rest } = recipe;
  return { ...rest, tables: [{ name: draft.table, ...(item ? { item } : {}), fields: fields ?? [] }] };
}

export interface NewField {
  name: string;
  type: FieldType;
  scope: FieldScope;
  selectors: ProtocolCandidate[];
  attr?: string;
  optional?: boolean;
  key?: boolean;
  fingerprint?: DraftField['fingerprint'];
  count?: number | null;
  sample?: string | null;
}

export interface NewDraftStep {
  kind: StepKind;
  target?: { selectors: ProtocolCandidate[]; fingerprint?: DraftField['fingerprint'] };
  value?: string;
  when?: DraftStep['when'];
  optional?: boolean;
  count?: number | null;
}

export type DraftAction =
  | { type: 'addField'; field: NewField }
  | { type: 'updateField'; index: number; patch: FieldPatch }
  /** Replace the field at `index` in place: options, selectors, fingerprint, and counts. */
  | { type: 'replaceField'; index: number; field: NewField }
  | { type: 'replaceSelectors'; index: number; selectors: ProtocolCandidate[]; fingerprint?: DraftField['fingerprint']; count: number | null; sample: string | null }
  | { type: 'removeField'; index: number }
  | { type: 'moveField'; from: number; to: number }
  | { type: 'setItem'; item: DraftItem | null }
  | { type: 'addExclusion'; candidate: ProtocolCandidate }
  | { type: 'removeExclusion'; index: number }
  | { type: 'setItemCounts'; count: number | null; total: number | null; withinCount?: number | null }
  /** Set or clear (null) the item container's list parent. */
  | { type: 'setWithin'; within: ProtocolCandidate[] | null; fingerprint?: DraftField['fingerprint'] }
  | { type: 'setFieldCounts'; counts: { count: number | null; sample: string | null }[] }
  | { type: 'setPagination'; pagination: DraftPagination | null }
  | { type: 'updatePagination'; patch: PaginationPatch }
  | { type: 'addStep'; step: NewDraftStep }
  | { type: 'updateStep'; index: number; patch: StepPatch }
  | { type: 'replaceStepTarget'; index: number; selectors: ProtocolCandidate[]; fingerprint?: DraftField['fingerprint']; count: number | null }
  | { type: 'removeStep'; index: number }
  | { type: 'moveStep'; from: number; to: number }
  | { type: 'setStepCounts'; counts: (number | null)[] }
  | { type: 'setName'; name: string }
  | { type: 'setVar'; name: string; value: string }
  | { type: 'markSaved' };

/** Actions that only refresh live data and do not make the draft dirty. */
const CLEAN_ACTIONS = new Set<DraftAction['type']>(['setItemCounts', 'setFieldCounts', 'setStepCounts', 'markSaved']);

/** Primary selector as a key, to tell whether two steps act on the same element. */
const targetKey = (step: { target?: { selectors: ProtocolCandidate[] } }) => {
  const primary = step.target?.selectors[0];
  return primary ? `${primary.strategy}=${primary.value}` : null;
};

function applyStepPatch(step: DraftStep, patch: StepPatch): DraftStep {
  const next: DraftStep = { ...step };
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.when !== undefined) next.when = patch.when;
  if (patch.optional !== undefined) next.optional = patch.optional;
  if (patch.value === null) delete next.value;
  else if (patch.value !== undefined) next.value = patch.value;
  if (patch.label === null || patch.label === '') delete next.label;
  else if (patch.label !== undefined) next.label = patch.label;
  return next;
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [entry] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, entry!);
  return out;
}

function applyFieldPatch(field: DraftField, patch: FieldPatch): DraftField {
  const next: DraftField = { ...field };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.scope !== undefined) next.scope = patch.scope;
  if (patch.optional !== undefined) next.optional = patch.optional;
  if (patch.key !== undefined) next.key = patch.key;
  if (patch.attr === null || patch.attr === '') delete next.attr;
  else if (patch.attr !== undefined) next.attr = patch.attr;
  return next;
}

function toDraftField(f: NewField): DraftField {
  return {
    name: f.name,
    type: f.type,
    scope: f.scope,
    selectors: f.selectors,
    ...(f.attr ? { attr: f.attr } : {}),
    optional: f.optional ?? false,
    key: f.key ?? false,
    ...(f.fingerprint ? { fingerprint: f.fingerprint } : {}),
    count: f.count ?? null,
    sample: f.sample ?? null,
  };
}

/** The pure draft state machine. Every result is re-validated. */
export function reduceDraft(draft: Draft, action: DraftAction): Draft {
  let next: Draft = draft;
  switch (action.type) {
    case 'addField': {
      const field = toDraftField(action.field);
      let fields = [...draft.fields, field];
      if (field.key) fields = fields.map((other, i) => (i === fields.length - 1 ? other : { ...other, key: false }));
      next = { ...draft, fields };
      break;
    }
    case 'replaceField': {
      if (!draft.fields[action.index]) return draft;
      const field = toDraftField(action.field);
      const fields = draft.fields.map((f, i) => (i === action.index ? field : field.key ? { ...f, key: false } : f));
      next = { ...draft, fields };
      break;
    }
    case 'updateField': {
      let fields = draft.fields.map((f, i) => (i === action.index ? applyFieldPatch(f, action.patch) : f));
      if (action.patch.key) fields = fields.map((f, i) => (i === action.index ? f : { ...f, key: false }));
      next = { ...draft, fields };
      break;
    }
    case 'replaceSelectors':
      next = {
        ...draft,
        fields: draft.fields.map((f, i) => {
          if (i !== action.index) return f;
          const { fingerprint: _fp, ...rest } = f;
          return {
            ...rest,
            selectors: action.selectors,
            ...(action.fingerprint ? { fingerprint: action.fingerprint } : {}),
            count: action.count,
            sample: action.sample,
          };
        }),
      };
      break;
    case 'removeField':
      next = { ...draft, fields: draft.fields.filter((_, i) => i !== action.index) };
      break;
    case 'moveField':
      next = { ...draft, fields: move(draft.fields, action.from, action.to) };
      break;
    case 'setItem':
      next = {
        ...draft,
        item: action.item,
        fields: action.item ? draft.fields : draft.fields.map((f) => (f.scope === 'item' ? { ...f, scope: 'page' as const } : f)),
      };
      break;
    case 'addExclusion':
      if (!draft.item) return draft;
      next = { ...draft, item: { ...draft.item, exclude: [...draft.item.exclude, action.candidate] } };
      break;
    case 'removeExclusion':
      if (!draft.item) return draft;
      next = { ...draft, item: { ...draft.item, exclude: draft.item.exclude.filter((_, i) => i !== action.index) } };
      break;
    case 'setItemCounts':
      if (!draft.item) return draft;
      next = {
        ...draft,
        item: { ...draft.item, count: action.count, total: action.total, ...(action.withinCount !== undefined && draft.item.within ? { withinCount: action.withinCount } : {}) },
      };
      break;
    case 'setWithin': {
      if (!draft.item) return draft;
      const { within: _w, withinFingerprint: _f, withinCount: _c, ...rest } = draft.item;
      next = {
        ...draft,
        item: action.within && action.within.length > 0
          ? { ...rest, within: action.within, ...(action.fingerprint ? { withinFingerprint: action.fingerprint } : {}), withinCount: action.within[0]!.count ?? null }
          : rest,
      };
      break;
    }
    case 'setFieldCounts':
      next = {
        ...draft,
        fields: draft.fields.map((f, i) => (action.counts[i] ? { ...f, ...action.counts[i] } : f)),
      };
      break;
    case 'setPagination':
      next = { ...draft, pagination: action.pagination };
      break;
    case 'updatePagination':
      next = { ...draft, pagination: { ...(draft.pagination ?? DEFAULT_PAGINATION), ...action.patch } };
      break;
    case 'addStep': {
      const s = action.step;
      const step: DraftStep = {
        kind: s.kind,
        ...(s.target ? { target: { selectors: s.target.selectors, ...(s.target.fingerprint ? { fingerprint: s.target.fingerprint } : {}) } } : {}),
        ...(s.value !== undefined ? { value: s.value } : {}),
        when: s.when ?? 'first-page',
        optional: s.optional ?? false,
        count: s.count ?? null,
      };
      const last = draft.steps.at(-1);
      // Typing into the same input again replaces the value instead of adding a step.
      const replaces = step.kind === 'type' && last?.kind === 'type' && targetKey(last) !== null && targetKey(last) === targetKey(step);
      next = { ...draft, steps: replaces ? [...draft.steps.slice(0, -1), { ...last, value: step.value ?? '' }] : [...draft.steps, step] };
      break;
    }
    case 'updateStep':
      next = { ...draft, steps: draft.steps.map((s, i) => (i === action.index ? applyStepPatch(s, action.patch) : s)) };
      break;
    case 'replaceStepTarget':
      next = {
        ...draft,
        steps: draft.steps.map((s, i) =>
          i === action.index
            ? { ...s, target: { selectors: action.selectors, ...(action.fingerprint ? { fingerprint: action.fingerprint } : {}) }, count: action.count }
            : s,
        ),
      };
      break;
    case 'removeStep':
      next = { ...draft, steps: draft.steps.filter((_, i) => i !== action.index) };
      break;
    case 'moveStep':
      next = { ...draft, steps: move(draft.steps, action.from, action.to) };
      break;
    case 'setStepCounts':
      next = { ...draft, steps: draft.steps.map((s, i) => (action.counts[i] !== undefined ? { ...s, count: action.counts[i]! } : s)) };
      break;
    case 'setName':
      next = { ...draft, name: action.name };
      break;
    case 'setVar':
      next = { ...draft, vars: draft.vars.map((v) => (v.name === action.name ? { ...v, value: action.value } : v)) };
      break;
    case 'markSaved':
      next = { ...draft, dirty: false };
      break;
  }
  if (!CLEAN_ACTIONS.has(action.type)) next = { ...next, dirty: true };
  return validateDraft(syncVars(next));
}

/** Whether the draft can be saved: it validates with the recipe schema. */
export function draftErrors(draft: Draft): { path: string; message: string }[] {
  const result = validateRecipe(draftToRecipe(draft));
  return result.errors;
}

export interface PaginationTarget {
  tag: string;
  attrs: Record<string, string>;
  role?: string;
}

export type DetectedPagination = Pick<DraftPagination, 'kind' | 'param'>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function numericParamChange(current: URL, target: URL): DraftPagination['param'] | null {
  const keys = new Set([...current.searchParams.keys(), ...target.searchParams.keys()]);
  let found: DraftPagination['param'] | null = null;
  for (const key of keys) {
    const a = current.searchParams.get(key);
    const b = target.searchParams.get(key);
    if (a === b) continue;
    if (found || b === null || !/^\d+$/.test(b) || (a !== null && !/^\d+$/.test(a)) || !IDENT.test(key)) return null;
    const start = a === null ? 1 : Number(a);
    const step = Number(b) - start;
    if (step === 0) return null;
    found = { name: key, start, step };
  }
  return found;
}

function numericSegmentChange(current: URL, target: URL): DraftPagination['param'] | null {
  const a = current.pathname.split('/');
  const b = target.pathname.split('/');
  if (current.search !== target.search) return null;
  let found: DraftPagination['param'] | null = null;
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (found || !/^\d+$/.test(a[i]!) || !/^\d+$/.test(b[i]!)) return null;
      const previous = b[i - 1] ?? '';
      const start = Number(a[i]);
      found = { name: IDENT.test(previous) ? previous : 'page', start, step: Number(b[i]) - start };
    }
  }
  return found && found.step !== 0 ? found : null;
}

/**
 * Guess the pagination kind from the element marked as the target: `url` for
 * a link that differs from the current URL only by a numeric query parameter
 * or path segment, `next` for any other link, `more` for a button.
 */
export function detectPagination(target: PaginationTarget, currentUrl: string): DetectedPagination {
  const isButton =
    target.tag === 'button' ||
    target.role === 'button' ||
    (target.tag === 'input' && ['button', 'submit'].includes(target.attrs.type ?? ''));
  if (isButton) return { kind: 'more' };
  const href = target.attrs.href;
  if (target.tag === 'a' && href !== undefined) {
    try {
      const current = new URL(currentUrl);
      const next = new URL(href, currentUrl);
      if (current.origin === next.origin) {
        const param =
          current.pathname === next.pathname ? numericParamChange(current, next) : numericSegmentChange(current, next);
        if (param) return { kind: 'url', param };
      }
    } catch {
      // Not a URL we can compare; fall through to `next`.
    }
    return { kind: 'next' };
  }
  return { kind: 'more' };
}
