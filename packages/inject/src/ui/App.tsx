import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isTypingTarget, shortcutFor, walkTrail, type KeyLike, type Shortcut } from '../keyboard';
import { modeOf, type Actions, type Snapshot } from '../store';
import { PickActionGrid, SelectorCandidateList } from './candidates';
import { useActions, useSnapshot } from './context';
import { FieldList } from './fields';
import { ItemDetectCard, ItemSummary } from './items';
import { PaginationEditor } from './pagination';
import { ElementInspector, PickModeStrip } from './picking';
import { RecipeBar } from './recipe';
import { RepickFooter, RepickPanel } from './repick';
import { ResultsDrawer } from './results';
import { PanelFooter, PanelHeader, PanelShell, ToastStack } from './shell';

/** Carry out a shortcut against the current state. */
export function runShortcut(shortcut: Shortcut, snap: Snapshot, actions: Actions): void {
  const { host, ui } = snap;
  switch (shortcut) {
    case 'pick':
      actions.startPicking();
      return;
    case 'cancel':
      actions.cancelPicking();
      return;
    case 'closeMenu':
      actions.setUi({ menu: null });
      return;
    case 'confirm':
      if (host?.proposal) void actions.send({ kind: 'draft.confirmItems', level: host.proposal[ui.level] ? ui.level : 'proposed' });
      return;
    case 'walkUp':
    case 'walkDown': {
      const selection = host?.selected?.selection;
      if (!selection) return;
      const trail = ui.trail.length > 0 ? ui.trail : selection.ancestors;
      const next = walkTrail(trail, selection.path, shortcut === 'walkUp' ? -1 : 1);
      if (next) actions.selectPath(next.path);
      return;
    }
    case 'moveUp':
    case 'moveDown': {
      const from = ui.focusedField;
      const count = host?.draft.fields.length ?? 0;
      if (from === null) return;
      const to = shortcut === 'moveUp' ? from - 1 : from + 1;
      if (to < 0 || to >= count) return;
      void actions.send({ kind: 'draft.moveField', from, to });
      actions.setUi({ focusedField: to });
      return;
    }
    case 'save':
      void actions.send({ kind: 'save.request' });
      return;
    case 'skip':
      void actions.send({ kind: 'repick.skip' });
      return;
    case 'abort':
      void actions.send({ kind: 'repick.abort' });
      return;
  }
}

/** Resolve and run the shortcut for a key event; returns whether one ran. */
export function handleKey(e: KeyLike, target: EventTarget | null, snap: Snapshot, actions: Actions): boolean {
  const shortcut = shortcutFor(e, {
    typing: isTypingTarget(target),
    picking: snap.ui.picking,
    menuOpen: snap.ui.menu !== null,
    hasProposal: Boolean(snap.host?.proposal),
    hasSelection: Boolean(snap.host?.selected),
    focusedField: snap.ui.focusedField,
    repicking: Boolean(snap.host?.repickContext),
  });
  if (!shortcut) return false;
  runShortcut(shortcut, snap, actions);
  return true;
}

/** The whole panel. */
export function ScoopRoot() {
  const snap = useSnapshot();
  const actions = useActions();
  const { host, ui } = snap;
  const mode = modeOf(snap);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (handleKey(e, e.target, snap, actions)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (!host) {
    return (
      <div onKeyDown={onKeyDown} style={{ display: 'contents' }}>
        <PanelShell header={<PanelHeader mode={mode} onEnd={() => void actions.send({ kind: 'session.end' })} />} footer={null}>
          <span className="ws-meta">Connecting to webscoop…</span>
        </PanelShell>
      </div>
    );
  }

  if (host.repickContext) {
    const ctx = host.repickContext;
    return (
      <div onKeyDown={onKeyDown} style={{ display: 'contents' }} data-ws="panel">
        <PanelShell
          header={<PanelHeader mode={mode} onEnd={() => void actions.send({ kind: 'repick.abort' })} />}
          footer={
            <RepickFooter
              canConfirm={ctx.picked !== null}
              reason={ctx.reason}
              onConfirm={() => void actions.send({ kind: 'repick.confirm' })}
              onSkip={() => void actions.send({ kind: 'repick.skip' })}
              onAbort={() => void actions.send({ kind: 'repick.abort' })}
            />
          }
        >
          <RepickPanel context={ctx} hoverScore={ui.hoverScore} picking={ui.picking} onPick={actions.startPicking} onCancel={actions.cancelPicking} />
        </PanelShell>
        <ToastStack toasts={ui.toasts} />
      </div>
    );
  }

  const { draft, selected, proposal } = host;
  return (
    <div onKeyDown={onKeyDown} style={{ display: 'contents' }} data-ws="panel">
      <PanelShell
        header={<PanelHeader mode={mode} onEnd={() => void actions.send({ kind: 'session.end' })} />}
        footer={
          <PanelFooter
            dirty={draft.dirty}
            canTest={draft.fields.length > 0}
            savedName={host.saved?.name ?? null}
            onTest={() => {
              void actions.send({ kind: 'test.run' });
              actions.setUi({ drawerOpen: true });
            }}
            onSave={() => void actions.send({ kind: 'save.request' })}
          />
        }
      >
        <RecipeBar draft={draft} editingVar={ui.editingVar} setEditingVar={(editingVar) => actions.setUi({ editingVar })} />
        <PickModeStrip picking={ui.picking} onStart={actions.startPicking} onCancel={actions.cancelPicking} />
        {selected && (
          <>
            <ElementInspector selection={selected.selection} trail={ui.trail} onSelectPath={actions.selectPath} />
            <SelectorCandidateList
              candidates={selected.selection.candidates}
              primary={selected.primary}
              onPrimary={(index) => void actions.send({ kind: 'inspect.primary', index })}
            />
            {!proposal && (
              <PickActionGrid
                scope={selected.scope}
                hasItem={draft.item !== null}
                repicking={host.repick !== null}
                onAddField={() => void actions.send({ kind: 'draft.addField' })}
                onUseAsItems={() => void actions.send({ kind: 'draft.setItem' })}
                onPagination={() => void actions.send({ kind: 'draft.markPagination' })}
                onDismiss={actions.startPicking}
              />
            )}
          </>
        )}
        {proposal && (
          <ItemDetectCard
            proposal={proposal}
            level={proposal[ui.level] ? ui.level : 'proposed'}
            onLevel={(level) => actions.setUi({ level })}
            highlight={ui.highlight}
            onHighlight={(highlight) => actions.setUi({ highlight })}
          />
        )}
        {draft.item && !proposal && <ItemSummary item={draft.item} />}
        <FieldList fields={draft.fields} focused={ui.focusedField} repick={host.repick} onFocus={(focusedField) => actions.setUi({ focusedField })} />
        {draft.pagination && <PaginationEditor pagination={draft.pagination} />}
        {draft.errors.length > 0 && draft.fields.length > 0 && (
          <div className="ws-col" data-ws="draft-errors">
            {draft.errors.map((e, i) => (
              <span key={i} className="ws-error">
                {e.path}: {e.message}
              </span>
            ))}
          </div>
        )}
      </PanelShell>
      <ToastStack toasts={ui.toasts} />
      {ui.drawerOpen && host.test && (
        <ResultsDrawer
          results={host.test}
          view={ui.drawerView}
          onView={(drawerView) => actions.setUi({ drawerView })}
          onClose={() => actions.setUi({ drawerOpen: false })}
        />
      )}
    </div>
  );
}
