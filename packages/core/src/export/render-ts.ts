import { commentBlock, header } from './header';
import { formatLiteral } from './literal';
import type { ExportPlan } from './plan';
import { TS_PRELUDE } from './prelude-ts';

export interface RenderOptions {
  /** webscoop version, for the header. */
  version: string;
  /** Export time, for the header. */
  now: Date;
  /** Make the script headless unless run with `--headed`. Default false. */
  headless?: boolean;
}

const SECTION = '// ---------------------------------------------------------------------------';

const literal = (value: unknown): string => formatLiteral(value, 'ts');

/** The recipe as named constants; the prelude reads nothing else. */
function constants(plan: ExportPlan, opts: RenderOptions): string {
  const { cap: _cap, ...pagination } = plan.pagination;
  const t = plan.timings;
  return [
    SECTION,
    '// Recipe',
    SECTION,
    '',
    `const RECIPE_NAME = ${literal(plan.recipe)};`,
    '/** Run without a window unless --headed is given. */',
    `const DEFAULT_HEADLESS = ${opts.headless === true};`,
    '',
    '/** Navigation, settle, wait step, and growth timeout. */',
    `const NAVIGATION_TIMEOUT_MS = ${t.navigationMs};`,
    '/** Default timeout of element actions. */',
    `const ACTION_TIMEOUT_MS = ${t.actionMs};`,
    '/** How long settling waits for an action to start a navigation. */',
    `const SETTLE_GRACE_MS = ${t.settleGraceMs};`,
    '/** How long settling waits for network idle when nothing navigated. */',
    `const SETTLE_IDLE_MS = ${t.settleIdleMs};`,
    '/** Interval between looks for a wait step target. */',
    `const WAIT_POLL_MS = ${t.waitPollMs};`,
    '/** Interval between item counts while a page grows. */',
    `const GROWTH_POLL_MS = ${t.growthPollMs};`,
    '/** Most pages --pages all walks. */',
    `const DEFAULT_PAGE_CAP = ${plan.pagination.cap};`,
    '',
    '/** Page URL; {name} marks a variable. */',
    `const URL_TEMPLATE = ${literal(plan.url)};`,
    `const VARS: Var[] = ${literal(plan.vars)};`,
    `const STEPS: Step[] = ${literal(plan.steps)};`,
    `const ITEM: Item | null = ${literal(plan.item)};`,
    `const FIELDS: Field[] = ${literal(plan.fields)};`,
    '/** Field that identifies a row across pages, or null to compare all field values. */',
    `const KEY_FIELD: string | null = ${literal(plan.key)};`,
    `const PAGINATION: Pagination = ${literal(pagination)};`,
    '',
    'main(process.argv.slice(2)).then((code) => {',
    '  process.exitCode = code;',
    '});',
  ].join('\n');
}

/** A standalone TypeScript script for Node and `playwright`, run with `npx tsx <file>`. */
export function renderTs(plan: ExportPlan, opts: RenderOptions): string {
  return `${commentBlock(header(plan, opts), '//')}\n\n${TS_PRELUDE}\n${constants(plan, opts)}\n`;
}
