import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  fillTemplate,
  MissingVariableError,
  RunEmitter,
  type HealOutcome,
  type OpenOptions,
  type Recipe,
  type RepickHandler,
  type Row,
  Runner,
  type RunReport,
  type SelectorCandidate,
} from '@webscoop/core';
import { loadConfig, type Config } from '../config';
import { log, type CliIo } from '../context';
import { requireDisplay } from '../display';
import { CliError, ExitCode, exitCodeFor, type ExitCode as Code } from '../exit';
import { acquireProfileLock, type ProfileLock } from '../lock';
import { resolvePaths } from '../paths';
import { interactiveRepick } from '../repick';
import { FsStorage } from '../storage';

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
  return `${report.rowCount} row${report.rowCount === 1 ? '' : 's'} from ${pages}${healed} in ${seconds}s (${report.recipe})`;
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
      return `model: ${selectorText(selector)}`;
    case 'user':
      return `re-picked: ${selectorText(selector)}`;
    case 'unresolved':
      return 'unresolved';
  }
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
    fillTemplate(recipe.url, recipe.vars, vars);
  } catch (error) {
    if (error instanceof MissingVariableError) {
      throw new CliError(`${error.message}; pass --var ${error.names[0]}=<value>`);
    }
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
  emitter.on('field.healed', (e) =>
    log(io, `healed ${e.target}: ${describeOutcome(e.outcome, e.newPrimary)} (was ${selectorText(e.oldPrimary)})`),
  );
  emitter.on('field.resolved', ({ field }) => {
    if ((field.status === 'ok' || field.status === 'healed') && field.missingRows.length === 0) return;
    log(io, `field ${field.name}: ${field.status}, ${describeOutcome(field.outcome, field.candidate)}`);
  });
  emitter.on('repick.requested', (e) => log(io, `waiting for a re-pick of ${e.target} (was ${selectorText(e.oldSelector)})`));
  emitter.on('recipe.saved', (e) => log(io, `recipe written to ${e.path}`));
}

async function e2ePort(io: CliIo): Promise<number | undefined> {
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

    const healing = healingFromFlags(opts);
    let openOptions: OpenOptions | undefined;
    let repick: RepickHandler | undefined;
    if (opts.interactive) {
      // Re-pick injects the recorder, which needs the page's CSP out of the way.
      const port = await e2ePort(io);
      const bundle = await io.recorderBundle(port !== undefined ? 'e2e' : 'default');
      openOptions = { bypassCSP: true, ...(port !== undefined ? { remoteDebuggingPort: port } : {}) };
      repick = interactiveRepick(io, { storage, bundle, vars, timeoutMs: opts.timeout });
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
      saveRecipe: (promoted) => storage.saveTo(storage.pathFor(recipeRef), promoted),
      ...(openOptions ? { openOptions } : {}),
      ...(repick ? { repick } : {}),
    });
    const result = await runner.run();
    await sink.finish(result.ok);

    for (const warning of result.report.warnings) log(io, `warning: ${warning}`);
    if (opts.report) io.stderr.write(`${JSON.stringify(result.report, null, 2)}\n`);
    if (!result.ok) {
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
    const browser = await io.createBrowser(config, io.env);
    // Only the first page: a later pagination change must not make `test` walk every page.
    const firstPage: Recipe = { ...recipe, pagination: { ...recipe.pagination, limit: 1 } };
    const runner = new Runner({
      recipe: firstPage,
      browser,
      profileDir,
      vars,
      timeoutMs: opts.timeout,
      emitter,
      signal: controller.signal,
      healing: { enabled: true, writeBack: false },
    });
    const result = await runner.run();
    const rows = testRows(result.report);
    io.stdout.write(opts.json ? `${JSON.stringify(rows, null, 2)}\n` : formatTable(rows));
    if (result.ok) {
      log(io, `every required field resolved (${result.report.rowCount} rows, ${result.report.healed} healed, nothing written)`);
      return ExitCode.Ok;
    }
    log(io, `test failed (${result.reason}): ${result.message}`);
    if (result.reason === 'missing-required') return ExitCode.Unresolved;
    return ExitCode.Error;
  } finally {
    offInterrupt();
    lock.release();
  }
}
