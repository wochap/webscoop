import { Emitter } from '../events';
import type { FieldScope, FieldType, PaginationKind } from '../recipe/schema';
import type { ProtocolCandidate } from './protocol';

export interface RecorderEvents {
  'recorder.ready': { url: string };
  'recorder.navigated': { url: string };
  'recorder.selected': { tag: string; path: number[]; scope: FieldScope; candidates: ProtocolCandidate[] };
  'recorder.itemsProposed': { count: number | null; container: string; broader: number | null; narrower: number | null };
  'recorder.itemsConfirmed': { count: number | null; selector: string };
  'recorder.excluded': { selector: string; count: number | null };
  'recorder.fieldAdded': { name: string; type: FieldType; scope: FieldScope; count: number | null };
  'recorder.fieldRemoved': { name: string };
  'recorder.paginationSet': { kind: PaginationKind };
  'recorder.testRun': { rows: number; durationMs: number; error?: string };
  'recorder.saved': { name: string; path?: string };
  'recorder.error': { message: string };
  'recorder.closed': { name: string; dirty: boolean };
}

export type RecorderEventName = keyof RecorderEvents;

export class RecorderEmitter extends Emitter<RecorderEvents> {}
