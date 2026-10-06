import { frameLabel, type FrameTarget, type RecorderState } from '@webscoop/core/page';
import { SelectorCandidateList } from './candidates';
import { useActions, usePending } from './context';
import { Icon } from './icons';
import { SelectorChip } from './selector-chip';
import { SelectorInput } from './selector-input';
import { Kbd } from './shell';

/** A frame target's key: its primary candidate as `strategy=value`. */
export const frameKey = (frame: FrameTarget): string => `${frame.selectors[0]?.strategy}=${frame.selectors[0]?.value}`;

/** Every frame target of the state: the selection's, then the tables', the flows' triggers and steps', and the pagination target's. */
function framesOf(host: RecorderState): FrameTarget[] {
  return [
    host.selected?.selection.frame,
    ...host.draft.tables.map((t) => t.frame),
    ...host.draft.flows.flatMap((f) => [f.trigger?.frame, ...f.steps.map((s) => s.target?.frame)]),
    host.draft.pagination?.target?.frame,
  ].filter((f): f is FrameTarget => !!f);
}

/** "Inside iframe" in the selection details: the frame target's primary, its count, and Edit (E). */
export function FrameCard({ frame }: { frame: FrameTarget }) {
  const actions = useActions();
  const primary = frame.selectors[0];
  return (
    <section className="ws-frame-card ws-col" data-ws="pick-frame" data-frame={frameLabel(frame)}>
      <div className="ws-row">
        <Icon name="frame-corners" size={13} className="ws-frame-icon" />
        <span className="ws-frame-title">Inside iframe</span>
        <span className="ws-meta">same-origin</span>
        <span className="ws-spacer" />
        <button type="button" className="ws-btn ws-btn-sm" title="Edit frame target" onClick={() => actions.setUi({ frameEdit: frameKey(frame) })} data-ws="pick-frame-edit">
          <Icon name="pencil-simple" size={11} />
          Edit
        </button>
      </div>
      {primary && (
        <div className="ws-row">
          <span className="ws-spacer ws-row">
            <SelectorChip candidate={primary} level="page" />
          </span>
          <span className="ws-num" data-ws="pick-frame-count" title="Matches of the frame selector on the page">
            {primary.count ?? '…'}
          </span>
        </div>
      )}
    </section>
  );
}

/** The teal frame badge on a field or step row: the frame's label; choosing it opens the frame editor. */
export function FrameBadge({ frame }: { frame: FrameTarget }) {
  const actions = useActions();
  const label = frameLabel(frame);
  return (
    <button
      type="button"
      className="ws-frame-badge"
      title={`Inside iframe ${label} · click to edit frame target`}
      onClick={(e) => {
        e.stopPropagation();
        actions.setUi({ frameEdit: frameKey(frame) });
      }}
      data-ws="frame-badge"
    >
      <Icon name="frame-corners" size={10} />
      <span className="ws-ellipsis">{label}</span>
    </button>
  );
}

/**
 * The frame target editor (E2): the iframe's candidates with stability and
 * match count, and a selector input. A change applies to every table, step,
 * and pagination target with the same frame.
 */
export function FrameEditor({ host, frameKey: key }: { host: RecorderState; frameKey: string }) {
  const actions = useActions();
  // Until the host answers an edit, the frame is still known by the old primary among its candidates.
  const frames = framesOf(host);
  const frame = frames.find((f) => frameKey(f) === key) ?? frames.find((f) => f.selectors.some((c) => `${c.strategy}=${c.value}` === key));
  const pending = usePending();
  const close = () => actions.setUi({ frameEdit: null });
  const useFrame = () => pending.applyPending('frame') && close();
  if (!frame) return null;
  const primary = frame.selectors[0]!;
  const edit = (patch: { by: 'primary'; index: number } | { by: 'selector'; selector: string }) => {
    void actions.send({ kind: 'frame.edit', key: { strategy: primary.strategy, value: primary.value, stability: primary.stability }, ...patch });
    // The frame's key follows its new primary.
    const next = patch.by === 'primary' ? frame.selectors[patch.index] : null;
    actions.setUi({ frameEdit: next ? `${next.strategy}=${next.value}` : patch.by === 'selector' ? patch.selector : key });
  };
  return (
    <section
      className="ws-card ws-col ws-frame-editor"
      role="dialog"
      aria-label="Frame target"
      data-ws="frame-editor"
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && !(e.target instanceof HTMLInputElement))) {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') close();
          else useFrame();
        }
      }}
    >
      <div className="ws-row">
        <Icon name="frame-corners" size={14} className="ws-frame-icon" />
        <span className="ws-title">Frame target</span>
        <span className="ws-meta ws-mono-sm ws-ellipsis">{frameLabel(frame)}</span>
        <span className="ws-spacer" />
        <Kbd>Esc</Kbd>
      </div>
      <div className="ws-row ws-row-between">
        <span className="ws-meta">Candidates for the iframe element</span>
        <span className="ws-meta">ranked by stability</span>
      </div>
      <SelectorCandidateList candidates={frame.selectors} primary={0} onPrimary={(index) => index !== 0 && edit({ by: 'primary', index })} level="page" />
      <SelectorInput
        label="Frame selector"
        testId="frame-selector"
        value={`${primary.strategy}=${primary.value}`}
        count={primary.count ?? null}
        error={host.error}
        pendingGroup="frame"
        onSubmit={(selector) => {
          edit({ by: 'selector', selector });
          close();
        }}
      />
      <span className="ws-meta">Pick selects the &lt;iframe&gt; element itself, not its content. A change applies to every field and step with this frame.</span>
      <div className="ws-row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="ws-btn ws-btn-ghost" onClick={close} data-ws="frame-editor-cancel">
          Cancel
        </button>
        <button type="button" className="ws-btn ws-btn-outline" onClick={useFrame} data-ws="frame-editor-done">
          Use frame <Kbd>Enter</Kbd>
        </button>
      </div>
    </section>
  );
}
