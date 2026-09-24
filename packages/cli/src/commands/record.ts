import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  draftFromRecipe,
  emptyDraft,
  fillTemplate,
  isInteractiveSession,
  RecorderController,
  RecorderEmitter,
  templateVariables,
  type Recipe,
  type RecorderMode,
  type Session,
  type StoragePort,
} from '@webscoop/core';
import { loadConfig } from '../config';
import { log, type CliIo } from '../context';
import { requireDisplay } from '../display';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';
import { acquireProfileLock } from '../lock';
import { resolvePaths } from '../paths';
import { FsStorage } from '../storage';
import { parseVars } from './run';

export interface RecordCommandOptions {
  name?: string;
  var: string[];
  profile?: string;
  timeout: number;
  lockTimeout: number;
  edit?: string;
  /** With `--edit`: re-pick only this field, then save and end. */
  repick?: string;
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Reject templates with stray braces or that do not produce an http(s) URL. */
export function checkTemplate(template: string): void {
  // A digit is valid wherever a variable may sit: host, port, path, or query.
  const stripped = template.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '1');
  const brace = stripped.search(/[{}]/);
  if (brace !== -1) {
    throw new CliError(`invalid URL template "${template}": unmatched "${stripped[brace]}" (variables look like {name})`);
  }
  let url: URL;
  try {
    url = new URL(stripped);
  } catch {
    throw new CliError(`invalid URL template "${template}": not an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`invalid URL template "${template}": only http and https pages can be recorded`);
  }
}

/** `<host>-<first path segment>`, slugified: `http://shop.test/catalog?x=1` becomes `shop-test-catalog`. */
export function proposeName(url: string): string {
  let host = '';
  let segment = '';
  try {
    const parsed = new URL(url);
    host = parsed.hostname.replace(/^www\./, '');
    segment = parsed.pathname.split('/').find(Boolean) ?? '';
  } catch {
    // Fall through to the generic name.
  }
  const slug = `${host}-${segment}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'recipe';
}

/** Values for every template variable: `--var` first, then the recipe default, then a terminal prompt. */
async function resolveValues(io: CliIo, template: string, given: Record<string, string>, recipe: Recipe | undefined): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const name of templateVariables(template)) {
    const known = given[name] ?? recipe?.vars.find((v) => v.name === name)?.default;
    if (known !== undefined) {
      values[name] = known;
      continue;
    }
    const answer = await io.prompt(`value for {${name}}: `);
    if (answer === null || answer.trim() === '') throw new CliError(`missing value for variable ${name}; pass --var ${name}=<value>`);
    values[name] = answer.trim();
  }
  return values;
}

function logEvents(io: CliIo, emitter: RecorderEmitter): void {
  emitter.on('recorder.ready', (e) => log(io, `recorder ready on ${e.url}`));
  emitter.on('recorder.selected', (e) => log(io, `selected <${e.tag}>: ${e.candidates.length} selector candidates, scope ${e.scope}`));
  emitter.on('recorder.itemsProposed', (e) => log(io, `found ${e.count ?? '?'} repeating items (${e.container})`));
  emitter.on('recorder.itemsConfirmed', (e) => log(io, `item container set: ${e.selector} (${e.count ?? '?'} items)`));
  emitter.on('recorder.excluded', (e) => log(io, `excluded ${e.selector}: ${e.count ?? '?'} items left`));
  emitter.on('recorder.fieldAdded', (e) => log(io, `added field ${e.name} (${e.type}, ${e.scope}, ${e.count ?? '?'} matches)`));
  emitter.on('recorder.fieldRemoved', (e) => log(io, `removed field ${e.name}`));
  emitter.on('recorder.paginationSet', (e) => log(io, `pagination: ${e.kind}`));
  emitter.on('recorder.testRun', (e) => log(io, e.error ? `test run failed: ${e.error}` : `test run: ${e.rows} rows in ${e.durationMs} ms`));
  emitter.on('recorder.saved', (e) => log(io, `saved ${e.name}${e.path ? ` to ${e.path}` : ''}`));
  emitter.on('recorder.error', (e) => log(io, `error: ${e.message}`));
}

export async function recordCommand(io: CliIo, template: string | undefined, opts: RecordCommandOptions): Promise<Code> {
  const paths = resolvePaths(io.env, io.homedir);
  const config = await loadConfig(paths);
  const storage = new FsStorage(paths.recipesDir, io.cwd);

  let recipe: Recipe | undefined;
  if (opts.repick !== undefined && !opts.edit) throw new CliError('--repick needs --edit <recipe>');
  if (opts.edit) {
    if (template) throw new CliError('pass either a URL template or --edit <recipe>, not both');
    recipe = await storage.load(opts.edit);
    template = recipe.url;
  }
  let mode: RecorderMode = { kind: 'full' };
  if (opts.repick !== undefined && recipe) {
    const fieldIndex = recipe.fields.findIndex((f) => f.name === opts.repick);
    if (fieldIndex === -1) {
      throw new CliError(`recipe "${recipe.name}" has no field named "${opts.repick}" (fields: ${recipe.fields.map((f) => f.name).join(', ')})`);
    }
    mode = { kind: 'repick', fieldIndex, reason: 'cli' };
  }
  if (!template) throw new CliError('a URL template is required (or --edit <recipe>)');
  checkTemplate(template);
  if (opts.name !== undefined && !KEBAB.test(opts.name)) throw new CliError(`invalid recipe name "${opts.name}": recipe names must be kebab-case`);

  const values = await resolveValues(io, template, parseVars(opts.var), recipe);
  const url = fillTemplate(template, [], values);
  const name = opts.name ?? recipe?.name ?? proposeName(url);

  requireDisplay(io.env);

  const profile = opts.profile ?? name;
  if (!PROFILE_NAME.test(profile)) throw new CliError(`invalid profile name "${profile}"`);
  const profileDir = join(paths.profilesDir, profile);
  await mkdir(profileDir, { recursive: true });
  const lock = await acquireProfileLock(profileDir, { timeoutMs: opts.lockTimeout, profileName: profile });

  const cdpPort = io.env.WEBSCOOP_E2E_CDP_PORT?.trim();
  const e2e = Boolean(cdpPort);
  if (e2e && !/^\d+$/.test(cdpPort!)) throw new CliError(`invalid WEBSCOOP_E2E_CDP_PORT "${cdpPort}"`);

  let stopInterrupt: () => void = () => {};
  const interrupt = new Promise<'interrupted'>((resolve) => {
    stopInterrupt = io.onInterrupt(() => {
      log(io, 'interrupted, closing the browser');
      resolve('interrupted');
    });
  });

  let session: Session | undefined;
  try {
    const bundle = await io.recorderBundle(e2e ? 'e2e' : 'default');
    const browser = await io.createBrowser(config, io.env);
    session = await browser.open(profileDir, { bypassCSP: true, ...(e2e ? { remoteDebuggingPort: Number(cdpPort) } : {}) });
    if (!isInteractiveSession(session)) throw new CliError('this browser adapter cannot run a recording session');

    const draft = recipe
      ? draftFromRecipe(recipe, values)
      : emptyDraft({ name, url: template, vars: templateVariables(template).map((v) => ({ name: v, value: values[v]! })) });
    const emitter = new RecorderEmitter();
    logEvents(io, emitter);
    // A re-pick writes the recipe back where it was loaded from, even when that is a path.
    const target = mode.kind === 'repick' ? storage.pathFor(opts.edit!) : null;
    const saveTo: StoragePort = target ? { list: () => storage.list(), load: (ref) => storage.load(ref), save: async (r) => void (await storage.saveTo(target, r)) } : storage;
    const controller = new RecorderController({
      session,
      storage: saveTo,
      bundle,
      draft,
      emitter,
      timeoutMs: opts.timeout,
      pathFor: (n) => target ?? storage.pathFor(n),
      mode,
    });

    if (mode.kind === 'repick') log(io, `re-picking ${opts.repick} of ${recipe!.name} on profile "${profile}": ${url}`);
    else log(io, `recording ${recipe ? `${recipe.name} (edit)` : name} on profile "${profile}": ${url}`);
    const closed = controller.closed().then(() => 'closed' as const);
    // The user may close the window while the first page is still settling; that ends the session, it is not an error.
    const started = controller.start().then(
      () => 'started' as const,
      async (error: unknown) => {
        const gone = await Promise.race([closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 250))]);
        if (gone) return 'closed' as const;
        throw error;
      },
    );
    const first = await Promise.race([started, closed, interrupt]);
    if (first === 'started' && mode.kind === 'repick') {
      log(io, `click the new location of ${opts.repick}, then "Use and save" (S skips, Esc aborts)`);
      const outcome = await Promise.race([controller.awaitRepick(), interrupt]);
      controller.dispose();
      if (outcome !== 'interrupted' && outcome.kind === 'picked') {
        const saved = controller.state.saved;
        log(io, `saved the new location of ${opts.repick}${saved?.path ? ` to ${saved.path}` : ''}`);
      } else {
        log(io, `re-pick ${outcome === 'interrupted' ? 'interrupted' : outcome.kind === 'skip' ? 'skipped' : 'aborted'}; the recipe is unchanged`);
      }
      return ExitCode.Ok;
    }
    if (first === 'started') {
      log(io, 'close the browser window or press Ctrl+C to end the session');
      await Promise.race([closed, interrupt]);
    } else if (first === 'interrupted') {
      await session.close().catch(() => {});
      await started.catch(() => {});
    }
    controller.dispose();

    const final = controller.draft;
    if (final.dirty) {
      log(io, `warning: recipe "${final.name}" has unsaved changes; the draft was not saved`);
    } else if (controller.state.saved) {
      log(io, `session ended; saved recipe "${controller.state.saved.name}"${controller.state.saved.path ? ` at ${controller.state.saved.path}` : ''}`);
    } else {
      log(io, 'session ended with nothing to save');
    }
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`recording failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    stopInterrupt();
    await session?.close().catch(() => {});
    lock.release();
  }
}
