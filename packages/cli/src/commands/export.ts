import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildPlan, renderPy, renderTs } from '@webscoop/core';
import { loadConfig } from '../config';
import { log, type CliIo } from '../context';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';
import { resolvePaths } from '../paths';
import { FsStorage } from '../storage';

export const EXPORT_FORMATS = ['ts', 'py'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportCommandOptions {
  /** `--format`: default `ts`. */
  format?: string;
  /** `--out`: write the script here instead of stdout. */
  out?: string;
  /** `--headless`: the script runs headless unless given `--headed`. */
  headless?: boolean;
}

/**
 * Write a standalone Playwright script for the recipe. Opens no browser and
 * needs no display or profile lock: it only reads the recipe.
 */
export async function exportCommand(io: CliIo, recipeRef: string, opts: ExportCommandOptions, version: string): Promise<Code> {
  const format = opts.format ?? 'ts';
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new CliError(`invalid --format "${format}", expected one of ${EXPORT_FORMATS.join(', ')}`);
  }
  const paths = resolvePaths(io.env, io.homedir);
  const recipe = await new FsStorage(paths.recipesDir, io.cwd).load(recipeRef);
  const render = format === 'py' ? renderPy : renderTs;
  // A configured download directory is kept; without one the script uses ~/Downloads/webscoop where it runs.
  const dir = (await loadConfig(paths)).downloads?.dir;
  const script = render(buildPlan(recipe), { version, now: new Date(), headless: opts.headless === true, ...(dir !== undefined ? { downloadDir: dir } : {}) });
  if (!opts.out) {
    io.stdout.write(script);
    return ExitCode.Ok;
  }
  const out = resolve(io.cwd, opts.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, script);
  log(io, `exported ${recipe.name} as ${format === 'py' ? 'Python' : 'TypeScript'} to ${out}`);
  return ExitCode.Ok;
}
