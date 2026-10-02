import { useEffect, useState } from 'react';
import type { FillPreview, NewStep } from '@webscoop/core/page';
import { useActions } from './context';
import { Icon } from './icons';

/** Element kinds a fill sets, as the panel lists them. */
export const FILL_SETS = ['text', 'textarea', 'select', 'checkbox', 'radio', 'combobox', 'OTP boxes', 'contenteditable', 'file'];

const KIND_LABELS: Record<FillPreview['kind'], string> = {
  file: 'file',
  toggle: 'checkbox',
  radio: 'radio',
  select: 'select',
  combobox: 'combobox',
  otp: 'OTP boxes',
  text: 'text',
  none: 'nothing',
};

/** The variable name a password or file fill proposes: the input's label, `name`, or `id`, as an identifier. */
export function proposedVarName(fill: FillPreview): string {
  const base = fill.hint
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z_]+|_+$/g, '');
  return base || (fill.password ? 'password' : fill.kind === 'file' ? 'file' : 'value');
}

/** The step "Add to flow as fill" sends: a password makes a secret, a file input an empty path variable, else the literal or a named variable. */
export function fillStep(fill: FillPreview, value: string, variable: string | null): NewStep {
  if (fill.kind === 'file') return { kind: 'fill', variable: { name: fill.hint || 'file', type: 'path' } };
  if (fill.password) return { kind: 'fill', value, variable: { name: fill.hint || 'password', secret: true } };
  return { kind: 'fill', value, ...(variable ? { variable: { name: variable } } : {}) };
}

/**
 * "Add to flow as fill" for a picked form element: what the fill will set,
 * prefilled from the element's current state, stored as literal text unless
 * made a variable. A password becomes a secret variable, a file input a path
 * variable the user types a path for in the variables list.
 */
export function FillPick({ fill, flowName, disabled = false }: { fill: FillPreview; flowName: string | null; disabled?: boolean }) {
  const actions = useActions();
  const [value, setValue] = useState(fill.value);
  const [variable, setVariable] = useState<string | null>(null);
  useEffect(() => {
    setValue(fill.value);
    setVariable(null);
  }, [fill.value, fill.kind, fill.hint]);
  const name = proposedVarName(fill);
  const add = () => void actions.send({ kind: 'draft.addStep', step: fillStep(fill, value, variable?.trim() || null) });
  return (
    <div className="ws-col ws-fill-pick" data-ws="pick-fill">
      <div className="ws-row ws-fill-head">
        <span className="ws-label">Add to flow</span>
        <span className="ws-meta">into {flowName ?? 'a new flow'}</span>
        <span className="ws-spacer" />
        <span className="ws-badge" data-ws="pick-fill-kind">
          fill · {KIND_LABELS[fill.kind]}
        </span>
      </div>
      {fill.kind === 'file' ? (
        <>
          <div className="ws-row ws-fill-value">
            <code className="ws-chip-var" data-ws="pick-fill-var">{`{${name}}`}</code>
            <span className="ws-meta">path typed in the variables list</span>
          </div>
          <span className="ws-meta" data-ws="pick-fill-note">
            File inputs take a path variable. Its default path is saved with the recipe (paths are not secret); the runner uploads that file.
          </span>
        </>
      ) : fill.password ? (
        <>
          <div className="ws-row ws-fill-value">
            <code className="ws-chip-var" data-ws="pick-fill-var">{`{${name}}`}</code>
            <span className="ws-meta">{value ? '••••••••' : 'empty'}</span>
          </div>
          <span className="ws-meta" data-ws="pick-fill-note">
            Text variable created, marked secret. Masked everywhere, kept for this session only, never saved.
          </span>
        </>
      ) : (
        <>
          <div className="ws-row ws-fill-value">
            {fill.kind === 'select' ? (
              <textarea className="ws-input ws-fill-input" rows={2} value={value} onChange={(e) => setValue(e.target.value)} data-ws="pick-fill-value" aria-label="Fill value" />
            ) : (
              <input className="ws-input ws-fill-input" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} data-ws="pick-fill-value" aria-label="Fill value" />
            )}
            {variable === null ? (
              <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => setVariable(name)} data-ws="pick-fill-make-var">
                make variable
              </button>
            ) : (
              <input
                className="ws-input ws-fill-var-name"
                value={variable}
                onChange={(e) => setVariable(e.target.value)}
                spellCheck={false}
                aria-label="Variable name"
                data-ws="pick-fill-var-name"
              />
            )}
          </div>
          <span className="ws-meta" data-ws="pick-fill-note">
            Prefilled with what is in the field now. Stored as literal text unless you make it a variable.
          </span>
        </>
      )}
      <button type="button" className="ws-btn ws-btn-outline ws-btn-wide" onClick={add} disabled={disabled} data-ws="pick-as-fill">
        <Icon name="record" size={12} />
        Add to flow as fill
      </button>
      <span className="ws-meta" data-ws="pick-fill-kinds">
        Fill sets {FILL_SETS.join(' · ')}
      </span>
    </div>
  );
}
