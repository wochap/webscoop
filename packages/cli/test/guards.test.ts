import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, NoopNotify, saveRecipe, type RecipeInput } from '@webscoop/core';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ExitCode, exitCodeFor, main, NotifySend, type Spawn } from '../src';
import { guardsFromFlags, summary } from '../src/commands/run';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/c/shoes';
const LOGIN = 'https://shop.test/login?next=%2Fc%2Fshoes';
const sel = (strategy: 'css' | 'testid', value: string) => ({ strategy, value, stability: strategy === 'testid' ? ('stable' as const) : ('medium' as const) });

function recipe(overrides: Partial<RecipeInput> = {}): RecipeInput {
  return {
    schemaVersion: 1,
    name: 'shop',
    url: 'https://shop.test/c/{category}',
    vars: [{ name: 'category', type: 'string', default: 'shoes' }],
    item: { selectors: [sel('testid', 'card')] },
    fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [sel('css', 'h2')] }],
    ...overrides,
  };
}

function shopPage(n: number, prefix = 'Shoe') {
  return h('html', {}, h('body', {}, Array.from({ length: n }, (_, i) => h('div', { 'data-testid': 'card' }, h('h2', {}, `${prefix} ${i}`)))));
}

function loginForm() {
  return h('html', {}, h('body', {}, h('form', {}, h('input', { name: 'username' }), h('input', { type: 'password', name: 'password' }), h('button', {}, 'Sign in'))));
}

function challenge() {
  return h('html', {}, h('body', {}, h('h1', {}, 'Verify you are human'), h('iframe', { src: '/turnstile' }), h('button', {}, 'I am human')));
}

async function home(recipes: RecipeInput[] = [recipe()]) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  for (const r of recipes) await writeFile(join(dir, 'recipes', `${r.name}.json`), saveRecipe(loadRecipe(r)));
  return dir;
}

const walled = () => new FakeBrowser({ [PAGE]: { dom: loginForm(), redirect: LOGIN }, [LOGIN]: loginForm() });

describe('NotifySend', () => {
  const note = { title: 'webscoop: shop needs you', body: 'login guard on page 2: redirected', urgency: 'critical' as const };

  it('spawns notify-send with critical urgency, the app name, title, and body, within 2 seconds', async () => {
    const spawn = vi.fn<Spawn>(async () => {});
    let err = '';
    await new NotifySend({ stderr: { write: (s: string) => (err += s) }, env: { PATH: '/bin' }, spawn }).notify(note);
    expect(spawn).toHaveBeenCalledWith('notify-send', ['--urgency=critical', '--app-name=webscoop', note.title, note.body], { timeoutMs: 2000, env: { PATH: '/bin' } });
    expect(err).toBe('');
  });

  it('falls back to stderr when notify-send is not installed', async () => {
    const spawn: Spawn = async () => {
      throw Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' });
    };
    let err = '';
    await new NotifySend({ stderr: { write: (s: string) => (err += s) }, env: {}, spawn }).notify(note);
    expect(err).toBe(`webscoop: notification (notify-send is not installed): ${note.title}: ${note.body}\n`);
  });

  it('falls back to stderr when notify-send fails or times out', async () => {
    let err = '';
    await new NotifySend({ stderr: { write: (s: string) => (err += s) }, env: {}, spawn: async () => Promise.reject(new Error('notify-send timed out after 2000 ms')) }).notify(note);
    expect(err).toContain('timed out');
    expect(err).toContain(note.body);
  });

  it('really spawns and falls back with an empty PATH', async () => {
    let err = '';
    await new NotifySend({ stderr: { write: (s: string) => (err += s) }, env: { PATH: '' } }).notify(note);
    expect(err).toContain('notify-send is not installed');
  });
});

describe('guard flags', () => {
  it('maps --guard-timeout, --no-guards, and --no-notify', () => {
    const t = testIo({});
    expect(guardsFromFlags(t, {}, 600_000)).toMatchObject({ enabled: true, timeoutMs: 600_000 });
    expect(guardsFromFlags(t, { guardTimeout: 300_000 }, 600_000).timeoutMs).toBe(300_000);
    expect(guardsFromFlags(t, { guards: false }, 600_000).enabled).toBe(false);
    expect(guardsFromFlags(t, { notify: false }, 600_000).notify).toBeInstanceOf(NoopNotify);
    expect(guardsFromFlags(t, {}, 0).timeoutMs).toBe(0);
  });

  it('maps paused to exit 2', () => {
    expect(exitCodeFor('paused')).toBe(ExitCode.Paused);
    expect(ExitCode.Paused).toBe(2);
  });

  it('exits 2 on a login wall with --guard-timeout 0, naming the guard, page, and URL, after one notification', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: walled() });
    expect(await main(['run', 'shop', '--guard-timeout', '0'], t)).toBe(ExitCode.Paused);
    expect(t.err()).toContain(`guard login on page 1: redirected to a login page (/login) (${LOGIN})`);
    expect(t.err()).toMatch(new RegExp(`run paused and gave up waiting: login guard on page 1 .*: ${LOGIN.replace(/[?]/g, '\\?')}`));
    expect(t.notifications).toEqual([expect.objectContaining({ urgency: 'critical', title: expect.stringContaining('shop'), body: expect.stringContaining('page 1') })]);
    expect(JSON.parse(t.out())).toEqual([]);
  });

  it('sends no notification with --no-notify', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: walled() });
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], t)).toBe(ExitCode.Paused);
    expect(t.notifications).toEqual([]);
  });

  it('treats the wall like any page with --no-guards', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: walled() });
    expect(await main(['run', 'shop', '--no-guards'], t)).toBe(ExitCode.Unresolved);
    expect(t.err()).not.toContain('guard');
  });

  it('makes test exit 2 at once on a wall', async () => {
    const dir = await home();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: { dom: challenge(), status: 403 } }) });
    const started = Date.now();
    expect(await main(['test', 'shop'], t)).toBe(ExitCode.Paused);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(t.err()).toContain('guard captcha on page 1');
  });

  it('keeps the rows of completed pages in the JSON array on exit 2', async () => {
    const paged = (n: number) => `${PAGE}?page=${n}`;
    const dir = await home([recipe({ pagination: { kind: 'url', param: { name: 'page', start: 1, step: 1 }, limit: 3 } })]);
    const browser = new FakeBrowser({ [paged(1)]: shopPage(2, 'A'), [paged(2)]: shopPage(2, 'B'), [paged(3)]: { dom: challenge(), status: 403 } });
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--guard-timeout', '0'], t)).toBe(ExitCode.Paused);
    const rows = JSON.parse(t.out()) as { title: string; _page: number }[];
    expect(rows.map((r) => r.title)).toEqual(['A 0', 'A 1', 'B 0', 'B 1']);
    expect(t.err()).toContain('4 rows from completed pages kept');
  });

  it('streams the rows of completed pages with --jsonl before exiting 2', async () => {
    const paged = (n: number) => `${PAGE}?page=${n}`;
    const dir = await home([recipe({ pagination: { kind: 'url', param: { name: 'page', start: 1, step: 1 }, limit: 3 } })]);
    const browser = new FakeBrowser({ [paged(1)]: shopPage(2, 'A'), [paged(2)]: { dom: challenge(), status: 403 } });
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--jsonl', '--guard-timeout', '0'], t)).toBe(ExitCode.Paused);
    expect(t.out().trim().split('\n')).toHaveLength(2);
  });

  it('lists the guard flags in help', async () => {
    for (const command of ['run', 'test']) {
      const t = testIo({});
      await main([command, '--help'], t);
      for (const flag of ['--guard-timeout <ms>', '--no-guards', '--no-notify']) expect(t.out()).toContain(flag);
    }
  });
});

describe('guard banner in interactive runs', () => {
  it('shows the banner, re-checks at once on Continue, and takes the recorder out of the page', async () => {
    const dir = await home();
    const browser = walled();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['run', 'shop', '--interactive'], t);
    const until = async (ok: () => boolean) => {
      while (!ok()) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await until(() => browser.sessions[0]?.exposed.has('__webscoopHost') ?? false);
    const session = browser.sessions[0]!;
    expect(session.injected).toEqual(['/* recorder default */']);
    expect(session.dispatchedOf('draft.state').at(-1)).toMatchObject({ state: { guardContext: { kind: 'login', page: 1, url: LOGIN } } });

    // The user logs in; Continue checks again well before the one-second poll.
    browser.setPage(PAGE, shopPage(2));
    await session.goto(PAGE, { timeoutMs: 1000 });
    const clicked = Date.now();
    await session.callHost({ kind: 'guard.continue' });
    expect(await run).toBe(ExitCode.Ok);
    expect(Date.now() - clicked).toBeLessThan(900);
    expect(JSON.parse(t.out())).toHaveLength(2);
    expect(session.dispatchedOf('draft.state').at(-1)).toMatchObject({ state: { guardContext: null } });
    expect(session.dispatchedOf('session.detach')).toHaveLength(1);
    expect(t.err()).toMatch(/1 guard cleared/);
  });

  it('exits 1 when the banner aborts the run', async () => {
    const dir = await home();
    const browser = walled();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    const run = main(['run', 'shop', '--interactive'], t);
    while (!browser.sessions[0]?.exposed.has('__webscoopHost')) await new Promise((resolve) => setTimeout(resolve, 5));
    await browser.sessions[0]!.callHost({ kind: 'guard.abort' });
    expect(await run).toBe(ExitCode.Error);
    expect(t.err()).toContain('aborted from the guard banner');
  });

  it('injects nothing in an unattended run', async () => {
    const dir = await home();
    const browser = walled();
    const t = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop', '--guard-timeout', '0'], t)).toBe(ExitCode.Paused);
    expect(browser.sessions[0]!.injected).toEqual([]);
    expect(browser.sessions[0]!.dispatched).toEqual([]);
  });
});

describe('summary', () => {
  it('mentions cleared guards', () => {
    const report = { recipe: 'shop', durationMs: 1500, pageCount: 1, rowCount: 3, healed: 0, duplicateCount: 0, guards: [{ kind: 'login', page: 1, url: PAGE, waitedMs: 12_000, cleared: true }] };
    expect(summary(report as never)).toBe('3 rows from 1 page, 1 guard cleared in 1.50s (shop)');
  });
});
