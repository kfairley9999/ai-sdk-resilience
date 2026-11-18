import { describe, expect, it } from 'vitest';
import { ManualClock, systemClock } from '../src/clock.js';

describe('clocks', () => {
  it('sleeps and aborts on the system clock', async () => {
    const start = systemClock.now();
    await systemClock.sleep(5);
    expect(systemClock.now()).toBeGreaterThanOrEqual(start);

    const controller = new AbortController();
    const pending = systemClock.sleep(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    const already = new AbortController();
    already.abort();
    await expect(systemClock.sleep(1, already.signal)).rejects.toBeTruthy();
  });

  it('parks a manual clock until time is advanced', async () => {
    const clock = new ManualClock();
    let done = false;
    const pending = clock.sleep(25).then(() => {
      done = true;
    });
    expect(clock.pending).toBe(1);
    await clock.advance(24);
    expect(done).toBe(false);
    await clock.advance(1);
    await pending;
    expect(done).toBe(true);
    expect(clock.now()).toBe(25);

    const controller = new AbortController();
    const aborted = clock.sleep(10, controller.signal);
    controller.abort(new Error('nope'));
    await expect(aborted).rejects.toThrow('nope');
    expect(clock.pending).toBe(0);
    await expect(clock.sleep(0, AbortSignal.abort('now'))).rejects.toBe('now');
  });
});
