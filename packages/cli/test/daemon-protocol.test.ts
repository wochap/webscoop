import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakeBrowser } from '@webscoop/core/testing';
import { describe, expect, it } from 'vitest';
import { ExitCode, main } from '../src';
import { greet, openDaemon } from '../src/daemon/client';
import { daemonLogPath, socketPath } from '../src/daemon/paths';
import { encode, LineDecoder, linkPair, type ClientMessage, type DaemonMessage } from '../src/daemon/protocol';
import { connectSocket, serveDaemon } from '../src/daemon/socket';
import { VERSION } from '../src/version';
import { DISPLAY, sharedDaemon, SHOP_PAGE, shopCards, shopHome, tempDir, testIo } from './helpers';

describe('protocol', () => {
  const messages: (ClientMessage | DaemonMessage)[] = [
    { type: 'hello', version: '1.2.3', programPath: '/usr/bin/webscoop' },
    { type: 'submit', command: 'run', recipe: 'shop', options: { var: ['q=a b'], quiet: true }, cwd: '/tmp', env: { A: 'ü\nx' }, queueTimeoutMs: 100 },
    { type: 'signal', runId: 'r1', action: 'continue' },
    { type: 'release', profileDir: '/p', command: 'record', force: false },
    { type: 'stdout', data: '[\n  {"a": 1}\n]\n' },
    { type: 'status', status: { pid: 1, version: '1', browsers: [{ profile: 'default', profileDir: '/p', pid: null, running: [], queued: [{ runId: 'r', recipe: 'shop' }], attention: null }] } },
    { type: 'done', exitCode: 3 },
  ];

  it('round-trips every message as one line each', () => {
    const text = messages.map(encode).join('');
    expect(text.split('\n').filter(Boolean)).toHaveLength(messages.length);
    expect(new LineDecoder().push(text)).toEqual(messages);
  });

  it('reassembles messages split across chunks', () => {
    const text = messages.map(encode).join('');
    const decoder = new LineDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < text.length; i += 7) out.push(...decoder.push(text.slice(i, i + 7)));
    expect(out).toEqual(messages);
  });

  it('rejects a malformed line', () => {
    expect(() => new LineDecoder().push('{nope\n')).toThrow();
  });

  it('delivers over an in-process pair and reports the close', async () => {
    const [client, server] = linkPair();
    const got = new Promise((resolve) => server.onMessage(resolve));
    const closed = new Promise<void>((resolve) => client.onClose(resolve));
    client.send({ type: 'status' });
    expect(await got).toEqual({ type: 'status' });
    server.close();
    await closed;
  });
});

describe('socket and log paths', () => {
  it('uses WEBSCOOP_HOME, then XDG_RUNTIME_DIR, then /tmp per user', () => {
    expect(socketPath({ WEBSCOOP_HOME: '/w', XDG_RUNTIME_DIR: '/run/user/1' }, 1)).toBe('/w/run/daemon.sock');
    expect(socketPath({ XDG_RUNTIME_DIR: '/run/user/1' }, 1)).toBe('/run/user/1/webscoop/daemon.sock');
    expect(socketPath({}, 1000)).toBe('/tmp/webscoop-1000/daemon.sock');
    expect(daemonLogPath({ WEBSCOOP_HOME: '/w' }, '/h')).toBe('/w/daemon.log');
    expect(daemonLogPath({ XDG_STATE_HOME: '/s' }, '/h')).toBe('/s/webscoop/daemon.log');
    expect(daemonLogPath({}, '/h')).toBe('/h/.local/state/webscoop/daemon.log');
  });
});

describe('serveDaemon', () => {
  it('leaves one daemon when two start at once, listening on a user-only socket', async () => {
    const home = await tempDir('ws-d-');
    const path = socketPath({ WEBSCOOP_HOME: home }, 0);
    const base = testIo({ env: { WEBSCOOP_HOME: home } });
    const opts = { socketPath: path, logPath: join(home, 'daemon.log'), base, version: VERSION, programPath: '/test/webscoop.js' };
    const first = serveDaemon(opts);
    const second = serveDaemon(opts);
    // The loser gives up at once; the winner serves until it has nothing left.
    expect(await Promise.race([first.then(() => 'first'), second.then(() => 'second')])).toBeTruthy();
    const link = await connectSocket(path);
    expect(link).not.toBeNull();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700);
    const reply = new Promise<DaemonMessage>((resolve) => link!.onMessage(resolve));
    link!.send({ type: 'hello', version: VERSION, programPath: '/test/webscoop.js' });
    expect(await reply).toMatchObject({ type: 'welcome', accepted: true, pid: process.pid });
    link!.send({ type: 'stop', force: false });
    const results = await Promise.all([first, second]);
    expect(results.sort()).toEqual([false, true]);
    expect(existsSync(path)).toBe(false);
    expect(await connectSocket(path)).toBeNull();
  });
});

const PAGE = SHOP_PAGE;
const cards = (n: number) => shopCards(n);

describe('spawn or connect', () => {
  it('starts a daemon on the first run and reuses it', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon({ idleMs: 60_000 });
    const browser = new FakeBrowser({ [PAGE]: cards(2) });
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser, daemon });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Ok);
    expect(JSON.parse(io.out())).toHaveLength(2);
    expect(daemon.server).not.toBeNull();
    const again = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser, daemon });
    expect(await main(['run', 'shop'], again)).toBe(ExitCode.Ok);
    expect(daemon.started).toBe(1);
    // One launch served both runs, each in its own tab.
    expect(io.browserCreated() + again.browserCreated()).toBe(1);
    await daemon.server!.stop(true);
  });

  it('waits for a daemon of another version to finish, then starts a new one', async () => {
    const dir = await shopHome();
    const daemon = sharedDaemon({ idleMs: 60_000 });
    daemon.version = '0.0.1';
    const browser = new FakeBrowser({ [PAGE]: cards(1) });
    const old = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser, daemon });
    old.daemon!.spawn();
    const oldServer = daemon.server!;
    expect((await greet(old))?.accepted).toBe(false);
    daemon.version = VERSION;
    const io = testIo({ env: { ...DISPLAY, WEBSCOOP_HOME: dir }, browser, daemon });
    expect(await main(['run', 'shop'], io)).toBe(ExitCode.Ok);
    expect(oldServer.isExited).toBe(true);
    expect(daemon.started).toBe(2);
    await daemon.server?.stop(true);
  });

  it('connects racing clients to the one daemon they started', async () => {
    const daemon = sharedDaemon();
    const io = testIo({ daemon });
    const links = await Promise.all([openDaemon(io), openDaemon(io), openDaemon(io)]);
    expect(daemon.started).toBe(1);
    for (const link of links) link.close();
  });
});
