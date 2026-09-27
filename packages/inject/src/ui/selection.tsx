import { useState } from 'react';
import { currentTable, type Crumb, type FieldOptions, type RecorderState } from '@webscoop/core/page';
import { CoverageHint, EditActions, PickActionGrid, SelectorCandidateList } from './candidates';
import { useActions } from './context';
import { FieldOptionsForm, formPatch, nameProblem } from './fields';
import { Icon } from './icons';
import { ElementInspector } from './picking';
import { SelectorInput } from './selector-input';
import { stackLevels } from './selector-stack';

/** The step "record as step" makes from a picked element: typing for text boxes, a click for anything else. */
export function recordAsStep(tag: string, attrs: Record<string, string>): { kind: 'click' } | { kind: 'type'; value: string } {
  const type = (attrs.type ?? '').toLowerCase();
  const typed = tag === 'textarea' || (tag === 'input' && ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(type));
  return typed ? { kind: 'type', value: '' } : { kind: 'click' };
}

/**
 * The selection panel: the inspector, the candidates, the typed selector,
 * the field options form, and the actions, for a new selection or a saved
 * field being edited. With nothing selected it offers only the typed
 * selector, when an item container is set.
 */
export function SelectionPanel({ host, trail }: { host: RecorderState; trail: Crumb[] }) {
  const { selected, editing, draft, proposal } = host;
  if (!selected && !editing) {
    if (!currentTable(draft).item || proposal) return null;
    return <TypedSelector host={host} scope="item" />;
  }
  const seed: FieldOptions = editing
    ? editing.options
    : {
        name: selected!.defaults.name,
        type: selected!.defaults.type,
        scope: selected!.scope,
        attr: selected!.defaults.attr ?? '',
        optional: false,
        key: false,
      };
  // The form starts over for each new selection, and stays through re-picks while editing.
  const key = editing ? `edit-${editing.index}` : `select-${selected!.selection.path.join('.')}-${selected!.scope}-${selected!.defaults.name}`;
  return <SelectionBody key={key} host={host} trail={trail} seed={seed} />;
}

/** Typed selector text for the selection, through the selector input. */
export function TypedSelector({ host, scope }: { host: RecorderState; scope: 'item' | 'page' }) {
  const actions = useActions();
  return (
    <SelectorInput
      label="Selection selector"
      testId="selection-selector"
      errorTestId="selector-error"
      scope={scope}
      error={host.selectorError}
      placeholder={scope === 'item' ? 'selector inside each item, e.g. h3' : 'selector on the page, e.g. h1'}
      submitLabel="Select"
      onSubmit={(selector) => void actions.send({ kind: 'selection.setSelector', selector, scope })}
    />
  );
}

/** Says the pick moved the active table, and why. */
export function MovedNotice({ host }: { host: RecorderState }) {
  const moved = host.selected?.moved;
  if (!moved) return null;
  return (
    <div className="ws-notice" role="status" data-ws="moved-notice">
      <Icon name="arrow-right" size={12} />
      <span>
        Moved to <b>{currentTable(host.draft).name}</b>: {moved.reason}
      </span>
    </div>
  );
}

function SelectionBody({ host, trail, seed }: { host: RecorderState; trail: Crumb[]; seed: FieldOptions }) {
  const actions = useActions();
  const [form, setForm] = useState(seed);
  const { selected, editing, draft, proposal } = host;
  const candidates = selected ? selected.selection.candidates : editing!.candidates;
  const primaryIndex = selected ? selected.primary : editing!.primary;
  const primary = candidates[primaryIndex];
  const scope = selected?.scope ?? editing!.options.scope;
  // The selection is computed for the active table: the tabs choose it.
  const target = selected && selected.table !== null ? (draft.tables[selected.table] ?? currentTable(draft)) : currentTable(draft);
  const targetIndex = draft.tables.indexOf(target);
  const item = target.item;
  const containers = scope === 'item' ? (item?.count ?? null) : null;
  const taken = target.fields.filter((_, i) => i !== editing?.index).map((f) => f.name);
  const nameError = nameProblem(form.name, taken);
  const clear = () => void actions.send({ kind: 'selection.clear' });
  return (
    <>
      {selected ? (
        <ElementInspector
          selection={selected.selection}
          trail={trail}
          onSelectPath={actions.selectPath}
          onClear={clear}
          chain={
            selected.scope === 'item' && item
              ? stackLevels(item.within?.[0], item.selectors[0], { within: item.withinCount ?? null, item: item.count }, { candidate: primary, count: primary?.items !== undefined && containers !== null ? `${primary.items}/${containers}` : null })
              : []
          }
        />
      ) : (
        <div className="ws-warning" role="alert" data-ws="edit-zero-match">
          <span className="ws-spacer">This field matches nothing on this page. Pick its element or type a selector.</span>
        </div>
      )}
      <SelectorCandidateList
        candidates={candidates}
        primary={primaryIndex}
        containers={containers}
        onPrimary={(index) => void actions.send({ kind: 'inspect.primary', index })}
        level={scope === 'item' ? 'field' : 'page'}
      />
      {primary?.items !== undefined && containers !== null && (primary.count ?? 0) > 0 && (
        <CoverageHint items={primary.items} containers={containers} optional={form.optional} onOptional={() => setForm({ ...form, optional: true })} />
      )}
      <TypedSelector host={host} scope={form.scope} />
      {!proposal && (
        <>
          <FieldOptionsForm value={form} onChange={setForm} nameError={nameError} hasItem={item !== null} />
          {editing ? (
            <EditActions
              canUpdate={nameError === null}
              onUpdate={() => void actions.send({ kind: 'draft.updateEditedField', patch: formPatch(form) })}
              onCancel={() => void actions.send({ kind: 'draft.cancelEdit' })}
            />
          ) : (
            <PickActionGrid
              scope={form.scope}
              hasItem={item !== null}
              repicking={host.repick !== null}
              canAdd={nameError === null}
              onAddField={() => void actions.send({ kind: 'draft.addField', patch: { ...formPatch(form), table: targetIndex } })}
              onRecordStep={() => void actions.send({ kind: 'draft.addStep', step: recordAsStep(selected!.selection.tag, selected!.selection.attrs) })}
              onUseAsItems={() => void actions.send({ kind: 'draft.setItem' })}
              onPagination={() => void actions.send({ kind: 'draft.markPagination' })}
              onDismiss={actions.startPicking}
            />
          )}
        </>
      )}
    </>
  );
}
