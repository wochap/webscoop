/** Commands a job runs in the daemon. */
export type JobCommand = 'run' | 'test';

export type TabSummary = {
  tabId: string;
  profile: string;
  url: string;
  title: string;
  isPopup: boolean;
  openerTabId?: string;
};

export type TabActionRequest =
  | {
      type: 'tab.open';
      url?: string;
      profile?: string;
      visual?: boolean;
      humanize?: boolean;
      timeoutMs?: number;
      cwd: string;
      env: Record<string, string>;
    }
  | { type: 'tab.list'; profile?: string }
  | { type: 'tab.goto'; tabId: string; url: string; timeoutMs?: number }
  | { type: 'tab.back'; tabId: string; timeoutMs?: number }
  | { type: 'tab.outline'; tabId: string; budgetTokens?: number }
  | { type: 'tab.find'; tabId: string; text: string }
  | { type: 'tab.html'; tabId: string; target: string }
  | { type: 'tab.click'; tabId: string; target: string; visual?: boolean; timeoutMs?: number }
  | { type: 'tab.fill'; tabId: string; target: string; value: string; visual?: boolean; timeoutMs?: number }
  | { type: 'tab.press'; tabId: string; key: string; target?: string; visual?: boolean; timeoutMs?: number }
  | { type: 'tab.scroll'; tabId: string; direction: 'down' | 'up' | 'bottom'; timeoutMs?: number }
  | { type: 'tab.eval'; tabId: string; expression: string }
  | {
      type: 'tab.download';
      tabId: string;
      /** Element ref/selector to click, or omitted when `url` is given. */
      target?: string;
      /** Direct download URL to trigger, when not clicking an element. */
      url?: string;
      /** Absolute destination file path (resolved against client CWD). */
      outPath: string;
      visual?: boolean;
      timeoutMs?: number;
    }
  | { type: 'tab.attend'; tabId: string; reason?: string; timeoutMs?: number }
  | { type: 'tab.close'; tabId?: string; profile?: string; all?: boolean };

export type TabActionResponse =
  | { type: 'tab.opened'; tab: TabSummary }
  | { type: 'tab.list'; tabs: TabSummary[] }
  | { type: 'tab.page'; tabId: string; url: string; title: string; message: string; newPopups?: TabSummary[] }
  | { type: 'tab.outline'; tabId: string; url: string; title: string; outline: string; cut: number }
  | { type: 'tab.find'; tabId: string; matches: string[] }
  | { type: 'tab.html'; tabId: string; html: string }
  | { type: 'tab.eval'; tabId: string; result: unknown }
  | { type: 'tab.download'; tabId: string; file: string; bytes: number; url: string }
  | { type: 'tab.closed'; closed: string[] }
  | { type: 'tab.error'; message: string; exitCode?: number };

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
  | { type: 'release'; profileDir: string; command: string; force: boolean }
  | { type: 'cooldown-clear'; recipes: string[] }
  | TabActionRequest;

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
  tabs?: TabSummary[];
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
  | { type: 'attention'; runId: string; reason: string; kind?: string; label?: string; line?: string; page: number; url: string }
  | { type: 'attention-resolved'; runId: string }
  | { type: 'still-blocked'; runId: string }
  | { type: 'waiting-attention'; holder: string }
  | { type: 'done'; exitCode: number }
  | { type: 'status'; status: DaemonStatus }
  | { type: 'released'; profile: string; running: number; queued: number; open: boolean }
  | { type: 'result'; ok: boolean; message?: string }
  | TabActionResponse;

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
