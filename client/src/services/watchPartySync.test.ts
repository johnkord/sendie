import { describe, it, expect } from 'vitest';
import {
  classifyTimelineChange,
  expectedMediaTime,
  decideDriftAction,
  DEFAULT_DRIFT_TUNABLES,
  type TimelinePoint,
} from './watchPartySync';

const tl = (over: Partial<TimelinePoint> = {}): TimelinePoint => ({
  playing: true,
  anchorMono: 100,
  anchorTime: 0,
  playbackRate: 1,
  ...over,
});

describe('classifyTimelineChange', () => {
  it('flags everything on first message', () => {
    const c = classifyTimelineChange(null, tl());
    expect(c).toEqual({ seekJump: true, playFlip: true, rateChange: true, hostChanged: true });
  });

  it('routine heartbeat (anchorTime advances proportionally) is NOT a seek', () => {
    // Host sent at t=100 anchorTime=10. Next heartbeat at t=101 should
    // have anchorTime ~= 11. That's the heartbeat advancing as expected.
    const prev = tl({ anchorMono: 100, anchorTime: 10 });
    const next = tl({ anchorMono: 101, anchorTime: 11 });
    const c = classifyTimelineChange(prev, next);
    expect(c.seekJump).toBe(false);
    expect(c.hostChanged).toBe(false);
  });

  it('routine heartbeat tolerates small anchor-sampling jitter', () => {
    const prev = tl({ anchorMono: 100, anchorTime: 10 });
    // 200 ms of jitter in the anchor sampling shouldn't trigger a seek.
    const next = tl({ anchorMono: 101, anchorTime: 11.2 });
    expect(classifyTimelineChange(prev, next).seekJump).toBe(false);
  });

  it('large anchorTime jump while playing is a seek', () => {
    const prev = tl({ anchorMono: 100, anchorTime: 10 });
    const next = tl({ anchorMono: 101, anchorTime: 50 }); // jumped 39 s ahead in 1 s
    expect(classifyTimelineChange(prev, next).seekJump).toBe(true);
  });

  it('any anchorTime change while paused is a seek', () => {
    const prev = tl({ playing: false, anchorMono: 100, anchorTime: 10 });
    const next = tl({ playing: false, anchorMono: 101, anchorTime: 10.5 });
    expect(classifyTimelineChange(prev, next).seekJump).toBe(true);
    expect(classifyTimelineChange(prev, next).playFlip).toBe(false);
  });

  it('paused with no anchorTime change is not a seek (idle heartbeat)', () => {
    const prev = tl({ playing: false, anchorMono: 100, anchorTime: 10 });
    const next = tl({ playing: false, anchorMono: 101, anchorTime: 10 });
    expect(classifyTimelineChange(prev, next).seekJump).toBe(false);
    expect(classifyTimelineChange(prev, next).hostChanged).toBe(false);
  });

  it('play -> pause flips playFlip but not seek when anchorTime stable', () => {
    const prev = tl({ playing: true, anchorMono: 100, anchorTime: 10 });
    // Host pauses at t=100.5, sees anchorTime=10.5. From the receiver's
    // expected math (10 + 0.5 * 1 = 10.5) this is exactly on track,
    // so we should flag playFlip but NOT seek.
    const next = tl({ playing: false, anchorMono: 100.5, anchorTime: 10.5 });
    const c = classifyTimelineChange(prev, next);
    expect(c.playFlip).toBe(true);
    expect(c.seekJump).toBe(false);
  });

  it('rate change is detected', () => {
    const prev = tl({ playbackRate: 1 });
    const next = tl({ playbackRate: 1.5 });
    expect(classifyTimelineChange(prev, next).rateChange).toBe(true);
  });

  it('1.5x heartbeat advances anchorTime proportionally', () => {
    const prev = tl({ anchorMono: 100, anchorTime: 10, playbackRate: 1.5 });
    const next = tl({ anchorMono: 101, anchorTime: 11.5, playbackRate: 1.5 });
    expect(classifyTimelineChange(prev, next).seekJump).toBe(false);
  });
});

describe('expectedMediaTime', () => {
  it('paused: returns anchorTime regardless of clock', () => {
    const t = tl({ playing: false, anchorMono: 100, anchorTime: 42 });
    expect(expectedMediaTime(t, 0, 999)).toBe(42);
  });

  it('playing: extrapolates by elapsed local time at host rate', () => {
    const t = tl({ playing: true, anchorMono: 100, anchorTime: 10 });
    // offset = 0, localNow = 105 -> 5 s elapsed -> 15
    expect(expectedMediaTime(t, 0, 105)).toBeCloseTo(15);
  });

  it('clamps elapsed to >= 0 (lookahead window)', () => {
    // anchorMono in the future relative to localNow (typical lookahead
    // pattern for play/seek transitions): elapsed should be 0, not
    // negative, so we land exactly on anchorTime.
    const t = tl({ playing: true, anchorMono: 100, anchorTime: 42 });
    expect(expectedMediaTime(t, 0, 99.5)).toBe(42);
  });

  it('applies host clock offset', () => {
    // Host time is 0.5 s ahead of local. anchorMono=100 (host time)
    // means anchorMonoLocal=99.5. localNow=100 -> elapsed=0.5.
    const t = tl({ playing: true, anchorMono: 100, anchorTime: 10 });
    expect(expectedMediaTime(t, 0.5, 100)).toBeCloseTo(10.5);
  });

  it('respects host playbackRate', () => {
    const t = tl({ playing: true, anchorMono: 100, anchorTime: 10, playbackRate: 1.5 });
    expect(expectedMediaTime(t, 0, 102)).toBeCloseTo(13);
  });
});

describe('decideDriftAction', () => {
  const tun = DEFAULT_DRIFT_TUNABLES;

  it('does nothing while buffering (canMeasure=false)', () => {
    expect(decideDriftAction(99, 1, 1, false, false, true, tun)).toEqual({ kind: 'none' });
  });

  it('does nothing inside the deadband at host rate', () => {
    expect(decideDriftAction(0.1, 1, 1, true, false, true, tun)).toEqual({ kind: 'none' });
  });

  it('hard-seeks above hardDriftS', () => {
    expect(decideDriftAction(2.0, 1, 1, true, false, true, tun).kind).toBe('hard-seek');
    expect(decideDriftAction(-2.0, 1, 1, true, false, true, tun).kind).toBe('hard-seek');
  });

  it('does NOT hard-seek during seek cooldown', () => {
    expect(decideDriftAction(2.0, 1, 1, true, true, true, tun)).toEqual({ kind: 'none' });
  });

  it('rate-nudges between soft and hard thresholds', () => {
    // ahead by 0.8 s -> nudge slower
    const a = decideDriftAction(0.8, 1, 1, true, false, true, tun);
    expect(a.kind).toBe('rate-nudge');
    if (a.kind === 'rate-nudge') {
      expect(a.toRate).toBeLessThan(1);
      expect(a.toRate).toBeGreaterThan(0.95);
    }
    // behind by 0.8 s -> nudge faster
    const b = decideDriftAction(-0.8, 1, 1, true, false, true, tun);
    expect(b.kind).toBe('rate-nudge');
    if (b.kind === 'rate-nudge') {
      expect(b.toRate).toBeGreaterThan(1);
      expect(b.toRate).toBeLessThan(1.05);
    }
  });

  it('does NOT rate-nudge during throttle window', () => {
    expect(decideDriftAction(0.8, 1, 1, true, false, false, tun)).toEqual({ kind: 'none' });
  });

  it('does not compound: target depends on host rate, not current rate', () => {
    // We're at currentRate=0.6 (huge previous nudge). New tick still ahead
    // by 0.8 s. Target should be relative to host rate (1.0), not 0.6.
    const a = decideDriftAction(0.8, 1, 0.6, true, false, true, tun);
    expect(a.kind).toBe('rate-nudge');
    if (a.kind === 'rate-nudge') {
      // Target ~= 1 * (1 - 0.05 * 0.8/1.5) ≈ 0.973, not 0.6 * (1 - ...)
      expect(a.toRate).toBeGreaterThan(0.9);
    }
  });

  it('rate-nudge size scales with drift magnitude', () => {
    // Just past soft threshold: tiny nudge.
    const small = decideDriftAction(0.55, 1, 1, true, false, true, tun);
    // Right at hard threshold: full max nudge.
    const big = decideDriftAction(1.49, 1, 1, true, false, true, tun);
    if (small.kind === 'rate-nudge' && big.kind === 'rate-nudge') {
      expect(Math.abs(1 - big.toRate)).toBeGreaterThan(Math.abs(1 - small.toRate));
    } else {
      throw new Error('expected rate-nudge in both');
    }
  });

  it('restores host rate inside deadband when current rate is off', () => {
    // We were nudging earlier; drift returned to zero. Restore.
    const a = decideDriftAction(0.05, 1, 0.95, true, false, true, tun);
    expect(a).toEqual({ kind: 'restore-rate', toRate: 1 });
  });

  it('does not restore inside throttle window', () => {
    const a = decideDriftAction(0.05, 1, 0.95, true, false, false, tun);
    expect(a).toEqual({ kind: 'none' });
  });

  it('handles host playing at 1.5x', () => {
    // Behind by 0.8 s while host plays at 1.5x -> still nudge, but the
    // target is relative to 1.5, so a small fraction above 1.5.
    const a = decideDriftAction(-0.8, 1.5, 1.5, true, false, true, tun);
    expect(a.kind).toBe('rate-nudge');
    if (a.kind === 'rate-nudge') {
      expect(a.toRate).toBeGreaterThan(1.5);
      expect(a.toRate).toBeLessThan(1.6);
    }
  });
});
