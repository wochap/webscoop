/** A CSS pixel box in the page's viewport, as Playwright's `boundingBox()` returns it, including for elements inside iframes. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Something that measures its first matched element in page coordinates; a Playwright `Locator` satisfies it. */
export interface Measurable {
  boundingBox(): Promise<Box | null>;
}
