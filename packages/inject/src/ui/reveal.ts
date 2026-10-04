import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useSnapshot } from './context';

/**
 * Scroll the closest panel body just enough to show `el`: nothing when it is
 * fully visible, its top when it is above or taller than the body, its bottom
 * when it is below. Only the body scrolls, never the page.
 */
export function revealInBody(el: Element): void {
  const body = el.closest('.ws-body');
  if (!body) return;
  const box = body.getBoundingClientRect();
  const card = el.getBoundingClientRect();
  if (card.top >= box.top && card.bottom <= box.bottom) return;
  if (card.top < box.top || card.height > box.height) body.scrollTop += card.top - box.top;
  else body.scrollTop += card.bottom - box.bottom;
}

/** Reveal the element behind `ref` in the panel body after each page pick, again on the next frame for late layout. */
export function useRevealOnPick(ref: RefObject<Element | null>, enabled = true): void {
  const { pickSeq } = useSnapshot().ui;
  const seen = useRef(pickSeq);
  useLayoutEffect(() => {
    if (seen.current === pickSeq) return;
    seen.current = pickSeq;
    const el = ref.current;
    if (!enabled || !el) return;
    revealInBody(el);
    const frame = requestAnimationFrame(() => revealInBody(el));
    return () => cancelAnimationFrame(frame);
  }, [pickSeq, enabled, ref]);
}
