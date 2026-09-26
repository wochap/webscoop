import { useEffect, useState, type HTMLAttributes } from 'react';
import { defaultAttr, FIELD_SCOPES, FIELD_TYPES, type DraftField, type FieldOptions, type FieldPatch } from '@webscoop/core/page';
import { useActions } from './context';
import { Toggle } from './items';

type FieldType = DraftField['type'];

export function TypeSelect({ value, onChange, testId = 'field-type' }: { value: FieldType; onChange: (type: FieldType) => void; testId?: string }) {
  return (
    <select className="ws-select" value={value} aria-label="Field type" onChange={(e) => onChange(e.target.value as FieldType)} data-ws={testId}>
      {FIELD_TYPES.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

export function ScopeBadge({ scope }: { scope: DraftField['scope'] }) {
  return (
    <span className={`ws-badge ws-scope ${scope === 'item' ? 'ws-tone-accent' : 'ws-tone-neutral'}`} data-ws="scope">
      {scope}
    </span>
  );
}

export function DedupKeyToggle({ on, onChange, testId = 'field-key' }: { on: boolean; onChange: (on: boolean) => void; testId?: string }) {
  return (
    <span className="ws-row" title="Use this field to recognise the same row across pages">
      <span className="ws-meta">key</span>
      <Toggle on={on} onChange={onChange} label="Dedup key" testId={testId} />
    </span>
  );
}

export function ZeroMatchWarning({ onRepick, onOptional, optional }: { onRepick: () => void; onOptional: () => void; optional: boolean }) {
  return (
    <div className="ws-warning" role="alert" data-ws="zero-match">
      <span className="ws-spacer">Matches nothing on this page.</span>
      <button type="button" className="ws-btn ws-btn-sm" onClick={onRepick} data-ws="repick">
        Re-pick
      </button>
      {!optional && (
        <button type="button" className="ws-btn ws-btn-sm" onClick={onOptional} data-ws="make-optional">
          Mark optional
        </button>
      )}
    </div>
  );
}

/** The form's values as a field patch: every option set, an empty attribute cleared. */
export function formPatch(form: FieldOptions): FieldPatch {
  return { name: form.name.trim(), type: form.type, scope: form.scope, attr: form.attr?.trim() || null, optional: form.optional, key: form.key };
}

/** Why the form's name cannot be saved, or null: empty, or taken by another field. */
export function nameProblem(name: string, taken: readonly string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'the field needs a name';
  return taken.includes(trimmed) ? `another field is already named ${trimmed}` : null;
}

/** Name, type, attribute, scope, optional, and dedup key of the field the selection becomes. */
export function FieldOptionsForm({
  value,
  onChange,
  nameError,
  hasItem,
}: {
  value: FieldOptions;
  onChange: (next: FieldOptions) => void;
  nameError: string | null;
  hasItem: boolean;
}) {
  const set = (patch: Partial<FieldOptions>) => onChange({ ...value, ...patch });
  return (
    <section className="ws-col" data-ws="field-form">
      <div className="ws-row">
        <input
          className={`ws-input ws-input-sm ws-mono-sm ws-spacer${nameError ? ' ws-invalid' : ''}`}
          value={value.name}
          aria-label="Field name"
          aria-invalid={nameError ? true : undefined}
          data-ws="form-name"
          onChange={(e) => set({ name: e.target.value })}
        />
        <TypeSelect
          value={value.type}
          testId="form-type"
          onChange={(type) => {
            // The attribute follows the type unless the user typed one of their own.
            const followed = value.attr === undefined || value.attr === '' || value.attr === defaultAttr(value.type);
            const attr = defaultAttr(type);
            set(followed ? { type, attr: attr ?? '' } : { type });
          }}
        />
        <select
          className="ws-select"
          value={value.scope}
          aria-label="Field scope"
          data-ws="form-scope"
          onChange={(e) => set({ scope: e.target.value as FieldOptions['scope'] })}
        >
          {FIELD_SCOPES.map((scope) => (
            <option key={scope} value={scope} disabled={scope === 'item' && !hasItem}>
              {scope}
            </option>
          ))}
        </select>
      </div>
      {nameError && (
        <span className="ws-error" data-ws="form-name-error">
          {nameError}
        </span>
      )}
      <div className="ws-row">
        <span className="ws-meta">attr</span>
        <input
          className="ws-input ws-input-sm ws-mono-sm ws-spacer"
          value={value.attr ?? ''}
          placeholder="text content"
          aria-label="Attribute to read"
          data-ws="form-attr"
          onChange={(e) => set({ attr: e.target.value })}
        />
        <span className="ws-row">
          <span className="ws-meta">optional</span>
          <Toggle on={value.optional} onChange={(optional) => set({ optional })} label="Optional" testId="form-optional" />
        </span>
        <DedupKeyToggle on={value.key} onChange={(key) => set({ key })} testId="form-key" />
      </div>
    </section>
  );
}

function NameField({ field, index }: { field: DraftField; index: number }) {
  const actions = useActions();
  const [value, setValue] = useState(field.name);
  useEffect(() => setValue(field.name), [field.name]);
  const commit = () => {
    if (value !== field.name) void actions.send({ kind: 'draft.updateField', index, patch: { name: value.trim() } });
  };
  return (
    <input
      className={`ws-input ws-input-sm ws-mono-sm${field.error ? ' ws-invalid' : ''}`}
      value={value}
      aria-label="Field name"
      aria-invalid={field.error ? true : undefined}
      data-ws="field-name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

export function FieldRow({
  field,
  index,
  focused,
  repicking,
  editing,
  editLocked = false,
  onFocus,
  onEdit,
  dragging,
  dragProps,
}: {
  field: DraftField;
  index: number;
  focused: boolean;
  repicking: boolean;
  /** The field is open in the selection panel. */
  editing: boolean;
  /** Field edits are unavailable, such as while the item container is being edited. */
  editLocked?: boolean;
  onFocus: () => void;
  onEdit: () => void;
  dragging: boolean;
  dragProps: Omit<HTMLAttributes<HTMLDivElement>, 'className'>;
}) {
  const actions = useActions();
  const update = (patch: FieldPatch) => void actions.send({ kind: 'draft.updateField', index, patch });
  const primary = field.selectors[0]!;
  return (
    <div
      {...dragProps}
      className={`ws-field${focused || editing ? ' ws-field-focused' : ''}${dragging ? ' ws-field-dragging' : ''}`}
      data-ws="field"
      data-name={field.name}
      data-editing={editing || undefined}
      tabIndex={-1}
      draggable
      onFocus={onFocus}
      onClick={onFocus}
    >
      <div className="ws-row">
        <span className="ws-handle" aria-hidden="true" title="Drag to reorder (Alt+Up, Alt+Down)">
          ⋮⋮
        </span>
        <NameField field={field} index={index} />
        <TypeSelect value={field.type} onChange={(type) => update({ type })} />
        <ScopeBadge scope={field.scope} />
        <span className={`ws-num${field.count === 0 ? ' ws-num-zero' : ''}`} data-ws="field-count" title="Matches of the primary selector on this page">
          {field.count ?? '…'}
        </span>
        <button
          type="button"
          className="ws-btn ws-btn-ghost ws-btn-sm"
          aria-label={`Edit field ${field.name}`}
          aria-pressed={editing}
          disabled={editLocked}
          title={editLocked ? 'Finish editing the items first' : 'Open in the selection panel to change its selectors and options'}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          data-ws="field-edit"
        >
          {editing ? 'Editing' : 'Edit'}
        </button>
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Remove field ${field.name}`} onClick={() => void actions.send({ kind: 'draft.removeField', index })} data-ws="field-remove">
          ×
        </button>
      </div>
      {field.error && (
        <span className="ws-error" data-ws="field-error">
          {field.error}
        </span>
      )}
      <div className={`ws-row${editLocked ? '' : ' ws-clickable'}`} data-ws="field-summary" title={editLocked ? undefined : 'Edit this field'} onClick={editLocked ? undefined : onEdit}>
        <span className="ws-mono-sm ws-faint ws-ellipsis ws-spacer" title={`${primary.strategy}=${primary.value}`}>
          {primary.strategy}={primary.value}
        </span>
        <span className="ws-meta ws-ellipsis" style={{ maxWidth: 140 }} title={field.sample ?? ''} data-ws="field-sample">
          {field.sample ?? ''}
        </span>
      </div>
      <div className="ws-row">
        <span className="ws-row ws-spacer">
          <span className="ws-meta">optional</span>
          <Toggle on={field.optional} onChange={(optional) => update({ optional })} label="Optional" testId="field-optional" />
        </span>
        <DedupKeyToggle on={field.key} onChange={(key) => update({ key })} />
      </div>
      {repicking && <span className="ws-meta">Pick the element for this field on the page.</span>}
      {field.count === 0 && !repicking && (
        <ZeroMatchWarning
          optional={field.optional}
          onRepick={() => {
            void actions.send({ kind: 'draft.repickTarget', target: 'field', index });
            actions.startPicking();
          }}
          onOptional={() => update({ optional: true })}
        />
      )}
    </div>
  );
}

/** Fields in recipe order; drag or Alt+Up and Alt+Down reorder. */
export function FieldList({
  fields,
  focused,
  repick,
  editing = null,
  editLocked = false,
  onFocus,
  onEdit = () => {},
}: {
  fields: DraftField[];
  focused: number | null;
  repick: number | null;
  /** Index of the field open in the selection panel. */
  editing?: number | null;
  /** Disable every field's Edit action. */
  editLocked?: boolean;
  onFocus: (index: number | null) => void;
  onEdit?: (index: number) => void;
}) {
  const actions = useActions();
  const [dragging, setDragging] = useState<number | null>(null);
  if (fields.length === 0) {
    return (
      <section className="ws-col" data-ws="fields">
        <span className="ws-caps">Fields</span>
        <span className="ws-meta">No fields yet. Pick an element and add it as a field.</span>
      </section>
    );
  }
  return (
    <section className="ws-col" data-ws="fields">
      <span className="ws-caps">Fields · {fields.length}</span>
      {fields.map((field, index) => (
        <FieldRow
          key={`${index}-${field.name}`}
          field={field}
          index={index}
          focused={focused === index}
          repicking={repick === index}
          editing={editing === index}
          editLocked={editLocked}
          onFocus={() => onFocus(index)}
          onEdit={() => onEdit(index)}
          dragging={dragging === index}
          dragProps={{
            onDragStart: (e) => {
              setDragging(index);
              e.dataTransfer?.setData('text/plain', String(index));
            },
            onDragOver: (e) => e.preventDefault(),
            onDrop: (e) => {
              e.preventDefault();
              const from = dragging ?? Number(e.dataTransfer?.getData('text/plain'));
              setDragging(null);
              if (Number.isInteger(from) && from !== index) {
                void actions.send({ kind: 'draft.moveField', from, to: index });
                onFocus(index);
              }
            },
            onDragEnd: () => setDragging(null),
          }}
        />
      ))}
    </section>
  );
}
