import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { isLocale, isTimezone, parseProxyUrl, PROXY_SCHEMES, type OpenOptions, type ProxySettings, type Recipe } from '@webscoop/core';
import type { Config } from './config';
import { chromiumOverride } from './context';
import { CliError } from './exit';
import type { Env } from './paths';
import { findOnPath, type FindBinary } from './window';

export type Driver = Config['browser']['driver'];
export type Channel = 'chromium' | 'chrome';
/** Profile directory suffix: `''` keeps today's unsuffixed directory. */
export type BrowserId = '' | 'chrome' | 'patchright';

/** Chrome binaries searched on the `PATH`, in order, before {@link CHROME_FALLBACK}. */
export const CHROME_NAMES = ['google-chrome-stable', 'google-chrome'];
export const CHROME_FALLBACK = '/opt/google/chrome/chrome';

/** The browser a command would launch: driver, channel, binary, and profile suffix. */
export interface BrowserChoice {
  driver: Driver;
  channel: Channel;
  id: BrowserId;
  /** The binary that runs; empty when none was found. */
  path: string;
  /** Where the binary came from. */
  source: 'playwright' | 'patchright' | 'override' | 'chrome';
  /** Binary passed to the driver; absent to let the driver pick its own build. */
  executablePath?: string;
  /** Paths looked at for the chrome channel, for the error when none exists. */
  tried?: string[];
  /** Set when the driver's package cannot be loaded. */
  driverMissing?: boolean;
}

export interface ResolveDeps {
  findBinary?: FindBinary;
  exists?: (path: string) => boolean;
  /** The Chromium build a driver expects; throws when the driver package is missing. */
  expectedPath: (driver: Driver) => Promise<string>;
}

/** Profile suffix for a driver and channel; binary overrides never change it. */
export function browserId(driver: Driver, channel: Channel): BrowserId {
  if (channel === 'chrome') return 'chrome';
  return driver === 'patchright' ? 'patchright' : '';
}

/** Pick the driver, channel, and binary from the config and environment, without running anything. */
export async function resolveBrowser(config: Config, env: Env, deps: ResolveDeps): Promise<BrowserChoice> {
  const driver = config.browser.driver;
  const channel: Channel = config.browser.channel ?? (driver === 'patchright' ? 'chrome' : 'chromium');
  const base = { driver, channel, id: browserId(driver, channel) };
  let driverMissing = false;
  let expected = '';
  try {
    expected = await deps.expectedPath(driver);
  } catch {
    driverMissing = true;
  }
  const missing = driverMissing ? { driverMissing: true } : {};
  const override = chromiumOverride(config, env);
  if (override) return { ...base, ...missing, path: override, source: 'override', executablePath: override };
  if (channel === 'chrome') {
    const findBinary = deps.findBinary ?? findOnPath;
    const exists = deps.exists ?? existsSync;
    const tried: string[] = [];
    for (const name of CHROME_NAMES) {
      const found = findBinary(name, env);
      if (found) return { ...base, ...missing, path: found, source: 'chrome', executablePath: found };
      tried.push(`${name} on the PATH`);
    }
    tried.push(CHROME_FALLBACK);
    if (exists(CHROME_FALLBACK)) return { ...base, ...missing, path: CHROME_FALLBACK, source: 'chrome', executablePath: CHROME_FALLBACK };
    return { ...base, ...missing, path: '', source: 'chrome', tried };
  }
  // Playwright's own Chromium is launched by default, as before; Patchright's is passed explicitly.
  if (driver === 'patchright') return { ...base, ...missing, path: expected, source: 'patchright', ...(expected ? { executablePath: expected } : {}) };
  return { ...base, ...missing, path: expected, source: 'playwright' };
}

/** Why a command cannot launch this browser, or null. Checked before any browser starts. */
export function launchProblem(choice: BrowserChoice & { installed: boolean; error?: string }): string | null {
  if (choice.driverMissing) return `the ${choice.driver} package is not installed (browser.driver is ${choice.driver}); run: npm install ${choice.driver}`;
  if (!choice.path) return `no browser binary found for channel ${choice.channel}; tried ${(choice.tried ?? []).join(', ')}`;
  // Playwright reports its own missing build, with the install command, as before.
  if (choice.source !== 'playwright' && !choice.installed) return `the ${choice.channel} binary ${choice.path} cannot run${choice.error ? `: ${choice.error}` : ''}`;
  return null;
}

const execFileAsync = promisify(execFile);
const versions = new Map<string, Promise<{ version?: string; error?: string }>>();

/** `<binary> --version`, run once per binary per process. */
export function probeVersion(path: string): Promise<{ version?: string; error?: string }> {
  let probe = versions.get(path);
  if (!probe) {
    probe = (async () => {
      if (!existsSync(path)) return { error: 'not found' };
      try {
        const { stdout } = await execFileAsync(path, ['--version'], { timeout: 15_000 });
        return { version: stdout.trim() };
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr?.trim().split('\n').pop();
        return { error: stderr || (error as Error).message };
      }
    })();
    versions.set(path, probe);
  }
  return probe;
}

/** A proxy URL with its user info replaced by `***`. */
export function maskProxy(url: string): string {
  const parsed = parseProxyUrl(url);
  if (!parsed || (!parsed.username && !parsed.password)) return url;
  return url.replace(/^([a-z0-9]+:\/\/)[^@/]*@/i, '$1***@');
}

/** Resolved network identity for one command. */
export interface BrowserSettings {
  proxy?: ProxySettings;
  /** The proxy as shown in logs: URL with credentials masked. */
  proxyShown?: string;
  timezone?: string;
  locale?: string;
}

export interface ProxyFlags {
  /** `--proxy <url>`, or false for `--no-proxy`. */
  proxy?: string | false;
}

function proxyFrom(value: string, bypass: string | undefined, credentialsFromUrl: boolean, env: Env, what: string): { proxy: ProxySettings; shown: string } {
  const url = parseProxyUrl(value);
  if (!url) throw new CliError(`invalid proxy URL in ${what}: expected ${PROXY_SCHEMES.join(', ')}://host:port`);
  let username = credentialsFromUrl && url.username ? decodeURIComponent(url.username) : undefined;
  let password = credentialsFromUrl && url.password ? decodeURIComponent(url.password) : undefined;
  if (username === undefined && password === undefined) {
    username = env.WEBSCOOP_PROXY_USERNAME || undefined;
    password = env.WEBSCOOP_PROXY_PASSWORD || undefined;
  }
  const server = `${url.protocol}//${url.host}`;
  const proxy: ProxySettings = {
    server,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(bypass ? { bypass } : {}),
  };
  return { proxy, shown: username !== undefined || password !== undefined ? `${url.protocol}//***@${url.host}` : server };
}

/**
 * Proxy, timezone, and locale for a command. Proxy: flag, then recipe, then
 * config; `--no-proxy` drops it. Timezone and locale: recipe, then config.
 * Throws a `CliError` on an invalid value, before any browser starts.
 */
export function browserSettings(config: Config, recipe: Pick<Recipe, 'browser'> | undefined, flags: ProxyFlags, env: Env): BrowserSettings {
  const settings: BrowserSettings = {};
  let resolved: { proxy: ProxySettings; shown: string } | undefined;
  if (typeof flags.proxy === 'string') resolved = proxyFrom(flags.proxy, undefined, true, env, '--proxy');
  else if (flags.proxy === false) resolved = undefined;
  else if (recipe?.browser?.proxy) resolved = proxyFrom(recipe.browser.proxy.server, recipe.browser.proxy.bypass?.join(','), false, env, 'the recipe');
  else if (config.browser.proxy) {
    const p = config.browser.proxy;
    const server = typeof p === 'string' ? p : p.server;
    const bypass = typeof p === 'string' ? undefined : Array.isArray(p.bypass) ? p.bypass.join(',') : p.bypass;
    resolved = proxyFrom(server, bypass, true, env, 'the config');
  }
  if (resolved) {
    settings.proxy = resolved.proxy;
    settings.proxyShown = resolved.shown;
  }
  const timezone = recipe?.browser?.timezone ?? config.browser.timezone;
  const locale = recipe?.browser?.locale ?? config.browser.locale;
  if (timezone !== undefined) {
    if (!isTimezone(timezone)) throw new CliError(`unknown timezone "${timezone}", expected an IANA identifier such as Europe/Madrid`);
    settings.timezone = timezone;
  }
  if (locale !== undefined) {
    if (!isLocale(locale)) throw new CliError(`invalid locale "${locale}", expected a BCP 47 tag such as es-ES`);
    settings.locale = locale;
  }
  return settings;
}

/** Open options carrying the settings. */
export function settingsOptions(settings: BrowserSettings): OpenOptions {
  return {
    ...(settings.proxy ? { proxy: settings.proxy } : {}),
    ...(settings.timezone ? { timezone: settings.timezone } : {}),
    ...(settings.locale ? { locale: settings.locale } : {}),
  };
}

/** How the start line names the proxy. */
export function proxyNote(settings: BrowserSettings): string {
  return settings.proxyShown ? `proxy ${settings.proxyShown}` : 'no proxy';
}
