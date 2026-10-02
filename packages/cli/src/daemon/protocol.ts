/** Commands a job runs in the daemon. */
export type JobCommand = 'run' | 'test';

/** What a client asks the daemon. */
export type ClientMessage =
  | { type: 'hello'; version: string; programPath: string }
  | {
      type: 'submit';
      command: JobCommand;
      recipe: string;
      /** The command's parsed options. */
      options: Record<string, unknown>;
      cwd: string;
      env: Record<string, string>;
      /** `--queue-timeout`: give up when the job has not started within this many milliseconds. */
      queueTimeoutMs?: number;
    }
  | { type: 'signal'; runId?: string; action: 'continue' | 'abort' }
  | { type: 'cancel' }
  | { type: 'status' }
  | { type: 'stop'; force: boolean }
  | { type: 'release'; profileDir: string; command: string; force: boolean };

/** One browser of the daemon, as `daemon status` shows it. */
export interface BrowserStatus {
  profile: string;
  profileDir: string;
  /** Main process id of the browser, when known. */
  pid: number | null;
  running: { runId: string; recipe: string }[];
  queued: { runId: string; recipe: string }[];
  /** Run id holding attention. */
  attention: string | null;
}

export interface DaemonStatus {
  pid: number;
  version: string;
  browsers: BrowserStatus[];
}

/** What the daemon sends a client. */
export type DaemonMessage =
  | { type: 'welcome'; version: string; pid: number; accepted: boolean }
  | { type: 'accepted'; runId: string }
  | { type: 'started' }
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'attention'; runId: string; reason: string; kind?: string; label?: string; page: number; url: string }
  | { type: 'attention-resolved'; runId: string }
  | { type: 'still-blocked'; runId: string }
  | { type: 'waiting-attention'; holder: string }
  | { type: 'done'; exitCode: number }
  | { type: 'status'; status: DaemonStatus }
  | { type: 'released'; profile: string; running: number; queued: number; open: boolean }
  | { type: 'result'; ok: boolean; message?: string };

export type Message = ClientMessage | DaemonMessage;

/** One message as a line of JSON. */
export function encode(message: Message): string {
  return `${JSON.stringify(message)}\n`;
}

/** Splits a byte stream into newline-delimited JSON messages. */
export class LineDecoder<T = Message> {
  private buffer = '';

  /** Messages completed by this chunk, in order. A malformed line throws. */
  push(chunk: string): T[] {
    this.buffer += chunk;
    const out: T[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) out.push(JSON.parse(line) as T);
    }
    return out;
  }
}

/** A two-way message channel: a unix socket, or an in-process pair in tests. */
export interface Link<In, Out> {
  send(message: Out): void;
  onMessage(cb: (message: In) => void): void;
  /** Called once when the other side goes away. */
  onClose(cb: () => void): void;
  close(): void;
}

export type ClientLink = Link<DaemonMessage, ClientMessage>;
export type ServerLink = Link<ClientMessage, DaemonMessage>;

/** Two connected in-process links, for tests. */
export function linkPair(): [ClientLink, ServerLink] {
  const make = <In, Out>() => {
    const listeners: ((m: In) => void)[] = [];
    const closers: (() => void)[] = [];
    let closed = false;
    let peer: { deliver(m: unknown): void; shut(): void } | undefined;
    const end = {
      deliver: (m: unknown) => {
        if (closed) return;
        // Round-trip through JSON, like the socket, and deliver asynchronously.
        const copy = JSON.parse(JSON.stringify(m)) as In;
        queueMicrotask(() => !closed && listeners.forEach((cb) => cb(copy)));
      },
      shut: () => {
        if (closed) return;
        closed = true;
        queueMicrotask(() => closers.forEach((cb) => cb()));
      },
    };
    const link: Link<In, Out> = {
      send: (m) => peer?.deliver(m),
      onMessage: (cb) => void listeners.push(cb),
      onClose: (cb) => void closers.push(cb),
      close: () => {
        end.shut();
        peer?.shut();
      },
    };
    return { link, end, connect: (p: typeof end) => (peer = p) };
  };
  const a = make<DaemonMessage, ClientMessage>();
  const b = make<ClientMessage, DaemonMessage>();
  a.connect(b.end);
  b.connect(a.end);
  return [a.link, b.link];
}
