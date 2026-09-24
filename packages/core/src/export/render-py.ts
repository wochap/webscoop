import { commentBlock, header } from './header';
import { formatLiteral } from './literal';
import type { ExportPlan } from './plan';
import { PY_PRELUDE } from './prelude-py';
import type { RenderOptions } from './render-ts';

const SECTION = '# ---------------------------------------------------------------------------';

const pyLiteral = (value: unknown): string => formatLiteral(value, 'py');

/** The recipe as named constants; the prelude reads nothing else. */
function constants(plan: ExportPlan, opts: RenderOptions): string {
  const { cap: _cap, ...pagination } = plan.pagination;
  const t = plan.timings;
  return [
    SECTION,
    '# Recipe',
    SECTION,
    '',
    `RECIPE_NAME = ${pyLiteral(plan.recipe)}`,
    '# Run without a window unless --headed is given.',
    `DEFAULT_HEADLESS = ${pyLiteral(opts.headless === true)}`,
    '',
    '# Navigation, settle, wait step, and growth timeout.',
    `NAVIGATION_TIMEOUT_MS = ${t.navigationMs}`,
    '# Default timeout of element actions.',
    `ACTION_TIMEOUT_MS = ${t.actionMs}`,
    '# How long settling waits for an action to start a navigation.',
    `SETTLE_GRACE_MS = ${t.settleGraceMs}`,
    '# How long settling waits for network idle when nothing navigated.',
    `SETTLE_IDLE_MS = ${t.settleIdleMs}`,
    '# Interval between looks for a wait step target.',
    `WAIT_POLL_MS = ${t.waitPollMs}`,
    '# Interval between item counts while a page grows.',
    `GROWTH_POLL_MS = ${t.growthPollMs}`,
    '# Most pages --pages all walks.',
    `DEFAULT_PAGE_CAP = ${plan.pagination.cap}`,
    '',
    '# Page URL; {name} marks a variable.',
    `URL_TEMPLATE = ${pyLiteral(plan.url)}`,
    `VARS = ${pyLiteral(plan.vars)}`,
    `STEPS = ${pyLiteral(plan.steps)}`,
    `ITEM = ${pyLiteral(plan.item)}`,
    `FIELDS = ${pyLiteral(plan.fields)}`,
    '# Field that identifies a row across pages, or None to compare all field values.',
    `KEY_FIELD = ${pyLiteral(plan.key)}`,
    `PAGINATION = ${pyLiteral(pagination)}`,
    '',
    '',
    'if __name__ == "__main__":',
    '    sys.exit(main(sys.argv[1:]))',
  ].join('\n');
}

/** A standalone Python script on the Playwright sync API, run with `python3 <file>`. */
export function renderPy(plan: ExportPlan, opts: RenderOptions): string {
  return `${commentBlock(header(plan, opts), '#')}\n\n${PY_PRELUDE}\n\n${constants(plan, opts)}\n`;
}
