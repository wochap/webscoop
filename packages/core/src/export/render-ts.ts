import { commentBlock, header } from './header';
import { formatLiteral } from './literal';
import type { ExportPlan } from './plan';
import { PAGE_HELPERS } from './page-helpers';
import { TS_PRELUDE } from './prelude-ts';

export interface RenderOptions {
  /** webscoop version, for the header. */
  version: string;
  /** Export time, for the header. */
  now: Date;
  /** Make the script headless unless run with `--headed`. Default false. */
  headless?: boolean;
  /** Where the script saves downloads. Default `~/Downloads/webscoop` on the machine that runs it. */
  downloadDir?: string;
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
    '/** Interval between checks of an await-user condition. */',
    `const AWAIT_POLL_MS = ${t.awaitPollMs};`,
    '/** How long an await-user step waits unless --await-timeout is given. */',
    `const DEFAULT_AWAIT_TIMEOUT_MS = ${t.awaitTimeoutMs};`,
    '/** Longest a --var-command may run. */',
    `const VAR_COMMAND_TIMEOUT_MS = ${t.varCommandMs};`,
    '/** How long a file chooser may take to open. */',
    `const FILE_CHOOSER_TIMEOUT_MS = ${t.fileChooserMs};`,
    '/** Most pages --pages all walks. */',
    `const DEFAULT_PAGE_CAP = ${plan.pagination.cap};`,
    '/** Where download steps save files. */',
    opts.downloadDir !== undefined ? `const DOWNLOAD_DIR = ${literal(opts.downloadDir)};` : "const DOWNLOAD_DIR = join(homedir(), 'Downloads', 'webscoop');",
    '',
    '/** Page URL; {name} marks a variable. */',
    `const URL_TEMPLATE = ${literal(plan.url)};`,
    `const VARS: Var[] = ${literal(plan.vars)};`,
    `const FLOWS: Flow[] = ${literal(plan.flows)};`,
    '/** Blocks in run order: called flows, extractions, and the paginate block. */',
    `const SEQUENCE: Block[] = ${literal(plan.sequence)};`,
    '/** Tables in sequence order. */',
    `const TABLES: Table[] = ${literal(plan.tables)};`,
    '/** Index of the table whose absence on its first extraction fails the run; -1 when none. */',
    `const LEAD = ${plan.primary};`,
    `const PAGINATION: Pagination = ${literal(pagination)};`,
    '/** Functions evaluated in the page, from webscoop core. */',
    `const PAGE_JS: Record<string, string> = ${literal(PAGE_HELPERS)};`,
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
