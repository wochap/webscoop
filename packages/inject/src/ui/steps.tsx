import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { STEP_KINDS, type DraftStep, type StepPatch, type VarValue } from '@webscoop/core/page';
import { useActions } from './context';
import { ZeroMatchWarning } from './fields';
import { Toggle } from './items';
import { Kbd } from './shell';

type StepKind = DraftStep['kind'];

/** Kinds whose value the user edits, with the placeholder the input shows. */
const VALUE_HINT: Partial<Record<StepKind, string>> = {
  type: 'Text to type, {var} allowed',
  select: 'Option value or label',
  press: 'Enter, Escape, Tab, or a key',
  wait: 'Milliseconds',
};

export function KindSelect({ value, onChange }: { value: StepKind; onChange: (kind: StepKind) => void }) {
  return (
    <select className="ws-select" value={value} aria-label="Step kind" onChange={(e) => onChange(e.target.value as StepKind)} data-ws="step-kind">
      {STEP_KINDS.map((k) => (
        <option key={k} value={k}>
          {k}
        </option>
      ))}
    </select>
  );
}

/** Short description of what a step acts on: role and name, else tag and text, else the primary selector. */
export function targetSummary(step: DraftStep): string {
  const target = step.target;
  if (!target) return step.kind === 'press' ? 'focused element' : 'no target';
  const fp = target.fingerprint;
  if (fp?.role && fp.name) return `${fp.role} "${fp.name}"`;
  if (fp?.textSample) return `${fp.tag} "${fp.textSample.slice(0, 40)}"`;
  const primary = target.selectors[0]!;
  return `${primary.strategy}=${primary.value}`;
}

/** The step's value, edited as text; variable chips insert `{name}` at the caret. */
function ValueField({ step, index, vars }: { step: DraftStep; index: number; vars: VarValue[] }) {
  const actions = useActions();
  const [value, setValue] = useState(step.value ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(step.value ?? ''), [step.value]);
  const commit = (next = value) => {
    if (next !== (step.value ?? '')) void actions.send({ kind: 'draft.updateStep', index, patch: { value: next } });
  };
  const insert = (name: string) => {
    const el = input.current;
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? at;
    const next = `${value.slice(0, at)}{${name}}${value.slice(end)}`;
    setValue(next);
    commit(next);
  };
  return (
    <div className="ws-row">
      <input
        ref={input}
        className={`ws-input ws-input-sm ws-mono-sm ws-spacer${step.error ? ' ws-invalid' : ''}`}
        value={value}
        placeholder={VALUE_HINT[step.kind]}
        aria-label="Step value"
        data-ws="step-value"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {step.kind === 'type' &&
        vars.map((v) => (
          <button
            key={v.name}
            type="button"
            className="ws-chip"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(v.name)}
            title={`Insert {${v.name}}`}
            data-ws={`step-var-${v.name}`}
          >
            {`{${v.name}}`}
          </button>
        ))}
    </div>
  );
}

export function StepRow({
  step,
  index,
  vars,
  focused,
  repicking,
  onFocus,
  dragging,
  dragProps,
}: {
  step: DraftStep;
  index: number;
  vars: VarValue[];
  focused: boolean;
  repicking: boolean;
  onFocus: () => void;
  dragging: boolean;
  dragProps: Omit<HTMLAttributes<HTMLDivElement>, 'className'>;
}) {
  const actions = useActions();
  const update = (patch: StepPatch) => void actions.send({ kind: 'draft.updateStep', index, patch });
  const hasValue = step.kind in VALUE_HINT;
  return (
    <div
      {...dragProps}
      className={`ws-field${focused ? ' ws-field-focused' : ''}${dragging ? ' ws-field-dragging' : ''}`}
      data-ws="step"
      data-kind={step.kind}
      tabIndex={-1}
      draggable
      onFocus={onFocus}
      onClick={onFocus}
    >
      <div className="ws-row">
        <span className="ws-handle" aria-hidden="true" title="Drag to reorder (Alt+Up, Alt+Down)">
          ⋮⋮
        </span>
        <span className="ws-num" aria-hidden="true">
          {index + 1}
        </span>
        <KindSelect value={step.kind} onChange={(kind) => update({ kind })} />
        <span className="ws-meta ws-ellipsis ws-spacer" title={targetSummary(step)} data-ws="step-target">
          {targetSummary(step)}
        </span>
        {step.target && (
          <span className={`ws-num${step.count === 0 ? ' ws-num-zero' : ''}`} data-ws="step-count" title="Matches of the target on this page">
            {step.count ?? '…'}
          </span>
        )}
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Replay step ${index + 1}`} title="Run this step on the page" onClick={() => void actions.send({ kind: 'draft.replayStep', index })} data-ws="step-replay">
          ▶
        </button>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Remove step ${index + 1}`} onClick={() => void actions.send({ kind: 'draft.removeStep', index })} data-ws="step-remove">
          ×
        </button>
      </div>
      {hasValue && <ValueField step={step} index={index} vars={vars} />}
      {step.error && (
        <span className="ws-error" data-ws="step-error">
          {step.error}
        </span>
      )}
      <div className="ws-row">
        <span className="ws-row ws-spacer" title="Run after every page load, not only the first">
          <span className="ws-meta">every page</span>
          <Toggle on={step.when === 'every-page'} onChange={(on) => update({ when: on ? 'every-page' : 'first-page' })} label="Every page" testId="step-every-page" />
        </span>
        <span className="ws-row" title="Skip the step when its element is missing">
          <span className="ws-meta">optional</span>
          <Toggle on={step.optional} onChange={(optional) => update({ optional })} label="Optional" testId="step-optional" />
        </span>
      </div>
      {repicking && <span className="ws-meta">Pick the element for this step on the page.</span>}
      {step.count === 0 && !repicking && (
        <ZeroMatchWarning
          optional={step.optional}
          onRepick={() => {
            void actions.send({ kind: 'draft.repickTarget', target: 'step', index });
            actions.startPicking();
          }}
          onOptional={() => update({ optional: true })}
        />
      )}
    </div>
  );
}

/** Steps in replay order; drag or Alt+Up and Alt+Down reorder. */
export function StepList({
  steps,
  vars,
  focused,
  repick,
  browsing,
  onFocus,
}: {
  steps: DraftStep[];
  vars: VarValue[];
  focused: number | null;
  repick: number | null;
  browsing: boolean;
  onFocus: (index: number | null) => void;
}) {
  const actions = useActions();
  const [dragging, setDragging] = useState<number | null>(null);
  const toggle = browsing ? (
    <button type="button" className="ws-btn ws-btn-sm ws-btn-primary" onClick={actions.stopBrowsing} data-ws="browse-stop">
      Stop recording <Kbd>B</Kbd>
    </button>
  ) : (
    <button type="button" className="ws-btn ws-btn-sm" onClick={actions.startBrowsing} data-ws="browse">
      Record steps <Kbd>B</Kbd>
    </button>
  );
  return (
    <section className="ws-col" data-ws="steps" data-browsing={browsing}>
      <div className="ws-row ws-row-between">
        <span className="ws-caps">Steps{steps.length > 0 ? ` · ${steps.length}` : ''}</span>
        {toggle}
      </div>
      {browsing && <span className="ws-meta">Use the page: clicks, typing, choices, and Enter are recorded. Esc stops.</span>}
      {steps.length === 0 && !browsing && <span className="ws-meta">No steps. Record the clicks and typing a page needs before its data shows.</span>}
      {steps.map((step, index) => (
        <StepRow
          key={index}
          step={step}
          index={index}
          vars={vars}
          focused={focused === index}
          repicking={repick === index}
          onFocus={() => onFocus(index)}
          dragging={dragging === index}
          dragProps={{
            onDragStart: (e) => {
              setDragging(index);
              e.dataTransfer?.setData('text/plain', String(index));
            },
            onDragOver: (e) => e.preventDefault(),
            onDrop: (e) => {
              e.preventDefault();
              const from = dragging ?? Number(e.dataTransfer?.getData('text/plain'));
              setDragging(null);
              if (Number.isInteger(from) && from !== index) {
                void actions.send({ kind: 'draft.moveStep', from, to: index });
                onFocus(index);
              }
            },
            onDragEnd: () => setDragging(null),
          }}
        />
      ))}
    </section>
  );
}
