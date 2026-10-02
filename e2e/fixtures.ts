import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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
export const TABLES_RECIPE = join(root, 'packages/cli/fixtures/playground-tables.json');
export const HOVER_RECIPE = join(root, 'packages/cli/fixtures/playground-hover.json');
export const FRAMED_RECIPE = join(root, 'packages/cli/fixtures/playground-framed.json');

export const hasDisplay = Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);

/** Driver the CLI runs under: `WEBSCOOP_E2E_DRIVER`, default `playwright`. Patchright uses Chrome. */
export const E2E_DRIVER = process.env.WEBSCOOP_E2E_DRIVER === 'patchright' ? 'patchright' : 'playwright';

/** System Chrome as the CLI finds it, or null. Pinned in the config so tests that trim the PATH still find it. */
export const CHROME =
  ['google-chrome-stable', 'google-chrome'].flatMap((name) => (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, name))).find((p) => existsSync(p)) ??
  (existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : null);

/** Profile directory of a profile name under the e2e driver. */
export function profileDir(home: string, name: string, driver: string = E2E_DRIVER): string {
  return join(home, 'profiles', driver === 'patchright' ? `${name}@chrome` : name);
}

/** The config every e2e home starts with; tests that write their own config pass their additions. */
export function e2eConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const browser = E2E_DRIVER === 'patchright' ? { driver: 'patchright', ...(CHROME ? { executablePath: CHROME } : {}) } : {};
  return { daemon: { idleMs: 0 }, ...extra, browser: { ...browser, ...(extra.browser as object | undefined) } };
}

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
  /** Start a plain `webscoop run` and attach once its guard banner shows up. */
  bannerRun(args: string[]): Promise<Recording>;
  /** Start `webscoop run` with a DevTools port and attach to its browser, to clear guards as the user would. */
  guardedRun(args: string[], env?: Record<string, string | undefined>): Promise<GuardedRun>;
}

export function referenceRecipe(port: number, path = REFERENCE_RECIPE): RecipeInput {
  const recipe = JSON.parse(readFileSync(path, 'utf8')) as RecipeInput;
  recipe.vars = recipe.vars!.map((v) => (v.name === 'port' ? { ...v, default: String(port) } : v));
  return recipe;
}

const formCss = (value: string) => ({ selectors: [{ strategy: 'css' as const, value, stability: 'medium' as const }] });
type FormStep = NonNullable<RecipeInput['flows']>[number]['steps'][number];
const fill = (selector: string, value: string): FormStep => ({ kind: 'fill', target: formCss(selector), value });

/** The forms page recipe: it fills every kind on the forms page from variables, submits, and extracts the echo. */
export function formsRecipe(port: number): RecipeInput {
  return {
    schemaVersion: 2,
    name: 'forms',
    url: `http://127.0.0.1:${port}/forms`,
    vars: [
      { name: 'user', type: 'string', default: 'Ada Lovelace' },
      { name: 'pass', type: 'string', secret: true },
      { name: 'city', type: 'string', default: 'Lima' },
      { name: 'code', type: 'string', default: '482913' },
      { name: 'resume', type: 'path' },
      { name: 'video', type: 'path' },
    ],
    flows: [
      {
        name: 'fill-form',
        steps: [
          fill('#text', '{user}'),
          fill('#email', 'ada@example.test'),
          fill('#password', '{pass}'),
          fill('#textarea', 'line one'),
          fill('#select', 'Peru'),
          fill('#multiselect', 'Spanish\nqu'),
          fill('#checkbox', 'true'),
          fill('#radio-pro', 'true'),
          fill('#switch', 'true'),
          fill('#date', '1815-12-10'),
          fill('#controlled', 'Ada'),
          fill('#combobox', '{city}'),
          fill('#otp-0', '{code}'),
          fill('#notes', 'some notes'),
          fill('#shadow', 'in the shadow'),
          fill('#file', '{resume}'),
          fill('#chooser-button', '{video}'),
          { kind: 'click', target: formCss('#submit') },
          { kind: 'wait', target: formCss('#echo') },
        ],
      },
    ],
    fields: [{ name: 'echo', type: 'text', scope: 'page', selectors: [{ strategy: 'css', value: '#echo', stability: 'medium' }] }],
    sequence: [{ flow: 'fill-form' }, { extract: 'items' }],
    // The password input would read as a login wall.
    guards: [{ kind: 'login', enabled: false }],
  } as RecipeInput;
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
    // Each home gets its own daemon (its socket is under WEBSCOOP_HOME); browsers close after their last job.
    await writeFile(join(home, 'config.json'), `${JSON.stringify(e2eConfig())}\n`);

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
      bannerRun: (args) => startRecording(scoop, args, cleanups, 'banner'),
      guardedRun: (args, env) => startGuardedRun(scoop, args, cleanups, env),
    };
    await use(scoop);

    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const child of children) child.kill('SIGINT');
    // The home's daemon: cancel what is left and close its browsers.
    await spawnCli(['daemon', 'stop', '--force']).done;
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
