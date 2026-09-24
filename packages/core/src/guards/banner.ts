import type { Session } from '../ports';
import type { GuardKind } from '../recipe/schema';

/** What the interactive banner shows about a guard. */
export interface GuardBannerInfo {
  kind: GuardKind;
  reason: string;
  page: number;
  url: string;
  /** When the guard timeout runs out, in epoch milliseconds. */
  deadline: number;
}

/** Hooks for the banner's buttons. */
export interface GuardBannerHooks {
  /** Continue: re-evaluate the guard at once. */
  onContinue(cb: () => void): void;
  /** Abort: end the run. */
  onAbort(cb: () => void): void;
}

/** Shows the guard banner over the page during an interactive run. */
export interface GuardBannerHandler {
  show(session: Session, info: GuardBannerInfo): Promise<GuardBannerHooks>;
  hide(): Promise<void>;
}
