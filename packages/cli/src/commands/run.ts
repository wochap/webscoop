import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_GUARD_TIMEOUT_MS,
  fillText,
  firstPageUrl,
  type GuardBannerHandler,
  type GuardOptions,
  MissingVariableError,
  NoopNotify,
  PaginationInputError,
  type PaginationOverrides,
  modelResolver,
  RunEmitter,
  type HealOutcome,
  type OpenOptions,
  type Recipe,
  type RepickHandler,
  type Resolver,
  type Row,
  Runner,
  type RunReport,
  type SelectorCandidate,
  type StepOptions,
  type StepReport,
} from '@webscoop/core';
import { loadConfig, type Config } from '../config';
import { log, type CliIo } from '../context';
import { requireDisplay } from '../display';
import { CliError, ExitCode, exitCodeFor, type ExitCode as Code } from '../exit';
import { acquireProfileLock, type ProfileLock } from '../lock';
import { resolvePaths } from '../paths';
import { interactiveGuardBanner } from '../guard';
import { createLlm } from '../llm';
import { interactiveRepick } from '../repick';
import { FsStorage } from '../storage';
import { windowMode } from '../window';

export interface RunCommandOptions {
  var: string[];
  jsonl?: boolean;
  out?: string;
  profile?: string;
  timeout: number;
  lockTimeout: number;
  report?: boolean;
  /** False with `--no-heal`. */
  heal?: boolean;
  /** False with `--no-save`. */
  save?: boolean;
  interactive?: boolean;
  /** False with `--no-llm`. */
  llm?: boolean;
  /** `--pages`: replaces the recipe's page limit. */
  pages?: number | 'all';
  /** `--max-pages`: cap on `all`. */
  maxPages?: number;
  /** `--delay`: milliseconds between pages. */
  delay?: number;
  /** `--guard-timeout`: longest total wait for guards. */
  guardTimeout?: number;
  /** False with `--no-guards`. */
  guards?: boolean;
  /** False with `--no-notify`. */
  notify?: boolean;
  /** `--skip-steps`: replay none of the recipe's steps. */
  skipSteps?: boolean;
  /** `--show`: never hide the browser window. */
  show?: boolean;
  /** `--hide`: hide the window even when config selects no provider. */
  hide?: boolean;
}

/** Step options for the runner from `--skip-steps`. */
export function stepsFromFlags(opts: { skipSteps?: boolean }): StepOptions {
  return { enabled: opts.skipSteps !== true };
}

/** Guard options for the runner from `--guard-timeout`, `--no-guards`, and `--no-notify`. */
export function guardsFromFlags(
  io: CliIo,
  opts: Pick<RunCommandOptions, 'guardTimeout' | 'guards' | 'notify'>,
  defaultTimeoutMs: number,
  banner?: GuardBannerHandler,
): GuardOptions {
  return {
    enabled: opts.guards !== false,
    timeoutMs: opts.guardTimeout ?? defaultTimeoutMs,
    notify: opts.notify === false ? new NoopNotify() : io.createNotify(io.env),
    ...(banner ? { banner } : {}),
  };
}

/** Pagination overrides for the runner from `--pages`, `--max-pages`, and `--delay`. */
export function paginationFromFlags(opts: Pick<RunCommandOptions, 'pages' | 'maxPages' | 'delay'>): PaginationOverrides {
  return {
    ...(opts.pages !== undefined ? { limit: opts.pages } : {}),
    ...(opts.maxPages !== undefined ? { cap: opts.maxPages } : {}),
    ...(opts.delay !== undefined ? { delayMs: opts.delay } : {}),
  };
}

/** Healing options for the runner from the `run` flags. */
export function healingFromFlags(opts: Pick<RunCommandOptions, 'heal' | 'save'>): { enabled: boolean; writeBack: boolean } {
  const enabled = opts.heal !== false;
  return { enabled, writeBack: enabled && opts.save !== false };
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseVars(pairs: readonly string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new CliError(`invalid --var "${pair}", expected name=value`);
    vars[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return vars;
}

export function summary(report: RunReport): string {
  const seconds = (report.durationMs / 1000).toFixed(2);
  const pages = `${report.pageCount} page${report.pageCount === 1 ? '' : 's'}`;
  const healed = report.healed > 0 ? `, ${report.healed} healed` : '';
  const cleared = report.guards.filter((g) => g.cleared).length;
  const guards = cleared > 0 ? `, ${cleared} guard${cleared === 1 ? '' : 's'} cleared` : '';
  const duplicates = report.duplicateCount > 0 ? `, ${report.duplicateCount} duplicate${report.duplicateCount === 1 ? '' : 's'} dropped` : '';
  const skippedSteps = report.steps.filter((s) => s.outcome === 'skipped').length;
  const skipped = skippedSteps > 0 ? `, ${skippedSteps} step${skippedSteps === 1 ? '' : 's'} skipped` : '';
  return `${report.rowCount} row${report.rowCount === 1 ? '' : 's'} from ${pages}${healed}${guards}${duplicates}${skipped} in ${seconds}s (${report.recipe})`;
}

const selectorText = (c: SelectorCandidate | null | undefined) => (c ? `${c.strategy}=${c.value}` : '-');

/** Which rung resolved a target, for logs and the `test` table. */
export function describeOutcome(outcome: HealOutcome, selector: SelectorCandidate | null): string {
  switch (outcome.kind) {
    case 'candidate':
      return `candidate ${outcome.index}: ${selectorText(selector)}`;
    case 'fuzzy':
      return `fuzzy ${outcome.score.toFixed(2)}: ${selectorText(selector)}`;
    case 'model':
      return `model: ${selectorText(selector)}${outcome.rationale ? ` (${outcome.rationale})` : ''}`;
    case 'user':
      return `re-picked: ${selectorText(selector)}`;
    case 'unresolved':
      return 'unresolved';
  }
}

/** One stderr line for a replayed or skipped step: index, kind, page, outcome, and how its target resolved. */
export function formatStep(step: StepReport): string {
  const name = `step ${step.index}${step.label ? ` "${step.label}"` : ''} (${step.kind}) on page ${step.page}`;
  const how = step.heal ? `, ${describeOutcome(step.heal, step.candidate)}` : '';
  const notes = step.notes && step.notes.length > 0 ? ` (${step.notes.join('; ')})` : '';
  return `${name}: ${step.outcome}${step.outcome === 'skipped' ? '' : how}${notes}`;
}

/** Where rows go: stdout or `--out`, JSON array or streamed JSONL. */
class RowSink {
  private stream: WriteStream | undefined;
  private readonly buffered: Row[] = [];

  constructor(
    private readonly io: CliIo,
    private readonly opts: { jsonl: boolean; out: string | undefined },
  ) {}

  private async target(): Promise<{ write(chunk: string): unknown }> {
    if (!this.opts.out) return this.io.stdout;
    if (!this.stream) {
      await mkdir(dirname(this.opts.out), { recursive: true });
      this.stream = createWriteStream(this.opts.out);
    }
    return this.stream;
  }

  private pending: Promise<unknown> = Promise.resolve();

  row(row: Row): void {
    if (!this.opts.jsonl) {
      this.buffered.push(row);
      return;
    }
    this.pending = this.pending.then(async () => (await this.target()).write(`${JSON.stringify(row)}\n`));
  }

  /** Write what was collected: every row on success, the rows of completed pages when a guard timed out. */
  async finish(success: boolean): Promise<void> {
    await this.pending;
    if (success && !this.opts.jsonl) (await this.target()).write(`${JSON.stringify(this.buffered, null, 2)}\n`);
    if (success && this.opts.jsonl && this.opts.out) await this.target();
    const stream = this.stream;
    if (stream) await new Promise<void>((done, fail) => stream.end((error?: Error | null) => (error ? fail(error) : done())));
  }
}

/** What `run` and `test` share: the recipe, its variables, a display, and a locked profile. */
interface Prepared {
  config: Config;
  storage: FsStorage;
  recipe: Recipe;
  vars: Record<string, string>;
  profile: string;
  profileDir: string;
  lock: ProfileLock;
}

async function prepare(io: CliIo, recipeRef: string, opts: { var: string[]; profile?: string; lockTimeout: number }): Promise<Prepared> {
  const paths = resolvePaths(io.env, io.homedir);
  const config = await loadConfig(paths);
  const storage = new FsStorage(paths.recipesDir, io.cwd);
  const recipe = await storage.load(recipeRef);
  const vars = parseVars(opts.var);
  try {
    firstPageUrl(recipe, vars);
    for (const step of recipe.steps) if (step.kind === 'type' && step.value) fillText(step.value, recipe.vars, vars);
  } catch (error) {
    if (error instanceof MissingVariableError) {
      throw new CliError(`${error.message}; pass --var ${error.names[0]}=<value>`);
    }
    if (error instanceof PaginationInputError) throw new CliError(error.message);
    throw error;
  }

  requireDisplay(io.env);

  const profile = opts.profile ?? recipe.name;
  if (!PROFILE_NAME.test(profile)) throw new CliError(`invalid profile name "${profile}"`);
  const profileDir = join(paths.profilesDir, profile);
  await mkdir(profileDir, { recursive: true });
  const lock = await acquireProfileLock(profileDir, { timeoutMs: opts.lockTimeout, profileName: profile });
  return { config, storage, recipe, vars, profile, profileDir, lock };
}

/** Log what the runner does on stderr: pages, fields that were not plain hits, healing, re-picks, write-back. */
function logRunEvents(io: CliIo, emitter: RunEmitter, profile: string): void {
  emitter.on('run.start', (e) => log(io, `running ${e.recipe} on profile "${profile}": ${e.url}`));
  emitter.on('page.loaded', (e) => log(io, `page ${e.page} loaded: ${e.url} (HTTP ${e.status ?? '?'})`));
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  emitter.on('guard.raised', (e) => log(io, `guard ${e.kind} on page ${e.page}: ${e.reason} (${e.url}); waiting for you in the browser window`));
  emitter.on('guard.cleared', (e) => log(io, `guard ${e.kind} on page ${e.page} cleared after ${seconds(e.waitedMs)}`));
  emitter.on('guard.timeout', (e) => log(io, `guard ${e.kind} on page ${e.page} timed out after ${seconds(e.waitedMs)}: ${e.url}`));
  emitter.on('step.replayed', (e) => log(io, formatStep(e.step)));
  emitter.on('step.skipped', (e) => log(io, formatStep(e.step)));
  emitter.on('field.healed', (e) =>
    log(io, `healed ${e.target}: ${describeOutcome(e.outcome, e.newPrimary)} (was ${selectorText(e.oldPrimary)})`),
  );
  emitter.on('field.resolved', ({ field }) => {
    if ((field.status === 'ok' || field.status === 'healed') && field.missingRows.length === 0) return;
    const notes = field.notes && field.notes.length > 0 ? ` (${field.notes.join('; ')})` : '';
    log(io, `field ${field.name}: ${field.status}, ${describeOutcome(field.outcome, field.candidate)}${notes}`);
  });
  emitter.on('page.advanced', (e) => log(io, `page ${e.page}: ${e.kind}`));
  emitter.on('pagination.stopped', (e) => {
    if (e.reason !== 'limit' && e.reason !== 'none') log(io, `pagination stopped after page ${e.page}: ${e.reason}`);
  });
  emitter.on('repick.requested', (e) => log(io, `waiting for a re-pick of ${e.target} (was ${selectorText(e.oldSelector)})`));
  emitter.on('recipe.saved', (e) => log(io, `recipe written to ${e.path}`));
}

/** The model rung for `run`, `test`, and `bench`: unavailable without an endpoint, off with `--no-llm`. */
export function modelRung(io: CliIo, config: Config, opts: { llm?: boolean }): Resolver {
  return modelResolver(createLlm(config, io.env, io.cwd), { enabled: opts.llm !== false, log: (message) => log(io, message) });
}

/** `WEBSCOOP_E2E_CDP_PORT`: a DevTools port so end-to-end tests can drive the run's own browser. */
export async function e2ePort(io: CliIo): Promise<number | undefined> {
  const cdpPort = io.env.WEBSCOOP_E2E_CDP_PORT?.trim();
  if (!cdpPort) return undefined;
  if (!/^\d+$/.test(cdpPort)) throw new CliError(`invalid WEBSCOOP_E2E_CDP_PORT "${cdpPort}"`);
  return Number(cdpPort);
}

export async function runCommand(io: CliIo, recipeRef: string, opts: RunCommandOptions): Promise<Code> {
  const { config, storage, recipe, vars, profile, profileDir, lock } = await prepare(io, recipeRef, opts);

  const controller = new AbortController();
  const offInterrupt = io.onInterrupt(() => {
    log(io, 'interrupted, closing the browser');
    controller.abort();
  });
  const sink = new RowSink(io, { jsonl: opts.jsonl ?? false, out: opts.out ? resolve(io.cwd, opts.out) : undefined });

  try {
    const emitter = new RunEmitter();
    logRunEvents(io, emitter, profile);
    emitter.on('row.emitted', (e) => sink.row(e.row));

    const healing = { ...healingFromFlags(opts), resolvers: [modelRung(io, config, opts)] };
    const port = await e2ePort(io);
    let openOptions: OpenOptions | undefined = port !== undefined ? { remoteDebuggingPort: port } : undefined;
    let repick: RepickHandler | undefined;
    let banner: GuardBannerHandler | undefined;
    if (opts.interactive) {
      // Re-pick and the guard banner inject the recorder, which needs the page's CSP out of the way.
      const bundle = await io.recorderBundle(port !== undefined ? 'e2e' : 'default');
      openOptions = { bypassCSP: true, ...openOptions };
      repick = interactiveRepick(io, { storage, bundle, vars, timeoutMs: opts.timeout });
      banner = interactiveGuardBanner(io, { storage, bundle, recipe, vars, timeoutMs: opts.timeout });
    }

    const browser = await io.createBrowser(config, io.env);
    const runner = new Runner({
      recipe,
      browser,
      profileDir,
      vars,
      timeoutMs: opts.timeout,
      emitter,
      signal: controller.signal,
      healing,
      pagination: paginationFromFlags(opts),
      guards: guardsFromFlags(io, opts, DEFAULT_GUARD_TIMEOUT_MS, banner),
      steps: stepsFromFlags(opts),
      window: io.createWindow(config, io.env, { profileDir, mode: windowMode(opts) }),
      saveRecipe: (promoted) => storage.saveTo(storage.pathFor(recipeRef), promoted),
      ...(openOptions ? { openOptions } : {}),
      ...(repick ? { repick } : {}),
    });
    const result = await runner.run();
    await sink.finish(result.ok || result.reason === 'paused');

    for (const warning of result.report.warnings) log(io, `warning: ${warning}`);
    if (opts.report) io.stderr.write(`${JSON.stringify(result.report, null, 2)}\n`);
    if (!result.ok) {
      if (result.reason === 'paused') {
        log(io, `run paused and gave up waiting: ${result.message} (${result.rows.length} rows from completed pages kept; retry later)`);
        return ExitCode.Paused;
      }
      log(io, `run failed (${result.reason}): ${result.message}`);
      return result.reason === 'aborted' ? ExitCode.Error : exitCodeFor(result.reason);
    }
    log(io, summary(result.report));
    return ExitCode.Ok;
  } finally {
    offInterrupt();
    lock.release();
  }
}

export interface TestCommandOptions {
  var: string[];
  profile?: string;
  timeout: number;
  lockTimeout: number;
  json?: boolean;
  /** False with `--no-llm`. */
  llm?: boolean;
  /** `--pages`: walk more than the first page. */
  pages?: number | 'all';
  maxPages?: number;
  delay?: number;
  /** `--guard-timeout`: default 0 for `test`, so a wall exits 2 at once. */
  guardTimeout?: number;
  /** False with `--no-guards`. */
  guards?: boolean;
  /** False with `--no-notify`. */
  notify?: boolean;
  /** `--skip-steps`: replay none of the recipe's steps. */
  skipSteps?: boolean;
  /** `--show`: never hide the browser window. */
  show?: boolean;
  /** `--hide`: hide the window even when config selects no provider. */
  hide?: boolean;
}

/** `test` stays on the first page, whatever the recipe says, unless `--pages` asks for more. */
export function testPagination(opts: Pick<TestCommandOptions, 'pages' | 'maxPages' | 'delay'>): PaginationOverrides {
  return { ...paginationFromFlags(opts), limit: opts.pages ?? 1 };
}

export interface TestRow {
  name: string;
  status: string;
  /** Rows (or item containers) where the target resolved. */
  matches: number;
  rows: number;
  optional: boolean;
  outcome: HealOutcome;
  /** The selector or rung that resolved the target. */
  resolvedBy: string;
  /** Why healing rungs declined the target. */
  notes?: string[];
}

/** Per-target rows for `webscoop test`: the item container first, then every field. */
export function testRows(report: RunReport): TestRow[] {
  const out: TestRow[] = [];
  // One row per item container, or a single row for a recipe without one.
  const rows = report.item ? report.item.count : 1;
  if (report.item) {
    const resolved = report.item.outcome.kind !== 'unresolved';
    out.push({
      name: 'item',
      status: !resolved || report.item.count === 0 ? 'missing' : report.item.outcome.kind === 'candidate' && report.item.outcome.index === 0 ? 'ok' : 'healed',
      matches: report.item.count,
      rows: report.item.count,
      optional: false,
      outcome: report.item.outcome,
      resolvedBy: describeOutcome(report.item.outcome, report.item.candidate),
      ...(report.item.notes ? { notes: report.item.notes } : {}),
    });
  }
  for (const field of report.fields) {
    out.push({
      name: field.name,
      status: field.status,
      matches: field.status === 'missing' ? 0 : rows - field.missingRows.length,
      rows,
      optional: field.optional,
      outcome: field.outcome,
      resolvedBy: describeOutcome(field.outcome, field.candidate),
      ...(field.notes ? { notes: field.notes } : {}),
    });
  }
  return out;
}

/** Aligned plain-text table. */
export function formatTable(rows: readonly TestRow[]): string {
  const header = ['FIELD', 'STATUS', 'MATCHES', 'RESOLVED BY'];
  const cells = rows.map((r) => [`${r.name}${r.optional ? '?' : ''}`, r.status, r.name === 'item' ? String(r.matches) : `${r.matches}/${r.rows}`, r.resolvedBy]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]!))).join('  ');
  return `${[line(header), ...cells.map(line)].join('\n')}\n`;
}

/**
 * Check a recipe on its first page: heal but never write back, print the
 * per-field table instead of rows, exit 0 when every required target
 * resolved on at least one row, 3 when one did not.
 */
export async function testCommand(io: CliIo, recipeRef: string, opts: TestCommandOptions): Promise<Code> {
  const { config, recipe, vars, profile, profileDir, lock } = await prepare(io, recipeRef, opts);
  const controller = new AbortController();
  const offInterrupt = io.onInterrupt(() => {
    log(io, 'interrupted, closing the browser');
    controller.abort();
  });
  try {
    const emitter = new RunEmitter();
    logRunEvents(io, emitter, profile);
    const port = await e2ePort(io);
    const browser = await io.createBrowser(config, io.env);
    const runner = new Runner({
      recipe,
      pagination: testPagination(opts),
      browser,
      profileDir,
      vars,
      timeoutMs: opts.timeout,
      emitter,
      signal: controller.signal,
      healing: { enabled: true, writeBack: false, resolvers: [modelRung(io, config, opts)] },
      guards: guardsFromFlags(io, opts, 0),
      steps: stepsFromFlags(opts),
      window: io.createWindow(config, io.env, { profileDir, mode: windowMode(opts) }),
      ...(port !== undefined ? { openOptions: { remoteDebuggingPort: port } } : {}),
    });
    const result = await runner.run();
    const rows = testRows(result.report);
    io.stdout.write(opts.json ? `${JSON.stringify(rows, null, 2)}\n` : formatTable(rows));
    if (result.ok) {
      const skipped = result.report.steps.filter((s) => s.outcome === 'skipped').length;
      log(io, `every required field resolved (${result.report.rowCount} rows, ${result.report.healed} healed${skipped > 0 ? `, ${skipped} step${skipped === 1 ? '' : 's'} skipped` : ''}, nothing written)`);
      return ExitCode.Ok;
    }
    log(io, `test failed (${result.reason}): ${result.message}`);
    if (result.reason === 'aborted') return ExitCode.Error;
    return exitCodeFor(result.reason);
  } finally {
    offInterrupt();
    lock.release();
  }
}
