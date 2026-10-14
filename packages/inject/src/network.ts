import type { NetworkEntry } from '@webscoop/core/page';

/** Requests the panel keeps, as the session does. */
export const NETWORK_LOG_MAX = 2000;

export type NetworkFilter = 'media' | 'xhr' | 'all';

/** HLS and DASH manifests. */
const MANIFEST_EXT = new Set(['m3u8', 'mpd']);
/** Whole media files a player may load. */
const MEDIA_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'mp3', 'ogg', 'oga', 'ogv', 'wav', 'flac', 'm4v']);
/** Pieces of a stream that a manifest lists. */
const SEGMENT_EXT = new Set(['ts', 'm4s', 'aac', 'm4a', 'cmfv', 'cmfa', 'mp4a', 'm4v_seg']);

/** Merge new and updated entries into the log, oldest first; `reset` replaces it. */
export function mergeNetwork(log: readonly NetworkEntry[], entries: readonly NetworkEntry[], reset: boolean): NetworkEntry[] {
  if (reset) return entries.slice(-NETWORK_LOG_MAX);
  const index = new Map(log.map((e, i) => [e.id, i]));
  const next = [...log];
  for (const entry of entries) {
    const at = index.get(entry.id);
    if (at !== undefined) next[at] = entry;
    else {
      index.set(entry.id, next.length);
      next.push(entry);
    }
  }
  return next.length > NETWORK_LOG_MAX ? next.slice(-NETWORK_LOG_MAX) : next;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The extension of a URL's last path segment, lowercase, or null without one. */
export function extensionOf(url: string): string | null {
  const path = parse(url)?.pathname ?? url.split(/[?#]/)[0]!;
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 && dot < last.length - 1 ? last.slice(dot + 1).toLowerCase() : null;
}

/** An HLS or DASH manifest, by extension or MIME type. */
export function isManifest(entry: Pick<NetworkEntry, 'url' | 'mime'>): boolean {
  const ext = extensionOf(entry.url);
  if (ext && MANIFEST_EXT.has(ext)) return true;
  const mime = entry.mime ?? '';
  return /mpegurl|dash\+xml/i.test(mime);
}

/** A media segment a manifest lists: `.ts`, `.m4s`, `.aac`, and similar. */
export function isSegment(entry: Pick<NetworkEntry, 'url' | 'mime'>): boolean {
  const ext = extensionOf(entry.url);
  return (ext !== null && SEGMENT_EXT.has(ext)) || entry.mime === 'video/mp2t';
}

/** A manifest or a whole media file: the "stream" badge, listed first. */
export function isStream(entry: Pick<NetworkEntry, 'url' | 'mime' | 'resourceType'>): boolean {
  if (isManifest(entry)) return true;
  if (isSegment(entry)) return false;
  const ext = extensionOf(entry.url);
  return (ext !== null && MEDIA_EXT.has(ext)) || entry.resourceType === 'media' || /^(video|audio)\//.test(entry.mime ?? '');
}

/** Which filters list the entry: Media for streams and segments, XHR/Fetch by resource type, All for everything. */
export function inFilter(entry: NetworkEntry, filter: NetworkFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'media') return isStream(entry) || isSegment(entry);
  return entry.resourceType === 'xhr' || entry.resourceType === 'fetch';
}

/** Whether the filter text is in the URL, the host, or the MIME type, ignoring case. */
export function matchesQuery(entry: NetworkEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.url.toLowerCase().includes(q) || (entry.mime ?? '').toLowerCase().includes(q);
}

/** The key two requests share when one repeats the other: the URL, without its query for a range request (206). */
export function repeatKey(entry: Pick<NetworkEntry, 'url' | 'status'>): string {
  return entry.status === 206 ? entry.url.split('?')[0]! : entry.url;
}

export interface RequestRow {
  kind: 'request';
  entry: NetworkEntry;
  /** Requests for the same URL, this one included. */
  repeats: number;
  stream: boolean;
}

export interface SegmentGroup {
  kind: 'segments';
  /** The URL up to the last `/`, shared by every segment. */
  prefix: string;
  first: string;
  last: string;
  entries: NetworkEntry[];
}

export type PickerRow = RequestRow | SegmentGroup;

const segmentNumber = (name: string) => Number(/(\d+)(?=\.[^.]+$)/.exec(name)?.[1] ?? Number.NaN);

/**
 * The picker's rows for the entries a filter shows: one row per URL with its
 * repeat count, newest first, streams above everything else, and media
 * segments that share a path prefix and extension folded into one group row
 * below the streams.
 */
export function pickerRows(entries: readonly NetworkEntry[]): PickerRow[] {
  const byKey = new Map<string, RequestRow>();
  const groups = new Map<string, SegmentGroup>();
  // Newest first: the first entry for a key is the one shown.
  for (const entry of [...entries].reverse()) {
    if (isSegment(entry)) {
      const prefix = entry.url.split('?')[0]!.slice(0, entry.url.split('?')[0]!.lastIndexOf('/') + 1);
      const key = `${prefix}*.${extensionOf(entry.url) ?? ''}`;
      const group = groups.get(key) ?? { kind: 'segments', prefix, first: '', last: '', entries: [] };
      if (!group.entries.some((e) => e.url === entry.url)) group.entries.push(entry);
      groups.set(key, group);
      continue;
    }
    const key = repeatKey(entry);
    const row = byKey.get(key);
    if (row) row.repeats++;
    else byKey.set(key, { kind: 'request', entry, repeats: 1, stream: isStream(entry) });
  }
  const rows = [...byKey.values()];
  const folded: PickerRow[] = [];
  for (const group of groups.values()) {
    // A lone segment stays a row of its own.
    if (group.entries.length === 1) {
      rows.push({ kind: 'request', entry: group.entries[0]!, repeats: 1, stream: false });
      continue;
    }
    const names = group.entries.map((e) => e.url.split('?')[0]!.slice(group.prefix.length)).sort((a, b) => segmentNumber(a) - segmentNumber(b) || a.localeCompare(b));
    folded.push({ ...group, first: names[0]!, last: names[names.length - 1]! });
  }
  return [...rows.filter((r) => r.stream), ...folded, ...rows.filter((r) => !r.stream)];
}

/** Escape text for a regex. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type ChipKind = 'filename' | 'extension' | 'hostExt' | 'exact';

export interface PatternChip {
  kind: ChipKind;
  label: string;
  pattern: string;
}

/**
 * The pattern chips for a picked URL: filename (the last path segment), extension,
 * host + extension, and the exact URL. Without an extension, the two
 * extension chips are left out; a path ending in `/` names its last segment.
 */
export function patternChips(url: string): PatternChip[] {
  const parsed = parse(url);
  const path = parsed?.pathname ?? url.split(/[?#]/)[0]!;
  const segments = path.split('/');
  const trailing = path.endsWith('/');
  const name = trailing ? `${segments.filter(Boolean).pop() ?? ''}/` : segments[segments.length - 1]!;
  const ext = trailing ? null : extensionOf(url);
  const chips: PatternChip[] = [{ kind: 'filename', label: 'filename', pattern: `/${escapeRegex(name)}(\\?|$)` }];
  if (ext) {
    const extPattern = `\\.${escapeRegex(ext)}(\\?|$)`;
    chips.push({ kind: 'extension', label: 'extension', pattern: extPattern });
    if (parsed) chips.push({ kind: 'hostExt', label: 'host + ext', pattern: `${escapeRegex(parsed.host)}/.*${extPattern}` });
  }
  chips.push({ kind: 'exact', label: 'exact URL', pattern: escapeRegex(url) });
  return chips;
}

/** The regex compile error of a pattern, or null when it compiles. */
export function regexError(pattern: string): string | null {
  if (pattern === '') return 'Enter a pattern.';
  try {
    new RegExp(pattern);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.replace(/^Invalid regular expression: /, '') : String(error);
  }
}

/** The unique URLs in the log a pattern matches, in the order first seen; empty for a pattern that does not compile. */
export function matchingUrls(pattern: string, log: readonly NetworkEntry[]): string[] {
  if (regexError(pattern) !== null) return [];
  const regex = new RegExp(pattern);
  const urls = new Set<string>();
  for (const entry of log) if (!urls.has(entry.url) && regex.test(entry.url)) urls.add(entry.url);
  return [...urls];
}

/** "1 match", "2 matches", or "0 matches yet". */
export function matchLabel(n: number, yet = true): string {
  if (n === 0) return yet ? '0 matches yet' : '0 matches';
  return `${n} match${n === 1 ? '' : 'es'}`;
}

/** A long host with its middle cut: `vz-aa93…b-cdn.net`. */
export function shortHost(host: string, max = 22): string {
  if (host.length <= max) return host;
  const tail = host.split('.').slice(-2).join('.');
  return `${host.slice(0, 7)}…${tail}`;
}

/** A URL as the picker shows it: the host and path up to the last segment, and the last segment with the query. */
export function splitUrl(url: string): { host: string; head: string; tail: string } {
  const parsed = parse(url);
  if (!parsed) return { host: '', head: '', tail: url };
  const path = parsed.pathname;
  const cut = path.endsWith('/') ? path.slice(0, -1).lastIndexOf('/') : path.lastIndexOf('/');
  return { host: parsed.host, head: path.slice(0, cut), tail: `${path.slice(cut)}${parsed.search}` };
}

/** Host of a URL, or the text itself. */
export function hostOf(url: string): string {
  return parse(url)?.host ?? url;
}

/** Seconds or minutes since a request, as "4s" or "2m". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** The frame badge of a request: the host of a frame on another host than the page, or null. */
export function frameHost(entry: NetworkEntry, pageUrl: string): string | null {
  if (!entry.frame || entry.window === 'popup') return null;
  const frame = parse(entry.frame);
  if (!frame || frame.host === '' || frame.host === parse(pageUrl)?.host) return null;
  return frame.host;
}

/** A capture name for a picked request: `videos` for a stream, `requests` otherwise. */
export function captureBaseName(entry: Pick<NetworkEntry, 'url' | 'mime' | 'resourceType'>): string {
  return isStream(entry) || isSegment(entry) ? 'videos' : 'requests';
}
