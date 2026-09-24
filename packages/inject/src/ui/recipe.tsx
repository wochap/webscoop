import { useEffect, useState } from 'react';
import type { Draft, VarValue } from '@webscoop/core/page';
import { useActions } from './context';

/** Split a URL template into text runs and `{name}` variables. */
export function templateParts(template: string): ({ text: string } | { name: string })[] {
  const parts: ({ text: string } | { name: string })[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    parts.push({ name: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}

export function VarChip({ name, value, onClick }: { name: string; value: string; onClick: () => void }) {
  return (
    <button type="button" className="ws-chip" onClick={onClick} data-ws={`var-${name}`} title={`Edit ${name}`}>
      {`{${name}}`}
      <span className="ws-chip-value">{value}</span>
    </button>
  );
}

export function UrlTemplateInput({ template, vars, onEditVar }: { template: string; vars: VarValue[]; onEditVar: (name: string) => void }) {
  return (
    <div className="ws-template" data-ws="template">
      {templateParts(template).map((part, i) =>
        'text' in part ? (
          <span key={i}>{part.text}</span>
        ) : (
          <VarChip key={i} name={part.name} value={vars.find((v) => v.name === part.name)?.value ?? ''} onClick={() => onEditVar(part.name)} />
        ),
      )}
    </div>
  );
}

/** Edit one variable's value; Enter or blur commits, Esc discards. */
export function VarRow({ variable, onDone }: { variable: VarValue; onDone: () => void }) {
  const actions = useActions();
  const [value, setValue] = useState(variable.value);
  useEffect(() => setValue(variable.value), [variable.value]);
  const commit = () => {
    if (value !== variable.value) void actions.send({ kind: 'draft.setVar', name: variable.name, value });
    onDone();
  };
  return (
    <div className="ws-row">
      <span className="ws-mono-sm ws-faint">{variable.name}</span>
      <input
        className="ws-input ws-input-sm"
        value={value}
        autoFocus
        aria-label={`Value of ${variable.name}`}
        data-ws={`var-input-${variable.name}`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') onDone();
        }}
      />
    </div>
  );
}

function NameInput({ name, error }: { name: string; error: string | undefined }) {
  const actions = useActions();
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  const commit = () => {
    if (value !== name) void actions.send({ kind: 'draft.setName', name: value.trim() });
  };
  return (
    <div className="ws-col">
      <input
        className={`ws-input ws-mono${error ? ' ws-invalid' : ''}`}
        value={value}
        aria-label="Recipe name"
        data-ws="recipe-name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {error && <span className="ws-error">{error}</span>}
    </div>
  );
}

export function RecipeBar({ draft, editingVar, setEditingVar }: { draft: Draft; editingVar: string | null; setEditingVar: (name: string | null) => void }) {
  const actions = useActions();
  const editing = draft.vars.find((v) => v.name === editingVar);
  return (
    <section className="ws-col" data-ws="recipe-bar">
      <span className="ws-caps">Recipe</span>
      <NameInput name={draft.name} error={draft.nameError} />
      <UrlTemplateInput template={draft.url} vars={draft.vars} onEditVar={setEditingVar} />
      {editing && <VarRow variable={editing} onDone={() => setEditingVar(null)} />}
      {draft.vars.length > 0 && (
        <div className="ws-row">
          <span className="ws-meta ws-spacer">Change a value and reopen the page.</span>
          <button type="button" className="ws-btn ws-btn-sm" onClick={() => void actions.send({ kind: 'draft.reopen' })} data-ws="reopen">
            Reopen
          </button>
        </div>
      )}
    </section>
  );
}
