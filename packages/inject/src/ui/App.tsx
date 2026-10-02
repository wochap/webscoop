import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { currentTable, tableMode } from '@webscoop/core/page';
import { isMenuTarget, isTypingTarget, shortcutFor, walkTrail, type KeyLike, type Shortcut } from '../keyboard';
import { modeOf, type Actions, type Snapshot } from '../store';
import { useActions, useSnapshot } from './context';
import { FieldList } from './fields';
import { GuardBanner, GuardPanel } from './guard';
import { ItemActions, ItemSummary, ListSetup, ListSetupActions } from './items';
import { PickModeStrip } from './picking';
import { RecipeBar } from './recipe';
import { RepickFooter, RepickPanel } from './repick';
import { ResultsDrawer } from './results';
import { Section } from './section';
import { FrameEditor } from './frame';
import { Icon } from './icons';
import { SelectionPanel } from './selection';
import { PanelFooter, PanelHeader, PanelShell, ToastStack } from './shell';
import { FlowsSection, switcherOrder } from './flows';
import { SequenceSection, sequenceBlocker } from './sequence';
import { TabBar, TableDescription, TableHeader } from './tables';
import { CompactBar, PanelRail, PanelStrip } from './windows';
import { flowsOnly } from './empty';

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
      if (host?.proposal && (host.proposal.proposed.count ?? 0) > 0) void actions.send({ kind: 'draft.confirmItems' });
      return;
    case 'setupList':
      void actions.send({ kind: 'list.open', from: 'suggestion' });
      return;
    case 'closeSetup':
      void actions.send({ kind: 'draft.cancelItems' });
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
      const at = ui.focusedStep;
      if (at === null || !host) return;
      const count = host.draft.flows[at.flow]?.steps.length ?? 0;
      const to = shortcut === 'moveStepUp' ? at.index - 1 : at.index + 1;
      if (to < 0 || to >= count) return;
      void actions.send({ kind: 'draft.moveStep', flow: at.flow, from: at.index, to });
      actions.setUi({ focusedStep: { flow: at.flow, index: to } });
      return;
    }
    case 'moveBlockUp':
    case 'moveBlockDown': {
      const from = ui.focusedBlock;
      if (from === null || !host) return;
      const blocks = host.draft.sequence.blocks;
      const delta = shortcut === 'moveBlockUp' ? -1 : 1;
      let to: number[];
      if (from.length === 2) {
        const inner = blocks[from[0]!];
        const length = inner && 'paginate' in inner ? inner.paginate.do.length : 0;
        const index = from[1]! + delta;
        // Moving past either end of the paginate block takes the block out of it.
        to = index < 0 ? [from[0]!] : index >= length ? [from[0]! + 1] : [from[0]!, index];
      } else {
        const index = from[0]! + delta;
        if (index < 0 || index >= blocks.length) return;
        const neighbour = blocks[index]!;
        // Moving onto the paginate block takes the block into it, at the near end.
        to = 'paginate' in neighbour && !('paginate' in blocks[from[0]!]!) ? [index, delta < 0 ? neighbour.paginate.do.length : 0] : [index];
      }
      void actions.send({ kind: 'sequence.move', from, to });
      // A block taken from above the paginate block shifts it up by one.
      actions.setUi({ focusedBlock: from.length === 1 && to.length === 2 && from[0]! < to[0]! ? [to[0]! - 1, to[1]!] : to });
      return;
    }
    case 'switcher':
      actions.setUi({ switcher: !ui.switcher, menu: null });
      return;
    case 'closeSwitcher':
      actions.setUi({ switcher: false });
      return;
    case 'chooseFlow1':
    case 'chooseFlow2':
    case 'chooseFlow3':
    case 'chooseFlow4':
    case 'chooseFlow5':
    case 'chooseFlow6':
    case 'chooseFlow7':
    case 'chooseFlow8':
    case 'chooseFlow9': {
      if (!host) return;
      const index = switcherOrder(host.draft)[Number(shortcut.slice(-1)) - 1];
      if (index !== undefined) void actions.send({ kind: 'draft.selectFlow', index });
      actions.setUi({ switcher: false });
      return;
    }
    case 'closeSheet':
      actions.setUi({ sheet: false });
      return;
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
      // Esc on a target edit's pick keeps the previous target.
      void actions.send(host?.targetEdit ? { kind: 'target.edit.cancel' } : { kind: 'selection.clear' });
      return;
    case 'moveTabLeft':
    case 'moveTabRight': {
      const from = ui.focusedTab;
      const count = host?.draft.tables.length ?? 0;
      if (from === null) return;
      const to = shortcut === 'moveTabLeft' ? from - 1 : from + 1;
      if (to < 0 || to >= count) return;
      void actions.send({ kind: 'draft.moveTable', from, to });
      actions.setUi({ focusedTab: to });
      return;
    }
    case 'renameTab': {
      const index = ui.focusedTab;
      if (index === null || !host) return;
      if (index !== host.draft.activeTable) void actions.send({ kind: 'draft.selectTable', index });
      actions.setUi({ renamingTab: index });
      return;
    }
    case 'cancelRename':
      actions.setUi({ renamingTab: null });
      return;
  }
}

/** Resolve and run the shortcut for a key event; returns whether one ran. */
export function handleKey(e: KeyLike, target: EventTarget | null, snap: Snapshot, actions: Actions): boolean {
  // While a run waits on a guard, every key belongs to the page (the user is logging in).
  if (snap.host?.guardContext) return false;
  // An open dropdown menu owns its keys (Esc closes only the menu).
  if (isMenuTarget(target)) return false;
  const host = snap.host;
  const selected = host?.selected;
  const shortcut = shortcutFor(e, {
    typing: isTypingTarget(target),
    picking: snap.ui.picking,
    menuOpen: snap.ui.menu !== null,
    hasProposal: Boolean(snap.host?.proposal),
    canConfirm: (snap.host?.proposal?.proposed.count ?? 0) > 0,
    canSetupList: Boolean(host && selected?.suggestion && !host.editing && host.repick === null && tableMode(currentTable(host.draft)) === 'none'),
    hasSelection: Boolean(snap.host?.selected || snap.host?.targetEdit),
    focusedField: snap.ui.focusedField,
    focusedStep: snap.ui.focusedStep,
    focusedBlock: snap.ui.focusedBlock,
    switcher: snap.ui.switcher,
    sheet: snap.ui.sheet,
    browsing: snap.ui.browsing,
    repicking: Boolean(snap.host?.repickContext),
    editing: Boolean(snap.host?.editing),
    focusedTab: snap.ui.focusedTab,
    renaming: snap.ui.renamingTab !== null,
    tabsLocked: Boolean(snap.host?.proposal),
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
    // A narrow window shows only the banner, across its top.
    if (ui.narrow) {
      return (
        <div style={{ display: 'contents' }} data-ws="panel">
          <GuardBanner context={ctx} onContinue={() => void actions.send({ kind: 'guard.continue' })} onAbort={abort} />
        </div>
      );
    }
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

  // Another window owns the panel: this one shows the rail or the strip.
  if (ui.panelMode !== 'owner') {
    return <div style={{ display: 'contents' }} data-ws="panel">{ui.panelMode === 'rail' ? <PanelRail /> : <PanelStrip />}</div>;
  }

  if (ui.narrow && !host.repickContext) {
    return (
      <div onKeyDown={onKeyDown} style={{ display: 'contents' }} data-ws="panel">
        <CompactBar draft={host.draft} />
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
  const stepCount = draft.flows.reduce((sum, f) => sum + f.steps.length, 0);
  const noTables = flowsOnly(draft) && !ui.showTables;
  const locked = Boolean(proposal);
  const collapsed = host.panel.collapsed;
  const collapse = (section: 'recipe' | 'flows' | 'sequence') => (on: boolean) => void actions.send({ kind: 'panel.setCollapsed', section, collapsed: on });
  const edit = (index: number) => {
    if (ui.picking) actions.cancelPicking();
    void actions.send({ kind: 'draft.editField', index });
  };
  return (
    <div onKeyDown={onKeyDown} style={{ display: 'contents' }} data-ws="panel">
      <PanelShell
        header={<PanelHeader mode={mode} onEnd={() => void actions.send({ kind: 'session.end' })} />}
        bar={proposal ? <ListSetupActions proposal={proposal} /> : undefined}
        footer={
          <PanelFooter
            dirty={draft.dirty}
            tableCount={noTables ? 0 : draft.tables.length}
            fieldCount={fieldCount}
            flowCount={draft.flows.length}
            stepCount={stepCount}
            canTest={fieldCount > 0 || stepCount > 0}
            blocker={sequenceBlocker(draft)}
            savedName={host.saved?.name ?? null}
            onTest={() => {
              void actions.send({ kind: 'test.run' });
              actions.setUi({ drawerOpen: true });
            }}
            onSave={() => void actions.send({ kind: 'save.request' })}
          />
        }
      >
        {proposal ? (
          // The list setup takes over the content; tabs, the table menu, and field edits wait.
          <div className="ws-col" style={{ gap: 'var(--ws-s3)' }} data-ws="table-content" data-table={table.name}>
            {host.levelPick && <PickModeStrip picking={ui.picking} onStart={actions.startPicking} onCancel={actions.cancelPicking} level={host.levelPick.level} hover={ui.hover} />}
            <ListSetup proposal={proposal} table={table.name} pick={host.selected?.selection.path ?? null} onPreview={(path) => actions.previewPath?.(path)} />
          </div>
        ) : (
          <>
            <RecipeBar
              draft={draft}
              urlError={host.urlError}
              varError={host.varError}
              pathChecks={host.pathChecks}
              descriptionError={host.descriptionError}
              openedUrl={host.openedUrl}
              collapsed={collapsed.recipe}
              onCollapse={collapse('recipe')}
            />
            <FlowsSection draft={draft} collapsed={collapsed.flows} onCollapse={collapse('flows')} />
            <SequenceSection draft={draft} collapsed={collapsed.sequence} onCollapse={collapse('sequence')} />
            {noTables ? (
              <section className="ws-card ws-col" data-ws="flows-only">
                <span className="ws-title">
                  <Icon name="check" size={12} /> Automation only
                </span>
                <span className="ws-meta">No tables — this recipe runs its flows and extracts nothing. A run succeeds when every step completes.</span>
                <span className="ws-row">
                  <button type="button" className="ws-btn ws-btn-sm" onClick={() => actions.setUi({ showTables: true })} data-ws="flows-only-add-table">
                    <Icon name="plus" size={11} />
                    Add a table
                  </button>
                  <span className="ws-meta">to extract data too</span>
                </span>
                <PickModeStrip picking={ui.picking} onStart={actions.startPicking} onCancel={actions.cancelPicking} level={host.levelPick?.level ?? null} hover={ui.hover} />
                <SelectionPanel host={host} trail={ui.trail} />
              </section>
            ) : (
              <>
            <TabBar draft={draft} locked={locked} />
            <TableDescription draft={draft} error={host.descriptionError} />
            <div className="ws-col" style={{ gap: 'var(--ws-s3)' }} data-ws="table-content" data-table={table.name}>
              <TableHeader draft={draft} locked={locked} />
              {table.item && (
                <Section id="rows" title="Rows" count={table.item.count ?? null} actions={<ItemActions item={table.item} locked={table.fields.length > 0} />}>
                  <ItemSummary item={table.item} />
                </Section>
              )}
              <Section id="pick" title="Pick">
                {ui.frameEdit && <FrameEditor host={host} frameKey={ui.frameEdit} />}
                <PickModeStrip picking={ui.picking} onStart={actions.startPicking} onCancel={actions.cancelPicking} level={host.levelPick?.level ?? null} hover={ui.hover} />
                <SelectionPanel host={host} trail={ui.trail} />
              </Section>
              <Section id="fields" title="Fields" count={table.fields.length > 0 ? table.fields.length : null}>
                <div className="ws-col" data-ws="fields">
                  <FieldList
                    fields={table.fields}
                    item={table.item}
                    frame={table.frame ?? null}
                    focused={ui.focusedField}
                    repick={host.repick}
                    editing={host.editing?.index ?? null}
                    editLocked={locked}
                    onFocus={(focusedField) => actions.setUi({ focusedField, focusedStep: null, focusedTab: null, focusedBlock: null })}
                    onEdit={(index) => edit(index)}
                  />
                </div>
              </Section>
            </div>
              </>
            )}
          </>
        )}
        {draft.errors.length > 0 && fieldCount > 0 && (
          <div className="ws-col" data-ws="panel-errors">
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
