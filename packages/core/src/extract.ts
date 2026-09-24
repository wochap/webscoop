import { convertValue, defaultAttr } from './convert';
import type { FieldReport, Row, RunReport } from './events';
import type { ElementRef, Session } from './ports';
import type { Recipe, RecipeField, SelectorCandidate } from './recipe/schema';

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
}

interface FieldTracker {
  field: RecipeField;
  bestIndex: number | null;
  missingRows: number[];
}

async function readField(
  session: Session,
  field: RecipeField,
  within: ElementRef | undefined,
  pageUrl: string,
  tracker: FieldTracker,
): Promise<{ value: unknown; found: boolean }> {
  const resolved = await resolveFirst(session, field.selectors, within);
  if (!resolved) return { value: null, found: false };
  if (tracker.bestIndex === null || resolved.index < tracker.bestIndex) tracker.bestIndex = resolved.index;
  const attr = field.attr ?? defaultAttr(field.type);
  const raw = await session.read(resolved.refs[0]!, {
    ...(attr ? { attr } : {}),
    mode: field.type === 'html' ? 'html' : 'text',
  });
  return { value: convertValue(field.type, raw, pageUrl), found: true };
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

/** Extract every row of the current page. Pure orchestration over a `Session`. */
export async function extractPage(
  session: Session,
  recipe: Recipe,
  opts: { pageUrl: string; page: number },
): Promise<PageExtraction> {
  const trackers = recipe.fields.map<FieldTracker>((field) => ({ field, bestIndex: null, missingRows: [] }));
  const pageTrackers = trackers.filter((t) => t.field.scope === 'page');

  const pageValues = new Map<string, { value: unknown; found: boolean }>();
  for (const tracker of pageTrackers) {
    pageValues.set(tracker.field.name, await readField(session, tracker.field, undefined, opts.pageUrl, tracker));
  }

  let containers: (ElementRef | undefined)[] = [undefined];
  let item: RunReport['item'] = null;
  if (recipe.item) {
    const resolved = await resolveFirst(session, recipe.item.selectors);
    const kept = resolved ? await excludeContainers(session, resolved.refs, recipe.item.exclude ?? []) : [];
    containers = kept;
    item = {
      candidateIndex: resolved?.index ?? null,
      candidate: resolved?.candidate ?? null,
      count: kept.length,
    };
  }

  const rows: Row[] = [];
  for (const [index, container] of containers.entries()) {
    const row: Row = { _page: opts.page, _index: index };
    for (const tracker of trackers) {
      const result =
        tracker.field.scope === 'page'
          ? pageValues.get(tracker.field.name)!
          : await readField(session, tracker.field, container, opts.pageUrl, tracker);
      if (!result.found) tracker.missingRows.push(index);
      row[tracker.field.name] = result.value;
    }
    rows.push(row);
  }

  const fields: FieldReport[] = trackers.map(({ field, bestIndex, missingRows }) => ({
    name: field.name,
    type: field.type,
    optional: field.optional,
    candidateIndex: bestIndex,
    candidate: bestIndex === null ? null : field.selectors[bestIndex]!,
    status:
      rows.length === 0 || missingRows.length === rows.length
        ? 'missing'
        : missingRows.length > 0
          ? 'partial'
          : 'ok',
    missingRows,
  }));

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

  return { rows, item, fields, missingRequired, warnings };
}
