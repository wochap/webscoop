import type { ReactNode } from 'react';
import type { Mode, Toast as ToastData } from '../store';
import { useActions } from './context';

export const MODE_LABEL: Record<Mode, string> = {
  idle: 'Idle',
  picking: 'Picking',
  browsing: 'Recording steps',
  repick: 'Re-pick',
  guard: 'Paused',
  selected: 'Selected',
  items: 'Items found',
  editing: 'Editing',
  test: 'Test run',
};

export const MODE_TONE: Record<Mode, 'neutral' | 'accent' | 'ok' | 'warn'> = {
  idle: 'neutral',
  picking: 'accent',
  browsing: 'accent',
  repick: 'warn',
  guard: 'warn',
  selected: 'accent',
  items: 'ok',
  editing: 'warn',
  test: 'ok',
};

export function ModePill({ mode }: { mode: Mode }) {
  return (
    <span className={`ws-pill ws-tone-${MODE_TONE[mode]}`} data-ws="mode" data-mode={mode}>
      {MODE_LABEL[mode]}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ws-kbd">{children}</kbd>;
}

export function PanelHeader({ mode, onEnd }: { mode: Mode; onEnd: () => void }) {
  return (
    <header className="ws-header">
      <span className="ws-logo">
        web<b>scoop</b>
      </span>
      <ModePill mode={mode} />
      <span className="ws-spacer" />
      <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={onEnd} title="End the recording session" data-ws="end">
        End session
      </button>
    </header>
  );
}

export function PanelShell({ header, footer, children }: { header: ReactNode; footer: ReactNode; children: ReactNode }) {
  return (
    <>
      {header}
      <div className="ws-body" data-ws="body">
        {children}
      </div>
      {footer}
    </>
  );
}

export function PanelFooter({
  dirty,
  fieldCount = 0,
  stepCount = 0,
  canTest,
  onTest,
  onSave,
  savedName,
}: {
  dirty: boolean;
  fieldCount?: number;
  stepCount?: number;
  canTest: boolean;
  onTest: () => void;
  onSave: () => void;
  savedName: string | null;
}) {
  return (
    <footer className="ws-footer">
      <button type="button" className="ws-btn ws-btn-lg" onClick={onTest} disabled={!canTest} data-ws="test-run">
        Test run
      </button>
      <span className="ws-meta" data-ws="footer-count">
        {plural(fieldCount, 'field')}
        {stepCount > 0 ? ` · ${plural(stepCount, 'step')}` : ''}
      </span>
      <span className="ws-spacer" />
      <span className="ws-meta" data-ws="save-status">
        {dirty ? 'Unsaved changes' : savedName ? `Saved ${savedName}` : ''}
      </span>
      <button type="button" className="ws-btn ws-btn-primary ws-btn-lg" onClick={onSave} data-ws="save">
        Save <Kbd>Ctrl S</Kbd>
      </button>
    </footer>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function Toast({ toast }: { toast: ToastData }) {
  const actions = useActions();
  return (
    <div className={`ws-toast ws-toast-${toast.tone}`} role="status" data-ws="toast" data-tone={toast.tone}>
      <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{toast.text}</span>
      <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => actions.dismissToast(toast.id)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export function ToastStack({ toasts }: { toasts: ToastData[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="ws-toasts">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  );
}
