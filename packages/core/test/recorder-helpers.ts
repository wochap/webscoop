import { readFileSync } from 'node:fs';
import {
  annotate,
  descendantsOf,
  detach,
  loadRecipe,
  pathOf,
  RecorderController,
  RecorderEmitter,
  saveRecipe,
  selectionOf,
  type AnnotatedNode,
  type Draft,
  type Recipe,
  type RecipeSummary,
  type SerializedElement,
  type StoragePort,
} from '../src';
import { FakeBrowser, type FakeInteractiveSession } from '../src/testing';

export const CATALOG = 'http://127.0.0.1:4777/catalog?tier=0';

export function referenceRecipe(): Recipe {
  return loadRecipe(readFileSync(new URL('../../cli/fixtures/playground-catalog.json', import.meta.url), 'utf8'));
}

export class MemoryStorage implements StoragePort {
  readonly files = new Map<string, string>();
  async list(): Promise<RecipeSummary[]> {
    return [...this.files.values()].map((text) => {
      const r = loadRecipe(text);
      return { name: r.name, url: r.url, fieldCount: r.fields.length, modified: new Date(0) };
    });
  }
  async load(ref: string): Promise<Recipe> {
    const text = this.files.get(ref);
    if (!text) throw new Error(`no recipe ${ref}`);
    return loadRecipe(text);
  }
  async save(recipe: Recipe): Promise<void> {
    this.files.set(recipe.name, saveRecipe(recipe));
  }
}

export interface Harness {
  controller: RecorderController;
  session: FakeInteractiveSession;
  storage: MemoryStorage;
  emitter: RecorderEmitter;
  events: { name: string; payload: unknown }[];
  /** The page's view of the DOM, annotated like the injected bundle does. */
  page: AnnotatedNode;
  snapshot: SerializedElement;
  /** Play the page picking the element. */
  pick(node: AnnotatedNode, containerPath?: number[] | null): Promise<unknown>;
  send(msg: unknown): Promise<unknown>;
}

export async function harness(dom: SerializedElement, draft: Draft, url = CATALOG): Promise<Harness> {
  const browser = new FakeBrowser({ [url]: dom });
  const session = await browser.open('/profile');
  const storage = new MemoryStorage();
  const emitter = new RecorderEmitter();
  const events: { name: string; payload: unknown }[] = [];
  emitter.onAny((name, payload) => events.push({ name, payload }));
  let tick = 0;
  const controller = new RecorderController({
    session,
    storage,
    bundle: '/* recorder */',
    draft,
    emitter,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, (tick += 5))),
    pathFor: (name) => `/recipes/${name}.json`,
  });
  await controller.start();
  const page = annotate(dom);
  const send = (msg: unknown) => session.callHost(msg);
  return {
    controller,
    session,
    storage,
    emitter,
    events,
    page,
    snapshot: dom,
    send,
    pick: (node, containerPath = null) =>
      send({ kind: 'picker.select', url, selection: selectionOf(node, { containerPath }), snapshot: detach(page) }),
  };
}

export const byClass = (root: AnnotatedNode, cls: string, nth = 0): AnnotatedNode =>
  descendantsOf(root).filter((n) => (n.attrs.class ?? '').split(' ').includes(cls))[nth]!;

/** Path of the item card holding a node. */
export const cardPath = (node: AnnotatedNode): number[] => {
  let cur: AnnotatedNode | null | undefined = node;
  while (cur && cur.attrs['data-testid'] !== 'product-card') cur = cur.parent;
  return pathOf(cur!);
};
