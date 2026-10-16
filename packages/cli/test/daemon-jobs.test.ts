import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, LOCK_FILE, main } from '../src';
import { DISPLAY, fakeTty, sharedDaemon, SHOP_PAGE, shopCards, shopHome, testIo, type SharedDaemon, type TestIo } from './helpers';

const LOGIN = 'https://shop.test/login?next=%2Fc%2Fshoes';
const loginForm = () => h('html', {}, h('body', {}, h('form', {}, h('input', { name: 'username' }), h('input', { type: 'password', name: 'password' }), h('button', {}, 'Sign in'))));
/** The shop page redirects to a login wall until the test puts the cards back. */
const walled = () => new FakeBrowser({ [SHOP_PAGE]: { dom: loginForm(), redirect: LOGIN }, [LOGIN]: loginForm() });

/** The user logs in inside tab `index`: the shop page shows its cards, and the tab goes back there. */
async function logIn(browser: FakeBrowser, index: number, cards = 1): Promise<void> {
  browser.setPage(SHOP_PAGE, shopCards(cards));
  await browser.sessions[index]!.goto(SHOP_PAGE, { timeoutMs: 1000 });
}

async function until(ok: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** `daemon status --json` through a fresh client of the same daemon. */
async function status(dir: string, daemon: SharedDaemon) {
  const io = testIo({ env: { WEBSCOOP_HOME: dir }, daemon });
  expect(await main(['daemon', 'status', '--json'], io)).toBe(ExitCode.Ok);
  return JSON.parse(io.out()) as { running: boolean; browsers?: { profile: string; running: { runId: string }[]; queued: { runId: string }[]; attention: string | null }[] };
}

function client(dir: string, daemon: SharedDaemon, opts: Parameters<typeof testIo>[0] = {}): TestIo {
  return testIo({ ...opts, env: { ...DISPLAY, WEBSCOOP_HOME: dir, PATH: process.env.PATH, ...opts.env }, daemon });
}

describe('jobs in the daemon', () => {
  it('prints the same rows, stderr lines, and exit code as a local run', async () => {
    const dir = await shopHome();
    const io = client(dir, sharedDaemon(), { browser: new FakeBrowser({ [SHOP_PAGE]: shopCards(2) }) });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Ok);
    expect(JSON.parse(io.out())).toEqual([
      { title: 'item 0', _index: 0 },
      { title: 'item 1', _index: 1 },
    ].map(({ title }) => expect.objectContaining({ title })));
    expect(io.err()).toMatch(/^webscoop: running shop on profile "shop" \(recipe name\) \(no proxy\): https:\/\/shop\.test\/c\/shoes\n/);
    expect(io.err()).toMatch(/webscoop: 2 rows from 1 page in \d+\.\d+s \(shop\)\n$/);
  });

  it('writes --out relative to the directory of the command that submitted the job', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon({ idleMs: 60_000 });
    const browser = new FakeBrowser({ [SHOP_PAGE]: shopCards(1) });
    const first = client(dir, daemon, { browser, cwd: dir });
    expect(await main(['run', 'shop', '--out', 'rows.json'], first)).toBe(ExitCode.Ok);
    expect(JSON.parse(await readFile(join(dir, 'rows.json'), 'utf8'))).toHaveLength(1);
    await daemon.server!.stop(true);
  });

  it('runs up to daemon.concurrency jobs at once in one browser, each printing only its rows', async () => {
    const dir = await shopHome({ daemon: { concurrency: { total: 3 } } }, { url: 'https://shop.test/search?q={query}', vars: [{ name: 'query', type: 'string' }] });
    const daemon = sharedDaemon();
    const browser = new FakeBrowser();
    for (const q of ['cat', 'dog', 'fox']) browser.setPage(`https://shop.test/search?q=${q}`, shopCards(2, q));
    let peak = 0;
    const open = browser.open.bind(browser);
    browser.open = async (profileDir, opts) => {
      const session = await open(profileDir, opts);
      peak = Math.max(peak, browser.openSessions);
      // Hold every tab until all three are open.
      await until(() => browser.openSessions >= 3 || peak >= 3, 2000).catch(() => {});
      return session;
    };
    const ios = ['cat', 'dog', 'fox'].map(() => client(dir, daemon, { browser }));
    const codes = await Promise.all(['cat', 'dog', 'fox'].map((q, i) => main(['run', 'shop', '--var', `query=${q}`], ios[i]!)));
    expect(codes).toEqual([0, 0, 0]);
    expect(peak).toBe(3);
    for (const [i, q] of ['cat', 'dog', 'fox'].entries()) {
      expect(JSON.parse(ios[i]!.out()).map((r: { title: string }) => r.title)).toEqual([`${q} 0`, `${q} 1`]);
    }
    expect(ios.reduce((n, io) => n + io.browserCreated(), 0)).toBe(1);
  });

  it('queues a second job by default, says so once, and fires run.queued', async () => {
    const dir = await shopHome();
    const log = join(dir, 'queued');
    const daemon = sharedDaemon();
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { 'run.queued': `cat >> ${log}` } })));
    const blocked = walled();
    const first = client(dir, daemon, { browser: blocked });
    const running = main(['run', 'shop', '--no-notify', '--guard-timeout', '600000'], first);
    await until(() => first.err().includes('guard login'));
    const second = client(dir, daemon, { browser: blocked });
    const queued = main(['run', 'shop', '--queue-timeout', '200'], second);
    expect(await queued).toBe(ExitCode.Error);
    expect(second.err().match(/queued on profile "shop": 1 job ahead/g)).toHaveLength(1);
    expect(second.err()).toContain('gave up after 200 ms waiting for profile "shop" (1 job ahead)');
    expect(JSON.parse((await readFile(log, 'utf8')).trim())).toMatchObject({ event: 'run.queued', ahead: 1, recipe: 'shop' });
    const quiet = client(dir, daemon, { browser: blocked });
    expect(await main(['run', 'shop', '--queue-timeout', '50', '--quiet'], quiet)).toBe(ExitCode.Error);
    expect(quiet.err()).not.toContain('queued on profile');
    first.interrupt();
    expect(await running).toBe(ExitCode.Error);
  });

  it('says once after 3 s who holds the profile lock, even with --quiet, and proceeds on release', async () => {
    const fs = await import('node:fs/promises');
    const dir = await shopHome();
    const lock = join(dir, 'profiles', 'shop', LOCK_FILE);
    await fs.mkdir(join(dir, 'profiles', 'shop'), { recursive: true });
    await fs.writeFile(lock, `${process.pid}\n`);
    const io = client(dir, sharedDaemon(), { browser: new FakeBrowser({ [SHOP_PAGE]: shopCards(1) }) });
    const run = main(['run', 'shop', '--quiet'], io);
    await new Promise((r) => setTimeout(r, 1000));
    expect(io.err()).not.toContain('is locked by');
    await until(() => io.err().includes('is locked by'), 5000);
    expect(io.err().match(/profile "shop" is locked by process \d+/g)).toHaveLength(1);
    expect(io.err()).toContain('waiting for it');
    await fs.unlink(lock);
    expect(await run).toBe(ExitCode.Ok);
  });

  it('prints nothing about the lock when it is released within 3 s', async () => {
    const fs = await import('node:fs/promises');
    const dir = await shopHome();
    const lock = join(dir, 'profiles', 'shop', LOCK_FILE);
    await fs.mkdir(join(dir, 'profiles', 'shop'), { recursive: true });
    await fs.writeFile(lock, `${process.pid}\n`);
    const io = client(dir, sharedDaemon(), { browser: new FakeBrowser({ [SHOP_PAGE]: shopCards(1) }) });
    const run = main(['run', 'shop', '--quiet'], io);
    await new Promise((r) => setTimeout(r, 400));
    await fs.unlink(lock);
    expect(await run).toBe(ExitCode.Ok);
    expect(io.err()).not.toContain('is locked by');
  });

  it('cancels only the interrupted job and closes its tab', async () => {
    const dir = await shopHome({ daemon: { concurrency: { total: 2 } } });
    const daemon = sharedDaemon();
    const browser = walled();
    const a = client(dir, daemon, { browser });
    const b = client(dir, daemon, { browser });
    const runA = main(['run', 'shop', '--no-notify'], a);
    await until(() => a.err().includes('guard login'));
    const runB = main(['run', 'shop', '--no-notify'], b);
    await until(() => b.err().includes('guard login') || b.err().includes('waiting for run'));
    a.interrupt();
    expect(await runA).toBe(ExitCode.Error);
    expect(a.err()).toContain('interrupted, closing the tab');
    expect(browser.openSessions).toBe(1);
    expect(b.err()).not.toContain('interrupted');
    // The second run now holds attention; the user logs in in its tab.
    await until(() => b.err().includes('guard login'));
    await logIn(browser, 1);
    expect(await runB).toBe(ExitCode.Ok);
  });
});

describe('attention in the daemon', () => {
  it('lets one solve free the next run, which reloads and continues without asking', async () => {
    const dir = await shopHome({ daemon: { concurrency: { total: 2 } } });
    const daemon = sharedDaemon();
    const browser = walled();
    const a = client(dir, daemon, { browser });
    const b = client(dir, daemon, { browser });
    const runA = main(['run', 'shop', '--no-notify'], a);
    await until(() => a.err().includes('guard login'));
    const runB = main(['run', 'shop', '--no-notify'], b);
    await until(() => b.err().includes('waiting for run'));
    // The user logs in once, in the first run's tab; the second run's reload finds the cards.
    await logIn(browser, 0, 2);
    expect(await runA).toBe(ExitCode.Ok);
    expect(await runB).toBe(ExitCode.Ok);
    expect(b.err()).not.toContain('guard login');
    expect(JSON.parse(b.out())).toHaveLength(2);
    expect(b.notifications).toEqual([]);
  });

  it('prompts Solved? [Y/n/a] on the terminal, re-prompts while still blocked, and withdraws the prompt', async () => {
    const dir = await shopHome();
    const tty = fakeTty();
    const browser = walled();
    const daemon = sharedDaemon();
    const io = client(dir, daemon, { browser, tty });
    const run = main(['run', 'shop', '--no-notify', '--quiet'], io);
    await until(() => tty.output().includes('Solved? [Y/n/a]'));
    tty.type('');
    await until(() => tty.output().includes('the guard is still there'));
    expect(tty.output().match(/Solved\? \[Y\/n\/a\]/g)).toHaveLength(2);
    // Answered from elsewhere: the pending prompt is taken back.
    await logIn(browser, 0);
    const answered = Date.now();
    expect(await main(['attention', 'continue'], client(dir, daemon))).toBe(ExitCode.Ok);
    expect(await run).toBe(ExitCode.Ok);
    expect(Date.now() - answered).toBeLessThan(900);
    expect(tty.output().endsWith('\r\x1b[K')).toBe(true);
    expect(tty.closed()).toBe(true);
    // The prompt never reaches stdout, which carries only rows.
    expect(JSON.parse(io.out())).toHaveLength(1);
    expect(io.out()).not.toContain('Solved');
  });

  it('keeps waiting on n without prompting again, and aborts on a', async () => {
    const dir = await shopHome();
    const tty = fakeTty();
    const io = client(dir, sharedDaemon(), { browser: walled(), tty });
    const run = main(['run', 'shop', '--no-notify'], io);
    await until(() => tty.output().includes('Solved?'));
    tty.type('n');
    await new Promise((r) => setTimeout(r, 50));
    expect(tty.output().match(/Solved\?/g)).toHaveLength(1);
    tty.type('a');
    await new Promise((r) => setTimeout(r, 20));
    // `n` stopped listening: the run goes on until something else answers.
    expect(io.err()).not.toContain('aborted');
    io.interrupt();
    expect(await run).toBe(ExitCode.Error);
  });

  it('aborts from the terminal prompt', async () => {
    const dir = await shopHome();
    const tty = fakeTty();
    const io = client(dir, sharedDaemon(), { browser: walled(), tty });
    const run = main(['run', 'shop', '--no-notify'], io);
    await until(() => tty.output().includes('Solved?'));
    tty.type('a');
    expect(await run).toBe(ExitCode.Error);
    expect(io.err()).toContain('run failed (aborted)');
  });

  it('answers the only run holding attention with webscoop attention continue', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const browser = walled();
    const io = client(dir, daemon, { browser });
    const run = main(['run', 'shop', '--no-notify'], io);
    await until(() => io.err().includes('guard login'));
    await logIn(browser, 0);
    const answered = Date.now();
    const answer = client(dir, daemon);
    expect(await main(['attention', 'continue'], answer)).toBe(ExitCode.Ok);
    expect(await run).toBe(ExitCode.Ok);
    expect(Date.now() - answered).toBeLessThan(900);
  });

  it('acts on an explicit run id, and exits 1 listing ids when none or several hold attention', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const none = client(dir, daemon);
    expect(await main(['attention', 'continue'], none)).toBe(ExitCode.Error);
    expect(none.err()).toContain('no run holds attention');

    const one = walled();
    const two = walled();
    const a = client(dir, daemon, { browser: one });
    const b = client(dir, daemon, { browser: two });
    const runA = main(['run', 'shop', '--no-notify', '--profile', 'a'], a);
    const runB = main(['run', 'shop', '--no-notify', '--profile', 'b'], b);
    await until(() => a.err().includes('guard login') && b.err().includes('guard login'));
    const holders = (await status(dir, daemon)).browsers!.map((x) => x.attention!);
    expect(holders).toHaveLength(2);
    const ambiguous = client(dir, daemon);
    expect(await main(['attention', 'abort'], ambiguous)).toBe(ExitCode.Error);
    for (const id of holders) expect(ambiguous.err()).toContain(id);
    for (const id of holders) expect(await main(['attention', 'abort', id], client(dir, daemon))).toBe(ExitCode.Ok);
    expect(await runA).toBe(ExitCode.Error);
    expect(await runB).toBe(ExitCode.Error);
    const unknown = client(dir, daemon);
    expect(await main(['attention', 'continue', 'nope'], unknown)).toBe(ExitCode.Error);
  });
});

describe('await-user in the daemon', () => {
  const loginButton = { selectors: [{ strategy: 'css' as const, value: '#login', stability: 'medium' as const }] };
  /** The shop shows a "Log in" button until the test logs the user in. */
  const loginPage = () => h('html', {}, h('body', {}, h('button', { id: 'login' }, 'Log in')));
  const awaitRecipe = {
    flows: [{ name: 'login', steps: [{ kind: 'await-user' as const, target: loginButton, until: 'disappears' as const, label: 'Log in to SOL' }] }],
    sequence: [{ flow: 'login' }, { extract: 'items' }],
  };
  const logInAll = (browser: FakeBrowser) => {
    browser.setPage(SHOP_PAGE, shopCards(1));
    for (const session of browser.sessions) session.replaceDom(shopCards(1));
  };

  it('prompts Solved? for an await-user step, fires the hooks with the window URL and the label, and checks at once on Enter', async () => {
    const out = join(tmpdir(), `webscoop-await-${process.pid}-${Date.now()}`);
    const dir = await shopHome({ notify: false, hooks: { 'attention.needed': `cat > ${out}` } }, awaitRecipe);
    const tty = fakeTty();
    const browser = new FakeBrowser({ [SHOP_PAGE]: loginPage() });
    const io = client(dir, sharedDaemon(), { browser, tty });
    const run = main(['run', 'shop', '--guard-timeout', '600000'], io);
    await until(() => tty.output().includes('Solved? [Y/n/a]'));
    logInAll(browser);
    const answered = Date.now();
    tty.type('');
    expect(await run).toBe(ExitCode.Ok);
    expect(Date.now() - answered).toBeLessThan(900);
    expect(JSON.parse(io.out())).toHaveLength(1);
    await until(() => existsSync(out) && statSync(out).size > 0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({ event: 'attention.needed', reason: 'await-user', url: SHOP_PAGE, label: 'Log in to SOL' });
  });

  it('lets a second run waiting on the same login continue without asking once the first user logged in', async () => {
    const dir = await shopHome({ notify: false, daemon: { concurrency: { total: 2 } } }, awaitRecipe);
    const daemon = sharedDaemon();
    const browser = new FakeBrowser({ [SHOP_PAGE]: loginPage() });
    const a = client(dir, daemon, { browser });
    const b = client(dir, daemon, { browser });
    const runA = main(['run', 'shop', '--guard-timeout', '600000'], a);
    const runB = main(['run', 'shop', '--guard-timeout', '600000'], b);
    await until(() => browser.sessions.length === 2 && (a.err() + b.err()).includes('waiting for run'));
    logInAll(browser);
    expect(await runA).toBe(ExitCode.Ok);
    expect(await runB).toBe(ExitCode.Ok);
  });
});

describe('hooks in the daemon', () => {
  it('gives run and attention hooks the environment of the submitting command', async () => {
    const dir = await shopHome();
    const out = join(dir, 'foo');
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { 'attention.needed': `test "$FOO" = 1 && echo ok > ${out}` } })));
    const daemon = sharedDaemon();
    // The daemon starts from a command without FOO.
    const browser = walled();
    daemon.spawn(testIo({ env: { PATH: process.env.PATH }, browser }));
    const io = client(dir, daemon, { browser, env: { FOO: '1' } });
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], io)).toBe(ExitCode.Paused);
    expect((await readFile(out, 'utf8')).trim()).toBe('ok');
  });

  it('honors config notify false for a daemon-served run and still fires attention.needed', async () => {
    const dir = await shopHome();
    const out = join(dir, 'attention');
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, 'config.json'), JSON.stringify({ notify: false, hooks: { 'attention.needed': `echo ok > ${out}` } })));
    const daemon = sharedDaemon();
    const browser = walled();
    const served = testIo({ env: { PATH: process.env.PATH }, browser });
    daemon.spawn(served);
    const io = client(dir, daemon, { browser });
    expect(await main(['run', 'shop', '--guard-timeout', '0'], io)).toBe(ExitCode.Paused);
    expect((await readFile(out, 'utf8')).trim()).toBe('ok');
    expect(io.notifications).toEqual([]);
    expect(served.notifications).toEqual([]);
  });

  it('fires browser events once per browser, not for a job served by a warm browser', async () => {
    const dir = await shopHome();
    const log = join(dir, 'events');
    const hooks = Object.fromEntries(['browser.starting', 'browser.started', 'browser.closed', 'run.start', 'run.done'].map((e) => [e, `echo ${e} >> ${log}`]));
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, 'config.json'), JSON.stringify({ hooks })));
    const daemon = sharedDaemon({ idleMs: 60_000 });
    const browser = new FakeBrowser({ [SHOP_PAGE]: shopCards(1) });
    expect(await main(['run', 'shop'], client(dir, daemon, { browser }))).toBe(ExitCode.Ok);
    expect(await main(['run', 'shop'], client(dir, daemon, { browser }))).toBe(ExitCode.Ok);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['browser.starting', 'browser.started', 'run.start', 'run.done', 'run.start', 'run.done']);
    await daemon.server!.stop(false);
    expect((await readFile(log, 'utf8')).trim().split('\n').at(-1)).toBe('browser.closed');
  });
});

describe('webscoop daemon', () => {
  it('prints no daemon and exits 0 when none runs', async () => {
    const io = testIo({ env: {} });
    expect(await main(['daemon', 'status'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toBe('no daemon running\n');
    const json = testIo({ env: {} });
    expect(await main(['daemon', 'status', '--json'], json)).toBe(ExitCode.Ok);
    expect(JSON.parse(json.out())).toEqual({ running: false });
    expect(await main(['daemon', 'stop'], testIo({ env: {} }))).toBe(ExitCode.Ok);
  });

  it('lists the browser with its running and queued runs, then stops with --force', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const browser = walled();
    const a = client(dir, daemon, { browser });
    const b = client(dir, daemon, { browser });
    const runA = main(['run', 'shop', '--no-notify'], a);
    await until(() => a.err().includes('guard login'));
    const runB = main(['run', 'shop'], b);
    await until(() => b.err().includes('queued'));
    const json = await status(dir, daemon);
    expect(json).toMatchObject({ running: true, version: expect.any(String), pid: process.pid });
    expect(json.browsers).toHaveLength(1);
    expect(json.browsers![0]).toMatchObject({ profile: 'shop' });
    expect(json.browsers![0]!.running).toHaveLength(1);
    expect(json.browsers![0]!.queued).toHaveLength(1);
    expect(json.browsers![0]!.attention).toBe(json.browsers![0]!.running[0]!.runId);

    const text = client(dir, daemon);
    expect(await main(['daemon', 'status'], text)).toBe(ExitCode.Ok);
    expect(text.out()).toContain('profile shop: browser pid');
    expect(text.out()).toContain(`attention: ${json.browsers![0]!.attention}`);

    const stop = client(dir, daemon);
    expect(await main(['daemon', 'stop', '--force'], stop)).toBe(ExitCode.Ok);
    expect(await runA).toBe(ExitCode.Error);
    expect(await runB).toBe(ExitCode.Error);
    expect(b.err()).toContain('stopped by `webscoop daemon stop --force`');
    expect(daemon.server).toBeNull();
  });
});

describe('exclusive commands', () => {
  async function busy() {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const job = client(dir, daemon, { browser: walled() });
    const run = main(['run', 'shop', '--no-notify'], job);
    await until(() => job.err().includes('guard login'));
    return { dir, daemon, job, run };
  }

  it('refuses without a terminal and without --force, naming the profile, and leaves the jobs running', async () => {
    const { dir, daemon, job, run } = await busy();
    const edit = client(dir, daemon);
    expect(await main(['edit', 'shop'], edit)).toBe(ExitCode.Error);
    expect(edit.err()).toContain('profile "shop"');
    expect(edit.err()).toContain('--force');
    expect((await status(dir, daemon)).browsers![0]!.running).toHaveLength(1);
    job.interrupt();
    await run;
  });

  it('asks Stop it? [y/N] on a terminal and does nothing on no', async () => {
    const { dir, daemon, job, run } = await busy();
    const record = client(dir, daemon, { terminal: true, answers: ['n'] });
    expect(await main(['record', SHOP_PAGE, '--profile', 'shop'], record)).toBe(ExitCode.Error);
    expect(record.prompts()).toEqual(['Stop it? [y/N] ']);
    expect(record.err()).toContain('1 running and 0 queued job');
    expect((await status(dir, daemon)).browsers![0]!.running).toHaveLength(1);
    job.interrupt();
    await run;
  });

  it('cancels the jobs and closes the browser on yes, naming the command', async () => {
    const { dir, daemon, job, run } = await busy();
    const record = client(dir, daemon, { terminal: true, answers: ['y'] });
    await main(['record', SHOP_PAGE, '--profile', 'shop'], record);
    expect(await run).toBe(ExitCode.Error);
    expect(job.err()).toContain('stopped by `record`');
    // Recording went on to launch its own browser.
    expect(record.err()).toContain('browser code must not run in this test');
    expect((await status(dir, daemon)).running).toBe(false);
  });

  it('stops without asking with --force', async () => {
    const { dir, daemon, job, run } = await busy();
    const edit = client(dir, daemon);
    await main(['edit', 'shop', '--force'], edit);
    expect(edit.prompts()).toEqual([]);
    expect(await run).toBe(ExitCode.Error);
    expect(job.err()).toContain('stopped by `edit`');
  });
});

describe('cooldowns in the daemon', () => {
  const coldList = async (dir: string, daemon: SharedDaemon) => {
    const io = client(dir, daemon);
    expect(await main(['cooldown', 'list', '--json'], io)).toBe(ExitCode.Ok);
    return JSON.parse(io.out()) as { recipe: string; kind: string; page: number; streak: number; until: string }[];
  };

  it('makes the recipe cold on a guard timeout, keeps the walled tab, and refuses the next run without a request', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const browser = walled();
    const first = client(dir, daemon, { browser });
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], first)).toBe(ExitCode.Paused);
    expect(browser.openSessions).toBe(1);
    expect(await coldList(dir, daemon)).toEqual([expect.objectContaining({ recipe: 'shop', kind: 'login', page: 1, streak: 1 })]);
    const visited = browser.visited.length;
    const second = client(dir, daemon, { browser });
    expect(await main(['run', 'shop', '--quiet'], second)).toBe(ExitCode.Paused);
    expect(second.err()).toMatch(/shop is cold until \d\d:\d\d:\d\d after a login guard on page 1 \(https:\/\/shop\.test\/login.*\); not running it \(--ignore-cooldown runs it anyway\)/);
    expect(JSON.parse(second.out())).toEqual([]);
    expect(browser.visited.length).toBe(visited);
    expect(browser.openSessions).toBe(1);
    await daemon.server!.stop(true);
    expect(browser.openSessions).toBe(0);
  });

  it('does not cool down on a zero-fields guard, and closes its tab', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const browser = new FakeBrowser({ [SHOP_PAGE]: h('html', {}, h('body', {}, h('p', {}, 'Please wait'))) });
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], client(dir, daemon, { browser }))).toBe(ExitCode.Paused);
    expect(await coldList(dir, daemon)).toEqual([]);
    expect(browser.openSessions).toBe(0);
  });

  it('does not cool down when cooldownMs is 0', async () => {
    const dir = await shopHome({ guards: { cooldownMs: 0 } });
    const daemon = sharedDaemon();
    const browser = walled();
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], client(dir, daemon, { browser }))).toBe(ExitCode.Paused);
    expect(await coldList(dir, daemon)).toEqual([]);
    expect(browser.openSessions).toBe(0);
  });

  it('ends a queued job of the recipe with cold, without opening a tab', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const browser = walled();
    const a = client(dir, daemon, { browser });
    const runA = main(['run', 'shop', '--guard-timeout', '300', '--no-notify'], a);
    await until(() => a.err().includes('guard login'));
    const b = client(dir, daemon, { browser });
    const runB = main(['run', 'shop', '--no-notify'], b);
    await until(() => b.err().includes('queued on profile'));
    expect(await runA).toBe(ExitCode.Paused);
    expect(await runB).toBe(ExitCode.Paused);
    expect(b.err()).toContain('shop is cold until');
    expect(browser.sessions).toHaveLength(1);
    await daemon.server!.stop(true);
  });

  it('ends a job waiting for attention with cold, without reloading its page', async () => {
    const dir = await shopHome({ daemon: { concurrency: { total: 2 } } });
    const daemon = sharedDaemon();
    const browser = walled();
    const a = client(dir, daemon, { browser });
    const runA = main(['run', 'shop', '--guard-timeout', '300', '--no-notify'], a);
    await until(() => a.err().includes('guard login'));
    const c = client(dir, daemon, { browser });
    const runC = main(['run', 'shop', '--no-notify'], c);
    await until(() => c.err().includes('waiting for run'));
    const visited = browser.visited.length;
    expect(await runA).toBe(ExitCode.Paused);
    expect(await runC).toBe(ExitCode.Paused);
    expect(c.err()).toContain('run failed (cold)');
    expect(browser.visited.length).toBe(visited);
    await daemon.server!.stop(true);
  });

  it('resets the streak after a clean --ignore-cooldown run, and doubles it on a repeat wall', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const browser = walled();
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], client(dir, daemon, { browser }))).toBe(ExitCode.Paused);
    const firstTab = browser.sessions[0]!;
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify', '--ignore-cooldown'], client(dir, daemon, { browser }))).toBe(ExitCode.Paused);
    const [entry] = await coldList(dir, daemon);
    expect(entry).toMatchObject({ streak: 2 });
    await until(() => firstTab.isClosed());
    expect(browser.openSessions).toBe(1);
    browser.setPage(SHOP_PAGE, shopCards(1));
    expect(await main(['run', 'shop', '--ignore-cooldown', '--no-notify'], client(dir, daemon, { browser }))).toBe(ExitCode.Ok);
    expect(await coldList(dir, daemon)).toEqual([]);
    await until(() => browser.openSessions === 0);
  });

  it('sends one notification for three refused runs', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const browser = walled();
    const first = client(dir, daemon, { browser });
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], first)).toBe(ExitCode.Paused);
    for (let i = 0; i < 3; i++) expect(await main(['run', 'shop'], client(dir, daemon, { browser }))).toBe(ExitCode.Paused);
    expect(first.notifications.filter((n) => n.title.includes('is cold'))).toHaveLength(1);
    await daemon.server!.stop(true);
  });

  it('warms up when the user clears the wall in the cold tab, without the tab navigating', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const browser = walled();
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], client(dir, daemon, { browser }))).toBe(ExitCode.Paused);
    const visited = browser.visited.length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(browser.visited.length).toBe(visited);
    await logIn(browser, 0);
    await until(() => browser.openSessions === 0, 4000);
    expect(await coldList(dir, daemon)).toEqual([]);
    expect(await main(['run', 'shop', '--no-notify'], client(dir, daemon, { browser }))).toBe(ExitCode.Ok);
  });

  it('cooldown clear warms the recipe and closes its cold tab; a warm recipe is reported', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const browser = walled();
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], client(dir, daemon, { browser }))).toBe(ExitCode.Paused);
    const clear = client(dir, daemon);
    expect(await main(['cooldown', 'clear', 'shop'], clear)).toBe(ExitCode.Ok);
    expect(clear.err()).toContain('shop is warm');
    await until(() => browser.openSessions === 0);
    const again = client(dir, daemon);
    expect(await main(['cooldown', 'clear', 'news'], again)).toBe(ExitCode.Ok);
    expect(again.err()).toContain('news is not cold');
    expect(await main(['cooldown', 'clear'], client(dir, daemon))).toBe(ExitCode.Error);
    expect(await main(['cooldown', 'clear', 'shop', '--all'], client(dir, daemon))).toBe(ExitCode.Error);
  });

  it('cooldown commands do not start the daemon', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon();
    const io = client(dir, daemon);
    expect(await main(['cooldown', 'list'], io)).toBe(ExitCode.Ok);
    expect(io.out()).toBe('');
    expect(await main(['cooldown', 'clear', '--all'], client(dir, daemon))).toBe(ExitCode.Ok);
    expect(daemon.started).toBe(0);
  });
});
