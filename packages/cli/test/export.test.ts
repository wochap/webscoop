import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { tempDir, testIo } from './helpers';

const CATALOG = fileURLToPath(new URL('../fixtures/playground-catalog.json', import.meta.url));

/** A `WEBSCOOP_HOME` holding the reference catalog recipe; no display variables anywhere. */
async function home() {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  await copyFile(CATALOG, join(dir, 'recipes', 'playground-catalog.json'));
  return dir;
}

describe('webscoop export', () => {
  it('prints a TypeScript script to stdout without a display or a browser', async () => {
    const dir = await home();
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['export', 'playground-catalog'], io)).toBe(ExitCode.Ok);
    const script = io.out();
    expect(script.split('\n')[0]).toBe('// Standalone Playwright script exported from the webscoop recipe "playground-catalog".');
    expect(script).toContain("from 'playwright';");
    expect(script).toContain('const DEFAULT_HEADLESS = false;');
    expect(io.err()).toBe('');
    expect(io.browserCreated()).toBe(0);
  });

  it('writes Python to --out, creating directories, with nothing on stdout', async () => {
    const dir = await home();
    const io = testIo({ env: { WEBSCOOP_HOME: dir }, cwd: dir });
    expect(await main(['export', 'playground-catalog', '--format', 'py', '--out', 'out/nested/scrape.py', '--headless'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toBe('');
    const path = join(dir, 'out/nested/scrape.py');
    expect((await stat(path)).isFile()).toBe(true);
    const script = await readFile(path, 'utf8');
    expect(script.startsWith('# Standalone Playwright script exported from the webscoop recipe "playground-catalog".\n')).toBe(true);
    expect(script).toContain('DEFAULT_HEADLESS = True');
    expect(io.err()).toMatch(/exported playground-catalog as Python to .*scrape\.py/);
  });

  it('loads a recipe by path', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { WEBSCOOP_HOME: dir }, cwd: dir });
    expect(await main(['export', CATALOG], io)).toBe(ExitCode.Ok);
    expect(io.out()).toContain('const RECIPE_NAME = "playground-catalog";');
  });

  it('exits 1 naming the flag for an unknown format', async () => {
    const dir = await home();
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['export', 'playground-catalog', '--format', 'rb'], io)).toBe(ExitCode.Error);
    expect(io.err()).toMatch(/invalid --format "rb", expected one of ts, py/);
    expect(io.out()).toBe('');
  });

  it('exits 1 with the validation errors for an invalid recipe', async () => {
    const dir = await home();
    await writeFile(join(dir, 'recipes', 'broken.json'), JSON.stringify({ schemaVersion: 1, name: 'broken', url: 'https://x.test/{q}', fields: [] }));
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    expect(await main(['export', 'broken'], io)).toBe(ExitCode.Error);
    expect(io.err()).toMatch(/a recipe needs at least one field/);
    expect(io.err()).toMatch(/template variable "q" is not declared/);
    expect(io.out()).toBe('');
  });

  it('is documented in the README with both invocations and the limits', async () => {
    const readme = await readFile(fileURLToPath(new URL('../../../README.md', import.meta.url)), 'utf8');
    const section = readme.slice(readme.indexOf('### Export'), readme.indexOf('### Exit codes'));
    for (const text of ['npx tsx', 'python3', 'pip install playwright', '--profile', 'fingerprint healing', 'model healing', 'recipe write-back']) {
      expect(section).toContain(text);
    }
  });

  it('lists its flags in --help', async () => {
    const io = testIo({});
    expect(await main(['export', '--help'], io)).toBe(ExitCode.Ok);
    for (const flag of ['--format <ts|py>', '--out <path>', '--headless']) expect(io.out()).toContain(flag);
  });
});
