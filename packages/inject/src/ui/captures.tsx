import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Draft, DraftCapture, NetworkEntry } from '@webscoop/core/page';
import { copyText } from '../clipboard';
import {
  ago,
  frameHost,
  hostOf,
  inFilter,
  isSegment,
  isStream,
  matchesQuery,
  matchingUrls,
  matchLabel,
  patternChips,
  pickerRows,
  regexError,
  shortHost,
  splitUrl,
  type ChipKind,
  type NetworkFilter,
  type PickerRow,
} from '../network';
import type { CaptureEditorState } from '../store';
import { useActions, useSnapshot } from './context';
import { flowsOnly } from './empty';
import { Icon } from './icons';
import { Toggle } from './items';
import { Section } from './section';
import { Kbd } from './shell';

/** Columns of a capture table, for the editor's output line. */
const CAPTURE_COLUMNS = 'url, method, status, mime, frame';

const FILTERS: { value: NetworkFilter; label: string; empty: string }[] = [
  { value: 'media', label: 'Media', empty: 'No media requests yet' },
  { value: 'xhr', label: 'XHR/Fetch', empty: 'No XHR/Fetch requests yet' },
  { value: 'all', label: 'All', empty: 'No requests yet' },
];

/** Names a new capture cannot take: saved tables, other captures, and `downloads`. */
function takenNames(draft: Draft, except?: number): string[] {
  return [...(flowsOnly(draft) ? [] : draft.tables.map((t) => t.name)), ...draft.captures.filter((_, i) => i !== except).map((c) => c.name), 'downloads'];
}

function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

/** Required captures no request in the log matches yet. */
export function unmatchedCaptures(draft: Pick<Draft, 'captures'>, network: readonly NetworkEntry[]): number {
  return draft.captures.filter((c) => !c.optional && matchingUrls(c.match, network).length === 0).length;
}

/** URL text with its end visible: the path's head ellipsizes, the last segment stays. */
function UrlText({ url }: { url: string }) {
  const { head, tail } = splitUrl(url);
  return (
    <span className="ws-url" title={url}>
      <span className="ws-url-head">{head}</span>
      <span className="ws-url-tail">{tail}</span>
    </span>
  );
}

/** The Captures section (frames N1, N4, N7): captures with live match badges, the notice for unmatched required ones, the picker and the editor. */
export function CapturesSection({ draft, collapsed, onCollapse }: { draft: Draft; collapsed: boolean; onCollapse: (collapsed: boolean) => void }) {
  const { ui, network, host } = useSnapshot();
  const actions = useActions();
  const popup = host?.popup ?? false;
  const captures = draft.captures;
  const matches = useMemo(() => captures.map((c) => matchingUrls(c.match, network)), [captures, network]);
  const openPicker = () => {
    actions.setUi({ picker: true, captureEditor: null });
    if (collapsed) onCollapse(false);
  };
  const unmatched = captures.map((c, i) => ({ c, i })).filter(({ c, i }) => !c.optional && matches[i]!.length === 0);
  const summary = captures.length === 0 ? 'URLs from network requests' : `${captures.length} capture${captures.length === 1 ? '' : 's'}`;
  return (
    <Section
      id="captures"
      title="Captures"
      count={captures.length > 0 ? captures.length : null}
      collapsible
      collapsed={collapsed}
      onCollapse={onCollapse}
      summary={<span data-ws="captures-summary">{summary}</span>}
      actions={
        <button type="button" className="ws-btn ws-btn-sm" onClick={openPicker} data-ws="captures-pick">
          <Icon name="plus" size={11} />
          Pick from network
        </button>
      }
    >
      <div className="ws-col" data-ws="captures">
        {unmatched.map(({ c }) => (
          <div key={c.name} className="ws-banner ws-banner-warn" role="alert" data-ws="capture-notice" data-capture={c.name}>
            <span className="ws-banner-icon">
              <Icon name="warning" size={12} />
            </span>
            <span className="ws-col ws-spacer">
              <span className="ws-banner-text">
                <span className="ws-mono-sm">{c.name}</span> hasn’t matched yet. It’s required, so a run now would fail. Play the video in the page to check it.
              </span>
              <span className="ws-row">
                <button type="button" className="ws-btn ws-btn-sm" onClick={() => void actions.send({ kind: 'capture.update', index: captures.indexOf(c), patch: { optional: true } })} data-ws="capture-make-optional">
                  Make optional
                </button>
                <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={openPicker} data-ws="capture-open-picker">
                  Open picker
                </button>
              </span>
            </span>
          </div>
        ))}
        {captures.length === 0 && !ui.picker && !ui.captureEditor && <span className="ws-meta">URLs from network requests, such as a video’s playlist the page never shows.</span>}
        {captures.map((capture, i) => (
          <CaptureRow key={capture.name} capture={capture} index={i} urls={matches[i]!} open={ui.openCaptures.includes(capture.name)} />
        ))}
        {ui.captureEditor && <CaptureEditor draft={draft} editor={ui.captureEditor} />}
        {ui.picker && !ui.captureEditor && (
          <NetworkPicker
            compact={popup}
            onClose={() => actions.setUi({ picker: false })}
            onPick={(entry) =>
              // In a popup, the editor opens in the main window.
              popup ? (actions.setUi({ picker: false }), void actions.send({ kind: 'capture.pick', id: entry.id })) : actions.setUi({ captureEditor: { mode: 'new', url: entry.url, frame: entry.frame, stream: isStream(entry) || isSegment(entry) } })
            }
          />
        )}
      </div>
    </Section>
  );
}

function CaptureRow({ capture, index, urls, open }: { capture: DraftCapture; index: number; urls: string[]; open: boolean }) {
  const { ui } = useSnapshot();
  const actions = useActions();
  const menuId = `capture-menu-${index}`;
  const menuOpen = ui.menu === menuId;
  const toggle = () => actions.setUi({ openCaptures: open ? ui.openCaptures.filter((n) => n !== capture.name) : [...ui.openCaptures, capture.name] });
  const tone = urls.length > 0 ? 'ws-tone-ok' : capture.optional ? 'ws-tone-neutral' : 'ws-tone-warn';
  const close = () => actions.setUi({ menu: null });
  return (
    <div className="ws-col ws-capture" data-ws="capture-row" data-capture={capture.name}>
      <div className="ws-row">
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} the URLs ${capture.name} matched`} onClick={toggle} data-ws="capture-caret">
          <Icon name={open ? 'caret-down' : 'caret-right'} size={10} />
        </button>
        <span className="ws-mono-sm ws-title">{capture.name}</span>
        <span className="ws-mono-sm ws-faint ws-ellipsis ws-spacer" title={capture.match} data-ws="capture-pattern-text">
          {capture.match}
        </span>
        <button type="button" className={`ws-pill ${tone}`} onClick={toggle} data-ws="capture-badge" data-count={urls.length}>
          {matchLabel(urls.length, capture.optional || urls.length > 0)}
        </button>
        <span className="ws-menu-anchor">
          <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" aria-label={`Capture ${capture.name} menu`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => actions.setUi({ menu: menuOpen ? null : menuId })} data-ws="capture-menu">
            <Icon name="dots-three" size={14} />
          </button>
          {menuOpen && (
            <div className="ws-menu" role="menu" style={{ right: 0, top: 24 }} data-ws="capture-menu-list">
              <button type="button" role="menuitem" className="ws-menu-item" onClick={() => (close(), actions.setUi({ captureEditor: { mode: 'edit', index }, picker: false }))} data-ws="capture-edit">
                <Icon name="pencil-simple" size={12} /> Edit <span className="ws-menu-hint">E</span>
              </button>
              <button type="button" role="menuitem" className="ws-menu-item" onClick={() => (close(), actions.setUi({ picker: true, captureEditor: null, networkQuery: '', networkFilter: 'all' }))} data-ws="capture-show-in-picker">
                <Icon name="eye" size={12} /> Show in picker
              </button>
              <button type="button" role="menuitem" className="ws-menu-item ws-menu-danger" onClick={() => (close(), void actions.send({ kind: 'capture.remove', index }))} data-ws="capture-delete">
                <Icon name="trash" size={12} /> Delete <span className="ws-menu-hint">Del</span>
              </button>
            </div>
          )}
        </span>
      </div>
      <span className="ws-meta ws-row-indent" data-ws="capture-meta">
        waits for {capture.count} · {capture.optional ? 'optional' : 'required'}
      </span>
      {capture.error && (
        <span className="ws-error ws-row-indent" data-ws="capture-error">
          {capture.error}
        </span>
      )}
      {open && (
        <div className="ws-col ws-row-indent" data-ws="capture-urls">
          {urls.length === 0 && <span className="ws-meta">No request matches yet.</span>}
          {urls.map((url) => (
            <span key={url} className="ws-mono-sm" data-ws="capture-url">
              <UrlText url={url} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The Network picker (frames N2, N2b, N5): the session's requests, filtered, streams first, segments folded, repeats counted. */
export function NetworkPicker({ onPick, onClose, compact = false }: { onPick: (entry: NetworkEntry) => void; onClose: () => void; compact?: boolean }) {
  const { ui, network, host } = useSnapshot();
  const actions = useActions();
  const pageUrl = host?.url ?? '';
  const [focused, setFocused] = useState(0);
  const [reveal, setReveal] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const queried = network.filter((e) => matchesQuery(e, ui.networkQuery));
  const counts = Object.fromEntries(FILTERS.map((f) => [f.value, pickerRows(queried.filter((e) => inFilter(e, f.value))).length])) as Record<NetworkFilter, number>;
  const rows = pickerRows(queried.filter((e) => inFilter(e, ui.networkFilter)));
  // Flatten open groups, so the keyboard walks their segments too.
  const flat: ({ kind: 'row'; row: PickerRow } | { kind: 'segment'; entry: NetworkEntry })[] = rows.flatMap((row) => [
    { kind: 'row' as const, row },
    ...(row.kind === 'segments' && openGroups.includes(row.prefix) ? row.entries.map((entry) => ({ kind: 'segment' as const, entry })) : []),
  ]);
  const at = Math.min(focused, Math.max(0, flat.length - 1));
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [at]);
  const now = Date.now();
  const activate = (i: number) => {
    const item = flat[i];
    if (!item) return;
    if (item.kind === 'segment') return onPick(item.entry);
    if (item.row.kind === 'request') return onPick(item.row.entry);
    const prefix = item.row.prefix;
    setOpenGroups((open) => (open.includes(prefix) ? open.filter((p) => p !== prefix) : [...open, prefix]));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setFocused(Math.max(0, Math.min(flat.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      activate(at);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowRight') {
      const item = flat[at];
      const url = item ? (item.kind === 'segment' ? item.entry.url : item.row.kind === 'request' ? item.row.entry.url : null) : null;
      if (url && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault();
        setReveal(reveal === url ? null : url);
      }
    }
  };
  const filter = FILTERS.find((f) => f.value === ui.networkFilter)!;
  const requestRow = (entry: NetworkEntry, i: number, extra: { repeats?: number; stream?: boolean; dim?: boolean }) => {
    const frame = frameHost(entry, pageUrl);
    const { tail, head } = splitUrl(entry.url);
    return (
      <div
        key={`${entry.id}-${i}`}
        role="option"
        aria-selected={i === at}
        className={`ws-net-row${i === at ? ' ws-net-row-focused' : ''}${extra.dim ? ' ws-faint' : ''}`}
        onMouseEnter={() => {
          setFocused(i);
          setReveal(entry.url);
        }}
        onMouseLeave={() => setReveal((url) => (url === entry.url ? null : url))}
        onClick={() => activate(i)}
        data-ws="network-row"
        data-index={i}
        data-url={entry.url}
        title={entry.url}
      >
        <span className="ws-row">
          {extra.stream && (
            <span className="ws-badge ws-tone-accent" data-ws="network-stream">
              stream
            </span>
          )}
          <span className="ws-url ws-spacer">
            <span className="ws-url-head">{head}</span>
            <span className="ws-url-tail">{tail}</span>
          </span>
          {(extra.repeats ?? 1) > 1 && (
            <span className="ws-meta" data-ws="network-repeats">
              ×{extra.repeats}
            </span>
          )}
          <span className="ws-meta">{ago(entry.at, now)}</span>
        </span>
        <span className="ws-row ws-meta">
          <span>{entry.method}</span>
          <span>{entry.failed ? 'failed' : (entry.status ?? '…')}</span>
          <span>{shortHost(hostOf(entry.url))}</span>
          {entry.mime && <span>· {entry.mime.replace(/^application\//, '')}</span>}
          <span className="ws-spacer" />
          {frame && (
            <span className="ws-frame-badge" data-ws="network-frame">
              {frame}
            </span>
          )}
          {entry.window === 'popup' && (
            <span className="ws-window-badge" data-ws="network-popup">
              popup
            </span>
          )}
        </span>
        {reveal === entry.url && (
          <span className="ws-row" data-ws="network-full-url">
            <span className="ws-mono-sm ws-spacer" style={{ wordBreak: 'break-all' }}>
              {entry.url}
            </span>
            <button
              type="button"
              className="ws-btn ws-btn-ghost ws-btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                void copyText(entry.url, list.current?.getRootNode() ?? undefined).then((ok) => actions.toast(ok ? 'ok' : 'danger', ok ? 'URL copied' : 'Could not copy the URL'));
              }}
              data-ws="network-copy"
            >
              copy URL
            </button>
          </span>
        )}
      </div>
    );
  };
  return (
    <div className={`ws-col ws-net${compact ? ' ws-net-compact' : ''}`} onKeyDown={onKeyDown} data-ws="network-picker">
      <div className="ws-row">
        <span className="ws-active-dot ws-active-dot-on" title="Listening" />
        <span className="ws-meta">live</span>
        <input
          className="ws-input ws-input-sm ws-spacer"
          placeholder="Filter by URL, host or MIME"
          aria-label="Filter requests"
          value={ui.networkQuery}
          autoFocus
          onChange={(e) => {
            setFocused(0);
            actions.setUi({ networkQuery: e.target.value });
          }}
          data-ws="network-filter"
        />
        <button type="button" className="ws-btn ws-btn-ghost ws-btn-sm" onClick={onClose} aria-label="Close the picker" data-ws="network-close">
          <Kbd>Esc</Kbd>
        </button>
      </div>
      <div className="ws-row ws-wrap">
        <div className="ws-seg" role="group" aria-label="Request filter">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={ui.networkFilter === f.value}
              onClick={() => {
                setFocused(0);
                actions.setUi({ networkFilter: f.value });
              }}
              data-ws="network-chip"
              data-filter={f.value}
            >
              {f.label} <span className="ws-count">{counts[f.value]}</span>
            </button>
          ))}
        </div>
        <span className="ws-meta ws-ellipsis ws-spacer" data-ws="network-counter">
          {network.length} request{network.length === 1 ? '' : 's'} · {rows.length} shown
        </span>
      </div>
      <div className="ws-col ws-net-list" role="listbox" tabIndex={0} aria-label="Requests" ref={list} data-ws="network-list">
        {rows.length === 0 && (
          <div className="ws-col ws-center" data-ws="network-empty">
            <span className="ws-title">{filter.empty}</span>
            <span className="ws-meta">Play the video or navigate in the page, requests appear here live.</span>
            {ui.networkFilter !== 'all' && counts.all > 0 && (
              <button type="button" className="ws-btn ws-btn-sm" onClick={() => actions.setUi({ networkFilter: 'all' })} data-ws="network-show-all">
                Show all {counts.all}
              </button>
            )}
          </div>
        )}
        {flat.map((item, i) => {
          if (item.kind === 'segment') return requestRow(item.entry, i, { dim: true });
          const row = item.row;
          if (row.kind === 'request') return requestRow(row.entry, i, { repeats: row.repeats, stream: row.stream });
          const open = openGroups.includes(row.prefix);
          const sample = row.entries[0]!;
          return (
            <div
              key={`group-${row.prefix}`}
              role="option"
              aria-selected={i === at}
              aria-expanded={open}
              className={`ws-net-row ws-faint${i === at ? ' ws-net-row-focused' : ''}`}
              onMouseEnter={() => setFocused(i)}
              onClick={() => activate(i)}
              data-ws="network-group"
              data-index={i}
              title={row.prefix}
            >
              <span className="ws-row">
                <Icon name={open ? 'caret-down' : 'caret-right'} size={10} />
                <span className="ws-url ws-spacer">
                  <span className="ws-url-head">{splitUrl(`${row.prefix}x`).head}</span>
                  <span className="ws-url-tail" data-ws="network-group-label">
                    /{row.first} … {row.last}
                  </span>
                </span>
                <span className="ws-meta" data-ws="network-group-count">
                  {row.entries.length} segments
                </span>
              </span>
              <span className="ws-row ws-meta">
                <span>{sample.method}</span>
                <span>{sample.status ?? '…'}</span>
                <span>{shortHost(hostOf(sample.url))}</span>
                {sample.mime && <span>· {sample.mime}</span>}
                <span className="ws-spacer" />
                {frameHost(sample, pageUrl) && <span className="ws-frame-badge">{frameHost(sample, pageUrl)}</span>}
                {sample.window === 'popup' && <span className="ws-window-badge">popup</span>}
              </span>
            </div>
          );
        })}
      </div>
      <span className="ws-row ws-meta">
        {compact ? 'Click a row to capture · editor opens in main' : 'Streams on top · segments grouped'}
        <span className="ws-spacer" />
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd>
        <Kbd>Enter</Kbd>
      </span>
    </div>
  );
}

/** The capture editor (frames N3, N3b, N6): name, pattern chips and regex, live matches, count, optional, output. */
export function CaptureEditor({ draft, editor }: { draft: Draft; editor: CaptureEditorState }) {
  const { network } = useSnapshot();
  const actions = useActions();
  const existing = editor.mode === 'edit' ? draft.captures[editor.index] : undefined;
  const sourceUrl = editor.mode === 'new' ? editor.url : (matchingUrls(existing?.match ?? '', network)[0] ?? null);
  const chips = useMemo(() => (sourceUrl ? patternChips(sourceUrl) : []), [sourceUrl]);
  const [name, setName] = useState(() => existing?.name ?? uniqueName(editor.mode === 'new' && editor.stream ? 'videos' : 'requests', takenNames(draft)));
  const [pattern, setPattern] = useState(existing?.match ?? chips[0]?.pattern ?? '');
  const [chip, setChip] = useState<ChipKind | null>(existing ? (chips.find((c) => c.pattern === existing.match)?.kind ?? null) : 'filename');
  const [count, setCount] = useState(existing?.count ?? 1);
  const [optional, setOptional] = useState(existing?.optional ?? false);
  const error = regexError(pattern);
  const urls = error ? [] : matchingUrls(pattern, network);
  const close = () => actions.setUi({ captureEditor: null });
  const submit = () => {
    if (error || !name.trim()) return;
    if (existing && editor.mode === 'edit') void actions.send({ kind: 'capture.update', index: editor.index, patch: { name: name.trim(), match: pattern, count, optional } });
    else void actions.send({ kind: 'capture.add', capture: { name: name.trim(), match: pattern, count, optional } });
    actions.setUi({ captureEditor: null, picker: false });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  };
  const helper = error ? (
    <span className="ws-error" data-ws="capture-helper" data-error="true">
      {error}
    </span>
  ) : chip === 'exact' ? (
    <span className="ws-meta" data-ws="capture-helper">
      Matches only this URL. Other pages or videos won’t match.
    </span>
  ) : (
    <span className="ws-meta" data-ws="capture-helper">
      Matched against the full request URL. Case-sensitive.
    </span>
  );
  return (
    <div className="ws-card ws-col ws-capture-editor" onKeyDown={onKeyDown} data-ws="capture-editor" data-mode={editor.mode}>
      <span className="ws-row">
        <span className="ws-title">{existing ? `Edit ${existing.name}` : 'New capture'}</span>
        <span className="ws-spacer" />
        <span className="ws-active-dot ws-active-dot-on" title="Listening" />
        <span className="ws-meta">live</span>
      </span>
      {editor.mode === 'new' && (
        <div className="ws-edit-line">
          <span className="ws-edit-label">from</span>
          <span className="ws-col ws-spacer" style={{ minWidth: 0 }}>
            <span className="ws-mono-sm" data-ws="capture-from">
              <UrlText url={editor.url} />
            </span>
            {editor.frame && hostOf(editor.frame) !== hostOf(editor.url) && <span className="ws-frame-badge">{hostOf(editor.frame)}</span>}
          </span>
        </div>
      )}
      <div className="ws-edit-line">
        <span className="ws-edit-label">name</span>
        <input className="ws-input ws-input-sm ws-mono-sm ws-spacer" aria-label="Capture name" value={name} onChange={(e) => setName(e.target.value)} data-ws="capture-name" />
      </div>
      <div className="ws-edit-line">
        <span className="ws-edit-label">pattern</span>
        <span className="ws-col ws-spacer" style={{ minWidth: 0 }}>
          {chips.length > 0 && (
            <span className="ws-row ws-wrap">
              {chips.map((c) => (
                <button
                  key={c.kind}
                  type="button"
                  className="ws-chip"
                  aria-pressed={chip === c.kind}
                  onClick={() => {
                    setChip(c.kind);
                    setPattern(c.pattern);
                  }}
                  data-ws="capture-chip"
                  data-kind={c.kind}
                >
                  {c.label} <span className="ws-count">{matchingUrls(c.pattern, network).length}</span>
                </button>
              ))}
            </span>
          )}
          <input
            className="ws-input ws-input-sm ws-mono-sm"
            aria-label="Pattern"
            aria-invalid={error !== null}
            value={pattern}
            onChange={(e) => {
              setChip(null);
              setPattern(e.target.value);
            }}
            data-ws="capture-pattern"
          />
          {helper}
        </span>
      </div>
      <div className="ws-edit-line">
        <span className="ws-edit-label">matches</span>
        <span className="ws-col ws-spacer" style={{ minWidth: 0 }} data-ws="capture-matches">
          {error ? (
            <span className="ws-meta">— fix the pattern to see matches</span>
          ) : (
            <>
              <span className="ws-row">
                <span className={`ws-pill ${urls.length > 0 ? 'ws-tone-ok' : 'ws-tone-neutral'}`} data-ws="capture-match-count" data-count={urls.length}>
                  {matchLabel(urls.length, false)}
                </span>
                <span className="ws-meta">{chip === 'exact' ? 'this request only' : `of ${network.length} requests · updates live`}</span>
              </span>
              {urls.slice(0, 5).map((url) => (
                <span key={url} className="ws-mono-sm" data-ws="capture-match-url">
                  <UrlText url={url} />
                </span>
              ))}
              {urls.length > 5 && <span className="ws-meta">and {urls.length - 5} more</span>}
            </>
          )}
        </span>
      </div>
      <div className="ws-edit-line">
        <span className="ws-edit-label">count</span>
        <span className="ws-stepper" data-ws="capture-count">
          <button type="button" className="ws-btn ws-btn-sm" aria-label="Fewer" disabled={count <= 1} onClick={() => setCount(count - 1)} data-ws="capture-count-minus">
            −
          </button>
          <span className="ws-num" data-ws="capture-count-value">
            {count}
          </span>
          <button type="button" className="ws-btn ws-btn-sm" aria-label="More" onClick={() => setCount(count + 1)} data-ws="capture-count-plus">
            +
          </button>
        </span>
        <span className="ws-meta">unique URL{count === 1 ? '' : 's'} to wait for</span>
      </div>
      <div className="ws-edit-line">
        <span className="ws-edit-label">optional</span>
        <Toggle on={optional} label="Optional" onChange={setOptional} testId="capture-optional" />
        <span className="ws-meta">{optional ? 'optional · the run only warns if fewer match' : 'required · the run fails if fewer match'}</span>
      </div>
      <div className="ws-edit-line">
        <span className="ws-edit-label">output</span>
        <span className="ws-meta" data-ws="capture-output">
          table <span className="ws-mono-sm">{name.trim() || '…'}</span> · {CAPTURE_COLUMNS}
        </span>
      </div>
      <span className="ws-row">
        <span className="ws-spacer" />
        <button type="button" className="ws-btn ws-btn-sm" onClick={close} data-ws="capture-cancel">
          Cancel <Kbd>Esc</Kbd>
        </button>
        <button type="button" className="ws-btn ws-btn-primary ws-btn-sm" disabled={error !== null || !name.trim()} onClick={submit} data-ws="capture-add">
          {existing ? 'Save capture' : 'Add capture'} <Kbd>Enter</Kbd>
        </button>
      </span>
    </div>
  );
}

/** The fixed last line of the Sequence section while the draft has captures. */
export function CaptureWaitLine() {
  return (
    <div className="ws-block ws-block-fixed" aria-disabled="true" title="The run waits for every required capture after the sequence" data-ws="sequence-capture-wait">
      <Icon name="lock-simple" size={10} />
      <span className="ws-meta">wait for captures</span>
    </div>
  );
}
