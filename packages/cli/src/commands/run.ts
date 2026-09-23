import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fillTemplate, MissingVariableError, RunEmitter, Runner, type Row, type RunReport } from '@webscoop/core';
import { loadConfig } from '../config';
import { log, type CliIo } from '../context';
import { requireDisplay } from '../display';
import { CliError, ExitCode, exitCodeFor, type ExitCode as Code } from '../exit';
import { acquireProfileLock } from '../lock';
import { resolvePaths } from '../paths';
import { FsStorage } from '../storage';

export interface RunCommandOptions {
  var: string[];
  jsonl?: boolean;
  out?: string;
  profile?: string;
  timeout: number;
  lockTimeout: number;
  report?: boolean;
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

function summary(report: RunReport): string {
  const seconds = (report.durationMs / 1000).toFixed(2);
  const pages = `${report.pageCount} page${report.pageCount === 1 ? '' : 's'}`;
  return `${report.rowCount} row${report.rowCount === 1 ? '' : 's'} from ${pages} in ${seconds}s (${report.recipe})`;
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

export async function runCommand(io: CliIo, recipeRef: string, opts: RunCommandOptions): Promise<Code> {
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

  const controller = new AbortController();
  const offInterrupt = io.onInterrupt(() => {
    log(io, 'interrupted, closing the browser');
    controller.abort();
  });
  const sink = new RowSink(io, { jsonl: opts.jsonl ?? false, out: opts.out ? resolve(io.cwd, opts.out) : undefined });

  try {
    const emitter = new RunEmitter();
    emitter.on('run.start', (e) => log(io, `running ${e.recipe} on profile "${profile}": ${e.url}`));
    emitter.on('page.loaded', (e) => log(io, `page ${e.page} loaded: ${e.url} (HTTP ${e.status ?? '?'})`));
    emitter.on('field.resolved', ({ field }) => {
      if (field.status === 'ok' && field.candidateIndex === 0) return;
      const used = field.candidate ? `${field.candidate.strategy}=${field.candidate.value}` : 'none';
      log(io, `field ${field.name}: ${field.status}, candidate ${field.candidateIndex ?? '-'} (${used})`);
    });
    emitter.on('row.emitted', (e) => sink.row(e.row));

    const browser = await io.createBrowser(config, io.env);
    const runner = new Runner({
      recipe,
      browser,
      profileDir,
      vars,
      timeoutMs: opts.timeout,
      emitter,
      signal: controller.signal,
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
