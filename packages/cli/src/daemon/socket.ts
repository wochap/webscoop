import { spawn } from 'node:child_process';
import { chmodSync, closeSync, createWriteStream, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { CliIo } from '../context';
import { acquireProfileLock } from '../lock';
import type { Env } from '../paths';
import { encode, LineDecoder, type ClientLink, type Link, type Message, type ServerLink } from './protocol';
import { DaemonServer } from './server';

/** A message link over a connected socket. */
export function socketLink<In extends Message, Out extends Message>(socket: Socket): Link<In, Out> {
  const decoder = new LineDecoder<In>();
  const listeners: ((m: In) => void)[] = [];
  const closers: (() => void)[] = [];
  let closed = false;
  const shut = () => {
    if (closed) return;
    closed = true;
    closers.forEach((cb) => cb());
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    let messages: In[];
    try {
      messages = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const m of messages) listeners.forEach((cb) => cb(m));
  });
  socket.on('close', shut);
  socket.on('error', () => socket.destroy());
  return {
    send: (m) => {
      if (!closed && socket.writable) socket.write(encode(m));
    },
    onMessage: (cb) => void listeners.push(cb),
    onClose: (cb) => void closers.push(cb),
    close: () => socket.end(),
  };
}

/** Connect to the daemon socket; null when nothing listens there. */
export function connectSocket(path: string): Promise<ClientLink | null> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socketLink(socket));
    });
    socket.once('error', () => resolve(null));
  });
}

/** Start `webscoop daemon serve` detached, with its output in the daemon log. */
export function spawnDaemon(programPath: string, env: Env, logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [programPath, 'daemon', 'serve'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: env as NodeJS.ProcessEnv,
      cwd: '/',
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
}

export interface ServeOptions {
  socketPath: string;
  logPath: string;
  base: CliIo;
  version: string;
  programPath: string;
}

/**
 * Serve on the socket until the daemon has nothing left. Resolves false at
 * once when another daemon holds the socket's lock.
 */
export async function serveDaemon(opts: ServeOptions): Promise<boolean> {
  const dir = dirname(opts.socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  let lock;
  try {
    lock = await acquireProfileLock(dir, { timeoutMs: 0, profileName: 'daemon' });
  } catch {
    return false;
  }
  try {
    unlinkSync(opts.socketPath);
  } catch {
    // No stale socket.
  }
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = createWriteStream(opts.logPath, { flags: 'a', mode: 0o600 });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const daemon = new DaemonServer({ base: opts.base, version: opts.version, programPath: opts.programPath, log, onExit: () => finish() });
  const server = createServer((socket) => daemon.accept(socketLink(socket) as ServerLink));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => resolve());
  });
  chmodSync(opts.socketPath, 0o600);
  log.write(`${new Date().toISOString()} daemon ${opts.version} listening on ${opts.socketPath} (pid ${process.pid})\n`);
  const stop = () => void daemon.stop(true);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await finished;
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Connections still open (a status client) must not keep the daemon alive.
    setTimeout(resolve, 200).unref();
  });
  try {
    unlinkSync(opts.socketPath);
  } catch {
    // Already gone.
  }
  lock.release();
  await new Promise<void>((resolve) => log.end(() => resolve()));
  return true;
}
