import { log, type CliIo } from '../context';
import { connectRunning, nextMessage } from '../daemon/client';
import type { DaemonStatus } from '../daemon/protocol';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';

/** `webscoop daemon status`: whether a daemon runs, and its browsers and jobs. Exits 0 either way. */
export async function daemonStatusCommand(io: CliIo, opts: { json?: boolean }): Promise<Code> {
  const link = await connectRunning(io);
  if (!link) {
    io.stdout.write(opts.json ? `${JSON.stringify({ running: false })}\n` : 'no daemon running\n');
    return ExitCode.Ok;
  }
  try {
    const reply = nextMessage(link, (m) => m.type === 'status');
    link.send({ type: 'status' });
    const message = await reply;
    if (!message || message.type !== 'status') throw new CliError('the daemon exited before answering');
    io.stdout.write(opts.json ? `${JSON.stringify({ running: true, ...message.status }, null, 2)}\n` : formatStatus(message.status));
    return ExitCode.Ok;
  } finally {
    link.close();
  }
}

/** Plain-text status. */
export function formatStatus(status: DaemonStatus): string {
  const lines = [`daemon running: pid ${status.pid}, version ${status.version}`];
  if (status.browsers.length === 0) lines.push('no browser open');
  for (const b of status.browsers) {
    lines.push(`profile ${b.profile}: browser pid ${b.pid ?? 'unknown'} (${b.profileDir})`);
    const runs = (list: { runId: string; recipe: string }[]) => (list.length === 0 ? 'none' : list.map((r) => `${r.runId} (${r.recipe})`).join(', '));
    lines.push(`  running: ${runs(b.running)}`);
    lines.push(`  queued: ${runs(b.queued)}`);
    lines.push(`  attention: ${b.attention ?? 'none'}`);
  }
  return `${lines.join('\n')}\n`;
}

/** `webscoop daemon stop`: wait for the jobs, or cancel them with `--force`, then close every browser. */
export async function daemonStopCommand(io: CliIo, opts: { force?: boolean }): Promise<Code> {
  const link = await connectRunning(io);
  if (!link) {
    log(io, 'no daemon running');
    return ExitCode.Ok;
  }
  try {
    const reply = nextMessage(link, (m) => m.type === 'result');
    link.send({ type: 'stop', force: opts.force === true });
    await reply;
    log(io, 'daemon stopped');
    return ExitCode.Ok;
  } finally {
    link.close();
  }
}

/** `webscoop attention continue|abort [run-id]`: answer the run holding attention. */
export async function attentionCommand(io: CliIo, action: 'continue' | 'abort', runId: string | undefined): Promise<Code> {
  const link = await connectRunning(io);
  if (!link) throw new CliError('no run holds attention (no daemon running)');
  try {
    const reply = nextMessage(link, (m) => m.type === 'result');
    link.send({ type: 'signal', action, ...(runId !== undefined ? { runId } : {}) });
    const message = await reply;
    if (!message || message.type !== 'result') throw new CliError('the daemon exited before answering');
    if (!message.ok) throw new CliError(message.message ?? 'no run holds attention');
    return ExitCode.Ok;
  } finally {
    link.close();
  }
}

/**
 * Before an exclusive command takes a profile: when the daemon has a browser
 * on it, ask (or with `--force`, do not ask) and stop its jobs and browser.
 * Exits 1 without a terminal and without `--force`, or on any answer but `y`.
 */
export async function releaseProfile(io: CliIo, profileDir: string, profile: string, command: string, force: boolean): Promise<void> {
  if (!io.daemon) return;
  const link = await connectRunning(io);
  if (!link) return;
  try {
    const ask = async (forced: boolean) => {
      const reply = nextMessage(link, (m) => m.type === 'released');
      link.send({ type: 'release', profileDir, command, force: forced });
      const message = await reply;
      if (!message || message.type !== 'released') return { open: false, running: 0, queued: 0 };
      return message;
    };
    const usage = await ask(false);
    if (!usage.open) return;
    const jobs = `${usage.running} running and ${usage.queued} queued job${usage.running + usage.queued === 1 ? '' : 's'}`;
    if (!force) {
      if (!io.terminal) throw new CliError(`the webscoop daemon has a browser open on profile "${profile}" (${jobs}); pass --force to stop it`);
      log(io, `the webscoop daemon has a browser open on profile "${profile}" with ${jobs}`);
      const answer = await io.prompt('Stop it? [y/N] ');
      if (answer?.trim().toLowerCase() !== 'y') throw new CliError(`profile "${profile}" is in use by the daemon; nothing changed`);
    }
    await ask(true);
  } finally {
    link.close();
  }
}
