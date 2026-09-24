import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GuardContextView } from '@webscoop/core/page';
import { useDrawerHost } from './context';

/** The countdown switches to the warning tone below this much time left. */
export const WARN_UNDER_MS = 90_000;

const KIND_LABEL: Record<GuardContextView['kind'], string> = {
  login: 'Login required',
  captcha: 'Bot check',
  'zero-fields': 'Nothing found',
};

const KIND_HINT: Record<GuardContextView['kind'], string> = {
  login: 'Log in in this window; the run resumes by itself.',
  captcha: 'Solve the check in this window; the run resumes by itself.',
  'zero-fields': 'Get past the interstitial in this window; the run resumes by itself.',
};

/** `m:ss`, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Time left until `deadline`, re-rendered every second. */
export function Countdown({ deadline, now = Date.now }: { deadline: number; now?: () => number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = deadline - now();
  const warn = left < WARN_UNDER_MS;
  return (
    <span className={`ws-pill ws-countdown ${warn ? 'ws-tone-warn' : 'ws-tone-neutral'}`} data-ws="countdown" data-tone={warn ? 'warn' : 'neutral'} title="Time left before the run gives up">
      {formatCountdown(left)}
    </span>
  );
}

/** Fixed bar across the top of the page, outside the sidebar, while the run waits on a guard. */
export function GuardBanner({
  context,
  onContinue,
  onAbort,
  now,
}: {
  context: GuardContextView;
  onContinue: () => void;
  onAbort: () => void;
  now?: () => number;
}) {
  const host = useDrawerHost();
  const banner = (
    <div id="ws-guard" data-ws="guard-banner" data-kind={context.kind} role="alert">
      <span className="ws-badge ws-tone-warn" data-ws="guard-kind">
        {KIND_LABEL[context.kind]}
      </span>
      <span className="ws-col ws-spacer ws-guard-text">
        <span className="ws-title ws-ellipsis" data-ws="guard-reason">
          Page {context.page}: {context.reason}
        </span>
        <span className="ws-meta ws-ellipsis">{KIND_HINT[context.kind]}</span>
      </span>
      <Countdown deadline={context.deadline} {...(now ? { now } : {})} />
      <button type="button" className="ws-btn ws-btn-ghost" onClick={onAbort} data-ws="guard-abort" title="Stop the run">
        Abort
      </button>
      <button type="button" className="ws-btn ws-btn-primary" onClick={onContinue} data-ws="guard-continue" title="Check again now">
        Continue
      </button>
    </div>
  );
  return host ? createPortal(banner, host) : banner;
}

/** Sidebar body while the run waits: what it is waiting for. */
export function GuardPanel({ context }: { context: GuardContextView }) {
  return (
    <section className="ws-card ws-col" data-ws="guard-panel">
      <span className="ws-caps">Run paused</span>
      <span className="ws-title">{KIND_LABEL[context.kind]}</span>
      <span className="ws-meta">{KIND_HINT[context.kind]}</span>
      <span className="ws-mono-sm ws-ellipsis" title={context.url}>
        {context.url}
      </span>
    </section>
  );
}
