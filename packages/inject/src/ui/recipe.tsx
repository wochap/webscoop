import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { describeUrlDiff, encodeFor, fillTemplate, templateParts, templateVariables, urlDiff, type DescriptionTarget, type Draft, type RecorderState, type VarValue } from '@webscoop/core/page';
import { useActions } from './context';
import { Icon } from './icons';
import { Toggle } from './items';
import { Section } from './section';

/** Where a variable is used: "used in URL", "used in <flow> step N", "not in URL", or "not used". */
export function varUsage(draft: Pick<Draft, 'url' | 'flows'>, name: string): { url: boolean; steps: string[]; text: string } {
  const url = templateVariables(draft.url).includes(name);
  const steps = draft.flows.flatMap((f) => f.steps.flatMap((s, i) => (s.kind === 'fill' && s.value && templateVariables(s.value).includes(name) ? [`${f.name} step ${i + 1}`] : [])));
  const parts = [...(url ? ['used in URL'] : []), ...steps.map((n) => `used in ${n}`), ...(steps.length > 0 && !url ? ['not in URL'] : [])];
  return { url, steps, text: parts.length > 0 ? parts.join(' · ') : 'not used' };
}

/** How the variables list shows a variable: a display label, not a stored type. */
export type ShownAs = 'text' | 'secret' | 'path' | 'external';

export function shownAs(v: VarValue): ShownAs {
  if (v.origin) return 'external';
  if (v.secret) return 'secret';
  return v.type === 'path' ? 'path' : 'text';
}

type PathCheck = RecorderState['pathChecks'][string];

/** The file check of a path variable for its current value: "file exists", or the paths not found. */
export function pathCheckText(variable: VarValue, check: PathCheck | undefined): string | null {
  if (variable.type !== 'path' || variable.value === '' || !check || check.value !== variable.value) return null;
  const missing = check.paths.filter((p) => !p.exists).map((p) => p.path);
  if (missing.length === 0) return check.paths.length > 1 ? 'files exist' : 'file exists';
  return `not found: ${missing.join(', ')}`;
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

/** The template as text runs and highlighted `{name}` and `{+name}` tokens, for the input backdrop. */
function TemplateHighlight({ template }: { template: string }) {
  return (
    <>
      {templateParts(template).map((part, i) =>
        'text' in part ? (
          <span key={i}>{part.text}</span>
        ) : (
          <span key={i} className="ws-token">{`{${part.reserved ? '+' : ''}${part.name}}`}</span>
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
      <div className={`ws-template${error ? ' ws-invalid' : ''}`}>
        <div className="ws-template-backdrop" ref={backdrop} aria-hidden="true" data-ws="recipe-url-backdrop">
          <TemplateHighlight template={value} />
        </div>
        <input
          ref={input}
          className="ws-template-input"
          value={value}
          spellCheck={false}
          aria-label="URL template"
          data-ws="recipe-url"
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
        <span className="ws-error" data-ws="recipe-url-error">
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
    <div className="ws-rendered" data-ws="recipe-rendered-url" title={renderedUrl(draft)}>
      <span className="ws-rendered-arrow">↳</span>
      <span className="ws-ellipsis">
        {parts.map((part, i) =>
          'text' in part ? (
            <span key={i}>{part.text}</span>
          ) : (
            <span key={i} className="ws-rendered-value">
              {encodeFor(part.reserved, values[part.name] ?? '')}
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

/**
 * A multiline description that keeps local text and commits on blur; Esc
 * restores the value. Enter inserts a line break.
 */
export function DescriptionInput({ value, target, label, testId, error }: { value: string | undefined; target: DescriptionTarget; label: string; testId: string; error: string | null }) {
  const actions = useActions();
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const commit = () => {
    if (text.trim() !== (value ?? '')) void actions.send({ kind: 'draft.setDescription', target, text });
  };
  return (
    <div className="ws-col" style={{ gap: 4 }}>
      <textarea
        className={`ws-input ws-description${error ? ' ws-invalid' : ''}`}
        rows={2}
        value={text}
        placeholder="What this holds, for people and AI models"
        aria-label={label}
        data-ws={testId}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setText(value ?? '');
          }
        }}
      />
      {error && (
        <span className="ws-error" data-ws={`${testId}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * One variable: name, value, how it is shown (text, secret, path, or
 * external), description, remove, and where it is used. Removing a used
 * variable asks first. Secret values stay masked; external values are
 * read-only.
 */
export function VarTableRow({
  draft,
  variable,
  error,
  descriptionError = null,
  pathCheck,
}: {
  draft: Draft;
  variable: VarValue;
  error: string | null;
  descriptionError?: string | null;
  pathCheck?: PathCheck;
}) {
  const actions = useActions();
  const [confirming, setConfirming] = useState(false);
  const usage = varUsage(draft, variable.name);
  const used = usage.url || usage.steps.length > 0;
  const name = variable.name;
  const where = [...(usage.url ? ['URL'] : []), ...usage.steps].join(', ');
  const kind = shownAs(variable);
  const checkText = pathCheckText(variable, pathCheck);
  const stale = variable.type === 'path' && variable.value !== '' && pathCheck?.value !== variable.value;
  useEffect(() => {
    if (stale) void actions.send({ kind: 'vars.checkPath', name });
  }, [stale, name, actions]);
  const notes = [
    ...(kind === 'secret' ? ['secret · never saved'] : []),
    ...(kind === 'path' ? ['default saved'] : []),
    ...(kind === 'external' ? [`from ${variable.origin === 'config' ? 'config' : 'CLI'} · read-only here`] : []),
  ];
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
        {kind === 'external' ? (
          <input
            className="ws-var-cell ws-var-readonly"
            value={variable.secret ? '••••••••' : variable.value}
            readOnly
            title={`Bound in the ${variable.origin === 'config' ? 'config file' : 'command line'}`}
            aria-label={`Value of ${name}`}
            data-ws={`var-input-${name}`}
          />
        ) : kind === 'secret' ? (
          <CommitInput
            className="ws-var-cell"
            type="password"
            value=""
            placeholder={variable.set ? '••••••••' : 'secret'}
            autoComplete="off"
            aria-label={`Value of ${name}`}
            data-ws={`var-input-${name}`}
            onCommit={(value) => void actions.send({ kind: 'draft.setVar', name, value })}
          />
        ) : (
          <CommitInput
            className="ws-var-cell"
            value={variable.value}
            {...(kind === 'path' ? { placeholder: 'path/to/file' } : {})}
            aria-label={`Value of ${name}`}
            data-ws={`var-input-${name}`}
            onCommit={(value) => void actions.send({ kind: 'draft.setVar', name, value })}
          />
        )}
        {kind === 'external' ? (
          <span className={`ws-var-kind ws-var-kind-${kind}`} data-ws={`var-kind-${name}`}>
            external
          </span>
        ) : (
          <select
            className={`ws-var-kind ws-var-kind-${kind}`}
            value={kind}
            aria-label={`${name} shown as`}
            data-ws={`var-kind-${name}`}
            onChange={(e) => {
              const to = e.target.value as ShownAs;
              void actions.send({ kind: 'draft.setVarKind', name, secret: to === 'secret', type: to === 'path' ? 'path' : 'string' });
            }}
          >
            <option value="text">text</option>
            <option value="secret">secret</option>
            <option value="path">path</option>
          </select>
        )}
        <CommitInput
          className={`ws-var-cell ws-var-description${descriptionError ? ' ws-invalid' : ''}`}
          value={variable.description ?? ''}
          placeholder="description"
          aria-label={`Description of ${name}`}
          data-ws={`var-description-${name}`}
          onCommit={(text) => void actions.send({ kind: 'draft.setDescription', target: { kind: 'var', name }, text })}
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
      {(notes.length > 0 || checkText) && (
        <span className="ws-var-note ws-var-kind-note" data-ws={`var-kind-note-${name}`}>
          {notes.join(' · ')}
          {checkText && (
            <span className={checkText.startsWith('not found') ? 'ws-error' : 'ws-var-ok'} data-ws={`var-path-check-${name}`}>
              {notes.length > 0 ? ' · ' : ''}
              {checkText}
            </span>
          )}
        </span>
      )}
      {error && <span className="ws-error ws-var-note">{error}</span>}
      {descriptionError && (
        <span className="ws-error ws-var-note" data-ws={`var-description-error-${name}`}>
          {descriptionError}
        </span>
      )}
      {confirming ? (
        <div className="ws-var-confirm" data-ws={`var-confirm-${name}`}>
          <span className="ws-spacer">{variable.secret ? `Used in ${where} — remove it from there?` : `Used in ${where} — replace with its value?`}</span>
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
      {error && (
        <span className="ws-error" data-ws="recipe-name-error">
          {error}
        </span>
      )}
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
            <span key={i} className="ws-chip" data-ws={`recipe-summary-var-${part.name}`} title={`{${part.reserved ? '+' : ''}${part.name}}`}>
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
  pathChecks = {},
  descriptionError = null,
  openedUrl = '',
  collapsed = false,
  onCollapse,
}: {
  draft: Draft;
  urlError?: string | null;
  varError?: { name: string; message: string } | null;
  pathChecks?: RecorderState['pathChecks'];
  descriptionError?: { key: string; message: string } | null;
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
      <div className="ws-col ws-recipe">
        <label className="ws-col ws-recipe-field">
          <span className="ws-label">Name</span>
          <NameInput name={draft.name} error={draft.nameError} />
        </label>
        <div className="ws-col ws-recipe-field">
          <span className="ws-label">Description</span>
          <DescriptionInput
            value={draft.description}
            target={{ kind: 'recipe' }}
            label="Recipe description"
            testId="recipe-description"
            error={descriptionError?.key === 'recipe' ? descriptionError.message : null}
          />
        </div>
        <div className="ws-col ws-recipe-field">
          <div className="ws-row">
            <span className="ws-label">URL template</span>
            {diff && (
              <span className="ws-edited" data-ws="recipe-url-edited">
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
              <span>shown as</span>
              <span>description</span>
              <span />
            </div>
          )}
          {draft.vars.map((v) => (
            <VarTableRow
              key={v.name}
              draft={draft}
              variable={v}
              error={rowError?.name === v.name ? rowError.message : null}
              descriptionError={descriptionError?.key === `var:${v.name}` ? descriptionError.message : null}
              {...(pathChecks[v.name] ? { pathCheck: pathChecks[v.name] } : {})}
            />
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
          <button type="button" className="ws-btn ws-btn-sm ws-btn-quiet" data-ws="recipe-use-current" onClick={() => void actions.send({ kind: 'draft.useCurrentUrl' })}>
            Use current page URL
          </button>
          <button
            type="button"
            className={`ws-btn ws-btn-sm ws-btn-quiet ws-reopen${diff ? ' ws-reopen-changed' : ''}`}
            onClick={() => void actions.send({ kind: 'draft.reopen' })}
            data-ws="recipe-reopen"
          >
            Reopen
            {diff && <span className="ws-reopen-dot" data-ws="recipe-reopen-dot" />}
          </button>
        </div>
        {diff && (
          <div className="ws-open-differs" data-ws="recipe-open-differs" title={`open: ${openedUrl}\nrendered: ${rendered}`}>
            Open page differs: <span className="ws-mono-sm ws-ellipsis">{describeUrlDiff(diff)}</span>
          </div>
        )}
        <div className="ws-col ws-recipe-field">
          <div className="ws-row">
            <span className="ws-label">Humanize input</span>
            <span className="ws-spacer" />
            <Toggle
              on={draft.browser?.humanize === true}
              onChange={(on) => void actions.send({ kind: 'draft.setHumanize', on })}
              label="Humanize input"
              testId="recipe-humanize"
            />
          </div>
          <span className="ws-meta" data-ws="recipe-humanize-hint">
            Slows runs to move, type, and scroll like a person; helps on sites with bot protection.
          </span>
        </div>
      </div>
    </Section>
  );
}
