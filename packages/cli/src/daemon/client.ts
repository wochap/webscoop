import { log, type CliIo, type DaemonAccess, type TtyPort } from '../context';
import { CliError, ExitCode, type ExitCode as Code } from '../exit';
import { VERSION } from '../version';
import type { ClientLink, ClientMessage, DaemonMessage, JobCommand } from './protocol';

/** How long a command retries connecting to a daemon it started. */
export const CONNECT_DEADLINE_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The next message, or null when the link closes first. */
export function nextMessage(link: ClientLink, accept: (m: DaemonMessage) => boolean = () => true): Promise<DaemonMessage | null> {
  return new Promise((resolve) => {
    let done = false;
    link.onMessage((m) => {
      if (done || !accept(m)) return;
      done = true;
      resolve(m);
    });
    link.onClose(() => {
      if (done) return;
      done = true;
      resolve(null);
    });
  });
}

function access(io: CliIo): DaemonAccess {
  if (!io.daemon) throw new CliError('no daemon access in this environment');
  return io.daemon;
}

/** Connect and greet a running daemon; null when none answers. `accepted` is false when its version differs. */
export async function greet(io: CliIo, version = VERSION): Promise<{ link: ClientLink; accepted: boolean } | null> {
  const daemon = access(io);
  const link = await daemon.connect();
  if (!link) return null;
  const welcome = nextMessage(link, (m) => m.type === 'welcome');
  link.send({ type: 'hello', version, programPath: daemon.programPath });
  const reply = await welcome;
  if (!reply || reply.type !== 'welcome') {
    link.close();
    return null;
  }
  return { link, accepted: reply.accepted };
}

/** Connect to a daemon of this version, starting one when none runs and waiting out a daemon of another version. */
export async function openDaemon(io: CliIo, version = VERSION): Promise<ClientLink> {
  const daemon = access(io);
  let spawned = false;
  let deadline = Date.now() + CONNECT_DEADLINE_MS;
  let delay = 20;
  for (;;) {
    const greeted = await greet(io, version);
    if (greeted?.accepted) return greeted.link;
    if (greeted) {
      // An older daemon finishes its jobs and exits; then a new one starts.
      greeted.link.close();
      spawned = false;
      deadline = Number.POSITIVE_INFINITY;
      await sleep(100);
      continue;
    }
    if (!spawned) {
      await daemon.spawn();
      spawned = true;
      deadline = Date.now() + CONNECT_DEADLINE_MS;
    }
    if (Date.now() > deadline) throw new CliError('the webscoop daemon did not start; see daemon.log in the webscoop state directory');
    await sleep(delay);
    delay = Math.min(delay * 2, 500);
  }
}

/** Connect to a running daemon without starting one; null when none runs. */
export async function connectRunning(io: CliIo): Promise<ClientLink | null> {
  return (await greet(io))?.link ?? null;
}

/** Plain-data environment for the job. */
function envOf(io: CliIo): Record<string, string> {
  return Object.fromEntries(Object.entries(io.env).filter((e): e is [string, string] => e[1] !== undefined));
}

/** The `Solved? [Y/n/a]` prompt on the controlling terminal, while a job holds attention for a guard. */
export class AttentionPrompt {
  private runId: string | null = null;
  private showing = false;
  private off: (() => void) | null = null;

  constructor(
    private readonly tty: TtyPort,
    private readonly send: (message: ClientMessage) => void,
  ) {}

  /** The job needs the user: ask. */
  open(runId: string): void {
    this.runId = runId;
    this.ask();
  }

  /** A continue found the guard still there: say so and ask again. */
  stillBlocked(): void {
    if (this.runId === null) return;
    this.withdraw();
    this.tty.write('webscoop: the guard is still there\n');
    this.ask();
  }

  /** Attention resolved some other way: take the prompt back. */
  resolved(): void {
    this.withdraw();
    this.runId = null;
  }

  close(): void {
    this.resolved();
    this.tty.close();
  }

  private ask(): void {
    this.withdraw();
    this.showing = true;
    this.tty.write('webscoop: Solved? [Y/n/a] ');
    this.off = this.tty.onLine((line) => this.answer(line.trim().toLowerCase()));
  }

  private answer(answer: string): void {
    const runId = this.runId;
    if (runId === null) return;
    this.off?.();
    this.off = null;
    this.showing = false;
    if (answer === '' || answer === 'y' || answer === 'yes') this.send({ type: 'signal', runId, action: 'continue' });
    else if (answer === 'a' || answer === 'abort') this.send({ type: 'signal', runId, action: 'abort' });
    // `n` keeps waiting without asking again.
  }

  private withdraw(): void {
    this.off?.();
    this.off = null;
    if (this.showing) this.tty.write('\r\x1b[K');
    this.showing = false;
  }
}

/**
 * `run` and `test` as a client: submit the job, write its stdout and stderr
 * as they come, answer attention on the terminal, and exit with its code.
 */
export async function submitJob(io: CliIo, command: JobCommand, recipe: string, options: object & { queueTimeout?: number }): Promise<Code> {
  const link = await openDaemon(io);
  const tty = io.tty?.() ?? null;
  const prompt = tty ? new AttentionPrompt(tty, (m) => link.send(m)) : null;
  let interrupted = false;
  const offInterrupt = io.onInterrupt(() => {
    interrupted = true;
    link.send({ type: 'cancel' });
  });
  try {
    const code = await new Promise<number>((resolve) => {
      let finished = false;
      link.onMessage((m) => {
        switch (m.type) {
          case 'stdout':
            io.stdout.write(m.data);
            break;
          case 'stderr':
            io.stderr.write(m.data);
            break;
          case 'attention':
            // Guards and await-user steps are answered at the terminal; a re-pick only in the browser.
            if (m.reason === 'guard' || m.reason === 'await-user') prompt?.open(m.runId);
            break;
          case 'still-blocked':
            prompt?.stillBlocked();
            break;
          case 'attention-resolved':
            prompt?.resolved();
            break;
          case 'done':
            finished = true;
            resolve(m.exitCode);
            break;
          default:
            break;
        }
      });
      link.onClose(() => {
        if (finished) return;
        log(io, interrupted ? 'interrupted' : 'the daemon exited while the job ran');
        resolve(ExitCode.Error);
      });
      link.send({
        type: 'submit',
        command,
        recipe,
        options: options as Record<string, unknown>,
        cwd: io.cwd,
        env: envOf(io),
        ...(options.queueTimeout !== undefined ? { queueTimeoutMs: options.queueTimeout } : {}),
      });
    });
    return code as Code;
  } finally {
    offInterrupt();
    prompt?.close();
    link.close();
  }
}
