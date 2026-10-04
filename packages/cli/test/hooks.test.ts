import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRecipe, RunEmitter, saveRecipe, type RecipeInput } from '@webscoop/core';
import { FakeBrowser, h } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ConfigSchema, ExitCode, HookRunner, main } from '../src';
import { browserSettings, settingsOptions } from '../src/browser';
import { doctorCommand } from '../src/commands/doctor';
import { tempDir, testIo } from './helpers';

const DISPLAY = { WAYLAND_DISPLAY: 'wayland-1' };
const PAGE = 'https://shop.test/c/shoes';
const LOGIN = 'https://shop.test/login?next=%2Fc%2Fshoes';

function runner(hooks: Record<string, string | string[]>, extra: Record<string, unknown> = {}) {
  let err = '';
  const config = ConfigSchema.parse({ hooks, ...extra });
  const hookRunner = new HookRunner(
    config,
    { command: 'run', profile: 'shop', profileDir: '/tmp/profiles/shop', recipe: 'shop', vars: { query: 'cat' } },
    { stderr: { write: (s: string) => (err += s) }, env: { PATH: process.env.PATH, WEBSCOOP_URL: 'stale' } },
  );
  return { hookRunner, err: () => err };
}

describe('HookRunner', () => {
  it('passes the event as environment variables', async () => {
    const dir = await tempDir();
    const out = join(dir, 'env');
    const t = runner({ 'attention.needed': `env | grep ^WEBSCOOP_ | sort > ${out}` });
    t.hookRunner.setPid(4242);
    await t.hookRunner.fire('attention.needed', { url: 'https://shop.test/login', reason: 'guard', kind: 'login', page: 2 });
    const env = Object.fromEntries((await readFile(out, 'utf8')).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    expect(env).toEqual({
      WEBSCOOP_EVENT: 'attention.needed',
      WEBSCOOP_COMMAND: 'run',
      WEBSCOOP_PROFILE: 'shop',
      WEBSCOOP_PROFILE_DIR: '/tmp/profiles/shop',
      WEBSCOOP_BROWSER_PID: '4242',
      WEBSCOOP_RECIPE: 'shop',
      WEBSCOOP_RUN_ID: t.hookRunner.runId,
      WEBSCOOP_URL: 'https://shop.test/login',
      WEBSCOOP_REASON: 'guard',
    });
  });

  it('writes the JSON payload to stdin, with the variables and details', async () => {
    const dir = await tempDir();
    const out = join(dir, 'payload');
    const t = runner({ 'run.start': `cat > ${out}` });
    await t.hookRunner.fire('run.start', { url: PAGE });
    const payload = JSON.parse(await readFile(out, 'utf8'));
    expect(payload).toMatchObject({ event: 'run.start', command: 'run', profile: 'shop', recipe: 'shop', url: PAGE, vars: { query: 'cat' }, runId: t.hookRunner.runId });
    expect(new Date(payload.at).toString()).not.toBe('Invalid Date');
  });

  it('leaves secret variables out of the payload and masks their values', async () => {
    const dir = await tempDir();
    const out = join(dir, 'payload');
    let err = '';
    const hookRunner = new HookRunner(
      ConfigSchema.parse({ hooks: { 'run.failed': [`cat > ${out}`, 'echo leaked hunter2 >&2'] } }),
      { command: 'run', profile: 'shop', profileDir: '/tmp/p', recipe: 'shop', vars: { user: 'ada', pass: 'hunter2' }, secrets: ['pass'] },
      { stderr: { write: (s: string) => (err += s) }, env: { PATH: process.env.PATH } },
    );
    await hookRunner.fire('run.failed', { message: 'typed hunter2 into the form' });
    const text = await readFile(out, 'utf8');
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text).vars).toEqual({ user: 'ada' });
    expect(err).toContain('leaked ***');
    expect(err).not.toContain('hunter2');
  });

  it('runs hooks one at a time, in event order and configured order', async () => {
    const dir = await tempDir();
    const log = join(dir, 'log');
    const t = runner({
      'run.start': [`sleep 0.2; echo start-1 >> ${log}`, `echo start-2 >> ${log}`],
      'run.done': `echo done >> ${log}`,
    });
    void t.hookRunner.fire('run.start');
    void t.hookRunner.fire('run.done');
    await t.hookRunner.drain();
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['start-1', 'start-2', 'done']);
  });

  it('kills a hook after hookTimeoutMs and warns', async () => {
    const t = runner({ 'run.start': 'sleep 5' }, { hookTimeoutMs: 100 });
    const started = Date.now();
    await t.hookRunner.fire('run.start');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.err()).toContain('webscoop: warning: hook run.start command "sleep 5" was killed after 100 ms');
  });

  it('warns on a non-zero exit, naming the event and the command', async () => {
    const t = runner({ 'run.done': 'exit 1' });
    await t.hookRunner.fire('run.done');
    expect(t.err()).toBe('webscoop: warning: hook run.done command "exit 1" exited 1\n');
  });

  it('sends hook output to stderr', async () => {
    const t = runner({ 'run.done': 'echo out; echo err >&2' });
    await t.hookRunner.fire('run.done');
    expect(t.err()).toContain('out\n');
    expect(t.err()).toContain('err\n');
  });

  it('runs nothing for an event without hooks', async () => {
    const t = runner({});
    await t.hookRunner.fire('run.done');
    expect(t.hookRunner.has('run.done')).toBe(false);
    expect(t.err()).toBe('');
  });

  it('maps runner events to hook events', async () => {
    const dir = await tempDir();
    const log = join(dir, 'log');
    const line = `echo $WEBSCOOP_EVENT $WEBSCOOP_BROWSER_PID >> ${log}`;
    const t = runner({ 'browser.started': line, 'browser.closed': line, 'attention.needed': line });
    const emitter = new RunEmitter();
    t.hookRunner.attach(emitter, { run: false });
    emitter.emit('browser.started', { pid: 7 });
    emitter.emit('attention.needed', { reason: 'guard', page: 1, url: PAGE });
    emitter.emit('browser.closed', {});
    await t.hookRunner.drain();
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['browser.started 7', 'browser.closed 7']);
  });

  it('fires download.saved with WEBSCOOP_FILE and the file details', async () => {
    const dir = await tempDir();
    const log = join(dir, 'log');
    const t = runner({ 'download.saved': `{ echo "$WEBSCOOP_FILE"; cat; } >> ${log}` });
    const emitter = new RunEmitter();
    t.hookRunner.attach(emitter, { run: true });
    emitter.emit('download.saved', { page: 1, file: '/dl/deck.pdf', name: 'deck.pdf', url: 'https://docs.test/x', bytes: 12, step: null });
    await t.hookRunner.drain();
    const [file, payload] = (await readFile(log, 'utf8')).split('\n');
    expect(file).toBe('/dl/deck.pdf');
    expect(JSON.parse(payload!)).toMatchObject({ event: 'download.saved', file: '/dl/deck.pdf', name: 'deck.pdf', url: 'https://docs.test/x', bytes: 12 });
  });

  it('rejects a downloads.saved hook as an unknown event', () => {
    expect(ConfigSchema.safeParse({ hooks: { 'downloads.saved': 'true' } }).success).toBe(false);
  });
});

function recipe(): RecipeInput {
  return {
    schemaVersion: 2, sequence: [{ extract: 'items' }],
    name: 'shop',
    url: 'https://shop.test/c/{category}',
    vars: [{ name: 'category', type: 'string', default: 'shoes' }],
    item: { selectors: [{ strategy: 'testid', value: 'card', stability: 'stable' }] },
    fields: [{ name: 'title', type: 'text', scope: 'item', selectors: [{ strategy: 'css', value: 'h2', stability: 'medium' }] }],
  };
}

const cards = (n: number) => h('html', {}, h('body', {}, Array.from({ length: n }, (_, i) => h('div', { 'data-testid': 'card' }, h('h2', {}, `Shoe ${i}`)))));
const loginForm = () => h('html', {}, h('body', {}, h('form', {}, h('input', { name: 'username' }), h('input', { type: 'password', name: 'password' }), h('button', {}, 'Sign in'))));

/** A home with the shop recipe and a config whose hooks append the event name to a log file. */
async function hookedHome(extra: Record<string, unknown> = {}) {
  const dir = await tempDir();
  await mkdir(join(dir, 'recipes'), { recursive: true });
  await writeFile(join(dir, 'recipes', 'shop.json'), saveRecipe(loadRecipe(recipe())));
  const log = join(dir, 'hooks.log');
  const line = `echo "$WEBSCOOP_EVENT $WEBSCOOP_COMMAND $WEBSCOOP_BROWSER_PID" >> ${log}`;
  const events = ['browser.starting', 'browser.started', 'browser.closed', 'run.start', 'run.done', 'run.failed', 'attention.needed', 'attention.resolved', 'browser.show', 'browser.hide'];
  await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, line])), ...extra }));
  const read = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return { dir, read };
}

describe('hooks in commands', () => {
  it('fires the run events in order and waits for them before exiting', async () => {
    const home = await hookedHome();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: home.dir, PATH: process.env.PATH }, browser: new FakeBrowser({ [PAGE]: cards(2) }), pid: 99 });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Ok);
    expect(await home.read()).toEqual(['browser.starting run', 'browser.started run 99', 'run.start run 99', 'run.done run 99', 'browser.closed run 99']);
    expect(io.pidLookups).toEqual([join(home.dir, 'profiles', 'shop')]);
    expect(JSON.parse(io.out())).toHaveLength(2);
  });

  it('pairs attention with a guard that times out, before run.failed', async () => {
    const home = await hookedHome();
    const browser = new FakeBrowser({ [PAGE]: { dom: loginForm(), redirect: LOGIN }, [LOGIN]: loginForm() });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: home.dir, PATH: process.env.PATH }, browser });
    expect(await main(['run', 'shop', '--guard-timeout', '0', '--no-notify'], io)).toBe(ExitCode.Paused);
    expect((await home.read()).map((l) => l.split(' ')[0])).toEqual([
      'browser.starting',
      'browser.started',
      'run.start',
      'attention.needed',
      'attention.resolved',
      'run.failed',
      'browser.closed',
    ]);
  });

  it('does not change the exit code when a hook fails', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'recipes'), { recursive: true });
    await writeFile(join(dir, 'recipes', 'shop.json'), saveRecipe(loadRecipe(recipe())));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { 'run.done': 'exit 1' } }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir, PATH: process.env.PATH }, browser: new FakeBrowser({ [PAGE]: cards(1) }) });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Ok);
    // Hooks of run and test run in the daemon; their output and warnings go to its log.
    expect(io.daemonLog()).toContain('webscoop: warning: hook run.done command "exit 1" exited 1');
  });

  it('warns once about a leftover window block and still runs', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'recipes'), { recursive: true });
    await writeFile(join(dir, 'recipes', 'shop.json'), saveRecipe(loadRecipe(recipe())));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ window: { provider: 'hyprland' } }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser: new FakeBrowser({ [PAGE]: cards(1) }) });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Ok);
    expect(io.err().match(/"window" block is no longer supported/g)).toHaveLength(1);
  });

  it('passes browser.args to the launch', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'recipes'), { recursive: true });
    await writeFile(join(dir, 'recipes', 'shop.json'), saveRecipe(loadRecipe(recipe())));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ browser: { args: ['--class=webscoop'] } }));
    const browser = new FakeBrowser({ [PAGE]: cards(1) });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Ok);
    expect(browser.openOptions[0]?.args).toEqual(['--class=webscoop']);
  });

  it('adds no arguments without browser.args', () => {
    const config = ConfigSchema.parse({});
    expect(settingsOptions(browserSettings(config, undefined, {}, {})).args).toBeUndefined();
    const withArgs = ConfigSchema.parse({ browser: { args: ['--class=webscoop', '--ozone-platform=wayland'] } });
    expect(settingsOptions(browserSettings(withArgs, undefined, {}, {})).args).toEqual(['--class=webscoop', '--ozone-platform=wayland']);
  });
});

describe('webscoop browser', () => {
  it('fires browser.show with the pid of the running browser', async () => {
    const home = await hookedHome({ profiles: { default: 'main' } });
    const io = testIo({ env: { WEBSCOOP_HOME: home.dir, PATH: process.env.PATH }, pid: 1234 });
    expect(await main(['browser', 'show'], io)).toBe(ExitCode.Ok);
    expect(await home.read()).toEqual(['browser.show browser 1234']);
    expect(io.pidLookups).toEqual([join(home.dir, 'profiles', 'main')]);
  });

  it('fires browser.hide for --profile', async () => {
    const home = await hookedHome();
    const io = testIo({ env: { WEBSCOOP_HOME: home.dir, PATH: process.env.PATH }, pid: 5 });
    expect(await main(['browser', 'hide', '--profile', 'work'], io)).toBe(ExitCode.Ok);
    expect(await home.read()).toEqual(['browser.hide browser 5']);
    expect(io.pidLookups).toEqual([join(home.dir, 'profiles', 'work')]);
  });

  it('exits 1 naming the profile when no browser runs on it', async () => {
    const home = await hookedHome();
    const io = testIo({ env: { WEBSCOOP_HOME: home.dir } });
    expect(await main(['browser', 'show', '--profile', 'shop'], io)).toBe(ExitCode.Error);
    expect(io.err()).toContain('no browser is running for profile "shop"');
    expect(await home.read()).toEqual([]);
  });

  it('warns and exits 0 without a hook for the event', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { WEBSCOOP_HOME: dir }, pid: 5 });
    expect(await main(['browser', 'show'], io)).toBe(ExitCode.Ok);
    expect(io.err()).toContain('warning: no hook is configured for browser.show');
  });

  it('rejects an unknown action', async () => {
    const io = testIo({});
    expect(await main(['browser', 'toggle'], io)).toBe(ExitCode.Error);
  });
});

describe('doctor hooks', () => {
  it('lists each configured event with its number of commands', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hooks: { 'attention.needed': ['a', 'b'], 'browser.started': 'c' } }));
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    await doctorCommand(io);
    expect(io.out()).toMatch(/^hook attention\.needed +2 commands$/m);
    expect(io.out()).toMatch(/^hook browser\.started +1 command$/m);
  });

  it('says when no hooks are configured', async () => {
    const dir = await tempDir();
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir } });
    await doctorCommand(io);
    expect(io.out()).toMatch(/^hooks +none configured$/m);
  });
});
