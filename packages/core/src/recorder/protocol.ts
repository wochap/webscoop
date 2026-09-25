// zod/mini keeps the injected page bundle small; the recipe schema itself stays on classic zod.
import * as z from 'zod/mini';
import type { SerializedElement } from '../ports';
import {
  FIELD_SCOPES,
  FIELD_TYPES,
  GUARD_KINDS,
  PAGINATION_KINDS,
  STABILITIES,
  STEP_KINDS,
  STEP_WHENS,
  STOP_RULES,
  STRATEGIES,
} from '../recipe/constants';

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

/** What the page reports about a picked element. */
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
});

/** The two proposal fields the user edits: the list parent and the item container. */
export const LEVEL_KINDS = ['within', 'item'] as const;
/** Item container levels of a proposal: the proposed one and the ladder shortcuts around it. */
export const RUNGS = ['proposed', 'broader', 'narrower'] as const;

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

export const ProposalSchema = z.object({
  /** The list parent, or null when there is none or the user cleared it. */
  within: z._default(z.nullable(LevelSchema), null),
  proposed: LevelSchema,
  broader: z.nullable(LevelSchema),
  narrower: z.nullable(LevelSchema),
  /** Elements on the item level under the list parent left out as dissimilar; 0 with `includeAll`. */
  skipped: z._default(count(), 0),
  /** Whether every element on the item level counts, similar or not. Not saved in the recipe. */
  includeAll: z._default(z.boolean(), false),
  /** Why the last edit of a field was refused; the previous value stays in effect. */
  error: z._default(z.nullable(z.object({ level: z.enum(LEVEL_KINDS), message: z.string() })), null),
  /** Exclusions added before confirming; they move to the item on confirm. */
  exclude: z._default(z.array(CandidateSchema), []),
});

export const VarValueSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export const DraftFieldSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES),
  scope: z.enum(FIELD_SCOPES),
  selectors: z.array(CandidateSchema).check(z.minLength(1)),
  attr: z.optional(z.string()),
  optional: z.boolean(),
  key: z.boolean(),
  fingerprint: z.optional(ProtocolFingerprintSchema),
  /** Matches of the primary selector on the current page, null until counted. */
  count: z.nullable(count()),
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
  exclude: z.array(CandidateSchema),
  fingerprint: z.optional(ProtocolFingerprintSchema),
  /** Containers left after exclusions. */
  count: z.nullable(count()),
  /** Containers before exclusions. */
  total: z.nullable(count()),
});

const TargetSchema = z.object({ selectors: z.array(CandidateSchema).check(z.minLength(1)), fingerprint: z.optional(ProtocolFingerprintSchema) });

const LimitSchema = z.union([z.int().check(z.positive()), z.literal('all')]);
const ParamSchema = z.object({ name: z.string(), start: z.int(), step: z.int() });
const StopRulesSchema = z.array(z.enum(STOP_RULES));

export const DraftPaginationSchema = z.object({
  kind: z.enum(PAGINATION_KINDS),
  target: z.optional(TargetSchema),
  param: z.optional(ParamSchema),
  limit: LimitSchema,
  stopRules: StopRulesSchema,
  delayMs: z.int().check(z.nonnegative()),
});

export const DraftStepSchema = z.object({
  kind: z.enum(STEP_KINDS),
  target: z.optional(TargetSchema),
  value: z.optional(z.string()),
  when: z.enum(STEP_WHENS),
  optional: z.boolean(),
  label: z.optional(z.string()),
  /** Matches of the target's primary selector on the current page, null until counted or without a target. */
  count: z.nullable(count()),
  error: z.optional(z.string()),
});

export const ErrorEntrySchema = z.object({ path: z.string(), message: z.string() });

export const DraftSchema = z.object({
  name: z.string(),
  nameError: z.optional(z.string()),
  url: z.string(),
  vars: z.array(VarValueSchema),
  item: z.nullable(DraftItemSchema),
  fields: z.array(DraftFieldSchema),
  steps: z._default(z.array(DraftStepSchema), []),
  pagination: z.nullable(DraftPaginationSchema),
  guards: z.optional(z.array(z.object({ kind: z.enum(GUARD_KINDS), enabled: z.boolean() }))),
  healing: z.optional(z.object({ fuzzyThreshold: z.number(), llm: z.boolean() })),
  dirty: z.boolean(),
  errors: z.array(ErrorEntrySchema),
});

export const SelectedSchema = z.object({
  selection: SelectionSchema,
  scope: z.enum(FIELD_SCOPES),
  defaults: z.object({
    name: z.string(),
    type: z.enum(FIELD_TYPES),
    attr: z.optional(z.string()),
  }),
  /** Index in `selection.candidates` of the primary candidate. */
  primary: index(),
});

/** The options of a field, as the selection panel's form shows them. */
export const FieldOptionsSchema = z.object({
  name: z.string(),
  type: z.enum(FIELD_TYPES),
  scope: z.enum(FIELD_SCOPES),
  attr: z.optional(z.string()),
  optional: z.boolean(),
  key: z.boolean(),
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

export const TestResultsSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: count(),
  fields: z.array(z.object({ name: z.string(), status: z.enum(['ok', 'healed', 'partial', 'missing']) })),
  durationMs: z.number().check(z.nonnegative()),
  warnings: z.array(z.string()),
  error: z.optional(z.string()),
});

/** What the focused re-pick mode shows about the field being re-picked. */
export const RepickContextSchema = z.object({
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

/** What the guard banner shows while an interactive run waits for a human. */
export const GuardContextSchema = z.object({
  kind: z.enum(GUARD_KINDS),
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
  /** Step index waiting for a re-pick. */
  repickStep: z._default(z.nullable(index()), null),
  /** Set in the focused re-pick mode. */
  repickContext: z._default(z.nullable(RepickContextSchema), null),
  /** Set while a saved field is open in the selection panel. */
  editing: z._default(z.nullable(EditingSchema), null),
  /** An element the page should select: the first match of a typed selector or of the edited field. */
  pendingSelect: z._default(z.nullable(z.object({ path: PathSchema })), null),
  /** Why the last typed selection selector was refused; the previous selection stays. */
  selectorError: z._default(z.nullable(z.string()), null),
  /** Set while an interactive run is paused on a guard. */
  guardContext: z._default(z.nullable(GuardContextSchema), null),
  test: z.nullable(TestResultsSchema),
  saved: z.nullable(z.object({ name: z.string(), path: z.optional(z.string()), at: z.string() })),
  busy: z.nullable(z.string()),
  error: z.nullable(z.string()),
});

const FieldPatchSchema = z.object({
  name: z.optional(z.string()),
  type: z.optional(z.enum(FIELD_TYPES)),
  scope: z.optional(z.enum(FIELD_SCOPES)),
  attr: z.optional(z.nullable(z.string())),
  optional: z.optional(z.boolean()),
  key: z.optional(z.boolean()),
});

const StepPatchSchema = z.object({
  kind: z.optional(z.enum(STEP_KINDS)),
  value: z.optional(z.nullable(z.string())),
  when: z.optional(z.enum(STEP_WHENS)),
  optional: z.optional(z.boolean()),
  label: z.optional(z.nullable(z.string())),
});

/** A step recorded on the page: its kind and value; the target comes from the selection, or from the picked element when absent. */
const NewStepSchema = z.object({
  kind: z.enum(STEP_KINDS),
  value: z.optional(z.string()),
  when: z.optional(z.enum(STEP_WHENS)),
  optional: z.optional(z.boolean()),
});

export const PaginationPatchSchema = z.object({
  kind: z.optional(z.enum(PAGINATION_KINDS)),
  param: z.optional(ParamSchema),
  limit: z.optional(LimitSchema),
  stopRules: z.optional(StopRulesSchema),
  delayMs: z.optional(z.int().check(z.nonnegative())),
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
  msg('inspect.count', { candidate: SelectorSchema, scope: z.enum(FIELD_SCOPES) }),
  msg('inspect.primary', { index: index() }),
  msg('draft.confirmItems', { level: z.enum(['proposed', 'broader', 'narrower']) }),
  msg('draft.cancelItems', {}),
  /**
   * Set the list parent or the item container: from an element picked on the
   * page (with a fresh snapshot when no proposal is shown), from typed
   * selector text, or clear the list parent.
   */
  msg('draft.setLevel', {
    level: z.enum(LEVEL_KINDS),
    by: z.enum(['pick', 'selector', 'clear']),
    path: z.optional(PathSchema),
    selector: z.optional(z.string()),
    snapshot: z.optional(SnapshotSchema),
  }),
  /** Start restricted picking for a proposal field. */
  msg('draft.pickLevel', { level: z.enum(LEVEL_KINDS) }),
  msg('draft.toggleIncludeAll', {}),
  /** Choose the candidate saved first for the list parent or an item level. */
  msg('draft.setPrimary', { level: z.enum(LEVEL_KINDS), index: index(), rung: z.optional(z.enum(RUNGS)) }),
  msg('draft.setItem', {}),
  msg('draft.clearItem', {}),
  msg('draft.addExclusion', { selector: z.string().check(z.minLength(1)) }),
  msg('draft.removeExclusion', { index: index() }),
  msg('draft.addField', { patch: z.optional(FieldPatchSchema) }),
  msg('draft.updateField', { index: index(), patch: FieldPatchSchema }),
  msg('draft.removeField', { index: index() }),
  /** Open a saved field in the selection panel; the snapshot maps its first match to a path. */
  msg('draft.editField', { index: index(), snapshot: z.optional(SnapshotSchema) }),
  /** Replace the edited field in place with the form's options and the selection's candidates. */
  msg('draft.updateEditedField', { patch: FieldPatchSchema }),
  msg('draft.cancelEdit', {}),
  msg('draft.moveField', { from: index(), to: index() }),
  msg('draft.repickTarget', { target: z.enum(['field', 'step']), index: z.nullable(index()) }),
  msg('draft.addStep', { step: NewStepSchema, selection: z.optional(z.nullable(SelectionSchema)) }),
  msg('draft.updateStep', { index: index(), patch: StepPatchSchema }),
  msg('draft.removeStep', { index: index() }),
  msg('draft.moveStep', { from: index(), to: index() }),
  msg('draft.replayStep', { index: index() }),
  msg('draft.markPagination', {}),
  msg('draft.updatePagination', { patch: PaginationPatchSchema }),
  msg('draft.clearPagination', {}),
  msg('draft.setName', { name: z.string() }),
  msg('draft.setVar', { name: z.string(), value: z.string() }),
  msg('draft.reopen', {}),
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
  msg('inspect.countResult', { count: count() }),
  msg('test.results', { results: TestResultsSchema, state: RecorderStateSchema }),
  msg('save.result', {
    ok: z.boolean(),
    path: z.optional(z.string()),
    errors: z.array(ErrorEntrySchema),
    state: RecorderStateSchema,
  }),
  msg('session.error', { message: z.string() }),
  /** How replaying one step on the live page went, for a toast. */
  msg('step.replayResult', { index: index(), ok: z.boolean(), message: z.string(), state: RecorderStateSchema }),
  /** Remove the recorder from the page; the host keeps the session. */
  msg('session.detach', {}),
]);

export const MessageSchema = z.union([PageMessageSchema, HostMessageSchema]);

export type ProtocolCandidate = z.infer<typeof CandidateSchema>;
export type Path = z.infer<typeof PathSchema>;
export type Crumb = z.infer<typeof CrumbSchema>;
export type Selection = z.input<typeof SelectionSchema>;
export type ParsedSelection = z.infer<typeof SelectionSchema>;
export type LevelView = z.infer<typeof LevelSchema>;
export type LevelViewInput = z.input<typeof LevelSchema>;
export type ProposalView = z.infer<typeof ProposalSchema>;
export type LevelKind = (typeof LEVEL_KINDS)[number];
export type Rung = (typeof RUNGS)[number];
export type LevelPick = z.infer<typeof LevelPickSchema>;
export type VarValue = z.infer<typeof VarValueSchema>;
export type DraftField = z.infer<typeof DraftFieldSchema>;
export type DraftItem = z.infer<typeof DraftItemSchema>;
export type DraftPagination = z.infer<typeof DraftPaginationSchema>;
export type DraftStep = z.infer<typeof DraftStepSchema>;
export type StepPatch = z.infer<typeof StepPatchSchema>;
export type NewStep = z.infer<typeof NewStepSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type SelectedView = z.infer<typeof SelectedSchema>;
export type FieldOptions = z.infer<typeof FieldOptionsSchema>;
export type EditingView = z.infer<typeof EditingSchema>;
export type TestResults = z.infer<typeof TestResultsSchema>;
export type RecorderState = z.infer<typeof RecorderStateSchema>;
export type RepickContext = z.infer<typeof RepickContextSchema>;
export type GuardContextView = z.infer<typeof GuardContextSchema>;
export type FieldPatch = z.infer<typeof FieldPatchSchema>;
export type PaginationPatch = z.infer<typeof PaginationPatchSchema>;
export type PageMessage = z.input<typeof PageMessageSchema>;
export type ParsedPageMessage = z.infer<typeof PageMessageSchema>;
export type HostMessage = z.infer<typeof HostMessageSchema>;
export type Message = PageMessage | HostMessage;
export type PageMessageKind = ParsedPageMessage['kind'];
export type HostMessageKind = HostMessage['kind'];

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
