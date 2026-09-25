import { useState } from 'react';
import type { Crumb, FieldOptions, RecorderState } from '@webscoop/core/page';
import { selectorChain } from '../chain';
import { CoverageHint, EditActions, PickActionGrid, SelectorCandidateList, SelectorInput } from './candidates';
import { useActions } from './context';
import { FieldOptionsForm, formPatch, nameProblem } from './fields';
import { ElementInspector } from './picking';

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
    if (!draft.item || proposal) return null;
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
  const candidates = selected ? selected.selection.candidates : editing!.candidates;
  const primaryIndex = selected ? selected.primary : editing!.primary;
  const primary = candidates[primaryIndex];
  const scope = selected?.scope ?? editing!.options.scope;
  const containers = scope === 'item' ? (draft.item?.count ?? null) : null;
  const taken = draft.fields.filter((_, i) => i !== editing?.index).map((f) => f.name);
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
          chain={selected.scope === 'item' && draft.item ? selectorChain([draft.item.within?.[0], draft.item.selectors[0], primary]) : ''}
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
          <FieldOptionsForm value={form} onChange={setForm} nameError={nameError} hasItem={draft.item !== null} />
          {editing ? (
            <EditActions
              canUpdate={nameError === null}
              onUpdate={() => void actions.send({ kind: 'draft.updateEditedField', patch: formPatch(form) })}
              onCancel={() => void actions.send({ kind: 'draft.cancelEdit' })}
            />
          ) : (
            <PickActionGrid
              scope={form.scope}
              hasItem={draft.item !== null}
              repicking={host.repick !== null}
              canAdd={nameError === null}
              onAddField={() => void actions.send({ kind: 'draft.addField', patch: formPatch(form) })}
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
