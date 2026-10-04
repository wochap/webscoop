import type { Recipe, SelectorCandidate } from './recipe/schema';

/** Opaque handle to one element in a live or serialized page. Adapters extend it. */
export interface ElementRef {
  /** Short description for logs, e.g. `testid=product-card >> nth=3`. */
  readonly description: string;
}

/** A DOM subtree in plain data form, used by tests and later by healing. */
export type SerializedNode = SerializedElement | SerializedText;

export interface SerializedElement {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: SerializedNode[];
  /** Bounding box in viewport CSS pixels, rounded, when the adapter measured it. */
  bbox?: Geometry;
}

export interface SerializedText {
  type: 'text';
  text: string;
}

export interface PageInfo {
  /** Final URL after redirects. */
  url: string;
  title: string;
  status: number | null;
  /** Set when the navigation started a download instead of loading a document; the page keeps its previous document. */
  download?: true;
}

export interface OpenOptions {
  /** Extra Chromium arguments, appended to the adapter defaults. */
  args?: string[];
  /** Ignore the page's Content-Security-Policy, so injected scripts and styles run. Recorder only. */
  bypassCSP?: boolean;
  /** Open a DevTools protocol port, so tests can attach with `connectOverCDP`. */
  remoteDebuggingPort?: number;
  /** Route the browser's traffic through this proxy. */
  proxy?: ProxySettings;
  /** IANA timezone the page sees, e.g. `Europe/Madrid`. */
  timezone?: string;
  /** BCP 47 locale for `navigator.language` and `Accept-Language`, e.g. `es-ES`. */
  locale?: string;
  /** Humanized input: curved pointer paths, typing rhythm, wheel scrolling, think times, and a page dwell. */
  humanize?: boolean;
  /** Absolute directory where the session saves downloads; created on the first save. */
  downloadDir?: string;
}

export interface ProxySettings {
  /** Proxy URL without credentials, e.g. `http://127.0.0.1:3128`. */
  server: string;
  username?: string;
  password?: string;
  /** Comma-separated hosts that bypass the proxy. */
  bypass?: string;
}

export interface GotoOptions {
  timeoutMs: number;
}

export interface SettleOptions {
  timeoutMs: number;
  /** URL before the action; a different current URL means a navigation to wait for. */
  previousUrl?: string;
}

export interface ReadOptions {
  /** Attribute to read instead of content. */
  attr?: string;
  mode: 'text' | 'html';
}

export interface BrowserPort {
  open(profileDir: string, opts?: OpenOptions): Promise<Session>;
}

export interface Session {
  goto(url: string, opts: GotoOptions): Promise<PageInfo>;
  /** All elements matching the candidate, in document order, optionally inside `within`. */
  resolve(candidate: SelectorCandidate, within?: ElementRef): Promise<ElementRef[]>;
  /** Raw string for an element: text content, inner HTML, or an attribute (empty when absent). */
  read(ref: ElementRef, opts: ReadOptions): Promise<string>;
  /** Whether two refs point at the same element. */
  same(a: ElementRef, b: ElementRef): Promise<boolean>;
  snapshot(within?: ElementRef): Promise<SerializedNode>;
  /**
   * The `<html>` element of a same-origin iframe's document, once it has
   * loaded, to pass as `within`. Null when the element is not such an iframe
   * or its document does not load within the navigation timeout. Inside it an
   * xpath starting with `/` is absolute in the iframe's document.
   */
  frameRoot(frame: ElementRef, opts?: { timeoutMs: number }): Promise<ElementRef | null>;
  /** Scroll the element into view and click it. */
  click(ref: ElementRef): Promise<void>;
  /**
   * Scroll the element into view and move the real mouse over it, so the page
   * gets trusted pointer events. Resolves quietly when it cannot hover.
   */
  hover(ref: ElementRef): Promise<void>;
  /**
   * Set the element as a `fill` step does, by its kind (see `classifyFillElement`):
   * files for a file input, or for the chooser another element opens when
   * `opts.files` is set; a checked state; a select's options; a combobox
   * option; one-character boxes; or typed text. Throws `FillUnresolvedError`
   * when no chooser or combobox option appears.
   */
  fill(ref: ElementRef, value: string, opts?: FillOptions): Promise<void>;
  /** Press a key (`Enter`, `Escape`, `Tab`, or one character) on the element, or on the focused element without one. */
  press(key: string, ref?: ElementRef): Promise<void>;
  /** Scroll the document to its bottom. */
  scrollToBottom(): Promise<void>;
  /**
   * Wait for the page to settle after an action: for the navigation when one
   * started, else briefly for network idle. Rejects with `TimeoutError` when a
   * navigation does not finish in time.
   */
  settle(opts: SettleOptions): Promise<PageInfo>;
  /** Current URL of the page. */
  url(): Promise<string>;
  /** Bring the browser window to the front, where the compositor allows it. */
  focus(): Promise<void>;
  /** Set the current document's title, so compositor rules can match the window before the first navigation. */
  setTitle(title: string): Promise<void>;
  /** Visible text of the document body, capped at `PAGE_TEXT_LIMIT` characters. */
  pageText(): Promise<string>;
  /**
   * Called with each popup the page opens (`window.open`, `target=_blank`),
   * as a session of its own; popups of a popup are reported too. Returns an
   * unsubscribe function.
   */
  onPopup(cb: (popup: Session) => void): () => void;
  /** Whether the page is closed, by the run or by the page itself (a popup that called `window.close`). */
  isClosed(): boolean;
  /**
   * Mark in the download queue of this page and its popups: a later
   * `nextDownload({ since })` takes only downloads started after the mark.
   */
  downloadMark(): number;
  /**
   * Take the oldest download of this page or its popups that started at or
   * after `since` and that no earlier call took, waiting up to `timeoutMs` for
   * one to start and finish. With `name`, the file is renamed to it (with the
   * ` (n)` collision rule). Rejects with `DownloadError` when none starts in
   * time or the download fails.
   */
  nextDownload(opts: NextDownloadOptions): Promise<SavedDownload>;
  /** Called with each download of this page or its popups once it is saved under its suggested name. Returns an unsubscribe function. */
  onDownload(cb: (download: SavedDownload) => void): () => void;
  /** Wait, up to `timeoutMs`, for downloads of this page and its popups that are still in progress. */
  settleDownloads(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface NextDownloadOptions {
  since: number;
  timeoutMs: number;
  /** File name to save as, without directories. */
  name?: string;
}

/** A file a session saved in its download directory. */
export interface SavedDownload {
  /** Unique within the session's download queue, in start order. */
  id: number;
  /** Absolute path. */
  file: string;
  /** File name in the download directory. */
  name: string;
  /** Source URL of the download. */
  url: string;
  bytes: number;
  /** The session whose page started the download: the session itself or one of its popups. */
  origin: Session;
}

/** A download that did not start in time, failed, or was cancelled. */
export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Default download directory below the home directory. */
export const DEFAULT_DOWNLOAD_SUBDIR = ['Downloads', 'webscoop'] as const;

/** `name` made unique among `taken` names: `name (1).ext`, `name (2).ext`, and so on. */
export function uniqueFileName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Most characters `Session.pageText` returns. */
export const PAGE_TEXT_LIMIT = 4000;

export interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A session the recorder can talk to: it injects a script into every page,
 * receives calls from the page, and sends messages back. Healing reuses it later.
 */
export interface InteractiveSession extends Session {
  /** Run the script in the current page now and in every page loaded afterwards. */
  inject(source: string): Promise<void>;
  /** Run the script in the current document only, in the page's main world. */
  evaluate(source: string): Promise<void>;
  /**
   * Expose `window[name](msg)` to the page and to its popups; the page receives
   * the handler's result. The handler gets the id of the window that called
   * (`MAIN_WINDOW` for the page itself). Exposing a name again replaces its handler.
   */
  expose(name: string, fn: (msg: unknown, windowId: string) => Promise<unknown>): Promise<void>;
  /** Called with each popup of the page, or of its popups, as a window of its own. Returns an unsubscribe function. */
  onWindow(cb: (win: RecorderWindow) => void): () => void;
  /** Deliver a message to the injected page (`window.__webscoopPage.dispatch`). */
  dispatch(msg: unknown): Promise<void>;
  /** Called with the new URL after each main frame navigation. Returns an unsubscribe function. */
  onNavigated(cb: (url: string) => void): () => void;
  /** Called once when the page or browser is closed by the user. Returns an unsubscribe function. */
  onClosed(cb: () => void): () => void;
  /** Bounding box of an element in CSS pixels. */
  geometry(ref: ElementRef): Promise<Geometry>;
}

/** Id of a session's own page among its windows. */
export const MAIN_WINDOW = 'main';

/** A popup window of an interactive session: the recorder's script and binding reach it too. */
export interface RecorderWindow {
  /** Unique within the session; the id the binding reports for calls from this window. */
  readonly id: string;
  /** Id of the window that opened it. */
  readonly opener: string;
  readonly session: InteractiveSession;
}

export function isInteractiveSession(session: Session): session is InteractiveSession {
  const s = session as Partial<InteractiveSession>;
  return typeof s.inject === 'function' && typeof s.expose === 'function' && typeof s.dispatch === 'function';
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  maxTokens?: number;
  signal?: AbortSignal;
  /** Ask the endpoint for a JSON object (`response_format: json_object`). */
  json?: boolean;
  /** Ask a reasoning model to skip its thinking block, where the endpoint supports it. */
  noThinking?: boolean;
  /** Sampling temperature; the adapter's configured value when absent. */
  temperature?: number;
}

/** Context window assumed when the config does not set one. */
export const DEFAULT_CONTEXT_TOKENS = 32_768;

/** Token estimate without a tokenizer: characters divided by 3.5, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export type LlmErrorKind = 'unavailable' | 'network' | 'timeout' | 'http' | 'invalid-response' | 'invalid-output';

/**
 * A failed completion. `invalid-output` means the endpoint answered but the
 * answer did not fit the requested shape; every other kind means the endpoint
 * itself failed.
 */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmPort {
  /** Whether an endpoint is configured and usable. */
  readonly available: boolean;
  /** Configured context window in tokens, for prompt budgets. */
  readonly contextTokens: number;
  /** The first choice's message content. Failures reject with an `LlmError`. */
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
  estimateTokens(text: string): number;
}

export interface Notification {
  title: string;
  body: string;
  urgency?: 'low' | 'normal' | 'critical';
}

export interface NotifyPort {
  notify(notification: Notification): Promise<void>;
}

export interface RecipeSummary {
  name: string;
  url: string;
  fieldCount: number;
  modified: Date;
}

export interface StoragePort {
  list(): Promise<RecipeSummary[]>;
  /** Load a recipe by name or path. */
  load(ref: string): Promise<Recipe>;
  save(recipe: Recipe): Promise<void>;
}

/** The browser's lifecycle around a run, for the CLI's hooks. */
export interface LifecyclePort {
  /** Awaited before the browser launches, such as hooks that install a window manager rule. */
  beforeLaunch?(): Promise<void>;
  /** Main process id of the launched browser, or undefined when it is not found in time. */
  browserPid?(): Promise<number | undefined>;
  /** Extra Chromium arguments for the launch. */
  readonly extraArgs?: readonly string[];
}

export class NoopNotify implements NotifyPort {
  async notify(): Promise<void> {}
}

export class NoopLlm implements LlmPort {
  readonly available = false;
  readonly contextTokens = DEFAULT_CONTEXT_TOKENS;
  async complete(): Promise<string> {
    throw new LlmError('unavailable', 'no LLM endpoint is configured');
  }
  estimateTokens(text: string): number {
    return estimateTokens(text);
  }
}

export interface FillOptions {
  /** Absolute paths, set when the value comes only from a `path` variable: a non-file element then opens a file chooser. */
  files?: readonly string[];
  /** Longest wait for a combobox option to show. Default 30000. */
  timeoutMs?: number;
}

/** Longest wait for the file chooser a clicked element opens. */
export const FILE_CHOOSER_TIMEOUT_MS = 5000;

/** A `fill` whose target opened no file chooser, or showed no matching combobox option: it counts as not resolving. */
export class FillUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FillUnresolvedError';
  }
}

/** Files on the host, for `path` variables. */
export interface FilePort {
  /** The absolute form of a path, against the submitting command's working directory. */
  resolve(path: string): string;
  /** Whether the path names a readable file. */
  readable(path: string): Promise<boolean>;
}
