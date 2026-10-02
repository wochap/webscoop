import { resolveFirst } from '../extract';
import type { ElementRef, Session } from '../ports';
import type { Target } from '../recipe/schema';

/** One popup of a run, in the order popups opened. */
interface Popup {
  session: Session;
  /** Position in the order of every popup the run saw. */
  seq: number;
}

/**
 * The windows of a run: the main window, where extraction happens, and the
 * popups opened from it or from its popups, in the order they opened.
 */
export class RunWindows {
  private readonly popups: Popup[] = [];
  private readonly waiters = new Set<() => void>();
  private seq = 0;
  private readonly off: () => void;

  constructor(readonly main: Session) {
    this.off = main.onPopup((session) => {
      this.popups.push({ session, seq: ++this.seq });
      for (const wake of [...this.waiters]) wake();
    });
  }

  /** A mark for `newestPopupSince`: popups opened after it are newer. */
  mark(): number {
    return this.seq;
  }

  /** The main window and every popup still open, oldest popup first. */
  open(): Session[] {
    return [this.main, ...this.popups.filter((p) => !p.session.isClosed()).map((p) => p.session)];
  }

  /** The newest popup opened after the mark, or null when none did or it has closed. */
  newestPopupSince(mark: number): Session | null {
    const newest = this.popups.filter((p) => p.seq > mark).at(-1);
    return newest && !newest.session.isClosed() ? newest.session : null;
  }

  /** Whether any popup opened after the mark, open or closed by now. */
  popupOpenedSince(mark: number): boolean {
    return this.popups.some((p) => p.seq > mark);
  }

  /** Wait up to `timeoutMs` for a popup opened after the mark. */
  async waitForPopup(mark: number, timeoutMs: number): Promise<Session | null> {
    const found = this.newestPopupSince(mark);
    if (found || this.popupOpenedSince(mark)) return found;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
    return this.newestPopupSince(mark);
  }

  /** Stop listening for popups, leaving them open. */
  release(): void {
    this.off();
  }

  /** Close every popup still open and stop listening. */
  async close(): Promise<void> {
    this.off();
    for (const popup of this.popups) if (!popup.session.isClosed()) await popup.session.close().catch(() => {});
  }
}

/**
 * Whether a target resolves to at least one element in a window, with its
 * stored candidates only: no healing ladder and no snapshot, so checking it
 * at every checkpoint stays cheap. A closed window holds nothing.
 */
export async function targetPresent(session: Session, target: Target): Promise<boolean> {
  if (session.isClosed()) return false;
  try {
    let within: ElementRef | undefined;
    if (target.frame) {
      const frame = await resolveFirst(session, target.frame.selectors);
      const root = frame ? await session.frameRoot(frame.refs[0]!, { timeoutMs: 1000 }) : null;
      if (!root) return false;
      within = root;
    }
    return (await resolveFirst(session, target.selectors, within)) !== null;
  } catch {
    // The window is mid-navigation or closing.
    return false;
  }
}
