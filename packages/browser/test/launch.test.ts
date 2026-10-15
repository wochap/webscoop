import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_ARGS, DriverMissingError, IGNORED_DEFAULT_ARGS, launchOptions, loadDriver, PlaywrightBrowser, STEALTH_ARGS, writePdfPreference, type Driver } from '../src';

/** A driver module whose `launchPersistentContext` records its arguments and returns a one-page context. */
function fakeDriver() {
  const calls: { dir: string; options: Record<string, unknown> }[] = [];
  const page = { on() {} };
  const context = { setDefaultTimeout() {}, pages: () => [page], close: async () => {} };
  const module = {
    chromium: {
      launchPersistentContext: async (dir: string, options: Record<string, unknown>) => {
        calls.push({ dir, options });
        return context;
      },
    },
  };
  return { calls, load: async (_driver: Driver) => module as never };
}

describe('launchOptions', () => {
  it('keeps the automation flags for the playwright driver', () => {
    const options = launchOptions({}, { remoteDebuggingPort: 9222, args: ['--class=webscoop'] });
    expect(options).toMatchObject({ headless: false, viewport: null, handleSIGINT: false, ignoreDefaultArgs: IGNORED_DEFAULT_ARGS });
    expect(options.args).toEqual([...STEALTH_ARGS, ...BACKGROUND_ARGS, '--remote-debugging-port=9222', '--class=webscoop']);
  });

  it('leaves the flags to Patchright', () => {
    const options = launchOptions({ driver: 'patchright', executablePath: '/bin/chrome' }, { args: ['--class=webscoop'] });
    expect(options).not.toHaveProperty('ignoreDefaultArgs');
    expect(options.args).toEqual([...BACKGROUND_ARGS, '--class=webscoop']);
    expect(options.executablePath).toBe('/bin/chrome');
    expect(options).toMatchObject({ headless: false, viewport: null });
  });

  it('keeps background tabs and hidden windows from being throttled, under both drivers', () => {
    for (const driver of ['playwright', 'patchright'] as const) {
      const args = launchOptions({ driver }, {}).args ?? [];
      for (const flag of ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) expect(args).toContain(flag);
    }
  });

  it('maps the proxy, timezone, and locale', () => {
    const proxy = { server: 'http://127.0.0.1:3128', username: 'u', password: 'p', bypass: 'localhost' };
    const options = launchOptions({}, { proxy, timezone: 'America/New_York', locale: 'en-US' });
    expect(options).toMatchObject({ proxy, timezoneId: 'America/New_York', locale: 'en-US' });
  });

  it('sets nothing for absent network settings', () => {
    const options = launchOptions({}, {});
    for (const key of ['proxy', 'timezoneId', 'locale', 'executablePath', 'bypassCSP']) expect(options).not.toHaveProperty(key);
  });
});

describe('PlaywrightBrowser driver loading', () => {
  it('launches through the configured driver module', async () => {
    const driver = fakeDriver();
    let loaded: Driver | undefined;
    const browser = new PlaywrightBrowser({ driver: 'patchright', load: (d) => ((loaded = d), driver.load(d)) });
    await browser.open('/tmp/profile', { timezone: 'Europe/Madrid' });
    expect(loaded).toBe('patchright');
    expect(driver.calls[0]!.dir).toBe('/tmp/profile');
    expect(driver.calls[0]!.options).toMatchObject({ timezoneId: 'Europe/Madrid' });
    expect(driver.calls[0]!.options).not.toHaveProperty('ignoreDefaultArgs');
  });

  it('defaults to the playwright driver', async () => {
    const driver = fakeDriver();
    let loaded: Driver | undefined;
    await new PlaywrightBrowser({ load: (d) => ((loaded = d), driver.load(d)) }).open('/tmp/profile');
    expect(loaded).toBe('playwright');
    expect(driver.calls[0]!.options.ignoreDefaultArgs).toEqual(IGNORED_DEFAULT_ARGS);
  });

  it('loads both real drivers', async () => {
    expect(typeof (await loadDriver('playwright')).chromium.launchPersistentContext).toBe('function');
    expect(typeof (await loadDriver('patchright')).chromium.launchPersistentContext).toBe('function');
  });

  it('names the package in DriverMissingError', () => {
    expect(new DriverMissingError('patchright').message).toBe('the patchright package is not installed');
  });
});

describe('writePdfPreference', () => {
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webscoop-pdfpref-'));
    return { dir, file: join(dir, 'Default', 'Preferences') };
  };
  const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

  it('creates the file on a fresh profile with only the key', async () => {
    const { dir, file } = await setup();
    await writePdfPreference(dir, 'download');
    expect(await read(file)).toEqual({ plugins: { always_open_pdf_externally: true } });
  });

  it('keeps the other keys of an existing file', async () => {
    const { dir, file } = await setup();
    await mkdir(join(dir, 'Default'));
    await writeFile(file, JSON.stringify({ homepage: 'x', plugins: { other: 1 } }));
    await writePdfPreference(dir, 'download');
    expect(await read(file)).toEqual({ homepage: 'x', plugins: { other: 1, always_open_pdf_externally: true } });
  });

  it('flips true to false for view', async () => {
    const { dir, file } = await setup();
    await writePdfPreference(dir, 'download');
    await writePdfPreference(dir, 'view');
    expect(await read(file)).toEqual({ plugins: { always_open_pdf_externally: false } });
  });

  it('leaves a corrupt file untouched and warns naming it', async () => {
    const { dir, file } = await setup();
    await mkdir(join(dir, 'Default'));
    await writeFile(file, '{not json');
    const warnings: string[] = [];
    await writePdfPreference(dir, 'download', (m) => warnings.push(m));
    expect(await readFile(file, 'utf8')).toBe('{not json');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(file);
  });

  it('writes the preference before launching, defaulting to download', async () => {
    const { dir, file } = await setup();
    const fake = fakeDriver();
    await new PlaywrightBrowser({ load: fake.load }).open(dir);
    expect(await read(file)).toEqual({ plugins: { always_open_pdf_externally: true } });
    await new PlaywrightBrowser({ load: fake.load }).open(dir, { pdf: 'view' });
    expect(await read(file)).toEqual({ plugins: { always_open_pdf_externally: false } });
  });
});
