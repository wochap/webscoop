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
}

export interface OpenOptions {
  /** Extra Chromium arguments, appended to the adapter defaults. */
  args?: string[];
  /** Ignore the page's Content-Security-Policy, so injected scripts and styles run. Recorder only. */
  bypassCSP?: boolean;
  /** Open a DevTools protocol port, so tests can attach with `connectOverCDP`. */
  remoteDebuggingPort?: number;
}

export interface GotoOptions {
  timeoutMs: number;
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
  close(): Promise<void>;
}

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
  /** Expose `window[name](msg)` to the page; the page receives the handler's result. Exposing a name again replaces its handler. */
  expose(name: string, fn: (msg: unknown) => Promise<unknown>): Promise<void>;
  /** Deliver a message to the injected page (`window.__webscoopPage.dispatch`). */
  dispatch(msg: unknown): Promise<void>;
  /** Called with the new URL after each main frame navigation. Returns an unsubscribe function. */
  onNavigated(cb: (url: string) => void): () => void;
  /** Called once when the page or browser is closed by the user. Returns an unsubscribe function. */
  onClosed(cb: () => void): () => void;
  /** Bounding box of an element in CSS pixels. */
  geometry(ref: ElementRef): Promise<Geometry>;
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

export interface LlmPort {
  /** Whether an endpoint is configured and usable. */
  readonly available: boolean;
  complete(messages: ChatMessage[], opts?: { maxTokens?: number; signal?: AbortSignal }): Promise<string>;
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

export interface WindowPort {
  show(): Promise<void>;
  hide(): Promise<void>;
}

export class NoopWindow implements WindowPort {
  async show(): Promise<void> {}
  async hide(): Promise<void> {}
}

export class NoopNotify implements NotifyPort {
  async notify(): Promise<void> {}
}

export class NoopLlm implements LlmPort {
  readonly available = false;
  async complete(): Promise<string> {
    throw new Error('no LLM endpoint is configured');
  }
}
