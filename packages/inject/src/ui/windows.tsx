import type { Draft } from '@webscoop/core/page';
import { useActions, useSnapshot } from './context';
import { FlowsSection } from './flows';
import { Icon } from './icons';
import { Kbd } from './shell';

/** The rail of a main window that does not own the panel: pressing it takes the panel back. */
export function PanelRail() {
  const actions = useActions();
  return (
    <button type="button" className="ws-rail" onClick={() => void actions.send({ kind: 'window.activity' })} title="The panel is active in another window. Click to use it here." data-ws="panel-rail">
      <span className="ws-logo">
        w<b>s</b>
      </span>
      <span className="ws-rail-text">Panel active in another window</span>
    </button>
  );
}

/** The strip of a popup that does not own the panel: pressing it takes the panel. */
export function PanelStrip() {
  const actions = useActions();
  return (
    <button type="button" className="ws-strip-bar" onClick={() => void actions.send({ kind: 'window.activity' })} data-ws="panel-strip">
      <span className="ws-logo">
        web<b>scoop</b>
      </span>
      <span className="ws-strip-dot" />
      <span className="ws-meta ws-spacer">Panel is active in the main window.</span>
      <span className="ws-strip-action">Use it here</span>
    </button>
  );
}

/** The compact bar of an owner window narrower than 640 pixels, and its sheet with the Flows section and the Pick and Browse controls. */
export function CompactBar({ draft }: { draft: Draft }) {
  const { ui } = useSnapshot();
  const actions = useActions();
  const flow = draft.activeFlow !== null ? draft.flows[draft.activeFlow] : undefined;
  return (
    <>
      <div className="ws-bar" data-ws="panel-bar">
        <span className="ws-logo">
          web<b>scoop</b>
        </span>
        <span className="ws-active-dot ws-active-dot-on" />
        <span className="ws-meta ws-ellipsis ws-spacer">
          {flow ? (
            <>
              into <span className="ws-mono-sm">{flow.name}</span> · {flow.steps.length} step{flow.steps.length === 1 ? '' : 's'}
            </>
          ) : (
            'no flow yet'
          )}
        </span>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label="Pick element" title="Pick element (P)" onClick={actions.startPicking} data-ws="bar-pick">
          <Icon name="crosshair-simple" size={12} />
        </button>
        <button type="button" className="ws-btn ws-btn-sm" aria-expanded={ui.sheet} onClick={() => actions.setUi({ sheet: !ui.sheet })} data-ws="bar-panel">
          <Icon name={ui.sheet ? 'caret-down' : 'caret-right'} size={10} />
          {ui.sheet ? 'Less' : 'Panel'}
        </button>
      </div>
      {ui.sheet && (
        <div className="ws-sheet" data-ws="panel-sheet">
          <div className="ws-sheet-body">
            <FlowsSection draft={draft} collapsed={false} onCollapse={() => {}} />
          </div>
          <div className="ws-sheet-foot">
            <button type="button" className="ws-btn ws-btn-sm" onClick={ui.picking ? actions.cancelPicking : actions.startPicking} data-ws="sheet-pick">
              <Icon name="crosshair-simple" size={11} />
              Pick <Kbd>P</Kbd>
            </button>
            <button type="button" className="ws-btn ws-btn-sm" aria-pressed={ui.browsing} onClick={ui.browsing ? actions.stopBrowsing : actions.startBrowsing} data-ws="sheet-browse">
              Browse <Kbd>B</Kbd>
            </button>
            <span className="ws-spacer" />
            <span className="ws-meta">Recipe, sequence, tables in main</span>
            <Kbd>Esc</Kbd>
          </div>
        </div>
      )}
    </>
  );
}
