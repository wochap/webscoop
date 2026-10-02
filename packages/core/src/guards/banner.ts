import type { Session } from '../ports';
import type { GuardKind } from '../recipe/schema';

/** What needs the user: a guard kind, or an `await-user` step. */
export type AttentionKind = GuardKind | 'await-user';

/** What the interactive banner shows about a guard or an `await-user` step. */
export interface GuardBannerInfo {
  kind: AttentionKind;
  /** The `await-user` step's label, shown in place of the guard kind. */
  label?: string;
  reason: string;
  page: number;
  url: string;
  /** When the guard timeout runs out, in epoch milliseconds. */
  deadline: number;
  /** The window is a popup of the run, which may close itself once the user is done; closing it is not an abort. */
  popup?: boolean;
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
