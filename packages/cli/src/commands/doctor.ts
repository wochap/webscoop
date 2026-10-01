import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeResult } from '@webscoop/llm';
import { HOOK_EVENTS, hookCommands, loadConfig, type Config } from '../config';
import { browserSettings } from '../browser';
import { log, type BrowserInfo, type CliIo } from '../context';
import { detectDisplay } from '../display';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';
import { canProbe, createLlm, llmSettings, type Probeable } from '../llm';
import { resolvePaths, type Env, type Paths } from '../paths';
import { hostOf, listProfiles, profileSourceLabel, resolveProfile } from '../profiles';
import { FsStorage } from '../storage';

/** Below this context window the model prompt budget gets too small to be useful. */
export const MIN_CONTEXT_TOKENS = 8192;

export interface DoctorOptions {
  /** Check the endpoint; the adapter's own probe by default. Injectable for tests. */
  probe?: (llm: Probeable) => Promise<ProbeResult>;
}

/** Doctor lines for the hooks: one per configured event with its number of commands. */
export function hookLines(config: Config): [string, string][] {
  const lines: [string, string][] = [];
  for (const event of HOOK_EVENTS) {
    const count = hookCommands(config, event).length;
    if (count > 0) lines.push([`hook ${event}`, `${count} command${count === 1 ? '' : 's'}`]);
  }
  return lines.length > 0 ? lines : [['hooks', 'none configured']];
}

/** Doctor lines for the browser setup; `ok` is false when the configured driver or binary is missing. */
export function browserLines(config: Config, env: Env, browser: BrowserInfo): { ok: boolean; lines: [string, string][] } {
  const lines: [string, string][] = [];
  let ok = true;
  if (browser.driver === 'patchright') {
    if (browser.driverMissing) ok = false;
    lines.push(['driver', browser.driverMissing ? 'patchright (missing: the patchright package is not installed; run: npm install patchright)' : 'patchright (installed)']);
  } else {
    lines.push(['driver', 'playwright']);
  }
  lines.push(['channel', browser.channel]);
  const where = { playwright: 'playwright build', patchright: 'patchright build', override: 'override', chrome: 'system chrome' }[browser.source];
  const hint = browser.source === 'playwright' ? '; run: npx playwright install chromium' : browser.source === 'patchright' ? '; run: npx patchright install chromium' : '';
  if (!browser.path) {
    ok = false;
    lines.push(['chromium', `missing: no ${browser.channel} binary found; tried ${(browser.tried ?? []).join(', ')}`]);
  } else if (!browser.installed) {
    ok = false;
    lines.push(['chromium', `missing: ${browser.path} (${where}${browser.error ? `: ${browser.error}` : ''})${hint}`]);
  } else {
    lines.push(['chromium', `${browser.path} (${where}${browser.version ? `, ${browser.version}` : ''})`]);
  }
  let proxy: string;
  try {
    proxy = browserSettings(config, undefined, {}, env).proxyShown ?? 'none';
  } catch (error) {
    ok = false;
    proxy = `invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  lines.push(['proxy', proxy]);
  lines.push(['timezone', config.browser.timezone ?? 'system default']);
  lines.push(['locale', config.browser.locale ?? 'system default']);
  return { ok, lines };
}

/**
 * Doctor lines for profile resolution: the default, each rule, and the profile
 * each recipe in the recipes directory resolves to without `--profile`. An
 * invalid recipe is reported and does not change the exit code.
 */
export async function profileLines(config: Config, paths: Pick<Paths, 'recipesDir'>, cwd: string): Promise<[string, string][]> {
  const lines: [string, string][] = [];
  if (config.profiles.default !== undefined) lines.push(['profiles.default', config.profiles.default]);
  config.profiles.rules.forEach((rule, i) => {
    const patterns = [rule.host !== undefined ? `host /${rule.host}/` : '', rule.name !== undefined ? `name /${rule.name}/` : ''].filter(Boolean).join(' and ');
    lines.push([`profile rule ${i + 1}`, `${patterns} -> ${rule.profile}`]);
  });
  let files: string[];
  try {
    files = (await readdir(paths.recipesDir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return lines;
  }
  const storage = new FsStorage(paths.recipesDir, cwd);
  for (const file of files) {
    const path = join(paths.recipesDir, file);
    try {
      const recipe = await storage.load(path);
      const host = hostOf(recipe.url, {}, recipe.vars);
      const resolved = resolveProfile({ recipePin: recipe.browser?.profile, name: recipe.name, host, config });
      const note = host === undefined && resolved.source !== 'recipe' ? '; host needs variables' : '';
      lines.push([`recipe ${recipe.name}`, `profile ${resolved.profile} (${profileSourceLabel(resolved.source)}${note})`]);
    } catch {
      lines.push([`recipe ${file.replace(/\.json$/, '')}`, 'invalid']);
    }
  }
  return lines;
}

/** Doctor lines for a probe result. Every problem is a warning; none changes the exit code. */
export function probeLines(endpoint: string, model: string, probe: ProbeResult): [string, string][] {
  if (!probe.reachable) return [['llm probe', `warning: ${endpoint} is unreachable${probe.error ? ` (${probe.error})` : ''}`]];
  if (!probe.modelFound) {
    const available = probe.models.length > 0 ? `; available: ${probe.models.join(', ')}` : '';
    return [['llm probe', `warning: model ${model} is not listed by ${endpoint}${available}${probe.error ? ` (${probe.error})` : ''}`]];
  }
  if (probe.latencyMs === null) return [['llm probe', `warning: model ${model} found, but a one-token completion failed${probe.error ? ` (${probe.error})` : ''}`]];
  return [['llm probe', `reachable, model ${model} found, ${probe.latencyMs} ms round trip`]];
}

export async function doctorCommand(io: CliIo, opts: DoctorOptions = {}): Promise<Code> {
  const paths = resolvePaths(io.env, io.homedir);
  const lines: [string, string][] = [];
  let ok = true;

  let config: Config | undefined;
  try {
    config = await loadConfig(paths, (message) => log(io, message));
    lines.push(['config', `${paths.configFile} (${existsSync(paths.configFile) ? 'found' : 'not found, using defaults'})`]);
  } catch (error) {
    ok = false;
    lines.push(['config', `${paths.configFile} (invalid: ${error instanceof CliError ? error.message : String(error)})`]);
  }
  lines.push(['paths from', paths.source]);
  lines.push(['recipes', paths.recipesDir]);
  lines.push(['profiles', paths.profilesDir]);

  const display = detectDisplay(io.env);
  if (!display.available) ok = false;
  lines.push(['display', display.available ? display.description : `missing: ${display.description}`]);

  if (config) {
    const browser = await io.chromium(config, io.env);
    const browserCheck = browserLines(config, io.env, browser);
    if (!browserCheck.ok) ok = false;
    lines.push(...browserCheck.lines);
    for (const { name, marker } of await listProfiles(paths)) {
      lines.push([`profile ${name}`, marker ? `${marker.driver}, ${marker.channel}, ${marker.version ?? 'version unknown'} (${marker.executablePath})` : 'unknown (no marker)']);
    }
    lines.push(...(await profileLines(config, paths, io.cwd)));
    lines.push(...hookLines(config));
    const llm = llmSettings(config, io.env, io.cwd);
    lines.push(['llm', llm.endpoint ? `${llm.endpoint}${llm.model ? ` (model ${llm.model})` : ' (warning: no model configured, the model rung is off)'}` : 'not configured']);
    if (llm.endpoint && llm.model) {
      const adapter = createLlm(config, io.env, io.cwd);
      if (canProbe(adapter)) {
        const probe = await (opts.probe ?? ((a: Probeable) => a.probe()))(adapter);
        lines.push(...probeLines(llm.endpoint, llm.model, probe));
      } else {
        lines.push(['llm probe', 'skipped (WEBSCOOP_LLM_MOCK is set)']);
      }
      const context = adapter.contextTokens;
      lines.push([
        'llm context',
        context < MIN_CONTEXT_TOKENS
          ? `warning: ${context} tokens is below ${MIN_CONTEXT_TOKENS}; prompts will list few candidates`
          : `${context} tokens (prompts use at most ${Math.floor(context * 0.4)})`,
      ]);
    }
  }

  const width = Math.max(...lines.map(([k]) => k.length));
  io.stdout.write(`${lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n')}\n`);
  return ok ? ExitCode.Ok : ExitCode.Error;
}
