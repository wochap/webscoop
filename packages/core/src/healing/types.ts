import type { ElementRef, Session } from '../ports';
import type { FieldScope, FieldType, Fingerprint, SelectorCandidate, StepKind } from '../recipe/schema';
import type { AnnotatedNode } from '../selectors/annotated';
import type { Viewport } from './score';

interface TargetBase {
  selectors: SelectorCandidate[];
  fingerprint?: Fingerprint;
}

/** Something the runner resolves on a page, with the place in the recipe a promotion writes to. */
export type HealTarget =
  | (TargetBase & { kind: 'item' })
  | (TargetBase & {
      kind: 'field';
      index: number;
      name: string;
      scope: FieldScope;
      optional: boolean;
      /** The field's value type, for rungs that check what they found. */
      type?: FieldType;
      /** Attribute the value is read from, when not the content. */
      attr?: string;
    })
  | (TargetBase & { kind: 'pagination' })
  | (TargetBase & {
      kind: 'step';
      index: number;
      /** The step's kind, for rungs that describe or filter what they look for. */
      step: StepKind;
      optional: boolean;
      label?: string;
    });

/** Name used in reports and events: the field name, `item`, `pagination`, or the step's label or `step:N`. */
export function targetName(target: HealTarget): string {
  switch (target.kind) {
    case 'field':
      return target.name;
    case 'step':
      return target.label ?? `step:${target.index}`;
    default:
      return target.kind;
  }
}

/** Whether a run fails when the target stays unresolved. */
export function isRequired(target: HealTarget): boolean {
  return target.kind === 'item' || ((target.kind === 'field' || target.kind === 'step') && !target.optional);
}

/** Which rung resolved a target. */
export type HealOutcome =
  | { kind: 'candidate'; index: number }
  | { kind: 'fuzzy'; score: number }
  | { kind: 'model'; rationale: string }
  | { kind: 'user' }
  | { kind: 'unresolved' };

/** Whether an outcome counts as healed: anything but the first stored candidate. */
export function isHealed(outcome: HealOutcome | null | undefined): boolean {
  return !!outcome && outcome.kind !== 'unresolved' && !(outcome.kind === 'candidate' && outcome.index === 0);
}

export interface Resolution {
  /** Every element the rung found in the scope, in document order. */
  refs: ElementRef[];
  outcome: HealOutcome;
  /** The selector that found `refs`. */
  selector: SelectorCandidate;
  /** Scope the elements were found in, when it differs from the context's (an item container further down the page). */
  within?: ElementRef;
  /** Snapshot node of the first element, when the rung worked from a snapshot. */
  node?: AnnotatedNode;
  /** Replacement selectors and fingerprint chosen by the rung itself, such as a user pick. */
  selectors?: SelectorCandidate[];
  fingerprint?: Fingerprint;
}

export interface HealContext {
  session: Session;
  /** Element the target is searched in: the first item container for item scoped fields, else the document. */
  within?: ElementRef;
  /** Every item container, first one first, for item scoped fields. */
  containers?: readonly ElementRef[];
  /**
   * The item container snapshot rungs search, when it is not `within`: the one
   * that best matches the item fingerprint, so field fingerprints recorded in
   * one item are compared with that same item.
   */
  probe?: () => Promise<ElementRef | undefined>;
  /** Annotated snapshot of a scope (the document when undefined), fetched once per scope and cached. */
  snapshotOf(within?: ElementRef): Promise<AnnotatedNode>;
  /** Ancestor tokens above the scope root, nearest first, so subtree nodes score like document nodes. */
  outerAncestors: readonly string[];
  /** The recipe's `healing.fuzzyThreshold`. */
  threshold: number;
  viewport?: Viewport;
  /** Record why a rung declined the target, for the field's report. */
  note?(target: HealTarget, text: string): void;
}

/** One rung of the healing ladder. */
export interface Resolver {
  readonly name: string;
  /** Skipped by the runner when the recipe turns `healing.llm` off. */
  readonly recipeGated?: boolean;
  resolve(target: HealTarget, ctx: HealContext): Promise<Resolution | null>;
}
