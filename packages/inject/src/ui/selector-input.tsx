import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useActions, usePending } from './context';
import { Dropdown, type DropdownOption } from './dropdown';
import { Icon } from './icons';
import { selectorSyntaxError } from '../pending';
import { STRATEGIES, STRATEGY_TAGS, StrategyTag, type Strategy } from './selector-chip';

const STRATEGY_OPTIONS: DropdownOption<Strategy>[] = STRATEGIES.map((s) => ({
  value: s,
  glyph: <StrategyTag strategy={s} />,
  name: s,
  hint: STRATEGY_TAGS[s].example,
}));

const TYPED = /^(role|testid|id|text|css|class|xpath)=([\s\S]*)$/;

/** Split selector text into strategy and value with the host's rule: `strategy=value`, a `/`, `./`, or `(` start is xpath, else the fallback. */
export function splitSelector(text: string, fallback: Strategy = 'css'): { strategy: Strategy; value: string } {
  const trimmed = text.trim();
  const typed = TYPED.exec(trimmed);
  if (typed) return { strategy: typed[1] as Strategy, value: typed[2]!.trim() };
  if (fallback === 'css' && /^(?:\/|\.\/|\()/.test(trimmed)) return { strategy: 'xpath', value: trimmed };
  return { strategy: fallback, value: trimmed };
}

/**
 * The value box's text after an edit: a pasted or typed `strategy=value`
 * sets the strategy and keeps only the value; a `/` or `./` start while on
 * css switches to xpath.
 */
export function applyTyping(strategy: Strategy, text: string): { strategy: Strategy; value: string } {
  const typed = TYPED.exec(text.trimStart());
  if (typed) return { strategy: typed[1] as Strategy, value: typed[2]! };
  if (strategy === 'css' && /^\.?\//.test(text.trimStart())) return { strategy: 'xpath', value: text };
  return { strategy, value: text };
}

/**
 * One selector input for every place the panel takes selector text: a
 * strategy dropdown, the value, the live match count, and optional pick and
 * candidates controls. Submitting sends `strategy=value`. With
 * `pendingGroup`, typed text that differs from `value` is pending: it shows
 * as such, and the group's closers apply it.
 */
export function SelectorInput({
  value = '',
  onSubmit,
  count = null,
  scope = 'page',
  error = null,
  placeholder = 'selector, or paste strategy=value',
  label,
  testId,
  onPick,
  picking = false,
  candidates,
  candidatesOpen = false,
  onCandidates,
  submitLabel,
  clearOnSubmit = false,
  errorTestId = `${testId}-error`,
  pickTestId = `${testId}-pick`,
  candidatesTestId = `${testId}-candidates`,
  strategyTestId = `${testId}-strategy`,
  extra,
  counter,
  onLive,
  onEscape,
  pendingGroup,
  pendingId = testId,
}: {
  /** The current selector as `strategy=value`; the input follows it when it changes. */
  value?: string;
  onSubmit: (selector: string) => void;
  /** Matches of the current value, from the host. */
  count?: number | null;
  /** Where the live count resolves: inside each item container, or on the page. */
  scope?: 'item' | 'page';
  error?: string | null;
  placeholder?: string;
  label: string;
  /** `data-ws` of the value box. */
  testId: string;
  onPick?: () => void;
  picking?: boolean;
  /** Number of candidates; with `onCandidates` it shows the candidates control. */
  candidates?: number;
  candidatesOpen?: boolean;
  onCandidates?: () => void;
  /** Shows a submit button with this text. */
  submitLabel?: string;
  clearOnSubmit?: boolean;
  errorTestId?: string;
  pickTestId?: string;
  candidatesTestId?: string;
  strategyTestId?: string;
  extra?: ReactNode;
  /** Counts the text in place of the host's page count, also while it equals `value`; `error` marks text that cannot be resolved. */
  counter?: (selector: string) => Promise<{ count: number; error: string | null } | null>;
  /** The text and its live count after each count; null while counting. */
  onLive?: (selector: string, result: { count: number; error: string | null } | null) => void;
  onEscape?: () => void;
  /** The closers that apply this input's pending text. */
  pendingGroup?: string;
  /** Key of this input's pending entry, for a closer of this input alone. */
  pendingId?: string;
}) {
  const actions = useActions();
  const seed = () => (value ? splitSelector(value) : { strategy: 'css' as Strategy, value: '' });
  const [state, setState] = useState(seed);
  const [shown, setShown] = useState(value);
  const [live, setLive] = useState<number | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  // Follow the host's value when it changes (a pick, a new primary), keeping the user's typing otherwise.
  if (shown !== value) {
    setShown(value);
    setState(seed());
  }
  const text = state.value.trim() ? `${state.strategy}=${state.value.trim()}` : '';
  const submitted = text !== '' && text === value;
  const [applied, setApplied] = useState<string | null>(null);
  const [syntaxError, setSyntaxError] = useState<{ text: string; message: string } | null>(null);
  const pending = pendingGroup !== undefined && text !== '' && text !== value && text !== applied;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setLive(null);
    setLiveError(null);
    if (counter) {
      onLive?.(text, null);
      if (!text) return;
      timer.current = setTimeout(() => {
        void counter(text).then((result) => {
          setLive(result?.count ?? null);
          setLiveError(result?.error ?? null);
          onLive?.(text, result);
        });
      }, 250);
      return () => {
        if (timer.current) clearTimeout(timer.current);
      };
    }
    if (!text || submitted || !actions.countSelector) return;
    timer.current = setTimeout(() => {
      void actions.countSelector!(text, scope).then(setLive);
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // `counter` and `onLive` are fresh closures each render; the text is what counts.
  }, [text, submitted, scope, actions]);
  const shownCount = !text ? null : submitted && !counter ? count : live;
  const shownError = error ?? (syntaxError?.text === text ? syntaxError.message : null) ?? liveError;
  const submit = () => {
    if (!text) return;
    onSubmit(text);
    setApplied(text);
    if (clearOnSubmit) setState({ strategy: state.strategy, value: '' });
  };
  const apply = () => {
    const message = selectorSyntaxError(text);
    if (message) {
      setSyntaxError({ text, message });
      return false;
    }
    submit();
    return true;
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const registry = usePending();
  useEffect(() => {
    if (!pending || pendingGroup === undefined) return;
    let done = false;
    // A closer may run before React commits the applied state; the entry applies once.
    return registry.register(pendingId, {
      group: pendingGroup,
      apply: () => {
        if (done) return true;
        const ok = applyRef.current();
        done = ok;
        return ok;
      },
    });
  }, [pending, pendingGroup, pendingId, registry, text]);
  const tag = STRATEGY_TAGS[state.strategy];
  return (
    <div className="ws-selin" data-ws="input" data-invalid={shownError ? true : undefined}>
      <div className="ws-row">
        <form
          className="ws-selin-box ws-spacer"
          data-pending={pending || undefined}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Dropdown
            value={state.strategy}
            options={STRATEGY_OPTIONS}
            onChange={(strategy) => setState({ ...state, strategy })}
            label={`${label} strategy`}
            testId={strategyTestId}
            className="ws-selin-strategy"
            title={`Strategy: ${tag.name}`}
            renderTrigger={() => (
              <>
                <StrategyTag strategy={state.strategy} />
                <span className="ws-selin-name">{state.strategy}</span>
                <Icon name="caret-down" size={9} />
              </>
            )}
            footer={
              <>
                Paste <code>{state.strategy}=…</code> to switch automatically
              </>
            }
          />
          <input
            className="ws-selin-value"
            value={state.value}
            placeholder={placeholder}
            aria-label={label}
            aria-invalid={shownError ? true : undefined}
            data-ws={testId}
            onChange={(e) => setState(applyTyping(state.strategy, e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && onEscape) {
                e.preventDefault();
                e.stopPropagation();
                onEscape();
                return;
              }
              if (e.key === 'Escape' && pending) {
                // Esc drops pending text.
                e.preventDefault();
                e.stopPropagation();
                setState(seed());
                return;
              }
              if (e.key !== 'Enter') return;
              e.preventDefault();
              submit();
            }}
          />
          {pending && <span className="ws-selin-dot" title="Pending: Enter or the closing button applies it" data-ws={`${testId}-pending`} />}
          <span
            className="ws-selin-count"
            title="Live match count"
            data-ws={`${testId}-count`}
            data-zero={shownCount === 0 || shownError ? true : undefined}
            data-empty={shownCount === null && !shownError ? true : undefined}
          >
            {shownError && <Icon name="warning" weight="bold" size={11} />}
            {shownCount ?? '—'}
          </span>
          {onPick && (
            <button type="button" className="ws-selin-btn" title="Pick on the page" aria-label={`Pick ${label.toLowerCase()}`} aria-pressed={picking} onClick={onPick} data-ws={pickTestId}>
              <Icon name="crosshair-simple" />
            </button>
          )}
          {onCandidates && candidates !== undefined && (
            <button type="button" className="ws-selin-btn" title="Candidates" aria-expanded={candidatesOpen} onClick={onCandidates} data-ws={candidatesTestId}>
              {candidates}
              <Icon name="caret-down" size={9} />
            </button>
          )}
        </form>
        {submitLabel && (
          <button type="button" className="ws-btn ws-btn-sm" onClick={submit} disabled={!text} data-ws={`${testId}-go`}>
            {submitLabel}
          </button>
        )}
        {extra}
      </div>
      {shownError && (
        <span className="ws-error" data-ws={errorTestId}>
          {shownError}
        </span>
      )}
    </div>
  );
}
