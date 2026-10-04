import { Emitter } from '../events';
import type { FieldScope, FieldType, PaginationKind, StepKind } from '../recipe/schema';
import type { ProtocolCandidate } from './protocol';

export interface RecorderEvents {
  'recorder.ready': { url: string };
  'recorder.navigated': { url: string };
  /** A window took the panel: `main` or a popup's id. */
  'recorder.owner': { window: string };
  'recorder.selected': { tag: string; path: number[]; scope: FieldScope; candidates: ProtocolCandidate[] };
  'recorder.itemsProposed': {
    count: number | null;
    container: string;
    /** Primary selector value of the list parent, null without one. */
    within: string | null;
    /** Elements left out as dissimilar. */
    skipped: number;
  };
  'recorder.itemsConfirmed': { count: number | null; selector: string };
  'recorder.excluded': { selector: string; count: number | null };
  'recorder.fieldAdded': { name: string; type: FieldType; scope: FieldScope; count: number | null };
  'recorder.fieldRemoved': { name: string };
  'recorder.paginationSet': { kind: PaginationKind };
  /** `target` is the primary selector as `strategy=value`, null for a step without a target. */
  'recorder.stepAdded': { flow: string; index: number; kind: StepKind; target: string | null; value?: string };
  /** A step or, with index -1 and kind `flow`, a whole flow was replayed on the live page. */
  'recorder.stepReplayed': { flow: string; index: number; kind: StepKind | 'flow'; ok: boolean; message: string };
  'recorder.testRun': { rows: number; durationMs: number; error?: string };
  'recorder.saved': { name: string; path?: string };
  'recorder.error': { message: string };
  /** A window of the session saved a download in the download directory. */
  'recorder.download': { file: string; name: string; url: string; bytes: number };
  'recorder.closed': { name: string; dirty: boolean };
}

export type RecorderEventName = keyof RecorderEvents;

export class RecorderEmitter extends Emitter<RecorderEvents> {}
