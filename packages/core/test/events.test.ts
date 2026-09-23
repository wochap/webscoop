import { describe, expect, expectTypeOf, it } from 'vitest';
import { recordEvents, RunEmitter, type Row, type RunEvents } from '../src';

describe('RunEmitter', () => {
  it('delivers typed payloads to named and catch-all listeners', () => {
    const emitter = new RunEmitter();
    const rows: Row[] = [];
    emitter.on('row.emitted', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<RunEvents['row.emitted']>();
      rows.push(payload.row);
    });
    const log = recordEvents(emitter);
    emitter.emit('row.emitted', { page: 1, row: { _page: 1, _index: 0, title: 'x' } });
    expect(rows).toEqual([{ _page: 1, _index: 0, title: 'x' }]);
    expect(log.names()).toEqual(['row.emitted']);
    expect(log.of('row.emitted')[0]!.row.title).toBe('x');
  });

  it('collapses repeated events in the sequence helper', () => {
    const emitter = new RunEmitter();
    const log = recordEvents(emitter);
    emitter.emit('page.done', { page: 1, rows: 0 });
    emitter.emit('page.done', { page: 2, rows: 0 });
    emitter.emit('page.loaded', { page: 3, url: 'u', title: '', status: 200 });
    expect(log.names()).toHaveLength(3);
    expect(log.sequence()).toEqual(['page.done', 'page.loaded']);
  });

  it('isolates listener errors and supports unsubscribe', () => {
    const emitter = new RunEmitter();
    let calls = 0;
    emitter.on('page.done', () => {
      throw new Error('boom');
    });
    const off = emitter.on('page.done', () => calls++);
    emitter.emit('page.done', { page: 1, rows: 0 });
    off();
    emitter.emit('page.done', { page: 1, rows: 0 });
    expect(calls).toBe(1);
  });
});
