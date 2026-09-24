import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import type { RecipeInput } from '@webscoop/core';
import { startPlayground, type Playground } from '@webscoop/playground';
import { startGuardedRun, type GuardedRun } from './guard-fixture';
import { startRecording, type Recording } from './recorder-fixture';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const CLI = join(root, 'packages/cli/dist/webscoop.js');
export const REFERENCE_RECIPE = join(root, 'packages/cli/fixtures/playground-catalog.json');
export const PAGED_RECIPE = join(root, 'packages/cli/fixtures/playground-paged.json');
export const POSITIONAL_RECIPE = join(root, 'packages/cli/fixtures/playground-positional.json');
export const STEPS_RECIPE = join(root, 'packages/cli/fixtures/playground-steps.json');

export const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CliRun {
  child: ChildProcess;
  done: Promise<CliResult>;
  /** Stdout so far. */
  out(): string;
  /** Stderr so far. */
  err(): string;
}

export interface Scoop {
  playground: Playground;
  /** Isolated `WEBSCOOP_HOME`. */
  home: string;
  /** Path of the reference recipe written into the recipes directory. */
  recipePath: string;
  /** The reference recipe, pointed at this playground. */
  recipe: RecipeInput;
  /** Write a recipe variant into the recipes directory; returns its name. */
  writeRecipe(recipe: RecipeInput): Promise<string>;
  /** Start the built CLI as a child process. */
  spawn(args: string[], env?: Record<string, string | undefined>): CliRun;
  /** Run the built CLI to completion. */
  run(args: string[], env?: Record<string, string | undefined>): Promise<CliResult>;
  /** Start `webscoop record` and attach Playwright to its browser over CDP. */
  record(args: string[]): Promise<Recording>;
  /** Start `webscoop run --interactive` and attach once its re-pick panel shows up. */
  interactiveRun(args: string[]): Promise<Recording>;
  /** Start `webscoop run` with a DevTools port and attach to its browser, to clear guards as the user would. */
  guardedRun(args: string[], env?: Record<string, string | undefined>): Promise<GuardedRun>;
}

export function referenceRecipe(port: number, path = REFERENCE_RECIPE): RecipeInput {
  const recipe = JSON.parse(readFileSync(path, 'utf8')) as RecipeInput;
  recipe.vars = recipe.vars!.map((v) => (v.name === 'port' ? { ...v, default: String(port) } : v));
  return recipe;
}

export const test = base.extend<{ scoop: Scoop }>({
  // eslint-disable-next-line no-empty-pattern
  scoop: async ({}, use) => {
    const playground = await startPlayground({ port: 0 });
    const home = await mkdtemp(join(tmpdir(), 'webscoop-e2e-'));
    const recipesDir = join(home, 'recipes');
    await mkdir(recipesDir, { recursive: true });

    const writeRecipe = async (recipe: RecipeInput) => {
      await writeFile(join(recipesDir, `${recipe.name}.json`), `${JSON.stringify(recipe, null, 2)}\n`);
      return recipe.name;
    };
    const recipe = referenceRecipe(playground.port);
    await writeRecipe(recipe);

    const children = new Set<ChildProcess>();
    const spawnCli = (args: string[], env: Record<string, string | undefined> = {}): CliRun => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, WEBSCOOP_HOME: home, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      const done = new Promise<CliResult>((resolveDone) => {
        child.on('close', (code, signal) => {
          children.delete(child);
          resolveDone({ code, signal, stdout, stderr });
        });
      });
      return { child, done, out: () => stdout, err: () => stderr };
    };

    const cleanups: (() => Promise<void>)[] = [];
    const scoop: Scoop = {
      playground,
      home,
      recipePath: join(recipesDir, `${recipe.name}.json`),
      recipe,
      writeRecipe,
      spawn: spawnCli,
      run: (args, env) => spawnCli(args, env).done,
      record: (args) => startRecording(scoop, args, cleanups),
      interactiveRun: (args) => startRecording(scoop, args, cleanups, 'run'),
      guardedRun: (args, env) => startGuardedRun(scoop, args, cleanups, env),
    };
    await use(scoop);

    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const child of children) child.kill('SIGINT');
    await Promise.race([
      Promise.all([...children].map((c) => new Promise((r) => c.once('close', r)))),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    for (const child of children) child.kill('SIGKILL');
    await playground.stop();
    await rm(home, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
export type { Recording } from './recorder-fixture';
export type { GuardedRun } from './guard-fixture';
