import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { RunEmitter, Runner, templateVariables, type HealOutcome, type Recipe } from '@webscoop/core';
import { loadConfig } from '../config';
import { log, type CliIo } from '../context';
import { requireDisplay } from '../display';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';
import { acquireProfileLock } from '../lock';
import { resolvePaths } from '../paths';
import { FsStorage } from '../storage';
import { modelRung, testRows } from './run';

export interface BenchCommandOptions {
  tiers: string;
  seed: number;
  json?: boolean;
  profile?: string;
  timeout: number;
  lockTimeout: number;
  /** False with `--no-llm`. */
  llm?: boolean;
}

export const MAX_BENCH_TIER = 4;

/** Tiers from `0-4`, `3`, or `0,2-3`, ascending and without duplicates. */
export function parseTiers(spec: string): number[] {
  const tiers = new Set<number>();
  for (const part of spec.split(',').map((p) => p.trim())) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new CliError(`invalid --tiers "${spec}", expected a range such as 0-4`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from > to || to > MAX_BENCH_TIER) throw new CliError(`invalid --tiers "${spec}", tiers go from 0 to ${MAX_BENCH_TIER}`);
    for (let t = from; t <= to; t++) tiers.add(t);
  }
  return [...tiers].sort((a, b) => a - b);
}

/** The rung that resolved a target, as bench reports it. */
export type Rung = HealOutcome['kind'];

export interface BenchField {
  name: string;
  rung: Rung;
  status: string;
  /** The model's reason, when the model rung resolved the target. */
  rationale?: string;
  notes?: string[];
}

export interface BenchTier {
  tier: number;
  elapsedMs: number;
  ok: boolean;
  /** Why the run failed, when it did. */
  reason?: string;
  message?: string;
  fields: BenchField[];
}

/** One row per tier and target: the rung that resolved it, its status, and the tier's elapsed time. */
export function formatBench(results: readonly BenchTier[]): string {
  const header = ['TIER', 'FIELD', 'RUNG', 'STATUS', 'TIME'];
  const cells = results.flatMap((r) => {
    const time = `${(r.elapsedMs / 1000).toFixed(2)}s`;
    const rows = r.fields.map((f) => [String(r.tier), f.name, f.rung, f.status, time]);
    if (r.fields.length === 0) rows.push([String(r.tier), '-', '-', r.reason ?? 'error', time]);
    return rows;
  });
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]!))).join('  ');
  return `${[line(header), ...cells.map(line)].join('\n')}\n`;
}

type PlaygroundModule = typeof import('@webscoop/playground');

/** The playground ships with a development checkout only; load it on demand. */
async function loadPlayground(): Promise<PlaygroundModule> {
  try {
    return await import('@webscoop/playground');
  } catch (error) {
    throw new CliError(`bench needs the playground (@webscoop/playground), which only a development checkout has: ${(error as Error).message}`);
  }
}

/** Failure reasons that mean the recipe did not heal, as opposed to the run breaking. */
const HEAL_OUTCOMES = new Set(['missing-required']);

/**
 * Run a recipe against a playground it starts itself, once per tier, with
 * write-back off, and report which rung resolved every target. Exits 0
 * whatever healed, 1 when a run broke.
 */
export async function benchCommand(io: CliIo, recipeRef: string, opts: BenchCommandOptions): Promise<Code> {
  const tiers = parseTiers(opts.tiers);
  const paths = resolvePaths(io.env, io.homedir);
  const config = await loadConfig(paths);
  const storage = new FsStorage(paths.recipesDir, io.cwd);
  const recipe = await storage.load(recipeRef);
  const variables = templateVariables(recipe.url);
  if (!variables.includes('port')) throw new CliError(`recipe ${recipe.name} has no {port} variable in its URL, so bench cannot point it at the playground`);
  requireDisplay(io.env);
  const { startPlayground } = await loadPlayground();

  const profile = opts.profile ?? recipe.name;
  const profileDir = join(paths.profilesDir, profile);
  await mkdir(profileDir, { recursive: true });
  const lock = await acquireProfileLock(profileDir, { timeoutMs: opts.lockTimeout, profileName: profile });
  const controller = new AbortController();
  const offInterrupt = io.onInterrupt(() => {
    log(io, 'interrupted, closing the browser');
    controller.abort();
  });
  const playground = await startPlayground({ port: 0 });
  const results: BenchTier[] = [];
  let broken = false;
  try {
    const browser = await io.createBrowser(config, io.env);
    for (const tier of tiers) {
      if (controller.signal.aborted) break;
      playground.control.tier = tier;
      playground.control.seed = opts.seed;
      const vars: Record<string, string> = { port: String(playground.port) };
      if (variables.includes('tier')) vars.tier = String(tier);
      if (variables.includes('seed')) vars.seed = String(opts.seed);
      const firstPage: Recipe = { ...recipe, pagination: { ...recipe.pagination, limit: 1 } };
      log(io, `tier ${tier}: running ${recipe.name}`);
      const started = performance.now();
      const result = await new Runner({
        recipe: firstPage,
        browser,
        profileDir,
        vars,
        timeoutMs: opts.timeout,
        emitter: new RunEmitter(),
        signal: controller.signal,
        healing: { enabled: true, writeBack: false, resolvers: [modelRung(io, config, opts)] },
      }).run();
      const elapsedMs = Math.round(performance.now() - started);
      const fields: BenchField[] = testRows(result.report).map((row) => ({
        name: row.name,
        rung: row.outcome.kind,
        status: row.status,
        ...(row.outcome.kind === 'model' ? { rationale: row.outcome.rationale } : {}),
        ...(row.notes ? { notes: row.notes } : {}),
      }));
      const entry: BenchTier = { tier, elapsedMs, ok: result.ok, fields };
      if (!result.ok) {
        entry.reason = result.reason;
        entry.message = result.message;
        if (!HEAL_OUTCOMES.has(result.reason)) {
          broken = true;
          log(io, `tier ${tier}: run failed (${result.reason}): ${result.message}`);
        }
      }
      results.push(entry);
    }
  } finally {
    offInterrupt();
    await playground.stop();
    lock.release();
  }
  io.stdout.write(opts.json ? `${JSON.stringify(results, null, 2)}\n` : formatBench(results));
  return broken || controller.signal.aborted ? ExitCode.Error : ExitCode.Ok;
}
