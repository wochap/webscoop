import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireProfileLock, CliError, ExitCode, LOCK_FILE } from '../src';
import { tempDir } from './helpers';

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(child.stdout.toString());
}

describe('profile lock', () => {
  it('writes the pid and removes the file on release', async () => {
    const dir = await tempDir();
    const lock = await acquireProfileLock(dir, { timeoutMs: 0 });
    expect((await readFile(join(dir, LOCK_FILE), 'utf8')).trim()).toBe(String(process.pid));
    lock.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('times out on contention with exit 1, naming the profile and holder', async () => {
    const dir = await tempDir();
    const first = await acquireProfileLock(dir, { timeoutMs: 0 });
    const started = Date.now();
    const error = await acquireProfileLock(dir, { timeoutMs: 300, pollMs: 50, profileName: 'shop' }).catch(
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(ExitCode.Error);
    expect((error as Error).message).toContain('"shop"');
    expect((error as Error).message).toContain(String(process.pid));
    first.release();
  });

  it('acquires once the holder releases within the timeout', async () => {
    const dir = await tempDir();
    const first = await acquireProfileLock(dir, { timeoutMs: 0 });
    setTimeout(() => first.release(), 100);
    const second = await acquireProfileLock(dir, { timeoutMs: 2000, pollMs: 20 });
    second.release();
  });

  it('reclaims a stale lock whose pid is gone', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, LOCK_FILE), `${deadPid()}\n`);
    const lock = await acquireProfileLock(dir, { timeoutMs: 0 });
    expect((await readFile(join(dir, LOCK_FILE), 'utf8')).trim()).toBe(String(process.pid));
    lock.release();
  });

  it('does not remove a lock it no longer owns', async () => {
    const dir = await tempDir();
    const lock = await acquireProfileLock(dir, { timeoutMs: 0 });
    await writeFile(join(dir, LOCK_FILE), '1\n');
    lock.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
  });

  it('leaves no temp file and never an empty lock', async () => {
    const dir = await tempDir();
    const lock = await acquireProfileLock(dir, { timeoutMs: 0 });
    expect(readdirSync(dir)).toEqual([LOCK_FILE]);
    expect((await readFile(join(dir, LOCK_FILE), 'utf8')).trim()).not.toBe('');
    lock.release();
  });

  it('takes the lock after a death between the temp write and the link', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, `${LOCK_FILE}.${process.pid}`), `${process.pid}\n`);
    const lock = await acquireProfileLock(dir, { timeoutMs: 0 });
    expect((await readFile(join(dir, LOCK_FILE), 'utf8')).trim()).toBe(String(process.pid));
    lock.release();
  });

  it('reclaims an empty lock older than 5 s', async () => {
    const dir = await tempDir();
    const path = join(dir, LOCK_FILE);
    await writeFile(path, '');
    const old = new Date(Date.now() - 10_000);
    await utimes(path, old, old);
    const lock = await acquireProfileLock(dir, { timeoutMs: 0 });
    expect((await readFile(path, 'utf8')).trim()).toBe(String(process.pid));
    lock.release();
  });

  it('treats a fresh empty lock as held by an unknown process', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, LOCK_FILE), '');
    const error = await acquireProfileLock(dir, { timeoutMs: 0, profileName: 'shop' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as Error).message).toContain('locked by process unknown');
  });
});
