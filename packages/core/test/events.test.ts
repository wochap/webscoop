import { describe, expect, expectTypeOf, it } from 'vitest';
import { recordEvents, RUN_EVENT_NAMES, RunEmitter, type FailureReason, type GuardEntry, type Row, type RunEvents, type RunReport } from '../src';

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

  it('types guard events, the paused failure, and the report guard list', () => {
    expect(RUN_EVENT_NAMES).toEqual(expect.arrayContaining(['guard.raised', 'guard.cleared', 'guard.timeout']));
    expect(RUN_EVENT_NAMES.indexOf('guard.raised')).toBeGreaterThan(RUN_EVENT_NAMES.indexOf('page.loaded'));
    expectTypeOf<RunEvents['guard.raised']>().toEqualTypeOf<{ kind: 'login' | 'captcha' | 'zero-fields'; page: number; url: string; reason: string }>();
    expectTypeOf<RunEvents['guard.cleared']>().toEqualTypeOf<{ kind: 'login' | 'captcha' | 'zero-fields'; page: number; url: string; waitedMs: number }>();
    expectTypeOf<RunEvents['guard.timeout']>().toEqualTypeOf<RunEvents['guard.cleared']>();
    expectTypeOf<'paused'>().toExtend<FailureReason>();
    expectTypeOf<RunReport['guards']>().toEqualTypeOf<GuardEntry[]>();
    const emitter = new RunEmitter();
    const log = recordEvents(emitter);
    emitter.emit('guard.raised', { kind: 'login', page: 1, url: 'http://x/login', reason: 'redirected to a login page' });
    emitter.emit('guard.cleared', { kind: 'login', page: 1, url: 'http://x/login', waitedMs: 1200 });
    expect(log.of('guard.cleared')[0]!.waitedMs).toBe(1200);
  });
});
