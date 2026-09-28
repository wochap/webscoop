/** A CSS pixel box in the viewport, as Playwright's `boundingBox()` returns it. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Something that runs a function over its matched elements in one page call; a Playwright `Locator` satisfies it. */
export interface Measurable {
  evaluateAll<R>(fn: (els: Element[]) => R): Promise<R>;
}

/**
 * The first matched element's box, or null when nothing matches or it has no layout.
 * One page call, without Patchright's full-document element finder.
 */
export function boxOf(target: Measurable): Promise<Box | null> {
  return target.evaluateAll((els) => {
    const el = els[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0 && el.getClientRects().length === 0 ? null : { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}
