import { spawn } from 'node:child_process';
import type { Notification, NotifyPort } from '@webscoop/core';
import type { Output } from './context';
import type { Env } from './paths';

/** How long `notify-send` may take before the notification counts as failed. */
export const NOTIFY_TIMEOUT_MS = 2000;

/** Run a command to completion; rejects on a spawn error (such as `ENOENT`), a non-zero exit, or the timeout. */
export type Spawn = (command: string, args: readonly string[], opts: { timeoutMs: number; env: Env }) => Promise<void>;

export const spawnProcess: Spawn = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', env: opts.env as NodeJS.ProcessEnv });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });

/**
 * Desktop notifications through `notify-send`. When the binary is missing or
 * fails, the same text goes to stderr instead and the run carries on.
 */
export class NotifySend implements NotifyPort {
  constructor(
    private readonly opts: { stderr: Output; env: Env; spawn?: Spawn; timeoutMs?: number },
  ) {}

  async notify(notification: Notification): Promise<void> {
    const urgency = notification.urgency ?? 'critical';
    const args = [`--urgency=${urgency}`, '--app-name=webscoop', notification.title, notification.body];
    try {
      await (this.opts.spawn ?? spawnProcess)('notify-send', args, { timeoutMs: this.opts.timeoutMs ?? NOTIFY_TIMEOUT_MS, env: this.opts.env });
    } catch (error) {
      const why = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'notify-send is not installed' : (error as Error).message;
      this.opts.stderr.write(`webscoop: notification (${why}): ${notification.title}: ${notification.body}\n`);
    }
  }
}
