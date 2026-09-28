import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserPort, OpenOptions, Session } from '@webscoop/core';
import { launchProblem, type BrowserChoice, type BrowserId } from './browser';
import type { Config } from './config';
import { log, type BrowserInfo, type CliIo } from './context';
import { CliError } from './exit';
import type { Paths } from './paths';

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
export async function prepareProfile(io: CliIo, config: Config, paths: Pick<Paths, 'profilesDir'>, name: string): Promise<PreparedProfile> {
  const browser = await io.chromium(config, io.env);
  const problem = launchProblem(browser);
  if (problem) throw new CliError(problem);
  for (const warning of await profileWarnings(paths, name, browser, browser.version)) log(io, warning);
  const profileDir = profileDirFor(paths, name, browser);
  await mkdir(profileDir, { recursive: true });
  return {
    browser,
    profileDir,
    createBrowser: async () => markingBrowser(await io.createBrowser(config, io.env, browser), browser, browser.version),
  };
}
