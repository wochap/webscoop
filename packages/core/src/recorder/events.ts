import { Emitter } from '../events';
import type { FieldScope, FieldType, PaginationKind, StepKind } from '../recipe/schema';
import type { ProtocolCandidate } from './protocol';

export interface RecorderEvents {
  'recorder.ready': { url: string };
  'recorder.navigated': { url: string };
  'recorder.selected': { tag: string; path: number[]; scope: FieldScope; candidates: ProtocolCandidate[] };
  'recorder.itemsProposed': {
    count: number | null;
    container: string;
    /** Primary selector value of the list parent, null without one. */
    within: string | null;
    /** Elements left out as dissimilar. */
    skipped: number;
    broader: number | null;
    narrower: number | null;
  };
  'recorder.itemsConfirmed': { count: number | null; selector: string };
  'recorder.excluded': { selector: string; count: number | null };
  'recorder.fieldAdded': { name: string; type: FieldType; scope: FieldScope; count: number | null };
  'recorder.fieldRemoved': { name: string };
  'recorder.paginationSet': { kind: PaginationKind };
  /** `target` is the primary selector as `strategy=value`, null for a step without a target. */
  'recorder.stepAdded': { index: number; kind: StepKind; target: string | null; value?: string };
  'recorder.stepReplayed': { index: number; kind: StepKind; ok: boolean; message: string };
  'recorder.testRun': { rows: number; durationMs: number; error?: string };
  'recorder.saved': { name: string; path?: string };
  'recorder.error': { message: string };
  'recorder.closed': { name: string; dirty: boolean };
}

export type RecorderEventName = keyof RecorderEvents;

export class RecorderEmitter extends Emitter<RecorderEvents> {}
