import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { currentTable } from '@webscoop/core/page';
import { isTypingTarget, shortcutFor, walkTrail, type KeyLike, type Shortcut } from '../keyboard';
import { modeOf, type Actions, type Snapshot } from '../store';
import { useActions, useSnapshot } from './context';
import { FieldList } from './fields';
import { GuardBanner, GuardPanel } from './guard';
import { ItemDetectCard, ItemSummary } from './items';
import { PaginationEditor } from './pagination';
import { PickModeStrip } from './picking';
import { RecipeBar } from './recipe';
import { RepickFooter, RepickPanel } from './repick';
import { ResultsDrawer } from './results';
import { SelectionPanel } from './selection';
import { PanelFooter, PanelHeader, PanelShell, ToastStack } from './shell';
import { StepList } from './steps';
import { ActiveTableBar, CollapsedTables, TableStrip } from './tables';

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
    case 'browse':
      actions.startBrowsing();
      return;
    case 'stopBrowse':
      actions.stopBrowsing();
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
      const count = host ? currentTable(host.draft).fields.length : 0;
      if (from === null) return;
      const to = shortcut === 'moveUp' ? from - 1 : from + 1;
      if (to < 0 || to >= count) return;
      void actions.send({ kind: 'draft.moveField', from, to });
      actions.setUi({ focusedField: to });
      return;
    }
    case 'moveStepUp':
    case 'moveStepDown': {
      const from = ui.focusedStep;
      const count = host?.draft.steps.length ?? 0;
      if (from === null) return;
      const to = shortcut === 'moveStepUp' ? from - 1 : from + 1;
      if (to < 0 || to >= count) return;
      void actions.send({ kind: 'draft.moveStep', from, to });
      actions.setUi({ focusedStep: to });
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
    case 'cancelEdit':
      void actions.send({ kind: 'draft.cancelEdit' });
      return;
    case 'clearSelection':
      void actions.send({ kind: 'selection.clear' });
      return;
  }
}

/** Resolve and run the shortcut for a key event; returns whether one ran. */
export function handleKey(e: KeyLike, target: EventTarget | null, snap: Snapshot, actions: Actions): boolean {
  // While a run waits on a guard, every key belongs to the page (the user is logging in).
  if (snap.host?.guardContext) return false;
  const shortcut = shortcutFor(e, {
    typing: isTypingTarget(target),
    picking: snap.ui.picking,
    menuOpen: snap.ui.menu !== null,
    hasProposal: Boolean(snap.host?.proposal),
    hasSelection: Boolean(snap.host?.selected),
    focusedField: snap.ui.focusedField,
    focusedStep: snap.ui.focusedStep,
    browsing: snap.ui.browsing,
    repicking: Boolean(snap.host?.repickContext),
    editing: Boolean(snap.host?.editing),
  });
  if (!shortcut) return false;
  runShortcut(shortcut, snap, actions);
  return true;
}

export { recordAsStep } from './selection';

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

  if (host.guardContext) {
    const ctx = host.guardContext;
    const abort = () => void actions.send({ kind: 'guard.abort' });
    return (
      <div style={{ display: 'contents' }} data-ws="panel">
        <PanelShell header={<PanelHeader mode={mode} onEnd={abort} />} footer={null}>
          <GuardPanel context={ctx} />
        </PanelShell>
        <GuardBanner context={ctx} onContinue={() => void actions.send({ kind: 'guard.continue' })} onAbort={abort} />
        <ToastStack toasts={ui.toasts} />
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

  const { draft, proposal } = host;
  const table = currentTable(draft);
  const fieldCount = draft.tables.reduce((sum, t) => sum + t.fields.length, 0);
  const locked = Boolean(proposal?.editing);
  const edit = (index: number, other?: number) => {
    if (ui.picking) actions.cancelPicking();
    void actions.send({ kind: 'draft.editField', index, ...(other !== undefined ? { table: other } : {}) });
  };
  return (
    <div onKeyDown={onKeyDown} style={{ display: 'contents' }} data-ws="panel">
      <PanelShell
        header={<PanelHeader mode={mode} onEnd={() => void actions.send({ kind: 'session.end' })} />}
        footer={
          <PanelFooter
            dirty={draft.dirty}
            fieldCount={fieldCount}
            stepCount={draft.steps.length}
            canTest={fieldCount > 0}
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
        <PickModeStrip picking={ui.picking} onStart={actions.startPicking} onCancel={actions.cancelPicking} level={host.levelPick?.level ?? null} />
        <SelectionPanel host={host} trail={ui.trail} />
        <TableStrip draft={draft} locked={locked} />
        <ActiveTableBar draft={draft} />
        {proposal && (
          <ItemDetectCard
            proposal={proposal}
            level={proposal[ui.level] ? ui.level : 'proposed'}
            onLevel={(level) => actions.setUi({ level })}
            highlight={ui.highlight}
            onHighlight={(highlight) => actions.setUi({ highlight })}
          />
        )}
        {table.item && !proposal && <ItemSummary item={table.item} />}
        <FieldList
          fields={table.fields}
          focused={ui.focusedField}
          repick={host.repick}
          editing={host.editing?.index ?? null}
          editLocked={locked}
          onFocus={(focusedField) => actions.setUi({ focusedField, focusedStep: null })}
          onEdit={(index) => edit(index)}
        />
        <CollapsedTables
          draft={draft}
          locked={locked}
          onEdit={(other, index) => {
            actions.setUi({ focusedField: null });
            edit(index, other);
          }}
        />
        <StepList
          steps={draft.steps}
          vars={draft.vars}
          focused={ui.focusedStep}
          repick={host.repickStep}
          browsing={ui.browsing}
          onFocus={(focusedStep) => actions.setUi({ focusedStep, focusedField: null })}
        />
        {draft.pagination && <PaginationEditor pagination={draft.pagination} />}
        {draft.errors.length > 0 && fieldCount > 0 && (
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
          active={table.name}
          view={ui.drawerView}
          onView={(drawerView) => actions.setUi({ drawerView })}
          onClose={() => actions.setUi({ drawerOpen: false })}
        />
      )}
    </div>
  );
}
