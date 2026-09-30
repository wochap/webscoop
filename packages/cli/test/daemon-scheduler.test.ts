import { describe, expect, it } from 'vitest';
import type { SharedBrowserHandle } from '../src/context';
import { AttentionGate, Scheduler, type Job, type LaunchedBrowser } from '../src/daemon/scheduler';

/** A browser port that counts launches and closes. */
function fakePort() {
  const log: string[] = [];
  let launches = 0;
  const launch = (profileDir: string, key: string): LaunchedBrowser => {
    const id = ++launches;
    const listeners = new Set<() => void>();
    log.push(`launch ${id} ${profileDir} ${key}`);
    const handle: SharedBrowserHandle = {
      newSession: async () => {
        throw new Error('not used');
      },
      close: async () => {
        log.push(`close ${id}`);
        listeners.forEach((cb) => cb());
      },
      onClosed: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    return { handle, pid: 1000 + id, release: () => log.push(`release ${id}`) };
  };
  return { log, launch, launches: () => launches };
}

interface FakeJob extends Job {
  events: string[];
  /** Let the job end with this code. */
  end(code?: number): void;
  /** Resolves once the job runs. */
  running: Promise<void>;
  done: Promise<{ code: number; message?: string }>;
}

function fakeJob(
  port: ReturnType<typeof fakePort>,
  runId: string,
  opts: { profile?: string; key?: string; concurrency?: number; idleMs?: number; queueTimeoutMs?: number; launch?: (signal: AbortSignal) => Promise<LaunchedBrowser> } = {},
): FakeJob {
  const events: string[] = [];
  const profile = opts.profile ?? 'default';
  let end!: (code: number) => void;
  let markRunning!: () => void;
  let markDone!: (r: { code: number; message?: string }) => void;
  const running = new Promise<void>((r) => (markRunning = r));
  const done = new Promise<{ code: number; message?: string }>((r) => (markDone = r));
  const key = opts.key ?? 'k';
  return {
    runId,
    recipe: `recipe-${runId}`,
    profile,
    profileDir: `/profiles/${profile}`,
    key,
    concurrency: opts.concurrency ?? 1,
    idleMs: opts.idleMs ?? 0,
    ...(opts.queueTimeoutMs !== undefined ? { queueTimeoutMs: opts.queueTimeoutMs } : {}),
    launch: opts.launch ?? (async () => port.launch(`/profiles/${profile}`, key)),
    execute: () => {
      events.push('execute');
      markRunning();
      return new Promise<number>((r) => (end = r));
    },
    queued: (ahead) => void events.push(`queued ${ahead}`),
    started: () => void events.push('started'),
    finish: (code, message) => {
      events.push(`finish ${code}${message ? ` ${message}` : ''}`);
      markDone({ code, ...(message ? { message } : {}) });
    },
    interrupt: (message) => {
      events.push(`interrupt${message ? ` ${message}` : ''}`);
      end(1);
    },
    browserClosed: async (pid) => void events.push(`browser closed ${pid}`),
    events,
    end: (code = 0) => end(code),
    running,
    done,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('Scheduler', () => {
  it('runs jobs of one profile one after another in submission order by default, in one browser', async () => {
    const port = fakePort();
    const scheduler = new Scheduler();
    const order: string[] = [];
    const jobs = ['a', 'b', 'c'].map((id) => fakeJob(port, id, { idleMs: 60_000 }));
    for (const job of jobs) {
      scheduler.submit(job);
      void job.running.then(() => order.push(job.runId));
    }
    expect(jobs[1]!.events).toEqual(['queued 1']);
    expect(jobs[2]!.events).toEqual(['queued 2']);
    for (const job of jobs) {
      await job.running;
      await tick();
      expect(scheduler.status()[0]!.running.map((r) => r.runId)).toEqual([job.runId]);
      job.end();
      await job.done;
    }
    expect(order).toEqual(['a', 'b', 'c']);
    expect(port.launches()).toBe(1);
    await scheduler.stop(false);
  });

  it('runs up to the concurrency at once', async () => {
    const port = fakePort();
    const scheduler = new Scheduler();
    const jobs = ['a', 'b', 'c', 'd'].map((id) => fakeJob(port, id, { concurrency: 3 }));
    for (const job of jobs) scheduler.submit(job);
    await Promise.all(jobs.slice(0, 3).map((j) => j.running));
    await tick();
    expect(jobs[3]!.events).toEqual(['queued 3']);
    const status = scheduler.status()[0]!;
    expect(status.running).toHaveLength(3);
    expect(status.queued.map((q) => q.runId)).toEqual(['d']);
    jobs[1]!.end();
    await jobs[3]!.running;
    for (const job of [jobs[0]!, jobs[2]!, jobs[3]!]) job.end();
    await Promise.all(jobs.map((j) => j.done));
    expect(port.launches()).toBe(1);
  });

  it('keeps one browser per profile', async () => {
    const port = fakePort();
    const scheduler = new Scheduler();
    const a = fakeJob(port, 'a', { profile: 'default' });
    const b = fakeJob(port, 'b', { profile: 'work' });
    scheduler.submit(a);
    scheduler.submit(b);
    await Promise.all([a.running, b.running]);
    expect(scheduler.status().map((s) => s.profile).sort()).toEqual(['default', 'work']);
    expect(port.launches()).toBe(2);
    a.end();
    b.end();
    await Promise.all([a.done, b.done]);
  });

  it('relaunches for other launch settings once the browser is idle', async () => {
    const port = fakePort();
    const scheduler = new Scheduler();
    const a = fakeJob(port, 'a', { key: 'proxy-a', concurrency: 3, idleMs: 60_000 });
    const b = fakeJob(port, 'b', { key: 'direct', concurrency: 3 });
    const c = fakeJob(port, 'c', { key: 'proxy-a', concurrency: 3 });
    scheduler.submit(a);
    await a.running;
    scheduler.submit(b);
    scheduler.submit(c);
    await tick();
    // FIFO: c matches the running browser but waits behind b.
    expect(b.events).toEqual(['queued 1']);
    expect(c.events).toEqual(['queued 2']);
    a.end();
    await b.running;
    expect(port.log.filter((l) => !l.startsWith('release'))).toEqual(['launch 1 /profiles/default proxy-a', 'close 1', 'launch 2 /profiles/default direct']);
    expect(a.events).toContain('browser closed 1001');
    b.end();
    await c.running;
    c.end();
    await c.done;
  });

  it('closes an idle browser after idleMs, and reports empty', async () => {
    const port = fakePort();
    let empty = 0;
    const scheduler = new Scheduler({ onEmpty: () => empty++ });
    const a = fakeJob(port, 'a', { idleMs: 50 });
    scheduler.submit(a);
    await a.running;
    a.end();
    await a.done;
    expect(port.log).not.toContain('close 1');
    expect(scheduler.empty).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(port.log).toEqual(['launch 1 /profiles/default k', 'close 1', 'release 1']);
    expect(scheduler.empty).toBe(true);
    expect(empty).toBe(1);
  });

  it('closes the browser before the last job reports its end when idleMs is 0', async () => {
    const port = fakePort();
    const scheduler = new Scheduler();
    const a = fakeJob(port, 'a', { idleMs: 0 });
    scheduler.submit(a);
    await a.running;
    a.end();
    await a.done;
    expect(a.events).toEqual(['started', 'execute', 'browser closed 1001', 'finish 0']);
    expect(scheduler.empty).toBe(true);
  });

  it('removes a job that did not start within its queue timeout, naming the profile and the jobs ahead', async () => {
    const port = fakePort();
    const scheduler = new Scheduler();
    const a = fakeJob(port, 'a');
    const b = fakeJob(port, 'b', { queueTimeoutMs: 30 });
    scheduler.submit(a);
    scheduler.submit(b);
    expect(await b.done).toEqual({ code: 1, message: 'gave up after 30 ms waiting for profile "default" (1 job ahead)' });
    expect(scheduler.status()[0]!.queued).toEqual([]);
    a.end();
    await a.done;
  });

  it('cancels one job and leaves the others running', async () => {
    const port = fakePort();
    const scheduler = new Scheduler();
    const a = fakeJob(port, 'a', { concurrency: 2 });
    const b = fakeJob(port, 'b', { concurrency: 2 });
    const c = fakeJob(port, 'c', { concurrency: 2 });
    for (const job of [a, b, c]) scheduler.submit(job);
    await Promise.all([a.running, b.running]);
    expect(scheduler.cancel('c')).toBe(true);
    expect((await c.done).code).toBe(1);
    expect(scheduler.cancel('a', 'stopped')).toBe(true);
    expect(a.events).toContain('interrupt stopped');
    expect((await a.done).code).toBe(1);
    expect(scheduler.status()[0]!.running.map((r) => r.runId)).toEqual(['b']);
    b.end();
    expect((await b.done).code).toBe(0);
  });

  it('cancels the jobs of a released profile and closes its browser', async () => {
    const port = fakePort();
    const scheduler = new Scheduler({ releasePauseMs: 10 });
    const a = fakeJob(port, 'a');
    const b = fakeJob(port, 'b');
    scheduler.submit(a);
    scheduler.submit(b);
    await a.running;
    expect(scheduler.usage('/profiles/default')).toEqual({ profile: 'default', running: 1, queued: 1, open: true });
    await scheduler.release('/profiles/default', 'stopped by `record`');
    expect(a.events).toContain('interrupt stopped by `record`');
    expect(await b.done).toEqual({ code: 1, message: 'stopped by `record`' });
    expect(port.log).toContain('close 1');
    expect(scheduler.usage('/profiles/default').open).toBe(false);
  });

  it('holds new jobs back while the profile lock is taken, and gives up at the queue timeout', async () => {
    const port = fakePort();
    const scheduler = new Scheduler();
    const job = fakeJob(port, 'a', {
      queueTimeoutMs: 30,
      launch: (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    scheduler.submit(job);
    expect(await job.done).toEqual({ code: 1, message: 'gave up after 30 ms waiting for profile "default" (0 jobs ahead, waiting for its browser)' });
    expect(job.events).not.toContain('execute');
  });
});

describe('AttentionGate', () => {
  it('grants attention to one run at a time, in request order, marking later ones as waited', async () => {
    const gate = new AttentionGate();
    const first = await gate.acquire('a');
    expect(first.waited).toBe(false);
    const order: string[] = [];
    const second = gate.acquire('b').then((l) => (order.push('b'), l));
    const third = gate.acquire('c').then((l) => (order.push('c'), l));
    expect(gate.holder).toBe('a');
    first.release();
    const b = await second;
    expect(b.waited).toBe(true);
    expect(gate.holder).toBe('b');
    b.release();
    (await third).release();
    expect(order).toEqual(['b', 'c']);
    expect(gate.holder).toBeNull();
  });

  it('drops a waiter whose signal aborts', async () => {
    const gate = new AttentionGate();
    const first = await gate.acquire('a');
    const abort = new AbortController();
    const waiting = gate.acquire('b', abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow('aborted');
    first.release();
    expect(gate.holder).toBeNull();
  });
});
