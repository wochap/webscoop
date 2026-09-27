import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { describeUrlDiff, fillTemplate, templateParts, templateVariables, urlDiff, type Draft, type VarValue } from '@webscoop/core/page';
import { useActions } from './context';
import { Icon } from './icons';
import { Section } from './section';

/** Where a variable is used: "used in URL", "used in step N", "not in URL", or "not used". */
export function varUsage(draft: Pick<Draft, 'url' | 'steps'>, name: string): { url: boolean; steps: number[]; text: string } {
  const url = templateVariables(draft.url).includes(name);
  const steps = draft.steps.flatMap((s, i) => (s.kind === 'type' && s.value && templateVariables(s.value).includes(name) ? [i + 1] : []));
  const parts = [...(url ? ['used in URL'] : []), ...steps.map((n) => `used in step ${n}`), ...(steps.length > 0 && !url ? ['not in URL'] : [])];
  return { url, steps, text: parts.length > 0 ? parts.join(' · ') : 'not used' };
}

const valuesOf = (vars: readonly VarValue[]) => Object.fromEntries(vars.map((v) => [v.name, v.value]));

/** The URL the template opens with the current values. */
export function renderedUrl(draft: Pick<Draft, 'url' | 'vars'>): string {
  try {
    return fillTemplate(draft.url, [], valuesOf(draft.vars));
  } catch {
    return draft.url;
  }
}

/** The template as text runs and highlighted `{name}` tokens, for the input backdrop. */
function TemplateHighlight({ template }: { template: string }) {
  return (
    <>
      {templateParts(template).map((part, i) =>
        'text' in part ? (
          <span key={i}>{part.text}</span>
        ) : (
          <span key={i} className="ws-token">{`{${part.name}}`}</span>
        ),
      )}
    </>
  );
}

/**
 * The URL template as a plain input over a highlight backdrop. It keeps local
 * text while focused, commits on Enter or blur, and Esc restores the draft value.
 */
export function UrlTemplateInput({ template, error }: { template: string; error: string | null }) {
  const actions = useActions();
  const [value, setValue] = useState(template);
  const input = useRef<HTMLInputElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useEffect(() => setValue(template), [template]);
  const sync = () => {
    if (backdrop.current && input.current) backdrop.current.scrollLeft = input.current.scrollLeft;
  };
  const commit = () => {
    if (value !== template) void actions.send({ kind: 'draft.setUrl', url: value });
  };
  return (
    <div className="ws-col" style={{ gap: 4 }}>
      <div className={`ws-template${error ? ' ws-invalid' : ''}`} data-ws="template">
        <div className="ws-template-backdrop" ref={backdrop} aria-hidden="true" data-ws="template-backdrop">
          <TemplateHighlight template={value} />
        </div>
        <input
          ref={input}
          className="ws-template-input"
          value={value}
          spellCheck={false}
          aria-label="URL template"
          data-ws="template-input"
          onChange={(e) => {
            setValue(e.target.value);
            sync();
          }}
          onScroll={sync}
          onSelect={sync}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setValue(template);
            }
          }}
        />
      </div>
      {error && (
        <span className="ws-error" data-ws="template-error">
          {error}
        </span>
      )}
    </div>
  );
}

/** The exact URL the template opens, without the scheme, with the encoded values emphasised. */
export function RenderedUrl({ draft }: { draft: Pick<Draft, 'url' | 'vars'> }) {
  const values = valuesOf(draft.vars);
  const parts = templateParts(draft.url);
  const first = parts[0];
  if (first && 'text' in first) parts[0] = { text: first.text.replace(/^https?:\/\//, '') };
  return (
    <div className="ws-rendered" data-ws="rendered-url" title={renderedUrl(draft)}>
      <span className="ws-rendered-arrow">↳</span>
      <span className="ws-ellipsis">
        {parts.map((part, i) =>
          'text' in part ? (
            <span key={i}>{part.text}</span>
          ) : (
            <span key={i} className="ws-rendered-value">
              {encodeURIComponent(values[part.name] ?? '')}
            </span>
          ),
        )}
      </span>
    </div>
  );
}

/** An input that keeps local text and commits on Enter or blur; Esc restores the value. */
function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (value: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <input
      {...rest}
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setText(value);
        }
      }}
    />
  );
}

/** One variable: name, value, remove, and where it is used. Removing a used variable asks first. */
export function VarTableRow({ draft, variable, error }: { draft: Draft; variable: VarValue; error: string | null }) {
  const actions = useActions();
  const [confirming, setConfirming] = useState(false);
  const usage = varUsage(draft, variable.name);
  const used = usage.url || usage.steps.length > 0;
  const name = variable.name;
  const where = [...(usage.url ? ['URL'] : []), ...usage.steps.map((n) => `step ${n}`)].join(', ');
  return (
    <>
      <div className="ws-var-row" data-ws={`var-row-${name}`}>
        <CommitInput
          className={`ws-var-cell ws-var-name${error ? ' ws-invalid' : ''}`}
          value={name}
          aria-label={`Name of ${name}`}
          data-ws={`var-name-${name}`}
          onCommit={(to) => void actions.send({ kind: 'draft.renameVar', from: name, to: to.trim() })}
        />
        <CommitInput
          className="ws-var-cell"
          value={variable.value}
          aria-label={`Value of ${name}`}
          data-ws={`var-input-${name}`}
          onCommit={(value) => void actions.send({ kind: 'draft.setVar', name, value })}
        />
        <button
          type="button"
          className="ws-var-remove"
          title={`Remove ${name}`}
          aria-label={`Remove ${name}`}
          data-ws={`var-remove-${name}`}
          onClick={() => (used ? setConfirming(true) : void actions.send({ kind: 'draft.removeVar', name }))}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
      {error && <span className="ws-error ws-var-note">{error}</span>}
      {confirming ? (
        <div className="ws-var-confirm" data-ws={`var-confirm-${name}`}>
          <span className="ws-spacer">{`Used in ${where} — replace with its value?`}</span>
          <button
            type="button"
            className="ws-btn ws-btn-sm ws-tone-danger"
            onClick={() => {
              setConfirming(false);
              void actions.send({ kind: 'draft.removeVar', name });
            }}
          >
            Remove
          </button>
          <button type="button" className="ws-btn ws-btn-sm ws-btn-ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <span className="ws-var-note ws-var-usage" data-ws={`var-usage-${name}`}>
          {usage.text}
        </span>
      )}
    </>
  );
}

/** The "+ var" control: a button that turns into a name input; Enter adds, Esc cancels. */
function AddVar({ error }: { error: { name: string; message: string } | null }) {
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) {
    return (
      <button type="button" className="ws-btn ws-btn-sm ws-btn-quiet" data-ws="var-add" onClick={() => setOpen(true)}>
        <Icon name="plus" size={12} />
        var
      </button>
    );
  }
  const add = () => {
    const trimmed = name.trim();
    if (trimmed) void actions.send({ kind: 'draft.addVar', name: trimmed });
    setOpen(false);
    setName('');
  };
  return (
    <input
      className={`ws-input ws-input-sm ws-mono-sm${error ? ' ws-invalid' : ''}`}
      style={{ width: 118 }}
      autoFocus
      placeholder="name"
      aria-label="New variable name"
      data-ws="var-add-input"
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={add}
      onKeyDown={(e) => {
        if (e.key === 'Enter') add();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
          setName('');
        }
      }}
    />
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

/** The collapsed Recipe summary: the name and the URL template with its variables as chips holding their values. */
export function RecipeSummary({ draft }: { draft: Draft }) {
  return (
    <>
      <span className="ws-mono-sm" style={{ color: 'var(--ws-text)' }} data-ws="recipe-summary-name">
        {draft.name}
      </span>
      <span className="ws-mono-sm ws-ellipsis" data-ws="recipe-summary-url">
        {templateParts(draft.url).map((part, i) =>
          'text' in part ? (
            <span key={i}>{part.text}</span>
          ) : (
            <span key={i} className="ws-chip" data-ws={`summary-var-${part.name}`} title={`{${part.name}}`}>
              {part.name}
              <span className="ws-chip-value">{draft.vars.find((v) => v.name === part.name)?.value ?? ''}</span>
            </span>
          ),
        )}
      </span>
    </>
  );
}

export function RecipeBar({
  draft,
  urlError = null,
  varError = null,
  openedUrl = '',
  collapsed = false,
  onCollapse,
}: {
  draft: Draft;
  urlError?: string | null;
  varError?: { name: string; message: string } | null;
  openedUrl?: string;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
}) {
  const actions = useActions();
  const rendered = renderedUrl(draft);
  const diff = openedUrl ? urlDiff(openedUrl, rendered) : null;
  const rowError = varError && draft.vars.some((v) => v.name === varError.name) ? varError : null;
  const addError = varError && !rowError ? varError : null;
  return (
    <Section id="recipe" title="Recipe" collapsible collapsed={collapsed} {...(onCollapse ? { onCollapse } : {})} summary={<RecipeSummary draft={draft} />}>
      <div className="ws-col ws-recipe" data-ws="recipe-bar">
        <label className="ws-col ws-recipe-field">
          <span className="ws-label">Name</span>
          <NameInput name={draft.name} error={draft.nameError} />
        </label>
        <div className="ws-col ws-recipe-field">
          <div className="ws-row">
            <span className="ws-label">URL template</span>
            {diff && (
              <span className="ws-edited" data-ws="template-edited">
                edited
              </span>
            )}
          </div>
          <UrlTemplateInput template={draft.url} error={urlError} />
          <RenderedUrl draft={draft} />
        </div>
        <div className="ws-var-table" data-ws="var-table">
          {draft.vars.length > 0 && (
            <div className="ws-var-row ws-var-head">
              <span>var</span>
              <span>value</span>
              <span />
            </div>
          )}
          {draft.vars.map((v) => (
            <VarTableRow key={v.name} draft={draft} variable={v} error={rowError?.name === v.name ? rowError.message : null} />
          ))}
          {addError && (
            <span className="ws-error" data-ws="var-add-error">
              {addError.message}
            </span>
          )}
        </div>
        <div className="ws-row">
          <AddVar error={addError} />
          <span className="ws-spacer" />
          <button type="button" className="ws-btn ws-btn-sm ws-btn-quiet" data-ws="use-current-url" onClick={() => void actions.send({ kind: 'draft.useCurrentUrl' })}>
            Use current page URL
          </button>
          <button
            type="button"
            className={`ws-btn ws-btn-sm ws-btn-quiet ws-reopen${diff ? ' ws-reopen-changed' : ''}`}
            onClick={() => void actions.send({ kind: 'draft.reopen' })}
            data-ws="reopen"
          >
            Reopen
            {diff && <span className="ws-reopen-dot" data-ws="reopen-dot" />}
          </button>
        </div>
        {diff && (
          <div className="ws-open-differs" data-ws="open-differs" title={`open: ${openedUrl}\nrendered: ${rendered}`}>
            Open page differs: <span className="ws-mono-sm ws-ellipsis">{describeUrlDiff(diff)}</span>
          </div>
        )}
      </div>
    </Section>
  );
}
