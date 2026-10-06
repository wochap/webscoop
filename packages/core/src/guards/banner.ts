import type { Session } from '../ports';
import type { STEP_UNTILS } from '../recipe/constants';
import type { GuardKind, Strategy } from '../recipe/schema';

/** What needs the user: a guard kind, or an `await-user` step. */
export type AttentionKind = GuardKind | 'await-user';

/** What the interactive banner shows about a guard or an `await-user` step. */
export interface GuardBannerInfo {
  kind: AttentionKind;
  /** The `await-user` step's label, shown in place of the guard kind. */
  label?: string;
  /** The `await-user` step's condition: whether the run waits for `target` to appear or disappear. */
  until?: (typeof STEP_UNTILS)[number];
  /** The `await-user` step target's primary selector. */
  target?: { strategy: Strategy; value: string };
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
