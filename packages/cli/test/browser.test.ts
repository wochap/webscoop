import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { h, FakeBrowser } from '@webscoop/core/testing';
import { loadRecipe, saveRecipe, type RecipeInput } from '@webscoop/core';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { browserSettings, maskProxy, resolveBrowser, resolveHumanize, type BrowserChoice } from '../src/browser';
import { ConfigSchema, type Config } from '../src/config';
import { MARKER_FILE, profileDirFor, profileWarnings } from '../src/profiles';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/';
const config = (browser: Record<string, unknown> = {}): Config => ConfigSchema.parse({ browser });
const expectedPath = async (driver: string) => `/cache/${driver}/chrome`;

describe('resolveBrowser', () => {
  const none = () => null;

  it('keeps Playwright and its Chromium by default, unsuffixed', async () => {
    const choice = await resolveBrowser(config(), {}, { expectedPath, findBinary: none });
    expect(choice).toMatchObject({ driver: 'playwright', channel: 'chromium', id: '', path: '/cache/playwright/chrome', source: 'playwright' });
    expect(choice.executablePath).toBeUndefined();
  });

  it('defaults Patchright to Chrome, searched on the PATH in order', async () => {
    const looked: string[] = [];
    const findBinary = (name: string, env: Record<string, string | undefined>) => {
      looked.push(name);
      return name === 'google-chrome' ? `${env.PATH}/google-chrome` : null;
    };
    const choice = await resolveBrowser(config({ driver: 'patchright' }), { PATH: '/run/bin' }, { expectedPath, findBinary });
    expect(looked).toEqual(['google-chrome-stable', 'google-chrome']);
    expect(choice).toMatchObject({ driver: 'patchright', channel: 'chrome', id: 'chrome', path: '/run/bin/google-chrome', executablePath: '/run/bin/google-chrome' });
  });

  it('falls back to /opt/google/chrome/chrome, then reports the paths tried', async () => {
    const found = await resolveBrowser(config({ channel: 'chrome' }), {}, { expectedPath, findBinary: none, exists: (p) => p === '/opt/google/chrome/chrome' });
    expect(found.path).toBe('/opt/google/chrome/chrome');
    const missing = await resolveBrowser(config({ channel: 'chrome' }), {}, { expectedPath, findBinary: none, exists: () => false });
    expect(missing.path).toBe('');
    expect(missing.tried).toEqual(['google-chrome-stable on the PATH', 'google-chrome on the PATH', '/opt/google/chrome/chrome']);
  });

  it('passes Patchright its own Chromium with the patchright suffix', async () => {
    const choice = await resolveBrowser(config({ driver: 'patchright', channel: 'chromium' }), {}, { expectedPath, findBinary: none });
    expect(choice).toMatchObject({ id: 'patchright', path: '/cache/patchright/chrome', executablePath: '/cache/patchright/chrome' });
  });

  it('lets an override win without changing the suffix', async () => {
    const plain = await resolveBrowser(config(), { WEBSCOOP_CHROMIUM: '/nix/chromium' }, { expectedPath, findBinary: none });
    expect(plain).toMatchObject({ id: '', path: '/nix/chromium', source: 'override', executablePath: '/nix/chromium' });
    const chrome = await resolveBrowser(config({ channel: 'chrome', executablePath: '/my/chrome' }), {}, { expectedPath, findBinary: none });
    expect(chrome).toMatchObject({ id: 'chrome', path: '/my/chrome' });
  });

  it('flags a missing driver package', async () => {
    const choice = await resolveBrowser(config({ driver: 'patchright' }), {}, {
      expectedPath: async () => {
        throw new Error('Cannot find package');
      },
      findBinary: () => '/bin/google-chrome-stable',
    });
    expect(choice.driverMissing).toBe(true);
  });
});

describe('browserSettings', () => {
  const recipe = { browser: { proxy: { server: 'http://proxy-b:8080', bypass: ['localhost'] }, timezone: 'America/New_York', locale: 'en-US' } };

  it('takes the flag, then the recipe, then the config', () => {
    const c = config({ proxy: 'http://proxy-a:8080', timezone: 'Europe/Madrid', locale: 'es-ES' });
    expect(browserSettings(c, undefined, {}, {}).proxy).toEqual({ server: 'http://proxy-a:8080' });
    expect(browserSettings(c, recipe, {}, {})).toMatchObject({ proxy: { server: 'http://proxy-b:8080', bypass: 'localhost' }, timezone: 'America/New_York', locale: 'en-US' });
    expect(browserSettings(c, recipe, { proxy: 'socks5://127.0.0.1:1080' }, {}).proxy).toEqual({ server: 'socks5://127.0.0.1:1080' });
    expect(browserSettings(c, undefined, {}, {})).toMatchObject({ timezone: 'Europe/Madrid', locale: 'es-ES' });
  });

  it('drops every proxy with --no-proxy', () => {
    const settings = browserSettings(config({ proxy: 'http://proxy-a:8080' }), recipe, { proxy: false }, {});
    expect(settings.proxy).toBeUndefined();
    expect(settings.proxyShown).toBeUndefined();
  });

  it('takes credentials from the URL, else from the environment, and masks them', () => {
    const fromUrl = browserSettings(config({ proxy: { server: 'http://user:s%40cret@proxy-a:8080', bypass: ['a', 'b'] } }), undefined, {}, {});
    expect(fromUrl.proxy).toEqual({ server: 'http://proxy-a:8080', username: 'user', password: 's@cret', bypass: 'a,b' });
    expect(fromUrl.proxyShown).toBe('http://***@proxy-a:8080');
    const fromEnv = browserSettings(config(), recipe, {}, { WEBSCOOP_PROXY_USERNAME: 'u', WEBSCOOP_PROXY_PASSWORD: 'p' });
    expect(fromEnv.proxy).toMatchObject({ server: 'http://proxy-b:8080', username: 'u', password: 'p' });
    expect(fromEnv.proxyShown).toBe('http://***@proxy-b:8080');
  });

  it('masks user info in a proxy URL', () => {
    expect(maskProxy('http://u:p@127.0.0.1:3128')).toBe('http://***@127.0.0.1:3128');
    expect(maskProxy('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
  });

  it('rejects an invalid flag proxy', () => {
    expect(() => browserSettings(config(), undefined, { proxy: 'ftp://nope' }, {})).toThrow(/invalid proxy URL in --proxy/);
  });
});

describe('config browser block', () => {
  it('rejects an unknown timezone and locale, naming them', () => {
    const tz = ConfigSchema.safeParse({ browser: { timezone: 'Mars/Base' } });
    expect(tz.success).toBe(false);
    expect(tz.error?.issues[0]?.message).toContain('Mars/Base');
    expect(ConfigSchema.safeParse({ browser: { locale: 'not a locale' } }).success).toBe(false);
  });

  it('does not echo credentials of an invalid proxy', () => {
    const parsed = ConfigSchema.safeParse({ browser: { proxy: 'ftp://user:secret@host' } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues.map((i) => i.message))).not.toContain('secret');
  });
});

function shopRecipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 2, sequence: [{ extract: 'items' }],
    name: 'shop',
    url: PAGE,
    fields: [{ name: 'title', type: 'text', scope: 'page', selectors: [{ strategy: 'css', value: 'h1', stability: 'medium' }] }],
    ...overrides,
  };
}

async function home(opts: { config?: Record<string, unknown>; recipe?: RecipeInput } = {}) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  await writeFile(join(dir, 'recipes', 'shop.json'), saveRecipe(loadRecipe(opts.recipe ?? shopRecipe())));
  if (opts.config) await writeFile(join(dir, 'config.json'), JSON.stringify(opts.config));
  return dir;
}

const page = () => new FakeBrowser({ [PAGE]: h('html', {}, h('body', {}, h('h1', {}, 'Shop'))) });
const CHROME: Partial<BrowserChoice> = { driver: 'playwright', channel: 'chrome', id: 'chrome', path: '/usr/bin/google-chrome-stable', source: 'chrome' };

describe('resolveHumanize', () => {
  it('takes the flag, then the recipe, then the config, then off', () => {
    const on = { browser: { humanize: true } };
    const off = { browser: { humanize: false } };
    expect(resolveHumanize({}, undefined, config())).toBe(false);
    expect(resolveHumanize({}, undefined, config({ humanize: true }))).toBe(true);
    expect(resolveHumanize({}, off, config({ humanize: true }))).toBe(false);
    expect(resolveHumanize({}, on, config())).toBe(true);
    expect(resolveHumanize({ humanize: false }, on, config({ humanize: true }))).toBe(false);
    expect(resolveHumanize({ humanize: true }, off, config({ humanize: false }))).toBe(true);
  });
});

describe('humanize flags', () => {
  it('opens with humanized input and says so in the start line', async () => {
    const dir = await home();
    const browser = page();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--humanize'], t)).toBe(ExitCode.Ok);
    expect(browser.openOptions[0]).toEqual({ humanize: true, bypassCSP: true, downloadDir: '/home/test/Downloads/webscoop' });
    expect(t.err()).toContain('(no proxy, humanized input)');
    const plain = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: page() });
    expect(await main(['run', 'shop'], plain)).toBe(ExitCode.Ok);
    expect(plain.err()).not.toContain('humanized input');
  });

  it('lets --no-humanize override the recipe', async () => {
    const dir = await home({ recipe: shopRecipe({ browser: { humanize: true } }) });
    const browser = page();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--no-humanize'], t)).toBe(ExitCode.Ok);
    expect(browser.openOptions[0]).toEqual({ bypassCSP: true, downloadDir: '/home/test/Downloads/webscoop' });
    const test = page();
    expect(await main(['test', 'shop'], testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: test }))).toBe(ExitCode.Ok);
    expect(test.openOptions[0]).toMatchObject({ humanize: true });
  });

  it('rejects --humanize with --no-humanize', async () => {
    const dir = await home();
    for (const command of [['run', 'shop'], ['test', 'shop'], ['bench', 'shop']]) {
      const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
      expect(await main([...command, '--humanize', '--no-humanize'], t)).toBe(ExitCode.Error);
      expect(t.err()).toContain('--humanize cannot be used with option --no-humanize');
      expect(t.browserCreated()).toBe(0);
    }
  });

  it('is not accepted by record or edit', async () => {
    const dir = await home();
    for (const command of [['record', PAGE], ['edit', 'shop']]) {
      const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
      expect(await main([...command, '--humanize'], t)).toBe(ExitCode.Error);
      expect(t.err()).toContain("unknown option '--humanize'");
      expect(t.browserCreated()).toBe(0);
    }
  });
});

describe('run with browser settings', () => {
  it('opens with the resolved proxy, timezone, and locale, and never prints the password', async () => {
    const dir = await home({ config: { browser: { proxy: 'http://user:secret@proxy-a:8080', timezone: 'Europe/Madrid' } } });
    const browser = page();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Ok);
    expect(browser.openOptions[0]).toEqual({ proxy: { server: 'http://proxy-a:8080', username: 'user', password: 'secret' }, timezone: 'Europe/Madrid', bypassCSP: true, downloadDir: '/home/test/Downloads/webscoop' });
    expect(t.err()).toContain('(proxy http://***@proxy-a:8080)');
    expect(t.err()).not.toContain('secret');
  });

  it('names the flag proxy masked in the start line, and says when none is used', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: page() });
    expect(await main(['run', 'shop', '--proxy', 'http://u:p@127.0.0.1:3128'], t)).toBe(ExitCode.Ok);
    expect(t.err()).toContain('http://***@127.0.0.1:3128');
    const plain = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: page() });
    expect(await main(['run', 'shop'], plain)).toBe(ExitCode.Ok);
    expect(plain.err()).toContain('(no proxy)');
  });

  it('rejects --proxy with --no-proxy', async () => {
    const dir = await home();
    for (const command of [['run', 'shop'], ['test', 'shop'], ['record', PAGE], ['edit', 'shop'], ['bench', 'shop']]) {
      const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
      expect(await main([...command, '--proxy', 'http://127.0.0.1:3128', '--no-proxy'], t)).toBe(ExitCode.Error);
      expect(t.err()).toContain('--proxy <url> cannot be used with option --no-proxy');
      expect(t.browserCreated()).toBe(0);
    }
  });

  it('exits 1 before launch on an invalid proxy, timezone, or locale', async () => {
    const bad = await home({ config: { browser: { timezone: 'Mars/Base' } } });
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: bad } });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain('Mars/Base');
    const dir = await home({ recipe: shopRecipe() });
    const flag = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['run', 'shop', '--proxy', 'not a url'], flag)).toBe(ExitCode.Error);
    expect(flag.err()).toContain('invalid proxy URL');
    expect(flag.browserCreated()).toBe(0);
  });

  it('exits 1 naming the channel and paths when Chrome is missing', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, chromium: { ...CHROME, path: '', installed: false, tried: ['google-chrome-stable on the PATH', '/opt/google/chrome/chrome'] } });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain('no browser binary found for channel chrome; tried google-chrome-stable on the PATH, /opt/google/chrome/chrome');
    expect(t.browserCreated()).toBe(0);
  });

  it('exits 1 naming the package when Patchright is missing', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, chromium: { ...CHROME, driver: 'patchright', driverMissing: true } });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain('the patchright package is not installed');
  });
});

describe('profiles per browser', () => {
  it('keeps the unsuffixed directory by default and writes the marker after launch', async () => {
    const dir = await home();
    const browser = page();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Ok);
    expect(browser.openedProfiles).toEqual([join(dir, 'profiles', 'shop')]);
    const marker = JSON.parse(await readFile(join(dir, 'profiles', 'shop', MARKER_FILE), 'utf8'));
    expect(marker).toMatchObject({ driver: 'playwright', channel: 'chromium', executablePath: '/opt/chromium/chrome', version: 'Chromium 1' });
    expect(t.err()).not.toContain('warning: profile');
  });

  it('gives Chrome its own profile and warns that it has no cookies', async () => {
    const dir = await home();
    await mkdir(join(dir, 'profiles', 'shop'), { recursive: true });
    const browser = page();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser, chromium: CHROME });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Ok);
    expect(browser.openedProfiles).toEqual([join(dir, 'profiles', 'shop@chrome')]);
    expect(t.err()).toContain(`has no cookies or logins from ${join(dir, 'profiles', 'shop')}`);
    expect(existsSync(join(dir, 'profiles', 'shop@chrome', MARKER_FILE))).toBe(true);
    const again = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: page(), chromium: CHROME });
    expect(await main(['run', 'shop'], again)).toBe(ExitCode.Ok);
    expect(again.err()).not.toContain('no cookies');
  });

  it('mutes profile warnings on run --quiet but not on test', async () => {
    const dir = await home();
    await mkdir(join(dir, 'profiles', 'shop'), { recursive: true });
    const quiet = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: page(), chromium: CHROME });
    expect(await main(['run', 'shop', '--quiet'], quiet)).toBe(ExitCode.Ok);
    expect(quiet.err()).toBe('');
    await rm(join(dir, 'profiles', 'shop@chrome'), { recursive: true, force: true });
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: page(), chromium: CHROME });
    await main(['test', 'shop'], t);
    expect(t.err()).toContain('no cookies');
  });

  it('warns when the marker names another binary or a newer version', async () => {
    const dir = await tempDir();
    const paths = { profilesDir: dir };
    const choice = { driver: 'playwright', channel: 'chromium', id: '', path: '/new/chromium', source: 'override' } as const;
    await mkdir(profileDirFor(paths, 'shop', choice), { recursive: true });
    const marker = (m: object) => writeFile(join(dir, 'shop', MARKER_FILE), JSON.stringify({ driver: 'playwright', channel: 'chromium', updatedAt: '', ...m }));
    await marker({ executablePath: '/old/chromium', version: 'Chromium 140.0' });
    expect(await profileWarnings(paths, 'shop', choice, 'Chromium 140.0')).toEqual([`warning: profile ${join(dir, 'shop')} was last opened with /old/chromium, now /new/chromium`]);
    await marker({ executablePath: '/new/chromium', version: 'Chromium 141.0' });
    expect((await profileWarnings(paths, 'shop', choice, 'Chromium 140.0'))[0]).toContain('newer than Chromium 140.0');
    expect(await profileWarnings(paths, 'shop', choice, 'Chromium 141.0')).toEqual([]);
  });

  it('names suffixed directories per browser', () => {
    const paths = { profilesDir: '/p' };
    expect(profileDirFor(paths, 'shop', { id: '' })).toBe('/p/shop');
    expect(profileDirFor(paths, 'shop', { id: 'chrome' })).toBe('/p/shop@chrome');
    expect(profileDirFor(paths, 'shop', { id: 'patchright' })).toBe('/p/shop@patchright');
  });
});

describe('doctor browser lines', () => {
  const line = (out: string, key: string) => out.split('\n').find((l) => l.startsWith(`${key} `)) ?? '';

  it('reports the driver, channel, binary, masked proxy, timezone, locale, and profiles', async () => {
    const dir = await home({ config: { browser: { proxy: 'http://user:secret@proxy-a:8080', timezone: 'Europe/Madrid', locale: 'es-ES' } } });
    for (const [name, m] of [['shop', { driver: 'playwright', channel: 'chromium', version: 'Chromium 147.0' }], ['shop@chrome', { driver: 'patchright', channel: 'chrome', version: 'Google Chrome 148.0' }]] as const) {
      await mkdir(join(dir, 'profiles', name), { recursive: true });
      await writeFile(join(dir, 'profiles', name, MARKER_FILE), JSON.stringify({ ...m, executablePath: '/x', updatedAt: '' }));
    }
    await mkdir(join(dir, 'profiles', 'old'), { recursive: true });
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['doctor'], t)).toBe(ExitCode.Ok);
    const out = t.out();
    expect(line(out, 'driver')).toMatch(/playwright$/);
    expect(line(out, 'channel')).toMatch(/chromium$/);
    expect(line(out, 'chromium')).toContain('/opt/chromium/chrome (playwright build, Chromium 1)');
    expect(line(out, 'proxy')).toMatch(/http:\/\/\*\*\*@proxy-a:8080$/);
    expect(out).not.toContain('secret');
    expect(line(out, 'timezone')).toMatch(/Europe\/Madrid$/);
    expect(line(out, 'locale')).toMatch(/es-ES$/);
    expect(line(out, 'profile shop')).toContain('playwright, chromium, Chromium 147.0');
    expect(line(out, 'profile shop@chrome')).toContain('patchright, chrome, Google Chrome 148.0');
    expect(line(out, 'profile old')).toContain('unknown');
  });

  it('exits 1 when Patchright is configured and missing', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, chromium: { ...CHROME, driver: 'patchright', driverMissing: true } });
    expect(await main(['doctor'], t)).toBe(ExitCode.Error);
    expect(line(t.out(), 'driver')).toContain('patchright (missing');
  });

  it('exits 1 when the Chrome binary is missing', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, chromium: { ...CHROME, path: '', installed: false, tried: ['/opt/google/chrome/chrome'] } });
    expect(await main(['doctor'], t)).toBe(ExitCode.Error);
    expect(line(t.out(), 'chromium')).toContain('missing: no chrome binary found; tried /opt/google/chrome/chrome');
  });
});

describe('unusable binary', () => {
  it('exits 1 when the chosen binary does not run', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, chromium: { ...CHROME, installed: false, error: 'not found' } });
    expect(await main(['run', 'shop'], t)).toBe(ExitCode.Error);
    expect(t.err()).toContain('the chrome binary /usr/bin/google-chrome-stable cannot run: not found');
  });
});
