import { useRef, useState } from 'react';
import type { Crumb, DraftStep, TargetEdit, TargetRef } from '@webscoop/core/page';
import { SelectorCandidateList } from './candidates';
import { useActions } from './context';
import { FrameCard } from './frame';
import { ElementInspector } from './picking';
import { SelectorChip } from './selector-chip';
import { SelectorInput } from './selector-input';
import type { Actions } from '../store';
import { useRevealOnPick } from './reveal';
import { Kbd } from './shell';

type Target = NonNullable<DraftStep['target']>;

export const sameRef = (a: TargetRef, b: TargetRef): boolean => JSON.stringify(a) === JSON.stringify(b);
const textOf = (c: { strategy: string; value: string }) => `${c.strategy}=${c.value}`;

/**
 * The target editor of a step, a reactive flow's trigger, or the paginate
 * target: its chip, how many candidates it has, Re-pick and Edit selector,
 * and the typed selector input while it is open.
 */
export function TargetEditor({
  targetRef,
  target,
  edit,
  disabled = null,
  testId = 'step-target-edit',
}: {
  targetRef: TargetRef;
  target: Target | undefined;
  /** The target edit in progress, of any target. */
  edit: TargetEdit | null;
  /** Why Re-pick and Edit selector are disabled. */
  disabled?: string | null;
  testId?: string;
}) {
  const actions = useActions();
  const own = edit && sameRef(edit.ref, targetRef) ? edit : null;
  const start = (mode: 'pick' | 'type') => void actions.send({ kind: 'target.edit.start', ref: targetRef, mode });
  const n = target?.selectors.length ?? 0;
  return (
    <div className="ws-col ws-spacer" data-ws={testId}>
      <span className="ws-row" data-ws={`${testId}-chip`}>
        {target ? <SelectorChip candidate={target.selectors[0]!} level="page" /> : <span className="ws-meta">none yet</span>}
      </span>
      {target && (
        <span className="ws-meta" data-ws={`${testId}-candidates`}>
          {n} candidate{n === 1 ? '' : 's'}, first used
        </span>
      )}
      {own && own.phase !== 'typing' ? (
        <span className="ws-meta" data-ws={`${testId}-repicking`}>
          re-picking…
        </span>
      ) : (
        <span className="ws-row">
          <button type="button" className="ws-btn ws-btn-sm" disabled={disabled !== null} title={disabled ?? 'Pick the element on the page'} onClick={() => start('pick')} data-ws={`${testId}-repick`}>
            Re-pick
          </button>
          <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" disabled={disabled !== null || !target || own?.phase === 'typing'} title={disabled ?? 'Type a selector'} onClick={() => start('type')} data-ws={`${testId}-type`}>
            Edit selector
          </button>
        </span>
      )}
      {disabled && (
        <span className="ws-meta ws-tone-warn-text" data-ws={`${testId}-disabled`}>
          {disabled}
        </span>
      )}
      {own?.phase === 'typing' && target && <TypedTarget targetRef={targetRef} initial={textOf(target.selectors[0]!)} testId={testId} />}
    </div>
  );
}

/** What the live count of typed target text says. */
function typedStatus(result: { count: number; error: string | null }): { text: string; tone: 'ok' | 'warn' } | null {
  if (result.error) return null;
  if (result.count === 0) return { text: 'Matches nothing on this page. Use still saves it.', tone: 'warn' };
  if (result.count === 1) return { text: '1 match', tone: 'ok' };
  return { text: `${result.count} matches. The first match is used.`, tone: 'warn' };
}

/**
 * The typed selector input of a target edit: the live count in the target's
 * window and frame, a warning for 0 matches, the first match outlined for
 * several, an error for invalid text, and Use, which puts it first.
 */
export function TypedTarget({ targetRef, initial, testId, cancel = true }: { targetRef: TargetRef; initial: string; testId: string; cancel?: boolean }) {
  const actions = useActions();
  const [live, setLive] = useState<{ text: string; result: { count: number; error: string | null } | null }>({ text: initial, result: null });
  const invalid = Boolean(live.result?.error);
  const status = live.result ? typedStatus(live.result) : null;
  const apply = (text: string) => {
    if (!text || invalid) return;
    actions.previewSelector?.(null);
    void actions.send({ kind: 'target.edit.apply', ref: targetRef, by: 'selector', selector: text });
  };
  const close = () => {
    actions.previewSelector?.(null);
    void actions.send({ kind: 'target.edit.cancel' });
  };
  return (
    <div className="ws-col" data-ws={`${testId}-input`}>
      <SelectorInput
        value={initial}
        label="Target selector"
        testId={`${testId}-selector`}
        counter={(text) => actions.countTarget?.(targetRef, text) ?? Promise.resolve(null)}
        onLive={(text, result) => {
          setLive({ text, result });
          actions.previewSelector?.(result && !result.error && result.count > 1 ? text : null);
        }}
        onSubmit={apply}
        onEscape={cancel ? close : undefined}
      />
      {status && (
        <span className={`ws-meta${status.tone === 'warn' ? ' ws-tone-warn-text' : ''}`} data-ws={`${testId}-status`} data-count={live.result?.count}>
          {status.text}
        </span>
      )}
      <span className="ws-row">
        <span className="ws-spacer" />
        {cancel && (
          <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={close} data-ws={`${testId}-cancel`}>
            Cancel <Kbd>Esc</Kbd>
          </button>
        )}
        <button type="button" className="ws-btn ws-btn-sm" disabled={!live.text || invalid} onClick={() => apply(live.text)} data-ws={`${testId}-use`}>
          Use <Kbd>Enter</Kbd>
        </button>
      </span>
    </div>
  );
}

/**
 * The Pick section while a target is re-picked: a header naming the target
 * with a link back to it, then, after the pick, the inspector, the iframe
 * card, the ranked candidates, the typed input, and Use or Cancel.
 */
export function TargetPickPanel({ edit, trail, onBack }: { edit: TargetEdit; trail: Crumb[]; onBack: () => void }) {
  const actions = useActions();
  const selection = edit.selection;
  const cancel = () => void actions.send({ kind: 'target.edit.cancel' });
  const ref = useRef<HTMLDivElement>(null);
  useRevealOnPick(ref);
  return (
    <div className="ws-col" ref={ref} data-ws="pick-target" data-phase={edit.phase}>
      <div className="ws-row">
        <span className="ws-title ws-spacer" data-ws="pick-target-title">
          {edit.title}
        </span>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={onBack} data-ws="pick-target-back">
          ← back
        </button>
      </div>
      {!selection ? (
        <span className="ws-meta" data-ws="pick-target-waiting">
          Click the element on the page.
        </span>
      ) : (
        <>
          <ElementInspector selection={selection} trail={trail} onSelectPath={actions.selectPath} />
          {edit.frame && <FrameCard frame={edit.frame} />}
          <SelectorCandidateList candidates={selection.candidates} primary={edit.primary} onPrimary={(index) => void actions.send({ kind: 'inspect.primary', index })} level="page" />
          <TypedTarget key={selection.path.join('.')} targetRef={edit.ref} initial="" testId="pick-target-typed" cancel={false} />
        </>
      )}
      <span className="ws-row">
        <span className="ws-spacer" />
        <button type="button" className="ws-btn ws-btn-ghost" onClick={cancel} data-ws="pick-target-cancel">
          Cancel <Kbd>Esc</Kbd>
        </button>
        <button type="button" className="ws-btn ws-btn-primary" disabled={!selection} onClick={() => void actions.send({ kind: 'target.edit.apply', ref: edit.ref, by: 'selection' })} data-ws="pick-target-use">
          {edit.use} <Kbd>Enter</Kbd>
        </button>
      </span>
    </div>
  );
}

/** The back link of the Pick section: open the edited step, trigger, or paginate settings again. */
export function targetBack(edit: TargetEdit, host: { draft: { flows: { name: string }[] } }, actions: Pick<Actions, 'setUi'>): void {
  const ref = edit.ref;
  if (ref.kind === 'step') actions.setUi({ editingStep: { flow: ref.flow, index: ref.index }, focusedStep: { flow: ref.flow, index: ref.index } });
  else if (ref.kind === 'pagination') actions.setUi({ paginateOpen: true });
  else {
    const name = host.draft.flows[ref.flow]?.name;
    if (name) actions.setUi({ openFlows: [name] });
  }
}
