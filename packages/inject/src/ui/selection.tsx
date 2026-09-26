import { useState } from 'react';
import { currentTable, type Crumb, type DraftTable, type FieldOptions, type RecorderState } from '@webscoop/core/page';
import { selectorChain } from '../chain';
import { CoverageHint, EditActions, PickActionGrid, SelectorCandidateList, SelectorInput } from './candidates';
import { useActions } from './context';
import { FieldOptionsForm, formPatch, nameProblem } from './fields';
import { ElementInspector } from './picking';
import { newTableName, tableNameProblem } from './tables';

const NEW_TABLE = 'new';

/** The table a new field goes to: every table of the draft, or a new one named inline. */
export function TableSelect({
  tables,
  value,
  newName,
  newError,
  onChange,
  onNewName,
}: {
  tables: readonly DraftTable[];
  /** Index of the chosen table, or null for a new table. */
  value: number | null;
  newName: string;
  newError: string | null;
  onChange: (table: number | null) => void;
  onNewName: (name: string) => void;
}) {
  return (
    <div className="ws-col" data-ws="form-table-row">
      <div className="ws-row">
        <span className="ws-meta">table</span>
        <select
          className="ws-select ws-spacer"
          value={value === null ? NEW_TABLE : String(value)}
          aria-label="Table"
          data-ws="form-table"
          onChange={(e) => onChange(e.target.value === NEW_TABLE ? null : Number(e.target.value))}
        >
          {tables.map((t, i) => (
            <option key={`${i}-${t.name}`} value={String(i)}>
              {t.name}
            </option>
          ))}
          <option value={NEW_TABLE}>New table…</option>
        </select>
        {value === null && (
          <input
            className={`ws-input ws-input-sm ws-mono-sm ws-spacer${newError ? ' ws-invalid' : ''}`}
            value={newName}
            aria-label="New table name"
            aria-invalid={newError ? true : undefined}
            data-ws="form-table-name"
            onChange={(e) => onNewName(e.target.value)}
          />
        )}
      </div>
      {value === null && newError && (
        <span className="ws-error" data-ws="form-table-error">
          {newError}
        </span>
      )}
    </div>
  );
}

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

function TypedSelector({ host, scope }: { host: RecorderState; scope: 'item' | 'page' }) {
  const actions = useActions();
  return <SelectorInput scope={scope} error={host.selectorError} onSubmit={(selector) => void actions.send({ kind: 'selection.setSelector', selector, scope })} />;
}

function SelectionBody({ host, trail, seed }: { host: RecorderState; trail: Crumb[]; seed: FieldOptions }) {
  const actions = useActions();
  const [form, setForm] = useState(seed);
  const { selected, editing, draft, proposal } = host;
  const [newName, setNewName] = useState(() => newTableName(draft.tables));
  const candidates = selected ? selected.selection.candidates : editing!.candidates;
  const primaryIndex = selected ? selected.primary : editing!.primary;
  const primary = candidates[primaryIndex];
  const scope = selected?.scope ?? editing!.options.scope;
  // A new selection is computed for its target table (null: a new one); an edit stays in the active table.
  const targetIndex = editing ? draft.activeTable : (selected!.table ?? null);
  const target = targetIndex === null ? null : (draft.tables[targetIndex] ?? currentTable(draft));
  const item = target?.item ?? null;
  const containers = scope === 'item' ? (item?.count ?? null) : null;
  const taken = (target?.fields ?? []).filter((_, i) => i !== editing?.index).map((f) => f.name);
  const newError = targetIndex === null ? tableNameProblem(newName, draft.tables) : null;
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
          chain={selected.scope === 'item' && item ? selectorChain([item.within?.[0], item.selectors[0], primary]) : ''}
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
      />
      {primary?.items !== undefined && containers !== null && (primary.count ?? 0) > 0 && (
        <CoverageHint items={primary.items} containers={containers} optional={form.optional} onOptional={() => setForm({ ...form, optional: true })} />
      )}
      <TypedSelector host={host} scope={form.scope} />
      {!proposal && (
        <>
          {!editing && (
            <TableSelect
              tables={draft.tables}
              value={targetIndex}
              newName={newName}
              newError={newError}
              onChange={(table) => void actions.send({ kind: 'selection.retarget', table })}
              onNewName={setNewName}
            />
          )}
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
              canAdd={nameError === null && newError === null}
              onAddField={() => void actions.send({ kind: 'draft.addField', patch: { ...formPatch(form), table: targetIndex === null ? { new: newName.trim() } : targetIndex } })}
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
