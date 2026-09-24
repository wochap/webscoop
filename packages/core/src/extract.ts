import { convertValue, defaultAttr } from './convert';
import type { FieldReport, Row, RunReport } from './events';
import { healContext, SnapshotCache } from './healing/context';
import { rankMatches } from './healing/fuzzy';
import { candidatesResolver, resolveTarget } from './healing/ladder';
import { promote, type Promotion } from './healing/promote';
import type { Viewport } from './healing/score';
import { isHealed, type HealContext, type HealOutcome, type HealTarget, type Resolution, type Resolver } from './healing/types';
import type { ElementRef, Session } from './ports';
import type { Fingerprint, Recipe, RecipeField, SelectorCandidate } from './recipe/schema';
import { refForNode } from './selectors/xpath';

export interface Resolved {
  index: number;
  candidate: SelectorCandidate;
  refs: ElementRef[];
}

/** Try candidates in listed order; the first that resolves at least one element wins. */
export async function resolveFirst(
  session: Session,
  candidates: readonly SelectorCandidate[],
  within?: ElementRef,
): Promise<Resolved | null> {
  for (const [index, candidate] of candidates.entries()) {
    const refs = await session.resolve(candidate, within);
    if (refs.length > 0) return { index, candidate, refs };
  }
  return null;
}

export interface PageExtraction {
  rows: Row[];
  item: RunReport['item'];
  fields: FieldReport[];
  /** Required fields that resolved on no row at all (or the item container, when nothing matched). */
  missingRequired: string[];
  warnings: string[];
  /** Targets that healed, with their new selectors, in the order they were resolved. */
  promotions: Promotion[];
}

export interface ExtractOptions {
  pageUrl: string;
  page: number;
  /** Healing ladder. Default: the stored candidates only, in order. */
  ladder?: readonly Resolver[];
  /**
   * Generate fresh selectors for targets resolved by a later stored candidate
   * too, not only for targets found by a snapshot rung. Default false.
   */
  promote?: boolean;
  /** Called once per healed target, before its field report exists. */
  onHealed?: (promotion: Promotion) => void;
  viewport?: Viewport;
}

/** Drop containers that also match one of the exclusion candidates. */
export async function excludeContainers(
  session: Session,
  containers: ElementRef[],
  exclude: readonly SelectorCandidate[],
): Promise<ElementRef[]> {
  if (exclude.length === 0) return containers;
  const excluded: ElementRef[] = [];
  for (const candidate of exclude) excluded.push(...(await session.resolve(candidate)));
  if (excluded.length === 0) return containers;
  const kept: ElementRef[] = [];
  for (const container of containers) {
    let drop = false;
    for (const other of excluded) {
      if (await session.same(container, other)) {
        drop = true;
        break;
      }
    }
    if (!drop) kept.push(container);
  }
  return kept;
}

async function readValue(session: Session, field: RecipeField, ref: ElementRef, pageUrl: string): Promise<unknown> {
  const attr = field.attr ?? defaultAttr(field.type);
  const raw = await session.read(ref, { ...(attr ? { attr } : {}), mode: field.type === 'html' ? 'html' : 'text' });
  return convertValue(field.type, raw, pageUrl);
}

/** How a target ended up after the ladder: the selectors rows use, and its promotion when it healed. */
interface Settled {
  resolution: Resolution;
  selectors: SelectorCandidate[];
  promotion: Promotion | null;
}

const UNRESOLVED: HealOutcome = { kind: 'unresolved' };

function fieldTarget(field: RecipeField, index: number): HealTarget {
  return {
    kind: 'field',
    index,
    name: field.name,
    scope: field.scope,
    optional: field.optional,
    selectors: field.selectors,
    ...(field.fingerprint ? { fingerprint: field.fingerprint } : {}),
  };
}

/**
 * The item container that best matches the item fingerprint: field
 * fingerprints were recorded in that item, so snapshot rungs compare like
 * with like even when the page reordered its items. The first container when
 * the item has no fingerprint or no container stands out.
 */
async function probeContainer(
  session: Session,
  cache: SnapshotCache,
  containers: readonly ElementRef[],
  fp: Fingerprint | undefined,
  threshold: number,
): Promise<ElementRef | undefined> {
  const first = containers[0];
  if (!fp || containers.length < 2) return first;
  const root = await cache.get();
  const [best] = rankMatches({ kind: 'item', selectors: [], fingerprint: fp }, root, { outerAncestors: [] }, true);
  if (!best || best.score < threshold) return first;
  const ref = await refForNode(session, best.node);
  if (!ref) return first;
  for (const container of containers) if (await session.same(container, ref)) return container;
  return first;
}

/**
 * Extract every row of the current page. Each target (item container, then
 * page fields, then item fields) goes through the healing ladder once: page
 * scoped targets against the document, item scoped fields against the first
 * item container, with the winning selector reused for the other containers.
 */
export async function extractPage(session: Session, recipe: Recipe, opts: ExtractOptions): Promise<PageExtraction> {
  const ladder = opts.ladder ?? [candidatesResolver];
  const cache = new SnapshotCache(session);
  const threshold = recipe.healing.fuzzyThreshold;
  const promotions: Promotion[] = [];
  const context = (
    extra: { within?: ElementRef; containers?: readonly ElementRef[]; probe?: () => Promise<ElementRef | undefined>; outerAncestors?: readonly string[] } = {},
  ): HealContext =>
    healContext({ session, cache, threshold, ...extra, ...(opts.viewport ? { viewport: opts.viewport } : {}) });

  /** Promote when the target healed; item scoped fuzzy matches must hold in at least half the containers. */
  const settle = (target: HealTarget, ctx: HealContext) => async (resolution: Resolution): Promise<Settled | null> => {
    const { outcome } = resolution;
    if (!isHealed(outcome)) return { resolution, selectors: target.selectors, promotion: null };
    const snapshotRung = outcome.kind !== 'candidate';
    if (!snapshotRung && !opts.promote) {
      return { resolution, selectors: target.selectors.slice(outcome.index), promotion: null };
    }
    const promotion = await promote(target, resolution, ctx);
    const containers = ctx.containers?.length ?? 0;
    const heldBy = promotion.coverage ?? containers;
    if (target.kind === 'field' && target.scope === 'item' && snapshotRung && outcome.kind !== 'user' && heldBy * 2 < containers) {
      return null;
    }
    return { resolution, selectors: promotion.selectors, promotion };
  };
  const record = (settled: Settled | null) => {
    if (!settled?.promotion) return;
    promotions.push(settled.promotion);
    opts.onHealed?.(settled.promotion);
  };

  // Item container.
  let containers: (ElementRef | undefined)[] = [undefined];
  let item: RunReport['item'] = null;
  let itemAncestors: readonly string[] = [];
  let itemFingerprint: Fingerprint | undefined;
  if (recipe.item) {
    const target: HealTarget = {
      kind: 'item',
      selectors: recipe.item.selectors,
      ...(recipe.item.fingerprint ? { fingerprint: recipe.item.fingerprint } : {}),
    };
    const ctx = context();
    const settled = await resolveTarget(ladder, target, ctx, settle(target, ctx));
    record(settled);
    let refs: ElementRef[] = [];
    if (settled) {
      refs = settled.resolution.refs;
      if (settled.resolution.outcome.kind !== 'candidate' && settled.selectors[0]) {
        const all = await session.resolve(settled.selectors[0]);
        if (all.length > refs.length) refs = all;
      }
    }
    const kept = await excludeContainers(session, refs, recipe.item.exclude ?? []);
    containers = kept;
    const outcome = settled?.resolution.outcome ?? UNRESOLVED;
    item = {
      candidateIndex: outcome.kind === 'candidate' ? outcome.index : null,
      candidate: settled?.selectors[0] ?? null,
      count: kept.length,
      outcome,
    };
    itemFingerprint = settled?.promotion?.fingerprint ?? recipe.item.fingerprint;
    itemAncestors = itemFingerprint?.ancestors ?? [];
  }

  // Fields: resolve each once, then read every row.
  interface FieldState {
    field: RecipeField;
    settled: Settled | null;
    pageValue?: { value: unknown; found: boolean };
    missingRows: number[];
  }
  const states: FieldState[] = [];
  const firstContainer = containers[0];
  const realContainers = containers.filter((c): c is ElementRef => c !== undefined);
  let probed: Promise<ElementRef | undefined> | undefined;
  const probe = () => (probed ??= probeContainer(session, cache, realContainers, itemFingerprint, threshold));
  for (const [index, field] of recipe.fields.entries()) {
    const target = fieldTarget(field, index);
    if (field.scope === 'page') {
      const ctx = context();
      const settled = await resolveTarget(ladder, target, ctx, settle(target, ctx));
      record(settled);
      const ref = settled?.resolution.refs[0];
      const pageValue = ref ? { value: await readValue(session, field, ref, opts.pageUrl), found: true } : { value: null, found: false };
      states.push({ field, settled, pageValue, missingRows: [] });
      continue;
    }
    if (recipe.item && realContainers.length === 0) {
      states.push({ field, settled: null, missingRows: [] });
      continue;
    }
    const ctx = context({
      ...(firstContainer ? { within: firstContainer } : {}),
      ...(realContainers.length > 0 ? { containers: realContainers, probe } : {}),
      outerAncestors: itemAncestors,
    });
    const settled = await resolveTarget(ladder, target, ctx, settle(target, ctx));
    record(settled);
    states.push({ field, settled, missingRows: [] });
  }

  const rows: Row[] = [];
  for (const [index, container] of containers.entries()) {
    const row: Row = { _page: opts.page, _index: index };
    for (const state of states) {
      let result = state.pageValue;
      if (!result) {
        const resolved = state.settled ? await resolveFirst(session, state.settled.selectors, container) : null;
        result = resolved
          ? { value: await readValue(session, state.field, resolved.refs[0]!, opts.pageUrl), found: true }
          : { value: null, found: false };
      }
      if (!result.found) state.missingRows.push(index);
      row[state.field.name] = result.value;
    }
    rows.push(row);
  }

  const fields: FieldReport[] = states.map(({ field, settled, missingRows }) => {
    const outcome = settled?.resolution.outcome ?? UNRESOLVED;
    const status: FieldReport['status'] =
      rows.length === 0 || missingRows.length === rows.length
        ? 'missing'
        : missingRows.length > 0
          ? 'partial'
          : isHealed(outcome)
            ? 'healed'
            : 'ok';
    return {
      name: field.name,
      type: field.type,
      optional: field.optional,
      candidateIndex: outcome.kind === 'candidate' ? outcome.index : null,
      candidate: settled?.selectors[0] ?? null,
      outcome,
      status,
      missingRows,
    };
  });

  const missingRequired: string[] = [];
  const warnings: string[] = [];
  if (recipe.item && rows.length === 0) missingRequired.push('item');
  for (const report of fields) {
    if (report.optional) continue;
    if (report.status === 'missing' && rows.length > 0) missingRequired.push(report.name);
    if (report.status === 'partial') {
      warnings.push(
        `required field "${report.name}" missing on page ${opts.page} row${report.missingRows.length > 1 ? 's' : ''} ${report.missingRows.join(', ')}`,
      );
    }
  }

  return { rows, item, fields, missingRequired, warnings, promotions };
}
