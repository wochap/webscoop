import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { DEFAULT_MAX_RETRIES, STEP_KINDS, popupClosedReason, type Draft, type DraftFlow, type DraftStep, type StepPatch, type VarValue } from '@webscoop/core/page';
import type { StepRef } from '../store';
import { useActions, useSnapshot } from './context';
import { ZeroMatchWarning } from './fields';
import { dropIndex, lineClass, rowHeader, useDragList, type DragRowState } from './drag';
import { FrameBadge } from './frame';
import { Icon, type IconName } from './icons';
import { Toggle } from './items';
import { Section } from './section';
import { SelectorChip } from './selector-chip';
import { Kbd } from './shell';
import { TargetEditor, sameRef } from './target-editor';

type StepKind = DraftStep['kind'];

const KIND_ICON: Record<StepKind, IconName> = {
  click: 'crosshair-simple',
  fill: 'text-t',
  press: 'arrow-right',
  wait: 'circle',
  'await-user': 'hand',
  download: 'download-simple',
};

/** Kinds whose value the user edits, with the placeholder the input shows. */
const VALUE_HINT: Partial<Record<StepKind, string>> = {
  fill: 'Text to fill or option to choose, {var} allowed',
  press: 'Enter, Escape, Tab, or a key',
  wait: 'Milliseconds',
  download: 'File name, {var} allowed; empty keeps the name the server suggests',
};

export function KindSelect({ value, onChange }: { value: StepKind; onChange: (kind: StepKind) => void }) {
  return (
    <select className={`ws-select${value === 'await-user' ? ' ws-select-await' : ''}`} value={value} aria-label="Step kind" onChange={(e) => onChange(e.target.value as StepKind)} data-ws="step-kind">
      {STEP_KINDS.map((k) => (
        <option key={k} value={k}>
          {k}
        </option>
      ))}
    </select>
  );
}

/** Short description of what a step acts on: role and name, else tag and text, else null when only the selector says. */
export function targetLabel(step: Pick<DraftStep, 'kind' | 'target'>): string | null {
  const target = step.target;
  if (!target) return step.kind === 'press' ? 'focused element' : step.kind === 'download' ? 'next download' : 'no target';
  const fp = target.fingerprint;
  if (fp?.role && fp.name) return `${fp.role} "${fp.name}"`;
  if (fp?.textSample) return `${fp.tag} "${fp.textSample.slice(0, 40)}"`;
  return null;
}

/** Short description of what a step acts on, as text: the label, else the primary selector as `strategy=value`. */
export function targetSummary(step: Pick<DraftStep, 'kind' | 'target'>): string {
  const primary = step.target?.selectors[0];
  return targetLabel(step) ?? (primary ? `${primary.strategy}=${primary.value}` : 'no target');
}

/** The collapsed Flows summary: the active flow and how many flows of each kind there are. */
export function flowsSummary(draft: Pick<Draft, 'flows' | 'activeFlow'>): string {
  if (draft.flows.length === 0) return 'no flows';
  const active = draft.activeFlow !== null ? draft.flows[draft.activeFlow]?.name : undefined;
  const reactive = draft.flows.filter((f) => f.trigger).length;
  const called = draft.flows.length - reactive;
  return `${active ? `into ${active} · ` : ''}${called} called · ${reactive} reactive`;
}

/** The value line under a step row: the value, the await-user condition, and badges. */
function StepMeta({ step }: { step: DraftStep }) {
  const parts: ReactNode[] = [];
  if (step.kind === 'await-user') {
    parts.push(
      <span key="until" className="ws-meta" data-ws="step-until">
        until {step.until ?? '…'}
        {step.label ? ` · “${step.label}”` : ''}
      </span>,
    );
  } else if (step.value !== undefined && step.value !== '') {
    parts.push(
      <span key="value" className="ws-mono-sm ws-ellipsis" data-ws="step-value-text">
        {step.value}
      </span>,
    );
  }
  if (step.window === 'popup') {
    parts.push(
      <span key="popup" className="ws-window-badge" title="Acts in the newest popup opened by an earlier step of this flow" data-ws="step-window-badge">
        <Icon name="app-window" size={10} />
        popup
      </span>,
    );
  }
  if (step.target?.frame) parts.push(<FrameBadge key="frame" frame={step.target.frame} />);
  if (step.optional) {
    parts.push(
      <span key="optional" className="ws-tag" data-ws="step-optional-marker" title="Skipped when its element is missing">
        optional
      </span>,
    );
  }
  if (parts.length === 0) return null;
  return <div className="ws-row ws-row-indent ws-wrap">{parts}</div>;
}

/** The step's value, edited as text; variable chips insert `{name}` at the caret, and "make variable" turns a literal into one. */
function ValueField({ step, at, vars }: { step: DraftStep; at: StepRef; vars: VarValue[] }) {
  const actions = useActions();
  const [value, setValue] = useState(step.value ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(step.value ?? ''), [step.value]);
  const commit = (next = value) => {
    if (next !== (step.value ?? '')) void actions.send({ kind: 'draft.updateStep', flow: at.flow, index: at.index, patch: { value: next } });
  };
  const insert = (name: string) => {
    const el = input.current;
    const from = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? from;
    const next = `${value.slice(0, from)}{${name}}${value.slice(end)}`;
    setValue(next);
    commit(next);
  };
  const literal = step.kind === 'fill' && value !== '' && !/\{[A-Za-z_]\w*\}/.test(value);
  const makeVariable = async () => {
    const taken = new Set(vars.map((v) => v.name));
    let name = (step.label ?? 'value').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
    if (/^\d/.test(name)) name = `v_${name}`;
    for (let n = 2; taken.has(name); n++) name = `${name.replace(/_\d+$/, '')}_${n}`;
    const literalValue = value;
    await actions.send({ kind: 'draft.updateStep', flow: at.flow, index: at.index, patch: { value: `{${name}}` } });
    await actions.send({ kind: 'draft.setVar', name, value: literalValue });
  };
  return (
    <div className="ws-row ws-wrap">
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
      {(step.kind === 'fill' || step.kind === 'download') &&
        vars.map((v) => (
          <button key={v.name} type="button" className="ws-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(v.name)} title={`Insert {${v.name}}`} data-ws={`step-var-${v.name}`}>
            {`{${v.name}}`}
          </button>
        ))}
      {literal && (
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void makeVariable()} title="Replace the value with a variable holding it" data-ws="step-make-variable">
          {'{}'} make variable
        </button>
      )}
    </div>
  );
}

/** Two or more choices as a segmented control. */
export function Segmented<T extends string>({ options, value, onChange, label, testId }: { options: readonly { value: T; label: string }[]; value: T | undefined; onChange: (value: T) => void; label: string; testId: string }) {
  return (
    <div className="ws-seg" role="group" aria-label={label} data-ws={testId}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)} data-ws={`${testId}-${o.value}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One labelled line of an edit state. */
function EditLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ws-edit-line">
      <span className="ws-edit-label">{label}</span>
      <div className="ws-row ws-wrap ws-spacer">{children}</div>
    </div>
  );
}

/** A timeout in seconds, or the guard budget when absent. */
function TimeoutLine({ step, update }: { step: DraftStep; update: (patch: StepPatch) => void }) {
  const [text, setText] = useState(step.timeoutMs !== undefined ? String(step.timeoutMs / 1000) : '');
  useEffect(() => setText(step.timeoutMs !== undefined ? String(step.timeoutMs / 1000) : ''), [step.timeoutMs]);
  if (step.timeoutMs === undefined && text === '') {
    return (
      <EditLine label="timeout">
        <span className="ws-meta" data-ws="step-timeout-budget">
          guard budget
        </span>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => setText('300')} data-ws="step-timeout-override">
          Override
        </button>
      </EditLine>
    );
  }
  const commit = () => {
    const seconds = Number(text);
    if (text.trim() === '') update({ timeoutMs: null });
    else if (Number.isFinite(seconds) && seconds > 0) update({ timeoutMs: Math.round(seconds * 1000) });
  };
  return (
    <EditLine label="timeout">
      <input className="ws-input ws-input-sm ws-mono-sm" inputMode="numeric" aria-label="Timeout in seconds" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} data-ws="step-timeout" />
      <span className="ws-meta">seconds</span>
      <button
        type="button"
        className="ws-btn ws-btn-ghost ws-btn-sm"
        onClick={() => {
          setText('');
          update({ timeoutMs: null });
        }}
        data-ws="step-timeout-clear"
      >
        Use guard budget
      </button>
    </EditLine>
  );
}

/** Why a step's target cannot be re-picked: a popup step while no popup is open. */
function repickBlocked(step: DraftStep, at: StepRef, host: { popups: number; popup: boolean }): string | null {
  if (step.window !== 'popup' || host.popup || host.popups > 0) return null;
  return popupClosedReason(at.index);
}

/** The edit state of a step: target, value, window, frame, optional; label, until, and timeout for await-user. */
function StepEditor({ step, at, vars, onDone }: { step: DraftStep; at: StepRef; vars: VarValue[]; onDone: () => void }) {
  const actions = useActions();
  const update = (patch: StepPatch) => void actions.send({ kind: 'draft.updateStep', flow: at.flow, index: at.index, patch });
  const { host } = useSnapshot();
  const [label, setLabel] = useState(step.label ?? '');
  useEffect(() => setLabel(step.label ?? ''), [step.label]);
  return (
    <div className="ws-col ws-step-edit" data-ws="step-edit">
      {step.kind === 'await-user' && (
        <EditLine label="label">
          <input
            className="ws-input ws-input-sm ws-spacer"
            value={label}
            placeholder="What the user does, e.g. Log in to the portal"
            aria-label="Step label"
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label !== (step.label ?? '') && update({ label: label.trim() || null })}
            data-ws="step-label"
          />
        </EditLine>
      )}
      {step.kind === 'await-user' && (
        <EditLine label="until">
          <Segmented label="Until" testId="step-until" value={step.until} onChange={(until) => update({ until })} options={[{ value: 'appears', label: 'appears' }, { value: 'disappears', label: 'disappears' }]} />
        </EditLine>
      )}
      <EditLine label={step.kind === 'await-user' ? 'element' : 'target'}>
        {step.target || step.kind === 'await-user' || step.kind === 'download' ? (
          <TargetEditor targetRef={{ kind: 'step', ...at }} target={step.target} edit={host?.targetEdit ?? null} disabled={host ? repickBlocked(step, at, host) : null} testId="step-target-edit" />
        ) : (
          <span className="ws-meta">{targetSummary(step)}</span>
        )}
      </EditLine>
      {step.kind in VALUE_HINT && (
        <EditLine label="value">
          <ValueField step={step} at={at} vars={vars} />
        </EditLine>
      )}
      <EditLine label="window">
        <Segmented label="Window" testId="step-window" value={step.window} onChange={(window) => update({ window })} options={[{ value: 'same', label: 'same' }, { value: 'popup', label: 'popup' }]} />
        <span className="ws-meta">{step.window === 'popup' ? 'the newest popup opened by an earlier step' : 'where the flow started'}</span>
      </EditLine>
      {step.target?.frame && (
        <EditLine label="frame">
          <FrameBadge frame={step.target.frame} />
        </EditLine>
      )}
      {step.kind === 'await-user' ? (
        <>
          <TimeoutLine step={step} update={update} />
          <span className="ws-meta ws-tone-warn-text">
            {step.timeoutMs === undefined ? "Shares the run's guard budget. If it runs out, the run fails with reason paused." : 'Waits at most this long. Then the run fails with reason paused.'}
          </span>
        </>
      ) : (
        <EditLine label="optional">
          <Toggle on={step.optional} onChange={(optional) => update({ optional })} label="Optional" testId="step-optional" />
          <span className="ws-meta">{step.kind === 'download' ? 'skip if no download starts' : 'skip if the target is missing'}</span>
        </EditLine>
      )}
      <div className="ws-row">
        <span className="ws-spacer" />
        <button type="button" className="ws-btn ws-btn-sm" onClick={onDone} data-ws="step-done">
          Done <Kbd>Enter</Kbd>
        </button>
      </div>
    </div>
  );
}

export function StepRow({
  step,
  at,
  vars,
  focused,
  editing,
  repicking,
  onFocus,
  drag,
}: {
  step: DraftStep;
  at: StepRef;
  vars: VarValue[];
  focused: boolean;
  editing: boolean;
  repicking: boolean;
  onFocus: () => void;
  drag: { props: Omit<HTMLAttributes<HTMLDivElement>, 'className'>; state: DragRowState };
}) {
  const actions = useActions();
  const update = (patch: StepPatch) => void actions.send({ kind: 'draft.updateStep', flow: at.flow, index: at.index, patch });
  const edit = (on: boolean) => actions.setUi({ editingStep: on ? at : null });
  return (
    <div
      {...drag.props}
      className={`ws-field ws-step${focused || editing ? ' ws-field-focused' : ''}${drag.state.dragging ? ' ws-field-dragging' : ''}${lineClass(drag.state)}${step.kind === 'await-user' ? ' ws-step-await' : ''}`}
      data-ws="step"
      data-kind={step.kind}
      data-index={at.index}
      tabIndex={-1}
      draggable={!editing}
      onFocus={onFocus}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (editing && e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'INPUT') edit(false);
      }}
    >
      <div className="ws-row">
        <span className="ws-handle" aria-hidden="true" title="Drag to reorder (Alt+Up, Alt+Down)">
          <Icon name="dots-six-vertical" size={12} />
        </span>
        <span className="ws-num" aria-hidden="true">
          {at.index + 1}
        </span>
        <Icon name={KIND_ICON[step.kind]} size={11} />
        <KindSelect value={step.kind} onChange={(kind) => update({ kind })} />
        <span className="ws-meta ws-ellipsis ws-spacer ws-row" title={targetSummary(step)} data-ws="step-target">
          {targetLabel(step) ?? <SelectorChip candidate={step.target!.selectors[0]!} level="page" />}
        </span>
        {step.target && (
          <span className={`ws-num${step.count === 0 ? ' ws-num-zero' : ''}`} data-ws="step-count" title="Matches of the target on this page">
            {step.count ?? '…'}
          </span>
        )}
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Replay step ${at.index + 1}`} title="Run this step on the page" onClick={() => void actions.send({ kind: 'draft.replayStep', flow: at.flow, index: at.index })} data-ws="step-replay">
          <Icon name="play" size={11} />
        </button>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`${editing ? 'Close' : 'Edit'} step ${at.index + 1}`} aria-expanded={editing} onClick={() => edit(!editing)} data-ws="step-edit-toggle">
          <Icon name={editing ? 'caret-down' : 'pencil-simple'} size={11} />
        </button>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Remove step ${at.index + 1}`} onClick={() => void actions.send({ kind: 'draft.removeStep', flow: at.flow, index: at.index })} data-ws="step-remove">
          <Icon name="x" size={11} />
        </button>
      </div>
      {editing ? <StepEditor step={step} at={at} vars={vars} onDone={() => edit(false)} /> : <StepMeta step={step} />}
      {step.error && (
        <span className="ws-error" data-ws="step-error">
          {step.error}
        </span>
      )}
      {repicking && !editing && (
        <span className="ws-meta" data-ws="step-repicking">
          re-picking…
        </span>
      )}
      {step.count === 0 && !repicking && step.kind !== 'await-user' && (
        <ZeroMatchWarning
          optional={step.optional}
          onRepick={() => void actions.send({ kind: 'target.edit.start', ref: { kind: 'step', ...at }, mode: 'pick' })}
          onOptional={() => update({ optional: true })}
        />
      )}
    </div>
  );
}

/** The trigger editor of a flow: called or reactive, the element whose appearance fires it, and where it is checked. */
function TriggerEditor({ flow, index, picking }: { flow: DraftFlow; index: number; picking: boolean }) {
  const actions = useActions();
  const { host } = useSnapshot();
  const pick = () => {
    void actions.send({ kind: 'draft.pickTrigger', index });
    actions.startPicking();
  };
  return (
    <div className="ws-col ws-trigger" data-ws="trigger-editor">
      <div className="ws-row">
        <Icon name="lightning" size={12} />
        <span className="ws-title ws-spacer">Trigger</span>
        <Segmented
          label="Flow kind"
          testId="flow-kind"
          value={flow.trigger ? 'reactive' : 'called'}
          onChange={(kind) => (kind === 'called' ? void actions.send({ kind: 'draft.updateFlow', index, patch: { trigger: null } }) : pick())}
          options={[{ value: 'called', label: 'called' }, { value: 'reactive', label: 'reactive' }]}
        />
      </div>
      <EditLine label="when">
        <span className="ws-meta">appears</span>
      </EditLine>
      <EditLine label="element">
        {flow.trigger ? (
          <TargetEditor targetRef={{ kind: 'trigger', flow: index }} target={flow.trigger} edit={host?.targetEdit ?? null} testId="trigger-target-edit" />
        ) : (
          <>
            <span className="ws-meta">{picking ? 'Pick the element on the page…' : 'none yet'}</span>
            <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={pick} data-ws="trigger-pick">
              Pick
            </button>
          </>
        )}
      </EditLine>
      <EditLine label="where">
        <span className="ws-meta">any window · checked after a page settles, before each step, before extraction, and every second while waiting for you</span>
      </EditLine>
      <span className="ws-meta">Not placed in Sequence. Won't re-fire while its own steps run.</span>
    </div>
  );
}

/** A flow's "…" menu: replay, rename, make reactive or called, duplicate, retries and recover for a reactive flow, delete. */
function FlowMenu({ flow, index, onRename, onTrigger, onClose }: { flow: DraftFlow; index: number; onRename: () => void; onTrigger: () => void; onClose: () => void }) {
  const actions = useActions();
  const retries = flow.maxRetries ?? DEFAULT_MAX_RETRIES;
  const item = (label: string, testId: string, onClick: () => void, icon: IconName, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={`ws-menu-item${danger ? ' ws-menu-danger' : ''}`}
      onClick={() => {
        onClick();
        onClose();
      }}
      data-ws={testId}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
  return (
    <div className="ws-menu ws-col" role="menu" data-ws="flow-menu">
      {item('Replay flow', 'flow-menu-replay', () => void actions.send({ kind: 'draft.replayFlow', index }), 'play')}
      {item('Rename', 'flow-menu-rename', onRename, 'pencil-simple')}
      {flow.trigger ? item('Make called', 'flow-menu-called', () => void actions.send({ kind: 'draft.updateFlow', index, patch: { trigger: null } }), 'flow-arrow') : item('Make reactive…', 'flow-menu-reactive', onTrigger, 'lightning')}
      {item('Duplicate', 'flow-menu-duplicate', () => void actions.send({ kind: 'draft.duplicateFlow', index }), 'rectangle')}
      {flow.trigger && (
        <div className="ws-col ws-menu-block" data-ws="flow-menu-retries">
          <div className="ws-row">
            <span className="ws-spacer">Max retries</span>
            <button type="button" className="ws-btn ws-btn-sm" aria-label="Fewer retries" onClick={() => retries > 1 && void actions.send({ kind: 'draft.updateFlow', index, patch: { maxRetries: retries - 1 } })}>
              −
            </button>
            <span className="ws-mono-sm" data-ws="flow-retries">
              {retries}
            </span>
            <button type="button" className="ws-btn ws-btn-sm" aria-label="More retries" onClick={() => void actions.send({ kind: 'draft.updateFlow', index, patch: { maxRetries: retries + 1 } })}>
              +
            </button>
          </div>
          <span className="ws-meta">
            Times this flow may fire between two successful extractions · default {DEFAULT_MAX_RETRIES}. More fails the run with <span className="ws-mono-sm">flow-loop</span>.
          </span>
          <div className="ws-row">
            <span className="ws-spacer">Recover</span>
            <Toggle on={flow.recover ?? false} onChange={(recover) => void actions.send({ kind: 'draft.updateFlow', index, patch: { recover } })} label="Recover" testId="flow-recover" />
          </div>
          <span className="ws-meta">Afterwards, reload where the current page batch began and replay the flows before this point.</span>
        </div>
      )}
      {item('Delete flow', 'flow-menu-delete', () => void actions.send({ kind: 'draft.removeFlow', index }), 'trash', true)}
    </div>
  );
}

function FlowName({ flow, index, renaming, onDone }: { flow: DraftFlow; index: number; renaming: boolean; onDone: () => void }) {
  const actions = useActions();
  const [name, setName] = useState(flow.name);
  useEffect(() => setName(flow.name), [flow.name, renaming]);
  if (!renaming) {
    return (
      <span className="ws-mono ws-ellipsis" data-ws="flow-name">
        {flow.name}
      </span>
    );
  }
  const commit = () => {
    if (name.trim() && name.trim() !== flow.name) void actions.send({ kind: 'draft.updateFlow', index, patch: { name: name.trim() } });
    onDone();
  };
  return (
    <input
      className="ws-input ws-input-sm ws-mono-sm"
      autoFocus
      value={name}
      aria-label="Flow name"
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone();
      }}
      data-ws="flow-rename"
    />
  );
}

/** One flow: its header (active dot, name, kind or trigger, step count, replay, menu) and, expanded, its steps. */
function FlowCard({ draft, flow, index }: { draft: Draft; flow: DraftFlow; index: number }) {
  const snap = useSnapshot();
  const actions = useActions();
  const { ui, host } = snap;
  const active = draft.activeFlow === index;
  const open = active || ui.openFlows.includes(flow.name);
  const [renaming, setRenaming] = useState(false);
  const [trigger, setTrigger] = useState(false);
  const drag = useDragList({
    list: `steps:${index}`,
    axis: 'y',
    getImage: rowHeader,
    onMove: (from, slot) => {
      const to = dropIndex(from.index, slot.index);
      void actions.send({ kind: 'draft.moveStep', flow: index, from: from.index, to });
      actions.setUi({ focusedStep: { flow: index, index: to } });
    },
  });
  const menuId = `flow-menu-${index}`;
  const picking = host?.pickTrigger === index;
  const edit = host?.targetEdit ?? null;
  const triggerEdit = edit !== null && sameRef(edit.ref, { kind: 'trigger', flow: index });
  const toggleOpen = () => {
    if (active) return;
    actions.setUi({ openFlows: open ? ui.openFlows.filter((n) => n !== flow.name) : [...ui.openFlows, flow.name] });
  };
  return (
    <div className={`ws-flow${active ? ' ws-flow-active' : ''}`} data-ws="flow" data-name={flow.name} data-kind={flow.trigger ? 'reactive' : 'called'} data-active={active || undefined}>
      <div className="ws-row ws-flow-head">
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`${open ? 'Collapse' : 'Expand'} ${flow.name}`} onClick={toggleOpen} data-ws="flow-toggle">
          <Icon name={open ? 'caret-down' : 'caret-right'} size={10} />
        </button>
        <button
          type="button"
          className={`ws-active-dot${active ? ' ws-active-dot-on' : ''}`}
          title={active ? 'Active flow — recording goes here' : 'Make this the active flow'}
          aria-label={`Record into ${flow.name}`}
          aria-pressed={active}
          onClick={() => void actions.send({ kind: 'draft.selectFlow', index })}
          data-ws="flow-activate"
        />
        <FlowName flow={flow} index={index} renaming={renaming} onDone={() => setRenaming(false)} />
        {flow.trigger ? (
          <span className="ws-row ws-trigger-chip" title="Fires when this element appears" data-ws="flow-trigger">
            <Icon name="lightning" size={11} />
            <SelectorChip candidate={flow.trigger.selectors[0]!} level="page" />
          </span>
        ) : (
          <span className="ws-meta">called</span>
        )}
        <span className="ws-spacer" />
        <span className="ws-mono-sm ws-faint" title={`${flow.steps.length} steps`} data-ws="flow-step-count">
          {flow.steps.length}
        </span>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Replay ${flow.name}`} title="Replay flow" onClick={() => void actions.send({ kind: 'draft.replayFlow', index })} data-ws="flow-replay">
          <Icon name="play" size={11} />
        </button>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`${flow.name} menu`} aria-expanded={ui.menu === menuId} onClick={() => actions.setUi({ menu: ui.menu === menuId ? null : menuId })} data-ws="flow-menu-toggle">
          <Icon name="dots-three" size={12} />
        </button>
      </div>
      {ui.menu === menuId && (
        <FlowMenu
          flow={flow}
          index={index}
          onRename={() => setRenaming(true)}
          onTrigger={() => {
            setTrigger(true);
            void actions.send({ kind: 'draft.pickTrigger', index });
            actions.startPicking();
          }}
          onClose={() => actions.setUi({ menu: null })}
        />
      )}
      {flow.error && (
        <span className="ws-error" data-ws="flow-error">
          {flow.error}
        </span>
      )}
      {open && (
        <div className="ws-col ws-flow-steps" {...drag.containerProps}>
          {(trigger || picking || triggerEdit || (flow.trigger && active)) && <TriggerEditor flow={flow} index={index} picking={picking} />}
          {flow.steps.map((step, i) => {
            const at = { flow: index, index: i };
            return (
              <StepRow
                key={i}
                step={step}
                at={at}
                vars={draft.vars}
                focused={ui.focusedStep?.flow === index && ui.focusedStep.index === i}
                editing={ui.editingStep?.flow === index && ui.editingStep.index === i}
                repicking={edit !== null && edit.phase !== 'typing' && sameRef(edit.ref, { kind: 'step', flow: index, index: i })}
                onFocus={() => actions.setUi({ focusedStep: at, focusedField: null, focusedTab: null, focusedBlock: null })}
                drag={drag.row(i)}
              />
            );
          })}
          {active && (
            <button type="button" className="ws-dashed" onClick={ui.browsing ? actions.stopBrowsing : actions.startBrowsing} data-ws="flow-add-steps">
              <Icon name="plus" size={11} />
              {ui.browsing ? (
                <>
                  Recording — use the page. <Kbd>B</Kbd> or <Kbd>Esc</Kbd> stops
                </>
              ) : (
                <>
                  Browse <Kbd>B</Kbd> or pick to add steps here
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The Alt+F switcher: every flow, called then reactive, numbered 1 to 9, and a new flow to record into. */
export function FlowSwitcher({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const actions = useActions();
  const order = switcherOrder(draft);
  return (
    <div className="ws-menu ws-col ws-switcher" role="menu" data-ws="flow-switcher">
      <span className="ws-meta">Record into</span>
      {order.map((index, n) => {
        const flow = draft.flows[index]!;
        return (
          <button
            key={flow.name}
            type="button"
            role="menuitem"
            className="ws-menu-item"
            onClick={() => {
              void actions.send({ kind: 'draft.selectFlow', index });
              onClose();
            }}
            data-ws="flow-switcher-item"
            data-name={flow.name}
          >
            <span className={`ws-active-dot${draft.activeFlow === index ? ' ws-active-dot-on' : ''}`} />
            <span className="ws-mono ws-spacer">{flow.name}</span>
            {flow.trigger && <Icon name="lightning" size={11} />}
            {n < 9 && <Kbd>{String(n + 1)}</Kbd>}
          </button>
        );
      })}
      <button
        type="button"
        role="menuitem"
        className="ws-menu-item"
        onClick={() => {
          void actions.send({ kind: 'draft.addFlow' });
          onClose();
        }}
        data-ws="flow-switcher-new"
      >
        <Icon name="plus" size={11} />
        New flow and record into it
      </button>
    </div>
  );
}

/** Flow indexes in switcher order: called flows, then reactive ones, each in list order. */
export function switcherOrder(draft: Pick<Draft, 'flows'>): number[] {
  const indexes = draft.flows.map((_, i) => i);
  return [...indexes.filter((i) => !draft.flows[i]!.trigger), ...indexes.filter((i) => draft.flows[i]!.trigger)];
}

/** The Flows section: called and reactive groups, the active flow and its switcher, and adding flows. */
/** The start URL downloaded a file instead of loading a page: say so, and offer a targetless download step while the draft has no steps. */
export function StartDownloadNotice({ host }: { host: { startDownload: { name: string; file: string } | null; draft: Pick<Draft, 'flows'> } }) {
  const actions = useActions();
  if (!host.startDownload) return null;
  const empty = host.draft.flows.every((f) => f.steps.length === 0);
  return (
    <section className="ws-card ws-col" data-ws="flows-start-download">
      <span className="ws-title">
        <Icon name="download-simple" size={12} /> The URL downloaded {host.startDownload.name}
      </span>
      <span className="ws-meta ws-mono-sm ws-ellipsis" title={host.startDownload.file}>
        {host.startDownload.file}
      </span>
      {empty && (
        <div className="ws-row">
          <button type="button" className="ws-btn ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.addDownloadStep' })} data-ws="flows-start-download-add">
            <Icon name="plus" size={12} /> Add download step
          </button>
        </div>
      )}
    </section>
  );
}

export function FlowsSection({ draft, collapsed, onCollapse }: { draft: Draft; collapsed: boolean; onCollapse: (collapsed: boolean) => void }) {
  const snap = useSnapshot();
  const actions = useActions();
  const { ui } = snap;
  const active = draft.activeFlow !== null ? draft.flows[draft.activeFlow] : undefined;
  const called = draft.flows.map((f, i) => ({ f, i })).filter(({ f }) => !f.trigger);
  const reactive = draft.flows.map((f, i) => ({ f, i })).filter(({ f }) => f.trigger);
  const headActions = (
    <>
      <button type="button" className="ws-btn ws-btn-sm" onClick={() => actions.setUi({ switcher: !ui.switcher })} title="Choose the flow recording goes into (Alt+F)" aria-expanded={ui.switcher} data-ws="flows-into">
        <span className={`ws-active-dot${active ? ' ws-active-dot-on' : ''}`} />
        {active ? (
          <>
            into <span className="ws-mono-sm">{active.name}</span>
          </>
        ) : (
          'no flow yet'
        )}
        <Icon name="caret-down" size={10} />
      </button>
      <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.addFlow' })} data-ws="flows-add">
        <Icon name="plus" size={11} />
        flow
      </button>
    </>
  );
  return (
    <Section
      id="flows"
      title="Flows"
      count={draft.flows.length > 0 ? draft.flows.length : null}
      actions={headActions}
      collapsible
      collapsed={collapsed && !ui.browsing}
      onCollapse={onCollapse}
      summary={<span data-ws="flows-summary">{flowsSummary(draft)}</span>}
    >
      <div className="ws-col" data-browsing={ui.browsing}>
        {ui.switcher && <FlowSwitcher draft={draft} onClose={() => actions.setUi({ switcher: false })} />}
        {draft.flows.length === 0 && (
          <div className="ws-col">
            <span className="ws-meta">No flows. Record the clicks and typing a page needs before its data shows; the first step creates a flow.</span>
            <button type="button" className="ws-dashed" onClick={ui.browsing ? actions.stopBrowsing : actions.startBrowsing} data-ws="flows-record">
              <Icon name="record" size={11} />
              {ui.browsing ? 'Stop recording' : 'Record steps'} <Kbd>B</Kbd>
            </button>
          </div>
        )}
        {called.length > 0 && (
          <span className="ws-group-label" data-ws="flows-called">
            Called <span className="ws-faint">· via Sequence</span>
          </span>
        )}
        {called.map(({ f, i }) => (
          <FlowCard key={f.name} draft={draft} flow={f} index={i} />
        ))}
        {reactive.length > 0 && (
          <span className="ws-group-label" data-ws="flows-reactive">
            Reactive <span className="ws-faint">· fire on trigger</span>
          </span>
        )}
        {reactive.map(({ f, i }) => (
          <FlowCard key={f.name} draft={draft} flow={f} index={i} />
        ))}
      </div>
    </Section>
  );
}
