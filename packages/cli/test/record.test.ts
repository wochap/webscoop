import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { annotate, descendantsOf, detach, loadRecipe, pathOf, saveRecipe, selectionOf, type AnnotatedNode } from '@webscoop/core';
import { FakeBrowser, type FakeInteractiveSession } from '@webscoop/core/testing';
import { dataset, render } from '@webscoop/playground';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { checkTemplate, pinProfile, proposeName } from '../src/commands/record';
import { ConfigSchema } from '../src/config';
import { encodedValueWarnings } from '../src/commands/run';
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
    for (const text of ['--name <recipe>', '--var <name=value>', '--profile <name>', '(default: resolved from recipe and', '--timeout <ms>', '--edit <recipe>', 'Ctrl+S saves']) {
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

  it('warns about encoded --var values used in the template, not about step-only ones', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { WEBSCOOP_HOME: dir } });
    // No display: the warning comes first, then the usual display error and exit code.
    expect(await main(['record', 'https://www.google.com/search?q={query}', '--var', 'query=top+llms'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('warning: --var query="top+llms" is URL-encoded, so "+" stays a literal plus; for a space pass "top llms"');
    expect(io.err()).toContain('a display is required');
    expect(encodedValueWarnings('https://shop.test/login', { login_email: 'a+b@acme.dev' })).toEqual([]);
    expect(encodedValueWarnings('https://x.test/{a}', { a: 'bad%zz' })).toEqual([]);
    expect(encodedValueWarnings('https://x.test/{a}', { a: '100%25%' })).toEqual(['warning: --var a="100%25%" is URL-encoded again ("%" becomes "%25")']);
    expect(encodedValueWarnings('https://x.test/{a}', { a: 'plain text' })).toEqual([]);
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
    await session.callHost({ kind: 'list.open', from: 'suggestion' });
    await session.callHost({ kind: 'draft.confirmItems' });
    await session.callHost({ kind: 'draft.addField', patch: { name: 'title' } });
    const saved = (await session.callHost({ kind: 'save.request' })) as { ok: boolean };
    expect(saved.ok).toBe(true);
    await session.userClose();
    expect(await run).toBe(ExitCode.Ok);

    const file = join(dir, 'recipes', '127-0-0-1-catalog.json');
    const recipe = loadRecipe(await readFile(file, 'utf8'));
    expect(recipe.fields!.map((f) => f.name)).toEqual(['title']);
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
    const reply = (await session.callHost({ kind: 'session.ready', url: PAGE })) as { state: { draft: { tables: { fields: unknown[] }[] } } };
    expect(reply.state.draft.tables[0]!.fields).toHaveLength(6);
    await session.userClose();
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).toContain('recording playground-catalog (edit)');

    const bad = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['record', '--edit', 'broken'], bad)).toBe(ExitCode.Error);
    expect(bad.err()).toContain('invalid recipe');
  });

  it('opens an existing recipe with edit like record --edit', async () => {
    const dir = await tempDir();
    const reference = loadRecipe(await readFile(new URL('../fixtures/playground-catalog.json', import.meta.url), 'utf8'));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'recipes'), { recursive: true });
    await writeFile(join(dir, 'recipes', 'playground-catalog.json'), saveRecipe(reference));
    await writeFile(join(dir, 'recipes', 'broken.json'), '{"schemaVersion":1,"name":"broken"}');
    const browser = new FakeBrowser({ [PAGE]: tier0() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['edit', 'playground-catalog'], io);
    const session = await Promise.race([sessionOf(browser), run.then((code) => Promise.reject(new Error(`exited ${code}: ${io.err()}`)))]);
    expect(browser.visited).toEqual([PAGE]);
    const reply = (await session.callHost({ kind: 'session.ready', url: PAGE })) as { state: { draft: { tables: { fields: unknown[] }[] } } };
    expect(reply.state.draft.tables[0]!.fields).toHaveLength(6);
    await session.userClose();
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).toContain('recording playground-catalog (edit)');

    const bad = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['edit', 'broken'], bad)).toBe(ExitCode.Error);
    expect(bad.err()).toContain('invalid recipe');

    const unknown = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    expect(await main(['edit', 'playground-catalog', '--repick', 'nope'], unknown)).toBe(ExitCode.Error);
    expect(unknown.err()).toContain('no field named "nope"');

    const missing = testIo({});
    expect(await main(['edit'], missing)).toBe(ExitCode.Error);
  });

  it('lists edit in help and documents its options and keys', async () => {
    const top = testIo({});
    expect(await main(['--help'], top)).toBe(ExitCode.Ok);
    expect(top.out()).toMatch(/edit \[options\] <recipe>\s+edit an existing recipe/);
    const io = testIo({});
    expect(await main(['edit', '--help'], io)).toBe(ExitCode.Ok);
    for (const text of ['--repick <field>', '--var <name=value>', '--profile <name>', '--timeout <ms>', '--lock-timeout <ms>', 'Ctrl+S saves']) {
      expect(io.out()).toContain(text);
    }
    expect(io.out()).not.toContain('--name');
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

describe('profile pin on save', () => {
  async function pickAndSave(session: FakeInteractiveSession, name?: string) {
    const page = annotate(tier0());
    const title = descendantsOf(page).find((n: AnnotatedNode) => n.attrs.class === 'product-title')!;
    await session.callHost({ kind: 'session.ready', url: PAGE });
    await session.callHost({ kind: 'picker.select', url: PAGE, selection: selectionOf(title), snapshot: detach(page) });
    await session.callHost({ kind: 'list.open', from: 'suggestion' });
    await session.callHost({ kind: 'draft.confirmItems' });
    await session.callHost({ kind: 'draft.addField', patch: { name: 'title' } });
    if (name) await session.callHost({ kind: 'draft.setName', name });
    const saved = (await session.callHost({ kind: 'save.request' })) as { ok: boolean };
    expect(saved.ok).toBe(true);
    await session.userClose();
  }

  async function record(args: string[], profiles?: unknown, name?: string) {
    const dir = await tempDir();
    if (profiles) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, 'config.json'), JSON.stringify({ profiles }));
    }
    const browser = new FakeBrowser({ [PAGE]: tier0() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['record', ...args], io);
    await pickAndSave(await sessionOf(browser), name);
    expect(await run).toBe(ExitCode.Ok);
    return { dir, io, browser };
  }

  const saved = async (dir: string, name: string) => loadRecipe(await readFile(join(dir, 'recipes', `${name}.json`), 'utf8'));

  it('pins the session profile when the recipe is renamed during recording', async () => {
    const { dir, io, browser } = await record([PAGE]);
    expect(browser.openedProfiles).toEqual([join(dir, 'profiles', '127-0-0-1-catalog')]);
    expect(io.err()).toContain('on profile "127-0-0-1-catalog" (recipe name)');
    expect((await saved(dir, '127-0-0-1-catalog')).browser).toBeUndefined();
    const renamed = await record([PAGE], undefined, 'shop');
    expect((await saved(renamed.dir, 'shop')).browser).toEqual({ profile: '127-0-0-1-catalog' });
  });

  it('leaves a recipe that follows a config rule unpinned', async () => {
    const { dir, io, browser } = await record([PAGE], { rules: [{ host: '^127\\.0\\.0\\.1$', profile: 'local' }] }, 'acme-list');
    expect(browser.openedProfiles).toEqual([join(dir, 'profiles', 'local')]);
    expect(io.err()).toContain('on profile "local" (config rule 1)');
    expect((await saved(dir, 'acme-list')).browser).toBeUndefined();
  });

  it('pins an explicit --profile', async () => {
    const { dir, browser } = await record([PAGE, '--name', 'acme-list', '--profile', 'second-account'], { rules: [{ host: '^127\\.0\\.0\\.1$', profile: 'local' }] });
    expect(browser.openedProfiles).toEqual([join(dir, 'profiles', 'second-account')]);
    expect((await saved(dir, 'acme-list')).browser).toEqual({ profile: 'second-account' });
  });

  async function pinnedHome() {
    const dir = await tempDir();
    const reference = loadRecipe(await readFile(new URL('../fixtures/playground-catalog.json', import.meta.url), 'utf8'));
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'recipes'), { recursive: true });
    await writeFile(join(dir, 'recipes', 'playground-catalog.json'), saveRecipe({ ...reference, browser: { profile: 'personal' } }));
    return dir;
  }

  it('keeps an existing pin on edit', async () => {
    const dir = await pinnedHome();
    const browser = new FakeBrowser({ [PAGE]: tier0() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['edit', 'playground-catalog'], io);
    const session = await Promise.race([sessionOf(browser), run.then((code) => Promise.reject(new Error(`exited ${code}: ${io.err()}`)))]);
    expect(browser.openedProfiles).toEqual([join(dir, 'profiles', 'personal')]);
    await session.callHost({ kind: 'session.ready', url: PAGE });
    await session.callHost({ kind: 'draft.setName', name: 'playground-catalog' });
    expect(((await session.callHost({ kind: 'save.request' })) as { ok: boolean }).ok).toBe(true);
    await session.userClose();
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).toContain('on profile "personal" (recipe)');
    expect((await saved(dir, 'playground-catalog')).browser).toEqual({ profile: 'personal' });
  });

  it('keeps an existing pin on a re-pick save', async () => {
    const dir = await pinnedHome();
    const browser = new FakeBrowser({ [PAGE]: tier0() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['edit', 'playground-catalog', '--repick', 'title'], io);
    const session = await Promise.race([sessionOf(browser), run.then((code) => Promise.reject(new Error(`exited ${code}: ${io.err()}`)))]);
    const page = annotate(tier0());
    const title = descendantsOf(page).filter((n: AnnotatedNode) => n.attrs.class === 'product-title')[2]!;
    await session.callHost({ kind: 'session.ready', url: PAGE });
    await session.callHost({ kind: 'picker.select', url: PAGE, selection: selectionOf(title), snapshot: detach(page) });
    await session.callHost({ kind: 'repick.confirm' });
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).toContain('saved the new location of title');
    expect((await saved(dir, 'playground-catalog')).browser).toEqual({ profile: 'personal' });
  });

  it('pins only when the used profile differs from the unpinned resolution', () => {
    const base = loadRecipe(JSON.stringify({ schemaVersion: 1, name: 'shop', url: 'https://{site}/x', vars: [{ name: 'site', type: 'string' }], fields: [{ name: 'a', type: 'text', scope: 'page', selectors: [{ strategy: 'css', value: 'h1', stability: 'medium' }] }] }));
    const config = ConfigSchema.parse({ profiles: { rules: [{ host: 'acme\\.com$', profile: 'acme' }] } });
    expect(pinProfile(base, 'acme', { site: 'acme.com' }, config).browser).toBeUndefined();
    expect(pinProfile(base, 'acme', {}, config).browser).toEqual({ profile: 'acme' });
    expect(pinProfile({ ...base, browser: { profile: 'shop', timezone: 'UTC' } }, 'shop', {}, config).browser).toEqual({ timezone: 'UTC' });
    expect(pinProfile({ ...base, browser: { profile: 'shop' } }, 'shop', {}, config).browser).toBeUndefined();
  });
});
