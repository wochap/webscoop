import type { ElementRef, SerializedElement, Session } from '../ports';
import { annotate, type AnnotatedNode } from '../selectors/annotated';
import type { Viewport } from './score';
import type { HealContext, HealTarget } from './types';

/** Snapshots of scopes, taken once per scope for the lifetime of the cache. */
export class SnapshotCache {
  private readonly cache = new Map<ElementRef | undefined, Promise<AnnotatedNode>>();

  constructor(private readonly session: Session) {}

  get(within?: ElementRef): Promise<AnnotatedNode> {
    let hit = this.cache.get(within);
    if (!hit) {
      hit = this.session.snapshot(within).then((tree) => {
        if (tree.type !== 'element') throw new Error('the page snapshot is empty');
        return annotate(tree as SerializedElement);
      });
      this.cache.set(within, hit);
      hit.catch(() => this.cache.delete(within));
    }
    return hit;
  }
}

export function healContext(opts: {
  session: Session;
  cache: SnapshotCache;
  threshold: number;
  within?: ElementRef;
  containers?: readonly ElementRef[];
  probe?: () => Promise<ElementRef | undefined>;
  outerAncestors?: readonly string[];
  viewport?: Viewport;
  note?: (target: HealTarget, text: string) => void;
}): HealContext {
  return {
    session: opts.session,
    ...(opts.within ? { within: opts.within } : {}),
    ...(opts.containers ? { containers: opts.containers } : {}),
    ...(opts.probe ? { probe: opts.probe } : {}),
    snapshotOf: (within) => opts.cache.get(within),
    outerAncestors: opts.outerAncestors ?? [],
    threshold: opts.threshold,
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
}
