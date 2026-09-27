import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useActions } from './context';
import { Icon } from './icons';
import { STRATEGIES, STRATEGY_TAGS, StrategyTag, type Strategy } from './selector-chip';

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
 * candidates controls. Submitting sends `strategy=value`.
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
  extra,
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
  extra?: ReactNode;
}) {
  const actions = useActions();
  const seed = () => (value ? splitSelector(value) : { strategy: 'css' as Strategy, value: '' });
  const [state, setState] = useState(seed);
  const [shown, setShown] = useState(value);
  const [live, setLive] = useState<number | null>(null);
  // Follow the host's value when it changes (a pick, a new primary), keeping the user's typing otherwise.
  if (shown !== value) {
    setShown(value);
    setState(seed());
  }
  const text = state.value.trim() ? `${state.strategy}=${state.value.trim()}` : '';
  const submitted = text !== '' && text === value;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setLive(null);
    if (!text || submitted || !actions.countSelector) return;
    timer.current = setTimeout(() => {
      void actions.countSelector!(text, scope).then(setLive);
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text, submitted, scope, actions]);
  const shownCount = !text ? null : submitted ? count : live;
  const submit = () => {
    if (!text) return;
    onSubmit(text);
    if (clearOnSubmit) setState({ strategy: state.strategy, value: '' });
  };
  const tag = STRATEGY_TAGS[state.strategy];
  return (
    <div className="ws-selin" data-ws="selector-input" data-invalid={error ? true : undefined}>
      <div className="ws-row">
        <form
          className="ws-selin-box ws-spacer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <span className="ws-selin-strategy" title={`Strategy: ${tag.name}`}>
            <StrategyTag strategy={state.strategy} />
            <span className="ws-selin-name">{state.strategy}</span>
            <Icon name="caret-down" size={9} />
            <select
              value={state.strategy}
              aria-label={`${label} strategy`}
              data-ws={`${testId}-strategy`}
              onChange={(e) => setState({ ...state, strategy: e.target.value as Strategy })}
            >
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {STRATEGY_TAGS[s].text ?? ''} {s}
                </option>
              ))}
            </select>
          </span>
          <input
            className="ws-selin-value"
            value={state.value}
            placeholder={placeholder}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            data-ws={testId}
            onChange={(e) => setState(applyTyping(state.strategy, e.target.value))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              submit();
            }}
          />
          <span
            className="ws-selin-count"
            title="Live match count"
            data-ws={`${testId}-count`}
            data-zero={shownCount === 0 || error ? true : undefined}
            data-empty={shownCount === null && !error ? true : undefined}
          >
            {error && <Icon name="warning" weight="bold" size={11} />}
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
      {error && (
        <span className="ws-error" data-ws={errorTestId}>
          {error}
        </span>
      )}
    </div>
  );
}
