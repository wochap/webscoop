import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fillTemplate, PROFILE_NAME, type BrowserPort, type OpenOptions, type Session } from '@webscoop/core';
import { launchProblem, type BrowserChoice, type BrowserId } from './browser';
import { profileRules, type Config } from './config';
import { log, type BrowserInfo, type CliIo } from './context';
import { CliError } from './exit';
import type { Paths } from './paths';

export { PROFILE_NAME };

/** Where a resolved profile name came from; `rule` is 1-based. */
export type ProfileSource = 'flag' | 'recipe' | { rule: number } | 'default' | 'name';

export interface ResolvedProfile {
  profile: string;
  source: ProfileSource;
}

/**
 * The profile a browser command uses: `--profile`, the recipe's
 * `browser.profile`, the first matching config rule, `profiles.default`, then
 * the recipe name. An undefined host makes `host` rules not match.
 */
export function resolveProfile(input: { flag?: string; recipePin?: string; name: string; host?: string; config: Config }): ResolvedProfile {
  if (input.flag !== undefined) return { profile: input.flag, source: 'flag' };
  if (input.recipePin !== undefined) return { profile: input.recipePin, source: 'recipe' };
  const rules = profileRules(input.config);
  for (const [i, rule] of rules.entries()) {
    if (rule.host && (input.host === undefined || !rule.host.test(input.host))) continue;
    if (rule.name && !rule.name.test(input.name)) continue;
    return { profile: rule.profile, source: { rule: i + 1 } };
  }
  const fallback = input.config.profiles?.default;
  if (fallback !== undefined) return { profile: fallback, source: 'default' };
  return { profile: input.name, source: 'name' };
}

/** The source as the start lines and doctor print it. */
export function profileSourceLabel(source: ProfileSource): string {
  if (typeof source === 'object') return `config rule ${source.rule}`;
  return { flag: 'flag', recipe: 'recipe', default: 'config default', name: 'recipe name' }[source];
}

/** `on profile "x" (source)`, for start lines. */
export function profileNote(resolved: ResolvedProfile): string {
  return `on profile "${resolved.profile}" (${profileSourceLabel(resolved.source)})`;
}

/** Host name of a URL template filled with `values` and the defaults of `vars`; undefined when a variable is missing or the URL is invalid. */
export function hostOf(urlTemplate: string, values: Readonly<Record<string, string>> = {}, vars: Parameters<typeof fillTemplate>[1] = []): string | undefined {
  try {
    return new URL(fillTemplate(urlTemplate, vars, values)).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Reject a profile name that is not a plain directory name. */
export function checkProfileName(profile: string): void {
  if (!PROFILE_NAME.test(profile)) throw new CliError(`invalid profile name "${profile}"`);
}

/** Marker file naming the browser that last opened a profile. */
export const MARKER_FILE = '.webscoop-browser.json';

export interface ProfileMarker {
  driver: string;
  channel: string;
  executablePath: string;
  version?: string;
  updatedAt: string;
}

/** Directory of a profile for a browser: `name` for Playwright's Chromium, else `name@id`. */
export function profileDirFor(paths: Pick<Paths, 'profilesDir'>, name: string, browser: { id: BrowserId }): string {
  return join(paths.profilesDir, browser.id === '' ? name : `${name}@${browser.id}`);
}

export async function readMarker(dir: string): Promise<ProfileMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MARKER_FILE), 'utf8')) as ProfileMarker;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeMarker(dir: string, browser: BrowserChoice, version: string | undefined, now = new Date()): Promise<void> {
  const marker: ProfileMarker = {
    driver: browser.driver,
    channel: browser.channel,
    executablePath: browser.path,
    ...(version ? { version } : {}),
    updatedAt: now.toISOString(),
  };
  await writeFile(join(dir, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
}

/** Leading major version in a `--version` line, e.g. 147 for `Google Chrome 147.0.1.2`. */
export function majorVersion(version: string | undefined): number | null {
  const match = version?.match(/(\d+)\.\d+/);
  return match ? Number(match[1]) : null;
}

/**
 * Warnings before a profile opens: a new suffixed profile beside an existing
 * unsuffixed one, and a marker naming another binary or a newer browser.
 * Call before the directory is created.
 */
export async function profileWarnings(paths: Pick<Paths, 'profilesDir'>, name: string, browser: BrowserChoice, version: string | undefined): Promise<string[]> {
  const dir = profileDirFor(paths, name, browser);
  const warnings: string[] = [];
  if (browser.id !== '' && !existsSync(dir)) {
    const plain = join(paths.profilesDir, name);
    if (existsSync(plain)) {
      warnings.push(
        `warning: profile ${dir} is new for ${browser.channel === 'chrome' ? 'Chrome' : 'Patchright'} and has no cookies or logins from ${plain}; a login wall may pause the run`,
      );
    }
    return warnings;
  }
  const marker = await readMarker(dir);
  if (!marker) return warnings;
  if (marker.executablePath && browser.path && marker.executablePath !== browser.path) {
    warnings.push(`warning: profile ${dir} was last opened with ${marker.executablePath}, now ${browser.path}`);
  } else {
    const before = majorVersion(marker.version);
    const now = majorVersion(version);
    if (before !== null && now !== null && before > now) {
      warnings.push(`warning: profile ${dir} was last opened with ${marker.version}, newer than ${version} launching now`);
    }
  }
  return warnings;
}

/** A browser port that writes the profile marker after each successful launch. */
export function markingBrowser(port: BrowserPort, browser: BrowserChoice, version: string | undefined): BrowserPort {
  return {
    async open(profileDir: string, opts?: OpenOptions): Promise<Session> {
      const session = await port.open(profileDir, opts);
      await writeMarker(profileDir, browser, version).catch(() => {});
      return session;
    },
  };
}

/** Every profile directory with its marker, for `doctor`. */
export async function listProfiles(paths: Pick<Paths, 'profilesDir'>): Promise<{ name: string; marker: ProfileMarker | null }[]> {
  let entries: string[];
  try {
    entries = (await readdir(paths.profilesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  entries.sort();
  return Promise.all(entries.map(async (name) => ({ name, marker: await readMarker(join(paths.profilesDir, name)) })));
}

/** The browser and profile directory a command launches, checked and warned about before anything starts. */
export interface PreparedProfile {
  browser: BrowserInfo;
  profileDir: string;
  /** The adapter for this browser, writing the marker on each launch. */
  createBrowser(): Promise<BrowserPort>;
}

/**
 * Resolve the browser, stop on a missing driver or binary, print the profile
 * warnings, and create the profile directory. Exit 1 happens here, before any
 * browser starts.
 */
export async function prepareProfile(io: CliIo, config: Config, paths: Pick<Paths, 'profilesDir'>, name: string, warn: (message: string) => void = (message) => log(io, message)): Promise<PreparedProfile> {
  const browser = await io.chromium(config, io.env);
  const problem = launchProblem(browser);
  if (problem) throw new CliError(problem);
  for (const warning of await profileWarnings(paths, name, browser, browser.version)) warn(warning);
  const profileDir = profileDirFor(paths, name, browser);
  await mkdir(profileDir, { recursive: true });
  return {
    browser,
    profileDir,
    createBrowser: async () => markingBrowser(await io.createBrowser(config, io.env, browser), browser, browser.version),
  };
}
