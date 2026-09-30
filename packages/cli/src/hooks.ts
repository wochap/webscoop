import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { LifecyclePort, RunEmitter } from '@webscoop/core';
import { DEFAULT_HOOK_TIMEOUT_MS, hookCommands, type Config, type HookEvent } from './config';
import type { Output } from './context';
import type { Env } from './paths';

/** The webscoop subcommand a hook fires for. */
export type HookCommand = 'run' | 'test' | 'record' | 'edit' | 'bench' | 'browser';

/** What every event of one command invocation shares. */
export interface HookContext {
  command: HookCommand;
  profile: string;
  profileDir: string;
  recipe?: string;
  /** The recipe's variable values; sent on stdin only, never in the environment. */
  vars?: Readonly<Record<string, string>>;
}

/** Per-event values: the ones with a variable, plus details that go only in the stdin payload. */
export interface HookDetails {
  url?: string;
  reason?: string;
  [detail: string]: unknown;
}

export interface HookRunnerOptions {
  stderr: Output;
  env: Env;
  /** Run id the events carry; default a new one. */
  runId?: string;
  /** Queue shared with other runners, so hooks of several jobs run one at a time. */
  queue?: HookQueue;
}

/** Hooks waiting to run, in order. */
export interface HookQueue {
  chain: Promise<void>;
}

/** Variables a hook gets from webscoop; unset ones are removed from the inherited environment. */
const HOOK_VARS = [
  'WEBSCOOP_EVENT',
  'WEBSCOOP_COMMAND',
  'WEBSCOOP_PROFILE',
  'WEBSCOOP_PROFILE_DIR',
  'WEBSCOOP_BROWSER_PID',
  'WEBSCOOP_RECIPE',
  'WEBSCOOP_RUN_ID',
  'WEBSCOOP_URL',
  'WEBSCOOP_REASON',
] as const;

/**
 * Runs the configured hook commands of one webscoop invocation, one at a
 * time in the order their events fired. A failing hook is a warning; it
 * never changes the command's outcome.
 */
export class HookRunner {
  readonly runId: string;
  private readonly queue: HookQueue;
  /** This runner's last queued hook. */
  private last: Promise<void> = Promise.resolve();
  private pid: number | undefined;
  private readonly timeoutMs: number;
  private readonly profileDir: string;

  constructor(
    private readonly config: Config,
    private readonly context: HookContext,
    private readonly opts: HookRunnerOptions,
  ) {
    this.runId = opts.runId ?? randomUUID();
    this.queue = opts.queue ?? { chain: Promise.resolve() };
    this.timeoutMs = config.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    // Hooks and the pid scan see the profile directory as Chromium does: absolute.
    this.profileDir = resolve(context.profileDir);
  }

  /** Whether any command is configured for the event. */
  has(event: HookEvent): boolean {
    return hookCommands(this.config, event).length > 0;
  }

  /** The browser main process id later events carry. */
  setPid(pid: number | undefined): void {
    this.pid = pid;
  }

  /** Queue the event's commands; the promise settles once they ran. Never rejects. */
  fire(event: HookEvent, details: HookDetails = {}): Promise<void> {
    const commands = hookCommands(this.config, event);
    if (commands.length === 0) return this.last;
    const { url, reason, ...rest } = details;
    const pid = this.pid;
    const env: Record<string, string | undefined> = { ...this.opts.env };
    for (const name of HOOK_VARS) delete env[name];
    Object.assign(env, {
      WEBSCOOP_EVENT: event,
      WEBSCOOP_COMMAND: this.context.command,
      WEBSCOOP_PROFILE: this.context.profile,
      WEBSCOOP_PROFILE_DIR: this.profileDir,
      WEBSCOOP_RUN_ID: this.runId,
      ...(pid !== undefined ? { WEBSCOOP_BROWSER_PID: String(pid) } : {}),
      ...(this.context.recipe !== undefined ? { WEBSCOOP_RECIPE: this.context.recipe } : {}),
      ...(url ? { WEBSCOOP_URL: url } : {}),
      ...(reason !== undefined ? { WEBSCOOP_REASON: reason } : {}),
    });
    const payload = JSON.stringify({
      event,
      at: new Date().toISOString(),
      command: this.context.command,
      profile: this.context.profile,
      profileDir: this.profileDir,
      runId: this.runId,
      ...(pid !== undefined ? { browserPid: pid } : {}),
      ...(this.context.recipe !== undefined ? { recipe: this.context.recipe } : {}),
      ...(url ? { url } : {}),
      ...(reason !== undefined ? { reason } : {}),
      vars: this.context.vars ?? {},
      ...rest,
    });
    this.last = this.queue.chain = this.queue.chain.then(async () => {
      for (const line of commands) await this.runOne(event, line, env, payload);
    });
    return this.last;
  }

  /** Wait for every hook this runner queued. */
  drain(): Promise<void> {
    return this.last;
  }

  /**
   * Fire hooks for the runner's events; `run` adds the run and attention
   * events to the browser ones, and `browser: false` leaves the browser events
   * to the daemon, which fires them once per browser.
   */
  attach(emitter: RunEmitter, opts: { run: boolean; browser?: boolean }): void {
    if (opts.browser !== false) {
      emitter.on('browser.started', (e) => {
        this.setPid(e.pid);
        void this.fire('browser.started');
      });
      emitter.on('browser.closed', () => void this.fire('browser.closed'));
    }
    if (!opts.run) return;
    emitter.on('run.start', (e) => void this.fire('run.start', { url: e.url }));
    emitter.on('attention.needed', (e) => {
      const { reason, url, ...rest } = e;
      void this.fire('attention.needed', { url, reason, ...rest });
    });
    emitter.on('attention.resolved', (e) => void this.fire('attention.resolved', { reason: e.reason, outcome: e.outcome }));
    emitter.on('run.done', ({ report }) =>
      void this.fire('run.done', { ...(report.finalUrl ? { url: report.finalUrl } : {}), rows: report.rowCount, pages: report.pageCount }),
    );
    emitter.on('run.failed', ({ reason, message, report }) =>
      void this.fire('run.failed', { ...(report.finalUrl ? { url: report.finalUrl } : {}), reason, message, rows: report.rowCount, pages: report.pageCount }),
    );
  }

  /** The runner's lifecycle port: `browser.starting` hooks before the launch, and the pid scan after it. */
  lifecycle(findPid: (profileDir: string) => Promise<number | null>): LifecyclePort {
    return {
      beforeLaunch: () => this.fire('browser.starting'),
      browserPid: async () => (await findPid(this.profileDir)) ?? undefined,
    };
  }

  private runOne(event: HookEvent, line: string, env: Record<string, string | undefined>, payload: string): Promise<void> {
    const warn = (why: string) => this.opts.stderr.write(`webscoop: warning: hook ${event} command "${line}" ${why}\n`);
    return new Promise((done) => {
      let settled = false;
      let timedOut = false;
      const finish = (why: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (why) warn(why);
        done();
      };
      // Own process group, so a timeout kills the whole command line.
      const child = spawn('/bin/sh', ['-c', line], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, this.timeoutMs);
      // Hook output never reaches stdout, which carries rows.
      child.stdout.on('data', (chunk: Buffer) => this.opts.stderr.write(chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => this.opts.stderr.write(chunk.toString()));
      child.stdin.on('error', () => {
        // The command did not read its stdin.
      });
      child.stdin.end(payload);
      child.on('error', (error) => finish(`failed to start: ${error.message}`));
      child.on('close', (code, signal) => {
        if (timedOut) finish(`was killed after ${this.timeoutMs} ms`);
        else if (code !== 0) finish(code === null ? `ended by ${signal}` : `exited ${code}`);
        else finish(null);
      });
    });
  }
}
