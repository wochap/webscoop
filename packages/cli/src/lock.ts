import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CliError } from './exit';

export const LOCK_FILE = '.webscoop.lock';

export interface ProfileLock {
  readonly path: string;
  release(): void;
}

export interface LockOptions {
  /** How long to wait for a held lock, in ms. */
  timeoutMs: number;
  pollMs?: number;
  /** Profile name for messages; defaults to the directory name. */
  profileName?: string;
  pid?: number;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function tryCreate(path: string, pid: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, `${pid}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the per-profile lock: a pid file created with O_EXCL. A lock whose pid
 * no longer exists is reclaimed. Waits up to `timeoutMs`, then fails with exit
 * 1 naming the profile and the holding pid.
 */
export async function acquireProfileLock(profileDir: string, opts: LockOptions): Promise<ProfileLock> {
  const path = join(profileDir, LOCK_FILE);
  const pid = opts.pid ?? process.pid;
  const name = opts.profileName ?? basename(profileDir);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (tryCreate(path, pid)) break;
    const holder = readHolder(path);
    if (holder !== null && !isAlive(holder)) {
      // Stale lock from a crashed run. Remove it only if it still names the dead pid.
      if (readHolder(path) === holder) {
        try {
          unlinkSync(path);
        } catch {
          // Another process reclaimed it first.
        }
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        `profile "${name}" is locked by process ${holder ?? 'unknown'} (${path}); gave up after ${opts.timeoutMs} ms`,
      );
    }
    await sleep(Math.min(opts.pollMs ?? 100, Math.max(1, deadline - Date.now())));
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    if (readHolder(path) === pid) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  };
  process.on('exit', release);
  return { path, release };
}
