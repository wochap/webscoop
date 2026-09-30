import { resolve } from 'node:path';
import {
  draftFromRecipe,
  emptyDraft,
  fillTemplate,
  isInteractiveSession,
  RecorderController,
  RecorderEmitter,
  tablesOf,
  templateProblem,
  templateVariables,
  type Recipe,
  type RecorderMode,
  type Session,
  type StoragePort,
} from '@webscoop/core';
import { browserSettings, proxyNote, settingsOptions } from '../browser';
import { loadConfig, type Config } from '../config';
import { log, type CliIo } from '../context';
import { requireDisplay } from '../display';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';
import { HookRunner } from '../hooks';
import { acquireProfileLock } from '../lock';
import { resolvePaths } from '../paths';
import { checkProfileName, hostOf, prepareProfile, profileNote, resolveProfile } from '../profiles';
import { FsStorage } from '../storage';
import { BROWSER_PID_DEADLINE_MS, encodedValueWarnings, parseVars } from './run';

export interface RecordCommandOptions {
  /** `--proxy <url>`, or false for `--no-proxy`. */
  proxy?: string | false;
  name?: string;
  var: string[];
  profile?: string;
  timeout: number;
  lockTimeout: number;
  edit?: string;
  /** With `--edit`: re-pick only this field, then save and end. */
  repick?: string;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Reject templates with stray braces or that do not produce an http(s) URL. */
export function checkTemplate(template: string): void {
  const problem = templateProblem(template);
  if (problem) throw new CliError(problem);
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

/**
 * The field `--repick` names: `table.field`, or a bare field name that exactly
 * one table has. An unknown table or field, or a bare name several tables
 * share, is an error naming it.
 */
export function resolveRepick(recipe: Recipe, spec: string): { table: string; fieldIndex: number } {
  const tables = tablesOf(recipe);
  const dot = spec.indexOf('.');
  if (dot !== -1) {
    const tableName = spec.slice(0, dot);
    const fieldName = spec.slice(dot + 1);
    const table = tables.find((t) => t.name === tableName);
    if (!table) throw new CliError(`recipe "${recipe.name}" has no table named "${tableName}" (tables: ${tables.map((t) => t.name).join(', ')})`);
    const fieldIndex = table.fields.findIndex((f) => f.name === fieldName);
    if (fieldIndex === -1) {
      throw new CliError(`table "${tableName}" of recipe "${recipe.name}" has no field named "${fieldName}" (fields: ${table.fields.map((f) => f.name).join(', ')})`);
    }
    return { table: table.name, fieldIndex };
  }
  const found = tables.flatMap((t) => {
    const fieldIndex = t.fields.findIndex((f) => f.name === spec);
    return fieldIndex === -1 ? [] : [{ table: t.name, fieldIndex }];
  });
  if (found.length > 1) {
    throw new CliError(`field "${spec}" is in several tables of recipe "${recipe.name}" (${found.map((f) => f.table).join(', ')}); pass one of ${found.map((f) => `${f.table}.${spec}`).join(', ')}`);
  }
  if (found.length === 0) {
    const all = tables.length > 1 ? tables.flatMap((t) => t.fields.map((f) => `${t.name}.${f.name}`)) : tables[0]!.fields.map((f) => f.name);
    throw new CliError(`recipe "${recipe.name}" has no field named "${spec}" (fields: ${all.join(', ')})`);
  }
  return found[0]!;
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

/**
 * The recipe as saved by `record` and `edit`: pinned to the profile the session
 * used when the saved name and URL would resolve to another one without a pin,
 * unpinned otherwise, so a later run opens the same profile.
 */
export function pinProfile(recipe: Recipe, used: string, values: Readonly<Record<string, string>>, config: Config): Recipe {
  const unpinned = resolveProfile({ name: recipe.name, host: hostOf(recipe.url, values, recipe.vars), config });
  const { profile: _, ...rest } = recipe.browser ?? {};
  const browser = used === unpinned.profile ? rest : { ...rest, profile: used };
  const { browser: __, ...others } = recipe;
  return Object.keys(browser).length > 0 ? { ...others, browser } : (others as Recipe);
}

function logEvents(io: CliIo, emitter: RecorderEmitter): void {
  emitter.on('recorder.ready', (e) => log(io, `recorder ready on ${e.url}`));
  emitter.on('recorder.navigated', (e) => log(io, `navigated to ${e.url}`));
  emitter.on('recorder.selected', (e) => log(io, `selected <${e.tag}>: ${e.candidates.length} selector candidates, scope ${e.scope}`));
  emitter.on('recorder.itemsProposed', (e) =>
    log(io, `found ${e.count ?? '?'} repeating items (${e.container}${e.within ? ` in ${e.within}` : ''})${e.skipped > 0 ? `, ${e.skipped} skipped as dissimilar` : ''}`),
  );
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
  const config = await loadConfig(paths, (message) => log(io, message));
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
    const { table, fieldIndex } = resolveRepick(recipe, opts.repick);
    mode = { kind: 'repick', fieldIndex, reason: 'cli', table };
  }
  if (!template) throw new CliError('a URL template is required (or --edit <recipe>)');
  checkTemplate(template);
  if (opts.name !== undefined && !KEBAB.test(opts.name)) throw new CliError(`invalid recipe name "${opts.name}": recipe names must be kebab-case`);

  const values = await resolveValues(io, template, parseVars(opts.var), recipe);
  for (const warning of encodedValueWarnings(template, values)) log(io, warning);
  const url = fillTemplate(template, [], values);
  const name = opts.name ?? recipe?.name ?? proposeName(url);
  // A fresh recording has no recipe yet: only the flag and the config apply.
  const settings = browserSettings(config, recipe, opts, io.env);

  requireDisplay(io.env);

  const resolved = resolveProfile({ flag: opts.profile, recipePin: recipe?.browser?.profile, name, host: hostOf(url), config });
  const profile = resolved.profile;
  checkProfileName(profile);
  const { profileDir, createBrowser } = await prepareProfile(io, config, paths, profile);
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

  const hooks = new HookRunner(config, { command: opts.edit ? 'edit' : 'record', profile, profileDir, recipe: name, vars: values }, io);
  let session: Session | undefined;
  try {
    const bundle = await io.recorderBundle(e2e ? 'e2e' : 'default');
    const browser = await createBrowser();
    await hooks.fire('browser.starting');
    session = await browser.open(profileDir, { ...settingsOptions(settings), bypassCSP: true, ...(e2e ? { remoteDebuggingPort: Number(cdpPort) } : {}) });
    hooks.setPid((await io.findBrowserPid(resolve(profileDir), BROWSER_PID_DEADLINE_MS)) ?? undefined);
    void hooks.fire('browser.started');
    if (!isInteractiveSession(session)) throw new CliError('this browser adapter cannot run a recording session');

    const draft = recipe
      ? draftFromRecipe(recipe, values)
      : emptyDraft({ name, url: template, vars: templateVariables(template).map((v) => ({ name: v, value: values[v]! })) });
    const emitter = new RecorderEmitter();
    logEvents(io, emitter);
    // A re-pick writes the recipe back where it was loaded from, even when that is a path.
    const target = mode.kind === 'repick' ? storage.pathFor(opts.edit!) : null;
    const write = (r: Recipe) => (target ? storage.saveTo(target, r).then(() => {}) : storage.save(r));
    const saveTo: StoragePort = {
      list: () => storage.list(),
      load: (ref) => storage.load(ref),
      save: (r) => write(pinProfile(r, profile, values, config)),
    };
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

    if (mode.kind === 'repick') log(io, `re-picking ${opts.repick} of ${recipe!.name} ${profileNote(resolved)}: ${url}`);
    else log(io, `recording ${recipe ? `${recipe.name} (edit)` : name} ${profileNote(resolved)} (${proxyNote(settings)}): ${url}`);
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
    if (session) void hooks.fire('browser.closed');
    await hooks.drain();
  }
}
