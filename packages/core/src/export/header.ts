import type { ExportPlan } from './plan';

/** What `webscoop run` does and an exported script does not, in the order the header lists them. */
export const EXCLUDED_BEHAVIORS = [
  'fingerprint healing',
  'model healing',
  'guards',
  'notifications',
  'window hiding',
  'recipe write-back',
] as const;

export interface HeaderOptions {
  /** webscoop version that exported the script. */
  version: string;
  /** Export time. */
  now: Date;
}

/** The header's text lines, without comment markers; each renderer adds its own. */
export function header(plan: ExportPlan, opts: HeaderOptions): string[] {
  return [
    `Standalone Playwright script exported from the webscoop recipe "${plan.recipe}".`,
    `Exported at ${opts.now.toISOString()} by webscoop ${opts.version}.`,
    '',
    'It navigates, replays the recipe steps, extracts rows, and paginates like',
    '`webscoop run` on a healthy site. Selector candidates are tried in their',
    'stored order; nothing else heals. Not included:',
    ...EXCLUDED_BEHAVIORS.map((behavior) => `  - ${behavior}`),
    '',
    'When the site changes, re-record the recipe with webscoop and export it',
    'again rather than editing selectors here; the recipe is the source of truth.',
  ];
}

/** Header lines as line comments with the given marker (`//` or `#`). */
export function commentBlock(lines: readonly string[], marker: string): string {
  return lines.map((line) => (line === '' ? marker : `${marker} ${line}`)).join('\n');
}
