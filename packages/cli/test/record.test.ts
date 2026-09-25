import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { annotate, descendantsOf, detach, loadRecipe, pathOf, saveRecipe, selectionOf, type AnnotatedNode } from '@webscoop/core';
import { FakeBrowser, type FakeInteractiveSession } from '@webscoop/core/testing';
import { dataset, render } from '@webscoop/playground';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { checkTemplate, proposeName } from '../src/commands/record';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'http://127.0.0.1:4777/catalog?tier=0';

function tier0() {
  const { window } = new JSDOM(render(dataset, { tier: 0, seed: 1 }));
  type El = { type: 'element'; tag: string; attrs: Record<string, string>; children: unknown[] };
  const walk = (node: Node): El | { type: 'text'; text: string } | null => {
    if (node.nodeType === 3) return { type: 'text', text: node.textContent ?? '' };
    if (node.nodeType !== 1) return null;
    const el = node as Element;
    return {
      type: 'element',
      tag: el.tagName.toLowerCase(),
      attrs: Object.fromEntries(Array.from(el.attributes).map((a) => [a.name, a.value])),
      children: Array.from(el.childNodes).map(walk).filter(Boolean),
    };
  };
  return walk(window.document.documentElement) as never;
}

async function until<T>(check: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function sessionOf(browser: FakeBrowser): Promise<FakeInteractiveSession> {
  return until(() => {
    const s = browser.sessions[0];
    return s && s.exposed.size > 0 && browser.visited.length > 0 ? s : undefined;
  });
}

describe('webscoop record', () => {
  it('documents its options and keys', async () => {
    const io = testIo({});
    expect(await main(['record', '--help'], io)).toBe(ExitCode.Ok);
    for (const text of ['--name <recipe>', '--var <name=value>', '--profile <name>', '--timeout <ms>', '--edit <recipe>', 'Ctrl+S saves']) {
      expect(io.out()).toContain(text);
    }
  });

  it('proposes a name from the host and first path segment', () => {
    expect(proposeName('http://127.0.0.1:4777/catalog?cat=shoes')).toBe('127-0-0-1-catalog');
    expect(proposeName('https://www.Shop.test/C/Electronics/page/2')).toBe('shop-test-c');
    expect(proposeName('https://shop.test/')).toBe('shop-test');
    expect(proposeName('nonsense')).toBe('recipe');
  });

  it('rejects an invalid template with exit 1 before opening a browser', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['record', 'http://host/{'], io)).toBe(ExitCode.Error);
    expect(io.err()).toMatch(/invalid URL template "http:\/\/host\/\{": unmatched "\{"/);
    expect(io.browserCreated()).toBe(0);
    expect(() => checkTemplate('ftp://x/{a}')).toThrow(/http and https/);
    expect(() => checkTemplate('/relative')).toThrow(/absolute/);
  });

  it('prompts for variables without a value, unless given with --var', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { WEBSCOOP_HOME: dir }, answers: ['shoes'] });
    // No display: fails after the prompt, before any browser code.
    expect(await main(['record', 'http://127.0.0.1:4777/catalog?cat={category}'], io)).toBe(ExitCode.Error);
    expect(io.prompts()).toEqual(['value for {category}: ']);
    expect(io.err()).toContain('a display is required');
    const given = testIo({ env: { WEBSCOOP_HOME: dir } });
    await main(['record', 'http://127.0.0.1:4777/catalog?cat={category}', '--var', 'category=shoes'], given);
    expect(given.prompts()).toEqual([]);
    const closed = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, answers: [null] });
    expect(await main(['record', 'http://127.0.0.1:4777/catalog?cat={category}'], closed)).toBe(ExitCode.Error);
    expect(closed.err()).toContain('missing value for variable category; pass --var category=<value>');
  });

  it('records on a fake page, saves, and exits 0 when the window closes', async () => {
    const dir = await tempDir();
    const browser = new FakeBrowser({ [PAGE]: tier0() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['record', 'http://127.0.0.1:4777/catalog?tier={tier}', '--var', 'tier=0'], io);
    const session = await sessionOf(browser);
    expect(browser.openOptions[0]).toEqual({ bypassCSP: true });
    expect(session.injected).toEqual(['/* recorder default */']);

    const page = annotate(tier0());
    const title = descendantsOf(page).find((n: AnnotatedNode) => n.attrs.class === 'product-title')!;
    await session.callHost({ kind: 'session.ready', url: PAGE });
    await session.callHost({ kind: 'picker.select', url: PAGE, selection: selectionOf(title), snapshot: detach(page) });
    await session.callHost({ kind: 'draft.confirmItems', level: 'proposed' });
    await session.callHost({ kind: 'draft.updateField', index: 0, patch: { name: 'title' } });
    const saved = (await session.callHost({ kind: 'save.request' })) as { ok: boolean };
    expect(saved.ok).toBe(true);
    await session.userClose();
    expect(await run).toBe(ExitCode.Ok);

    const file = join(dir, 'recipes', '127-0-0-1-catalog.json');
    const recipe = loadRecipe(await readFile(file, 'utf8'));
    expect(recipe.fields.map((f) => f.name)).toEqual(['title']);
    expect(recipe.item!.selectors.slice(0, 2).map((c) => c.value)).toEqual(['article', 'product-card']);
    expect(recipe.item!.within![0]).toEqual({ strategy: 'role', value: 'list', stability: 'stable' });
    expect(io.err()).toContain(`saved 127-0-0-1-catalog to ${file}`);
    expect(io.err()).toContain('found 24 repeating items');
    expect(io.err()).toContain(`session ended; saved recipe "127-0-0-1-catalog" at ${file}`);
    expect(pathOf(title).length).toBeGreaterThan(0);
  });

  it('warns about unsaved changes and still exits 0', async () => {
    const dir = await tempDir();
    const browser = new FakeBrowser({ [PAGE]: tier0() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['record', PAGE, '--name', 'shop'], io);
    const session = await sessionOf(browser);
    await session.callHost({ kind: 'draft.setName', name: 'shop-two' });
    await session.userClose();
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).toContain('warning: recipe "shop-two" has unsaved changes; the draft was not saved');
  });

  it('ends cleanly on Ctrl+C and releases the profile lock', async () => {
    const dir = await tempDir();
    const browser = new FakeBrowser({ [PAGE]: tier0() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['record', PAGE, '--name', 'shop'], io);
    await sessionOf(browser);
    io.interrupt();
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).toContain('interrupted, closing the browser');
    expect(browser.openSessions).toBe(0);
    await expect(readFile(join(dir, 'profiles', 'shop', '.webscoop.lock'))).rejects.toThrow();
  });

  it('opens an existing recipe with --edit and exits 1 for an invalid one', async () => {
    const dir = await tempDir();
    const reference = loadRecipe(await readFile(new URL('../fixtures/playground-catalog.json', import.meta.url), 'utf8'));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'recipes'), { recursive: true });
    await writeFile(join(dir, 'recipes', 'playground-catalog.json'), saveRecipe(reference));
    await writeFile(join(dir, 'recipes', 'broken.json'), '{"schemaVersion":1,"name":"broken"}');
    const browser = new FakeBrowser({ [PAGE]: tier0() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['record', '--edit', 'playground-catalog'], io);
    const session = await Promise.race([sessionOf(browser), run.then((code) => Promise.reject(new Error(`exited ${code}: ${io.err()}`)))]);
    expect(browser.visited).toEqual([PAGE]);
    const reply = (await session.callHost({ kind: 'session.ready', url: PAGE })) as { state: { draft: { fields: unknown[] } } };
    expect(reply.state.draft.fields).toHaveLength(6);
    await session.userClose();
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).toContain('recording playground-catalog (edit)');

    const bad = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['record', '--edit', 'broken'], bad)).toBe(ExitCode.Error);
    expect(bad.err()).toContain('invalid recipe');
  });

  it('passes the CDP port and uses the e2e bundle under WEBSCOOP_E2E_CDP_PORT', async () => {
    const dir = await tempDir();
    const browser = new FakeBrowser({ [PAGE]: tier0() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, WEBSCOOP_E2E_CDP_PORT: '9333' }, browser });
    const run = main(['record', PAGE, '--name', 'shop'], io);
    const session = await sessionOf(browser);
    expect(browser.openOptions[0]).toEqual({ bypassCSP: true, remoteDebuggingPort: 9333 });
    expect(session.injected).toEqual(['/* recorder e2e */']);
    await session.userClose();
    expect(await run).toBe(ExitCode.Ok);
  });
});
