// zod/mini keeps the injected page bundle small; the recipe schema itself stays on classic zod.
import * as z from 'zod/mini';
import { FILL_KINDS } from '../fill-kind';
import type { SerializedElement } from '../ports';
import type { FieldScope } from '../recipe/schema';
import {
  FIELD_SCOPES,
  FIELD_TYPES,
  GUARD_KINDS,
  PAGINATE_KINDS,
  STABILITIES,
  STEP_KINDS,
  STEP_UNTILS,
  STEP_WINDOWS,
  STOP_RULES,
  STRATEGIES,
} from '../recipe/constants';

/** Key of a description edit target, as used in `descriptionError`. */
export function descriptionKey(target: DescriptionTarget): string {
  return target.kind === 'recipe' ? 'recipe' : target.kind === 'table' ? `table:${target.index}` : `var:${target.name}`;
}

/**
 * Messages between the injected recorder page and the host process.
 * Page to host goes through the `__webscoopHost` binding, which returns a
 * host message as the reply. Host to page goes through
 * `window.__webscoopPage.dispatch`.
 */

export const HOST_BINDING = '__webscoopHost';
export const PAGE_GLOBAL = '__webscoopPage';

const count = () => z.int().check(z.nonnegative());
const index = () => z.int().check(z.nonnegative());

export const SelectorSchema = z.object({
  strategy: z.enum(STRATEGIES),
  value: z.string().check(z.minLength(1)),
  stability: z.enum(STABILITIES),
});
export const CandidateSchema = z.extend(SelectorSchema, {
  count: z.optional(count()),
  /** For an item scoped candidate: how many item containers hold at least one match. */
  items: z.optional(count()),
  /** Whether the first match is the element picked by hand; absent when not verified. */
  hit: z.optional(z.boolean()),
});
export const PathSchema = z.array(index());
export const BBoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

/** Mirrors the recipe fingerprint; the recipe schema validates it again on save. */
export const ProtocolFingerprintSchema = z.object({
  tag: z.string().check(z.minLength(1)),
  role: z.optional(z.string()),
  name: z.optional(z.string()),
  textSample: z.string().check(z.maxLength(80)),
  attrs: z.record(z.string(), z.string()),
  ancestors: z.array(z.string()).check(z.maxLength(6)),
  bbox: BBoxSchema,
});

/** A serialized annotated element. Children are checked shallowly to keep large pages cheap. */
export const SnapshotSchema = z.custom<SerializedElement>((value) => {
  const v = value as Partial<SerializedElement> | null;
  return typeof v === 'object' && v !== null && v.type === 'element' && typeof v.tag === 'string' && typeof v.attrs === 'object' && Array.isArray(v.children);
}, 'expected a serialized element');

export const CrumbSchema = z.object({ label: z.string(), path: PathSchema });

/** An `<iframe>` in the top document whose document holds a target: its candidates (with counts in the top document) and fingerprint. */
export const FrameTargetSchema = z.object({
  selectors: z.array(CandidateSchema).check(z.minLength(1)),
  fingerprint: z.optional(ProtocolFingerprintSchema),
});

/** Short name of a frame target for the panel: `iframe#id` for an id candidate, else the primary selector. */
export function frameLabel(frame: { selectors: readonly { strategy: string; value: string }[] }): string {
  const primary = frame.selectors[0];
  if (!primary) return 'iframe';
  if (primary.strategy === 'id') return `iframe#${primary.value}`;
  if (primary.strategy === 'css' || primary.strategy === 'class') return primary.value;
  return `iframe ${primary.strategy}=${primary.value}`;
}

/** Whether two frame targets name the same `<iframe>`: one's primary is among the other's candidates. */
export function sameFrame(
  a: { selectors: readonly { strategy: string; value: string }[] } | null | undefined,
  b: { selectors: readonly { strategy: string; value: string }[] } | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  const key = (c: { strategy: string; value: string }) => `${c.strategy}=${c.value}`;
  const keys = new Set(a.selectors.map(key));
  return b.selectors.some((c) => keys.has(key(c)));
}

/** What the page reports about a picked element. */
export const FillPreviewSchema = z.object({
  kind: z.enum(FILL_KINDS),
  /** The element's current state as a fill value; empty for a file input. */
  value: z.string(),
  /** The input's label, `name`, or `id`, for naming a variable. */
  hint: z.string(),
  /** An `input[type=password]`: its fill makes a secret variable. */
  password: z._default(z.boolean(), false),
});

export const SelectionSchema = z.object({
  path: PathSchema,
  tag: z.string(),
  role: z.optional(z.string()),
  name: z.optional(z.string()),
  text: z.string(),
  attrs: z.record(z.string(), z.string()),
  candidates: z.array(CandidateSchema),
  fingerprint: ProtocolFingerprintSchema,
  /** From the document body down to the element itself. */
  ancestors: z.array(CrumbSchema),
  /** Path of the item container holding the element, when an item container is set. */
  containerPath: z._default(z.nullable(PathSchema), null),
  /** For an element inside a same-origin iframe: the `<iframe>`'s path in the top document. `path`, `ancestors`, and `containerPath` are then in the iframe's document. */
  framePath: z._default(z.nullable(PathSchema), null),
  /** The `<iframe>` as a target, for an element inside one. */
  frame: z._default(z.nullable(FrameTargetSchema), null),
  /** What a fill of the element sets, read from the live element when it was picked; null for an element a fill cannot set. */
  fill: z._default(z.nullable(FillPreviewSchema), null),
});

/** The two proposal fields the user edits: the list parent and the item container. */
export const LEVEL_KINDS = ['within', 'item'] as const;
/** Where a list setup was opened from: a pick's suggestion, empty for manual input, or the set item container. */
export const PROPOSAL_ORIGINS = ['pick', 'manual', 'edit'] as const;

export const LevelSchema = z.object({
  tag: z.string(),
  label: z.string(),
  path: PathSchema,
  selectors: z.array(CandidateSchema),
  /** Index in `selectors` of the candidate saved first. */
  primary: z._default(index(), 0),
  /** Matches left after the proposal's exclusions. */
  count: z.nullable(count()),
  /** Matches before exclusions. */
  total: z._default(z.nullable(count()), null),
  paths: z.array(PathSchema),
  samples: z.array(z.string()),
});

/** One row of "Adjust item level": an ancestor-or-self of the pick (or of the item container) below the list parent. */
export const ItemLadderRowSchema = z.object({
  /** Steps up from the pick, or from the item container without a pick. */
  distance: index(),
  path: PathSchema,
  /** The level's top candidate, relative to the list parent; null when none matches. */
  selector: z.nullable(CandidateSchema),
  /** Matches of `selector` inside the list parent. */
  count: count(),
  /** The level the recorder proposes. */
  likely: z.boolean(),
  /** Distance of the listed row that matches the same elements; this row is folded into it. */
  sameAs: z._default(z.nullable(index()), null),
});

/** One row of "Adjust list parent": an ancestor of the item container. */
export const ParentLadderRowSchema = z.object({
  distance: index(),
  path: PathSchema,
  selector: z.nullable(CandidateSchema),
  /** Children with the item container's tag and a similar structure. */
  children: count(),
  likely: z.boolean(),
});

export const ProposalSchema = z.object({
  /** The list parent, or null when there is none or the user cleared it. */
  within: z._default(z.nullable(LevelSchema), null),
  /** The list parent was derived by the recorder, not chosen by the user. Not saved in the recipe. */
  withinInferred: z._default(z.boolean(), false),
  /** The item container level; a manual setup starts with an empty one (no selectors, count 0). */
  proposed: LevelSchema,
  /** Elements on the item level under the list parent left out as dissimilar; 0 with `includeAll`. */
  skipped: z._default(count(), 0),
  /** Whether every element on the item level counts, similar or not. Not saved in the recipe. */
  includeAll: z._default(z.boolean(), false),
  /** Why the last edit of a field was refused; the previous value stays in effect. */
  error: z._default(z.nullable(z.object({ level: z.enum(LEVEL_KINDS), message: z.string() })), null),
  /** Exclusions added before confirming; they move to the item on confirm. */
  exclude: z._default(z.array(CandidateSchema), []),
  /** `edit` replaces the set item container; `pick` returns to the pick on accept. No accept adds a field. */
  origin: z._default(z.enum(PROPOSAL_ORIGINS), 'pick'),
  /** Item count of the set container before an edit. */
  previousCount: z._default(z.nullable(count()), null),
  /** The pick read inside the proposed containers: its top relative candidate and coverage. */
  pick: z._default(z.nullable(z.object({ selector: z.nullable(CandidateSchema), matched: count(), total: count() })), null),
  /** Filled on `list.ladder`; null until asked. */
  itemLadder: z._default(z.nullable(z.array(ItemLadderRowSchema)), null),
  parentLadder: z._default(z.nullable(z.array(ParentLadderRowSchema)), null),
  /** While editing: item fields whose primary would match in fewer of the new containers than there are. */
  fieldPreview: z._default(z.array(z.object({ name: z.string(), matched: count(), total: count() })), []),
});

export const VarValueSchema = z.object({
  name: z.string(),
  value: z.string(),
  /** Added with "+ var": kept in the draft while nothing uses it, never saved unused. */
  added: z.optional(z.literal(true)),
  description: z.optional(z.string()),
  /** A file path variable; its value is saved as the default. */
  type: z.optional(z.literal('path')),
  /** Masked in the panel, kept for the session only, never saved. The panel receives an empty value and `set`. */
  secret: z.optional(z.literal(true)),
  /** Sent to the panel for a secret with a value. */
  set: z.optional(z.literal(true)),
  /** Bound outside the recipe, in the config file or on the command line: read-only, and saved without a default. */
  origin: z.optional(z.enum(['config', 'cli'])),
  /** For an external variable: the recipe's own default, saved in place of the bound value. */
  savedDefault: z.optional(z.string()),
});

export const DraftFieldSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES),
  scope: z.enum(FIELD_SCOPES),
  selectors: z.array(CandidateSchema).check(z.minLength(1)),
  attr: z.optional(z.string()),
  optional: z.boolean(),
  key: z.boolean(),
  /** Walk the candidates per row instead of using only the settled primary; absent means false. */
  fallback: z.optional(z.boolean()),
  /** Move the real mouse over the element before reading it at run time; absent means false. */
  hover: z.optional(z.boolean()),
  fingerprint: z.optional(ProtocolFingerprintSchema),
  /** Matches of the primary selector on the current page, null until counted. */
  count: z.nullable(count()),
  /** Item scoped fields: containers in which the primary selector matches, out of the container count. */
  coverage: z.optional(z.nullable(z.object({ matched: count(), total: count() }))),
  sample: z.nullable(z.string()),
  error: z.optional(z.string()),
});

export const DraftItemSchema = z.object({
  selectors: z.array(CandidateSchema).check(z.minLength(1)),
  /** The list parent's candidates; containers are found inside its first match. */
  within: z.optional(z.array(CandidateSchema).check(z.minLength(1))),
  withinFingerprint: z.optional(ProtocolFingerprintSchema),
  /** Matches of the list parent's primary selector on the current page, null until counted. */
  withinCount: z.optional(z.nullable(count())),
  /** The list parent was derived by the recorder; authoring metadata, never saved in the recipe. */
  withinInferred: z.optional(z.boolean()),
  exclude: z.array(CandidateSchema),
  fingerprint: z.optional(ProtocolFingerprintSchema),
  /** Containers left after exclusions. */
  count: z.nullable(count()),
  /** Containers before exclusions. */
  total: z.nullable(count()),
});

const TargetSchema = z.object({
  selectors: z.array(CandidateSchema).check(z.minLength(1)),
  fingerprint: z.optional(ProtocolFingerprintSchema),
  frame: z.optional(FrameTargetSchema),
});

const LimitSchema = z.union([z.int().check(z.positive()), z.literal('all')]);
const ParamSchema = z.object({ name: z.string(), start: z.int(), step: z.int() });
const StopRulesSchema = z.array(z.enum(STOP_RULES));

/** The paginate block's settings; its `do` blocks live in the sequence. */
export const DraftPaginationSchema = z.object({
  kind: z.enum(PAGINATE_KINDS),
  target: z.optional(TargetSchema),
  param: z.optional(ParamSchema),
  limit: LimitSchema,
  stopRules: StopRulesSchema,
  delayMs: z.int().check(z.nonnegative()),
  /** The driving table's name; absent means the first item table extracted in `do`. */
  table: z.optional(z.string()),
});

export const DraftStepSchema = z.object({
  kind: z.enum(STEP_KINDS),
  target: z.optional(TargetSchema),
  value: z.optional(z.string()),
  until: z.optional(z.enum(STEP_UNTILS)),
  timeoutMs: z.optional(z.int().check(z.positive())),
  window: z._default(z.enum(STEP_WINDOWS), 'same'),
  optional: z.boolean(),
  label: z.optional(z.string()),
  /** Matches of the target's primary selector on the current page, null until counted or without a target. */
  count: z.nullable(count()),
  error: z.optional(z.string()),
});

export const DraftFlowSchema = z.object({
  name: z.string(),
  description: z.optional(z.string()),
  /** Present for a reactive flow: the element whose appearance fires it. */
  trigger: z.optional(TargetSchema),
  maxRetries: z.optional(z.int().check(z.positive())),
  recover: z.optional(z.boolean()),
  steps: z.array(DraftStepSchema),
  error: z.optional(z.string()),
});

export const DraftInnerBlockSchema = z.union([z.object({ flow: z.string() }), z.object({ extract: z.string() })]);
/** A block of the draft's sequence; the paginate block's settings are the draft's `pagination`. */
export const DraftBlockSchema = z.union([z.object({ flow: z.string() }), z.object({ extract: z.string() }), z.object({ paginate: z.object({ do: z.array(DraftInnerBlockSchema) }) })]);

/** Where a block sits: `[i]` at the top level, `[i, j]` inside the paginate block at `i`. */
export const BlockPathSchema = z.array(index()).check(z.minLength(1), z.maxLength(2));

export const DraftSequenceSchema = z.object({
  /** Whether the user edited the sequence; while false it follows the draft. */
  custom: z.boolean(),
  blocks: z.array(DraftBlockSchema),
});

/** A sequence validation error on a block, or on the sequence as a whole (a table never extracted). */
export const SequenceErrorSchema = z.object({ path: z.nullable(BlockPathSchema), message: z.string() });

export const ErrorEntrySchema = z.object({
  path: z.string(),
  message: z.string(),
  /** Index of the table the error belongs to, for paths under a table or a field. */
  table: z.optional(index()),
  /** Index of the field in that table, for field paths. */
  index: z.optional(index()),
});

/** One table of the draft: its name, item container, and fields. */
/** Which description an edit sets: the recipe's, a table's by index, or a variable's by name. */
export const DescriptionTargetSchema = z.union([
  z.object({ kind: z.literal('recipe') }),
  z.object({ kind: z.literal('table'), index: index() }),
  z.object({ kind: z.literal('var'), name: z.string() }),
]);

export const DraftTableSchema = z.object({
  name: z.string(),
  description: z.optional(z.string()),
  /** The iframe the table reads from, set by its first field or item container picked inside one. */
  frame: z.optional(FrameTargetSchema),
  item: z.nullable(DraftItemSchema),
  fields: z.array(DraftFieldSchema),
  /** Why the table does not validate as a whole, such as an invalid name or no fields. */
  error: z.optional(z.string()),
  /** The recorder chose the name; it follows the mode when the first field is added. Never saved. */
  defaultName: z.optional(z.boolean()),
});

/** How the draft is written: the shorthand (top level `item` and `fields`) or the `tables` form. */
export const DRAFT_FORMS = ['shorthand', 'tables'] as const;

export const DraftSchema = z.object({
  name: z.string(),
  nameError: z.optional(z.string()),
  description: z.optional(z.string()),
  url: z.string(),
  vars: z.array(VarValueSchema),
  /** Every table, in strip order; there is always at least one. */
  tables: z.array(DraftTableSchema).check(z.minLength(1)),
  /** Index in `tables` of the table that receives picks, inference, and field edits. */
  activeTable: index(),
  /** The form the draft was created or loaded in; see `draftToRecipe` for when it is kept. */
  form: z.enum(DRAFT_FORMS),
  flows: z._default(z.array(DraftFlowSchema), []),
  /** Index in `flows` of the flow browse recording and "Add to flow" go into; null without flows. */
  activeFlow: z._default(z.nullable(index()), null),
  /** Settings of the paginate block, when one was marked. */
  pagination: z.nullable(DraftPaginationSchema),
  sequence: z._default(DraftSequenceSchema, { custom: false, blocks: [] }),
  /** Sequence validation errors; while any exist, Save and Test run are disabled. */
  sequenceErrors: z._default(z.array(SequenceErrorSchema), []),
  guards: z.optional(z.array(z.object({ kind: z.enum(GUARD_KINDS), enabled: z.boolean() }))),
  healing: z.optional(z.object({ fuzzyThreshold: z.number(), llm: z.boolean() })),
  /** The recipe's browser block, kept as loaded; the panel edits only `humanize`, and `profile` round-trips untouched. */
  browser: z.optional(
    z.object({
      proxy: z.optional(z.object({ server: z.string(), bypass: z.optional(z.array(z.string())) })),
      timezone: z.optional(z.string()),
      locale: z.optional(z.string()),
      humanize: z.optional(z.boolean()),
      profile: z.optional(z.string()),
    }),
  ),
  dirty: z.boolean(),
  errors: z.array(ErrorEntrySchema),
});

/** Panel sections that collapse. */
export const PANEL_SECTIONS = ['recipe', 'flows', 'sequence'] as const;
export type PanelSection = (typeof PANEL_SECTIONS)[number];

export const SelectedSchema = z.object({
  selection: SelectionSchema,
  scope: z.enum(FIELD_SCOPES),
  defaults: z.object({
    name: z.string(),
    type: z.enum(FIELD_TYPES),
    attr: z.optional(z.string()),
    /** Table the field goes to unless the user picks another. */
    table: z._default(index(), 0),
  }),
  /** Index in `selection.candidates` of the primary candidate. */
  primary: index(),
  /** Table the selection's scope and candidates are computed for; null for a new table. */
  table: z._default(z.nullable(index()), 0),
  /** The pick repeats: how often, the first item texts, and how many more; null when nothing repeats or it was dismissed. */
  suggestion: z._default(z.nullable(z.object({ count: count(), samples: z.array(z.string()), more: count() })), null),
  /** The pick is outside every container of the active list: that list, how often the pick repeats, the first page table. */
  outside: z._default(z.nullable(z.object({ table: index(), repeats: z.nullable(count()), pageTable: z.nullable(index()) })), null),
  /** The pick is inside a container of another list table: that table, the container's index and count, and its selector stack. */
  belongs: z._default(
    z.nullable(z.object({ table: index(), index: index(), of: count(), stack: z.object({ within: z.nullable(CandidateSchema), item: CandidateSchema }) })),
    null,
  ),
  /** Why the pick cannot go into the table: it reads from another iframe, or from the top document. */
  frameRefusal: z._default(z.nullable(z.string()), null),
});

/** The options of a field, as the selection panel's form shows them. */
export const FieldOptionsSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES),
  scope: z.enum(FIELD_SCOPES),
  attr: z.optional(z.string()),
  optional: z.boolean(),
  key: z.boolean(),
  hover: z.optional(z.boolean()),
});

/** A saved field opened in the selection panel for editing. */
export const EditingSchema = z.object({
  index: index(),
  /** The field's options when the edit opened; the form starts from them. */
  options: FieldOptionsSchema,
  /** The field's saved candidates with current counts, used while no element is selected. */
  candidates: z.array(CandidateSchema),
  /** Index in `candidates` of the primary candidate. */
  primary: z._default(index(), 0),
});

export const TestTableSchema = z.object({
  name: z.string(),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: count(),
  /** Rows left out because a required field resolved nothing, and the fields that caused it. */
  dropped: z.object({ count: count(), fields: z.array(z.string()) }),
  /** `hover` marks fields the runner hovers before reading; the preview reads them as they are. */
  fields: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'healed', 'partial', 'missing']), hover: z.optional(z.boolean()) })),
  /** Why this table produced no rows, such as a required field that matched nothing. */
  error: z.optional(z.string()),
});

export const TestResultsSchema = z.object({
  /** One entry per table, in draft order; empty when the draft does not validate. */
  tables: z.array(TestTableSchema),
  durationMs: z.number().check(z.nonnegative()),
  warnings: z.array(z.string()),
  error: z.optional(z.string()),
});

/** What the focused re-pick mode shows about the field being re-picked. */
export const RepickContextSchema = z.object({
  /** Name of the table holding the field; the table is active while the re-pick lasts. */
  table: z.string(),
  field: z.string(),
  index: index(),
  /** Primary selector before the re-pick. */
  oldSelector: SelectorSchema,
  fingerprint: z.nullable(ProtocolFingerprintSchema),
  /** Last known value of the field. */
  sample: z.nullable(z.string()),
  /** The recipe's fuzzy threshold: hovered scores at or above it are likely matches. */
  threshold: z.number(),
  /** `run` when a run is waiting on the pick, `cli` for `record --repick`. */
  reason: z.enum(['run', 'cli']),
  /** The element picked so far, waiting for confirmation. */
  picked: z.nullable(z.object({ score: z.nullable(z.number()), sample: z.nullable(z.string()), selector: SelectorSchema })),
});

/** The target a target edit replaces: a step's, a reactive flow's trigger, or the paginate block's. */
export const TargetRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('step'), flow: index(), index: index() }),
  z.object({ kind: z.literal('trigger'), flow: index() }),
  z.object({ kind: z.literal('pagination') }),
]);

/** Why a popup step cannot be re-picked while no popup is open; `index` is the step's index in its flow. */
export function popupClosedReason(index: number): string {
  if (index === 0) return 'popup not open';
  return `popup not open — replay ${index === 1 ? 'step 1' : `steps 1–${index}`} first`;
}

/** A target edit in progress: typing a selector, picking on the page, or a pick waiting for "Use". */
export const TargetEditSchema = z.object({
  ref: TargetRefSchema,
  phase: z.enum(['typing', 'picking', 'picked']),
  /** What is edited, for the Pick section header: `flow-2 · step 1`, `trigger for login-wall`, `pagination target`. */
  title: z.string(),
  /** The page strip while picking. */
  strip: z.string(),
  /** The apply button's text: `Use for step`, `Use for trigger`, `Use for pagination`. */
  use: z.string(),
  /** The frame lookups run in: the picked element's, else the target's; null for the top document. */
  frame: z.nullable(FrameTargetSchema),
  /** The picked element with its page scope candidates, counted, verified, and ranked. */
  selection: z.nullable(SelectionSchema),
  /** Index in `selection.candidates` of the highlighted candidate, saved first. */
  primary: z._default(index(), 0),
});

/** What the guard banner shows while an interactive run waits for a human: a guard, or an `await-user` step with its label. */
export const GuardContextSchema = z.object({
  kind: z.enum([...GUARD_KINDS, 'await-user'] as const),
  label: z.optional(z.string()),
  reason: z.string(),
  page: z.int().check(z.positive()),
  url: z.string(),
  /** When the guard timeout runs out, in epoch milliseconds. */
  deadline: z.number(),
});

/**
 * Restricted picking for a proposal field: which elements a click may set.
 * An element must be a strict ancestor of one of `ancestorOf` (or of a
 * confirmed item container with `ofContainers`), a strict descendant of
 * `descendantOf`, and an ancestor-or-self of `containing`, where set.
 */
export const LevelPickSchema = z.object({
  level: z.enum(LEVEL_KINDS),
  ancestorOf: z.array(PathSchema),
  ofContainers: z.boolean(),
  descendantOf: z.nullable(PathSchema),
  containing: z.nullable(PathSchema),
});

export const RecorderStateSchema = z.object({
  url: z.string(),
  draft: DraftSchema,
  selected: z.nullable(SelectedSchema),
  proposal: z.nullable(ProposalSchema),
  /** Set while the user picks the list parent or the item container on the page. */
  levelPick: z._default(z.nullable(LevelPickSchema), null),
  /** Field index waiting for a re-pick. */
  repick: z.nullable(index()),
  /** A step, trigger, or pagination target being edited. */
  targetEdit: z._default(z.nullable(TargetEditSchema), null),
  /** How many popups of the session are open. */
  popups: z._default(count(), 0),
  /** Flow whose trigger waits for a pick in the trigger editor. */
  pickTrigger: z._default(z.nullable(index()), null),
  /** How this window shows the panel: the full panel, the rail of a main window, or the strip of a popup. */
  panelMode: z._default(z.enum(['owner', 'rail', 'strip']), 'owner'),
  /** Whether this window is a popup of the session. */
  popup: z._default(z.boolean(), false),
  /** Set in the focused re-pick mode. */
  repickContext: z._default(z.nullable(RepickContextSchema), null),
  /** Set while a saved field is open in the selection panel. */
  editing: z._default(z.nullable(EditingSchema), null),
  /** An element the page should select: the first match of a typed selector or of the edited field. */
  pendingSelect: z._default(z.nullable(z.object({ path: PathSchema })), null),
  /** Why the last typed selection selector was refused; the previous selection stays. */
  selectorError: z._default(z.nullable(z.string()), null),
  /** Why the last committed URL template was refused; the previous template stays. */
  urlError: z._default(z.nullable(z.string()), null),
  /** Per path variable: the value checked and whether each of its paths names an existing file on the host. */
  pathChecks: z._default(z.record(z.string(), z.object({ value: z.string(), paths: z.array(z.object({ path: z.string(), exists: z.boolean() })) })), {}),
  /** Why the last variable add or rename was refused; `name` is the row (the new name for an add). */
  varError: z._default(z.nullable(z.object({ name: z.string(), message: z.string() })), null),
  /** Why the last description edit was refused; `key` is `recipe`, `table:<index>`, or `var:<name>`. */
  descriptionError: z._default(z.nullable(z.object({ key: z.string(), message: z.string() })), null),
  /** The URL the session itself last opened: at start, on Reopen, or the page it attached to. */
  openedUrl: z._default(z.string(), ''),
  /** Set while an interactive run is paused on a guard. */
  guardContext: z._default(z.nullable(GuardContextSchema), null),
  test: z.nullable(TestResultsSchema),
  saved: z.nullable(z.object({ name: z.string(), path: z.optional(z.string()), at: z.string() })),
  busy: z.nullable(z.string()),
  error: z.nullable(z.string()),
  /** A one-shot message for the Pick section, cleared by the next pick. */
  notice: z._default(z.nullable(z.string()), null),
  /** While the active table is a list: the containers of every other list table, for muted outlines. */
  otherLists: z._default(z.array(z.object({ table: index(), paths: z.array(PathSchema) })), []),
  /**
   * The iframe whose document the state's paths refer to (selection, proposal,
   * pending select, other lists): its path in the top document when known, and
   * its candidates. Null for the top document.
   */
  frame: z._default(z.nullable(z.object({ path: z.nullable(PathSchema), selectors: z.array(CandidateSchema) })), null),
  /** Panel state kept for the session, across navigations; never saved in the recipe. */
  panel: z._default(z.object({ collapsed: z.record(z.enum(PANEL_SECTIONS), z.boolean()) }), { collapsed: { recipe: false, flows: false, sequence: true } }),
});

const FieldPatchSchema = z.object({
  name: z.optional(z.string()),
  type: z.optional(z.enum(FIELD_TYPES)),
  scope: z.optional(z.enum(FIELD_SCOPES)),
  attr: z.optional(z.nullable(z.string())),
  optional: z.optional(z.boolean()),
  key: z.optional(z.boolean()),
  fallback: z.optional(z.boolean()),
  hover: z.optional(z.boolean()),
  /** Table for a new field: an index, or a new table by name. The table becomes active. */
  table: z.optional(z.union([index(), z.object({ new: z.string() })])),
});

const StepPatchSchema = z.object({
  kind: z.optional(z.enum(STEP_KINDS)),
  value: z.optional(z.nullable(z.string())),
  until: z.optional(z.nullable(z.enum(STEP_UNTILS))),
  timeoutMs: z.optional(z.nullable(z.int().check(z.positive()))),
  window: z.optional(z.enum(STEP_WINDOWS)),
  optional: z.optional(z.boolean()),
  label: z.optional(z.nullable(z.string())),
});

/** A step recorded on the page: its kind and value; the target comes from the selection, or from the picked element when absent. */
const NewStepSchema = z.object({
  kind: z.enum(STEP_KINDS),
  value: z.optional(z.string()),
  until: z.optional(z.enum(STEP_UNTILS)),
  optional: z.optional(z.boolean()),
  /**
   * A fill whose value goes into a variable: named from `name` (made unique),
   * holding `value`, and the step's value becomes `{name}`. A later fill of
   * the same target right after reuses the variable.
   */
  variable: z.optional(z.object({ name: z.string(), secret: z.optional(z.boolean()), type: z.optional(z.enum(['string', 'path'])) })),
  /** A file chooser fill: the click that opened the chooser, when it is the flow's last step, is dropped. */
  replacesClick: z.optional(z.boolean()),
});

const FlowPatchSchema = z.object({
  name: z.optional(z.string()),
  /** Null makes the flow called again; a reactive flow gets its trigger through `draft.setTrigger`. */
  trigger: z.optional(z.null()),
  maxRetries: z.optional(z.nullable(z.int().check(z.positive()))),
  recover: z.optional(z.nullable(z.boolean())),
});

export const PaginationPatchSchema = z.object({
  kind: z.optional(z.enum(PAGINATE_KINDS)),
  param: z.optional(ParamSchema),
  limit: z.optional(LimitSchema),
  stopRules: z.optional(StopRulesSchema),
  delayMs: z.optional(z.int().check(z.nonnegative())),
  /** The driving table's name; null goes back to the default. */
  table: z.optional(z.nullable(z.string())),
});

const msg = <K extends string, S extends z.core.$ZodLooseShape>(kind: K, shape: S) => z.object({ kind: z.literal(kind), ...shape });

export const PageMessageSchema = z.discriminatedUnion('kind', [
  msg('session.ready', { url: z.string() }),
  msg('session.end', {}),
  msg('picker.hover', { path: PathSchema, tag: z.string() }),
  msg('picker.select', { url: z.string(), selection: SelectionSchema, snapshot: SnapshotSchema }),
  msg('picker.cancel', {}),
  /** Return to the empty state: no selection, proposal, or field edit. The draft does not change. */
  msg('selection.clear', {}),
  /**
   * Select by typed selector text: inside each item container for scope
   * `item`, else on the page. The snapshot maps the first match to a path.
   */
  msg('selection.setSelector', { selector: z.string(), scope: z.optional(z.enum(FIELD_SCOPES)), snapshot: z.optional(SnapshotSchema) }),
  /** Recompute the selection's scope, candidates, and coverage for a table; null stands for a new table. */
  msg('selection.retarget', { table: z.nullable(index()) }),
  msg('inspect.count', { candidate: SelectorSchema, scope: z.enum(FIELD_SCOPES) }),
  msg('inspect.primary', { index: index() }),
  /** Accept the list setup with the level in the view. */
  msg('draft.confirmItems', {}),
  /** Close the list setup; a pick keeps its selection and suggestion. */
  msg('draft.cancelItems', {}),
  /** Open the list setup: from the pick's suggestion, empty for manual input, or in a new table from the kept pick. */
  msg('list.open', { from: z.enum(['suggestion', 'manual', 'newTable']) }),
  /** Hide the suggestion for this selection ("No, single value"). */
  msg('list.dismiss', {}),
  /** Fill one ladder of the list setup. */
  msg('list.ladder', { which: z.enum(['item', 'parent']) }),
  /** Reopen the confirmed item as a proposal, seeded from its list parent, container, and exclusions. */
  msg('draft.editItem', { snapshot: z.optional(SnapshotSchema) }),
  /**
   * Set the list parent or the item container: from an element picked on the
   * page (with a fresh snapshot when no proposal is shown), from typed
   * selector text, from a ladder row's path, or clear the list parent.
   */
  msg('draft.setLevel', {
    level: z.enum(LEVEL_KINDS),
    by: z.enum(['pick', 'selector', 'clear', 'path']),
    path: z.optional(PathSchema),
    selector: z.optional(z.string()),
    snapshot: z.optional(SnapshotSchema),
  }),
  /** Start restricted picking for a proposal field. */
  msg('draft.pickLevel', { level: z.enum(LEVEL_KINDS) }),
  msg('draft.toggleIncludeAll', {}),
  /** Choose the candidate saved first for the list parent or an item level. */
  msg('draft.setPrimary', { level: z.enum(LEVEL_KINDS), index: index() }),
  /** Remove the item container; refused once the table has fields. */
  msg('draft.clearItem', {}),
  /** Remove the active table's fields, item container, list parent, and exclusions. */
  msg('draft.clearTable', {}),
  /** Move a page scoped field of a list to the first table without an item container, creating one when needed. */
  msg('draft.moveFieldToPage', { index: index() }),
  msg('draft.addExclusion', { selector: z.string().check(z.minLength(1)) }),
  msg('draft.removeExclusion', { index: index() }),
  msg('draft.addField', { patch: z.optional(FieldPatchSchema) }),
  msg('draft.updateField', { index: index(), patch: FieldPatchSchema }),
  msg('draft.removeField', { index: index() }),
  /** Open a saved field in the selection panel; the snapshot maps its first match to a path. A table other than the active one is activated first. */
  msg('draft.editField', { index: index(), table: z.optional(index()), snapshot: z.optional(SnapshotSchema) }),
  /** Replace the edited field in place with the form's options and the selection's candidates. */
  msg('draft.updateEditedField', { patch: FieldPatchSchema }),
  msg('draft.cancelEdit', {}),
  msg('draft.moveField', { from: index(), to: index() }),
  /** Re-pick a field's selectors; null ends the re-pick. */
  msg('draft.repickTarget', { target: z.literal('field'), index: z.nullable(index()) }),
  /**
   * Edit a step, trigger, or pagination target: `pick` starts picking in the
   * target's window, `type` opens the typed selector input.
   */
  msg('target.edit.start', { ref: TargetRefSchema, mode: z.enum(['pick', 'type']) }),
  /** Count typed selector text in the target's window and frame; answered with `inspect.countResult`. */
  msg('target.edit.count', { ref: TargetRefSchema, selector: z.string() }),
  /** Save the edit: the typed selector first (`selector`), or the picked element's ranked candidates (`selection`). */
  msg('target.edit.apply', { ref: TargetRefSchema, by: z.enum(['selector', 'selection']), selector: z.optional(z.string()) }),
  /** End the edit and keep the previous target. */
  msg('target.edit.cancel', {}),
  /** Add a step to a flow (the active one when absent); without any flow the first step creates one. */
  msg('draft.addStep', { step: NewStepSchema, selection: z.optional(z.nullable(SelectionSchema)), flow: z.optional(index()) }),
  msg('draft.updateStep', { flow: z.optional(index()), index: index(), patch: StepPatchSchema }),
  msg('draft.removeStep', { flow: z.optional(index()), index: index() }),
  msg('draft.moveStep', { flow: z.optional(index()), from: index(), to: index() }),
  msg('draft.replayStep', { flow: z.optional(index()), index: index() }),
  /** Add a called flow and make it active; without a name the host picks one. */
  msg('draft.addFlow', { name: z.optional(z.string()) }),
  msg('draft.updateFlow', { index: index(), patch: FlowPatchSchema }),
  msg('draft.removeFlow', { index: index() }),
  msg('draft.duplicateFlow', { index: index() }),
  msg('draft.selectFlow', { index: index() }),
  /** Replay a flow's steps on the live page, in order. */
  msg('draft.replayFlow', { index: index() }),
  /** Open the trigger editor for a flow: the next pick becomes its trigger; null closes the editor. */
  msg('draft.pickTrigger', { index: z.nullable(index()) }),
  /** Make a flow reactive with the selected element as its trigger. */
  msg('draft.setTrigger', { index: index(), selection: SelectionSchema }),
  /** Replay, in order, the called flows the sequence runs before a table's extract block. */
  msg('draft.replayFlowsBefore', { table: index() }),
  msg('draft.markPagination', {}),
  msg('paginate.update', { patch: PaginationPatchSchema }),
  msg('draft.clearPagination', {}),
  /** Move a block; a block moved into the paginate block runs on every page. The sequence becomes custom. */
  msg('sequence.move', { from: BlockPathSchema, to: BlockPathSchema }),
  /** Keep the sequence as it is shown, without following the draft any more. */
  msg('sequence.customize', {}),
  /** Go back to the default sequence. */
  msg('sequence.reset', {}),
  /** A real pointer or key press in this window: it becomes the panel's owner. */
  msg('window.activity', {}),
  /** Add a table and make it active; without a name the host picks one. */
  msg('draft.addTable', { name: z.optional(z.string()) }),
  /** Rename the active table. */
  msg('draft.renameTable', { name: z.string() }),
  /** Remove the active table with its item container and fields; the last table stays. */
  msg('draft.removeTable', {}),
  /** Activate a table; a selection is kept and computed for it. */
  msg('draft.selectTable', { index: index() }),
  /** Move a table to another position; the saved recipe keeps the order. */
  msg('draft.moveTable', { from: index(), to: index() }),
  /**
   * Edit a frame target: make one of its candidates primary, or put a typed
   * selector first. `key` is the primary candidate of the frame being edited;
   * every table, step, and pagination target with that frame gets the result.
   */
  msg('frame.edit', { key: SelectorSchema, by: z.enum(['primary', 'selector']), index: z.optional(index()), selector: z.optional(z.string()) }),
  /** Collapse or expand a panel section; session state only. */
  msg('panel.setCollapsed', { section: z.enum(PANEL_SECTIONS), collapsed: z.boolean() }),
  msg('draft.setName', { name: z.string() }),
  /** Set a description: trimmed, empty removes it, too long is refused into `descriptionError`. */
  msg('draft.setDescription', { target: DescriptionTargetSchema, text: z.string() }),
  /** Turn humanized input on for runs of the recipe, or remove the setting. */
  msg('draft.setHumanize', { on: z.boolean() }),
  msg('draft.setVar', { name: z.string(), value: z.string() }),
  msg('draft.reopen', {}),
  /** Replace the URL template; an invalid template is refused into `urlError`. */
  msg('draft.setUrl', { url: z.string() }),
  /** Add a variable that nothing uses yet; a bad or taken name is refused into `varError`. */
  msg('draft.addVar', { name: z.string() }),
  /** Rename a variable and every `{from}` in the template and `type` step values. */
  msg('draft.renameVar', { from: z.string(), to: z.string() }),
  /** Remove a variable, writing its value in place of every use. */
  msg('draft.removeVar', { name: z.string() }),
  /** Mark a text variable secret (or not), or change its type between text and path; external variables refuse. */
  msg('draft.setVarKind', { name: z.string(), secret: z.optional(z.boolean()), type: z.optional(z.enum(['string', 'path'])) }),
  /** Check on the host that every path of a path variable names an existing file; the answer lands in `pathChecks`. */
  msg('vars.checkPath', { name: z.string() }),
  /** Set the template from the open page's URL, putting back variables found exactly once. */
  msg('draft.useCurrentUrl', {}),
  msg('test.run', {}),
  msg('test.clear', {}),
  msg('save.request', {}),
  msg('repick.confirm', {}),
  msg('repick.skip', {}),
  msg('repick.abort', {}),
  msg('guard.continue', {}),
  msg('guard.abort', {}),
]);

export const HostMessageSchema = z.discriminatedUnion('kind', [
  msg('draft.state', { state: RecorderStateSchema }),
  /** `error` is set for selector text that cannot be resolved. */
  msg('inspect.countResult', { count: count(), error: z.optional(z.string()) }),
  msg('test.results', { results: TestResultsSchema, state: RecorderStateSchema }),
  msg('save.result', {
    ok: z.boolean(),
    path: z.optional(z.string()),
    errors: z.array(ErrorEntrySchema),
    state: RecorderStateSchema,
  }),
  msg('session.error', { message: z.string() }),
  /** How replaying one step or a flow on the live page went, for a toast. */
  msg('step.replayResult', { index: z.nullable(index()), ok: z.boolean(), message: z.string(), state: RecorderStateSchema }),
  /** How this window shows the panel; draft state goes only to the owner. */
  msg('panel.mode', { mode: z.enum(['owner', 'rail', 'strip']), popup: z.boolean() }),
  /** Remove the recorder from the page; the host keeps the session. */
  msg('session.detach', {}),
]);

export const MessageSchema = z.union([PageMessageSchema, HostMessageSchema]);

export type ProtocolCandidate = z.infer<typeof CandidateSchema>;
export type Path = z.infer<typeof PathSchema>;
export type Crumb = z.infer<typeof CrumbSchema>;
export type FrameTarget = z.infer<typeof FrameTargetSchema>;
export type Selection = z.input<typeof SelectionSchema>;
export type FillPreview = z.infer<typeof FillPreviewSchema>;
export type ParsedSelection = z.infer<typeof SelectionSchema>;
export type LevelView = z.infer<typeof LevelSchema>;
export type LevelViewInput = z.input<typeof LevelSchema>;
export type ProposalView = z.infer<typeof ProposalSchema>;
export type LevelKind = (typeof LEVEL_KINDS)[number];
export type ProposalOrigin = (typeof PROPOSAL_ORIGINS)[number];
export type ItemLadderRow = z.infer<typeof ItemLadderRowSchema>;
export type ParentLadderRow = z.infer<typeof ParentLadderRowSchema>;
export type LevelPick = z.infer<typeof LevelPickSchema>;
export type VarValue = z.infer<typeof VarValueSchema>;
export type DescriptionTarget = z.infer<typeof DescriptionTargetSchema>;
export type DraftField = z.infer<typeof DraftFieldSchema>;
export type DraftItem = z.infer<typeof DraftItemSchema>;
export type DraftTable = z.infer<typeof DraftTableSchema>;
export type DraftForm = (typeof DRAFT_FORMS)[number];
export type DraftPagination = z.infer<typeof DraftPaginationSchema>;
export type DraftStep = z.infer<typeof DraftStepSchema>;
export type DraftFlow = z.infer<typeof DraftFlowSchema>;
export type DraftBlock = z.infer<typeof DraftBlockSchema>;
export type DraftInnerBlock = z.infer<typeof DraftInnerBlockSchema>;
export type DraftSequence = z.infer<typeof DraftSequenceSchema>;
export type BlockPath = z.infer<typeof BlockPathSchema>;
export type SequenceError = z.infer<typeof SequenceErrorSchema>;
export type FlowPatch = z.infer<typeof FlowPatchSchema>;
export type PanelMode = 'owner' | 'rail' | 'strip';
export type StepPatch = z.infer<typeof StepPatchSchema>;
export type NewStep = z.infer<typeof NewStepSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type SelectedView = z.infer<typeof SelectedSchema>;
export type FieldOptions = z.infer<typeof FieldOptionsSchema>;
export type EditingView = z.infer<typeof EditingSchema>;
export type TestResults = z.infer<typeof TestResultsSchema>;
export type TestTable = z.infer<typeof TestTableSchema>;
export type RecorderState = z.infer<typeof RecorderStateSchema>;
export type RepickContext = z.infer<typeof RepickContextSchema>;
export type TargetRef = z.infer<typeof TargetRefSchema>;
export type TargetEdit = z.infer<typeof TargetEditSchema>;
export type GuardContextView = z.infer<typeof GuardContextSchema>;
export type FieldPatch = z.infer<typeof FieldPatchSchema>;
export type PaginationPatch = z.infer<typeof PaginationPatchSchema>;
export type PageMessage = z.input<typeof PageMessageSchema>;
export type ParsedPageMessage = z.infer<typeof PageMessageSchema>;
export type HostMessage = z.infer<typeof HostMessageSchema>;
export type Message = PageMessage | HostMessage;
export type PageMessageKind = ParsedPageMessage['kind'];
export type HostMessageKind = HostMessage['kind'];

/** The called flows a sequence runs before a table's extract block, in order. */
export function flowsBefore(blocks: readonly DraftBlock[], table: string): string[] {
  const names: string[] = [];
  for (const block of blocks) {
    if ('flow' in block) names.push(block.flow);
    else if ('extract' in block) {
      if (block.extract === table) return names;
    } else {
      for (const inner of block.paginate.do) {
        if ('flow' in inner) names.push(inner.flow);
        else if (inner.extract === table) return names;
      }
    }
  }
  return names;
}

/** The table that receives picks and field edits. */
export function currentTable(draft: Pick<Draft, 'tables' | 'activeTable'>): DraftTable {
  return draft.tables[draft.activeTable] ?? draft.tables[0]!;
}

export type TableMode = 'list' | 'page' | 'none';

/** A list has an item container, a page table has fields and none, else the table has no mode yet. */
export function tableMode(table: Pick<DraftTable, 'item' | 'fields'>): TableMode {
  if (table.item !== null) return 'list';
  return table.fields.length > 0 ? 'page' : 'none';
}

/** The scope of a field added to a table: `item` in a list, else `page`. */
export function scopeForTable(table: Pick<DraftTable, 'item' | 'fields'>): FieldScope {
  return tableMode(table) === 'list' ? 'item' : 'page';
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function describe(error: z.core.$ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '$'}: ${i.message}`)
    .join('; ');
}

/** Validate a message from the page. */
export function parsePageMessage(input: unknown): ParsedPageMessage {
  const result = PageMessageSchema.safeParse(input);
  if (!result.success) throw new ProtocolError(`invalid page message: ${describe(result.error)}`);
  return result.data;
}

/** Validate a message from the host. */
export function parseHostMessage(input: unknown): HostMessage {
  const result = HostMessageSchema.safeParse(input);
  if (!result.success) throw new ProtocolError(`invalid host message: ${describe(result.error)}`);
  return result.data;
}

/** Validate any protocol message. */
export function parse(input: unknown): ParsedPageMessage | HostMessage {
  const result = MessageSchema.safeParse(input);
  if (!result.success) throw new ProtocolError(`invalid message: ${describe(result.error)}`);
  return result.data;
}

type Literal = { _zod: { def: { values: readonly unknown[] } } };
const kindsOf = (schema: { _zod: { def: { options: readonly z.core.$ZodType[] } } }) =>
  schema._zod.def.options.map((o) => String(((o as z.ZodMiniObject)._zod.def.shape.kind as unknown as Literal)._zod.def.values[0]));

export const PAGE_MESSAGE_KINDS: PageMessageKind[] = kindsOf(PageMessageSchema) as PageMessageKind[];
export const HOST_MESSAGE_KINDS: HostMessageKind[] = kindsOf(HostMessageSchema) as HostMessageKind[];
