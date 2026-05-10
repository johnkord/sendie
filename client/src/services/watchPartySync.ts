/**
 * Pure helpers for watch-party sync. Extracted from WatchPartyService so
 * we can unit-test the timing math without spinning up WebRTC peer
 * connections, AudioContexts, or HTMLVideoElements.
 *
 * Everything here is a pure function. State machines and side effects
 * stay in WatchPartyService.
 */

/** Subset of TimelineState used by the math. Real type lives in src/types. */
export interface TimelinePoint {
  playing: boolean;
  /** Host's monotonic clock at send time (seconds, AudioContext-aligned). */
  anchorMono: number;
  /** Host's currentTime at send time. */
  anchorTime: number;
  playbackRate: number;
}

/** Decision returned by classifyTimelineChange. */
export interface TimelineChange {
  seekJump: boolean;
  playFlip: boolean;
  rateChange: boolean;
  /** True if any of the three flags is set; convenience. */
  hostChanged: boolean;
}

/**
 * Decide whether an incoming timeline message represents a host action
 * (seek, play, pause, rate change) or a routine heartbeat. Heartbeats
 * advance anchorTime in proportion to anchorMono; only deviations from
 * that prediction count as a real seek.
 *
 * - `seekJump`: anchorTime jumped to a value the previous timeline
 *   would not predict. Threshold 1 s mismatch when host was playing
 *   (tolerates anchor-sampling jitter); 250 ms when host was paused
 *   (anchorTime can't advance on its own, so any change is a seek).
 * - `playFlip`: playing state toggled.
 * - `rateChange`: playbackRate changed.
 *
 * @param prev  most recent prior timeline; null on first message.
 * @param next  newly-received timeline.
 */
export function classifyTimelineChange(
  prev: TimelinePoint | null,
  next: TimelinePoint,
): TimelineChange {
  if (!prev) {
    const initial = { seekJump: true, playFlip: true, rateChange: true };
    return { ...initial, hostChanged: true };
  }
  const playFlip = prev.playing !== next.playing;
  const rateChange = Math.abs(prev.playbackRate - next.playbackRate) > 1e-6;

  let seekJump: boolean;
  if (!prev.playing) {
    // Paused before. Any anchorTime change is a deliberate seek.
    seekJump = Math.abs(prev.anchorTime - next.anchorTime) > 0.25;
  } else {
    // Playing before. Predict where anchorTime should be now.
    const dt = next.anchorMono - prev.anchorMono;
    const expectedAnchorTime = prev.anchorTime + dt * prev.playbackRate;
    seekJump = Math.abs(expectedAnchorTime - next.anchorTime) > 1.0;
  }

  const hostChanged = seekJump || playFlip || rateChange;
  return { seekJump, playFlip, rateChange, hostChanged };
}

/**
 * Compute the host's expected currentTime at a given local-mono time
 * using the latest timeline and our estimate of the host clock offset.
 *
 * @param tl              latest received timeline.
 * @param hostClockOffset offset = host_time - local_time (seconds).
 * @param localNow        local AudioContext.currentTime (seconds).
 */
export function expectedMediaTime(
  tl: TimelinePoint,
  hostClockOffset: number,
  localNow: number,
): number {
  const anchorMonoLocal = tl.anchorMono - hostClockOffset;
  const elapsed = tl.playing ? Math.max(0, localNow - anchorMonoLocal) : 0;
  return tl.anchorTime + elapsed * tl.playbackRate;
}

/** Tunable thresholds; mirrored in WatchPartyService for the live loop. */
export interface DriftTunables {
  softDriftS: number;
  hardDriftS: number;
  deadbandS: number;
  rateNudgeMax: number;
}

export const DEFAULT_DRIFT_TUNABLES: DriftTunables = {
  softDriftS: 0.5,
  hardDriftS: 1.5,
  deadbandS: 0.5,
  rateNudgeMax: 0.05,
};

export type DriftAction =
  | { kind: 'none' }
  | { kind: 'hard-seek'; toMediaTime: number }
  | { kind: 'rate-nudge'; toRate: number }
  | { kind: 'restore-rate'; toRate: number };

/**
 * Decide what correction (if any) the drift loop should apply this tick.
 *
 * Pure function: caller passes in everything that could vary, gets back
 * a deterministic action. Tested for compounding-protection,
 * deadband/hysteresis, and the readyState gate.
 *
 * @param drift         frameMediaTime - expectedMediaTime (seconds).
 *                      Positive = ahead of host; negative = behind.
 * @param hostRate      host's playbackRate (target rate).
 * @param currentRate   our element's current playbackRate.
 * @param canMeasure    receiver readyState >= HAVE_FUTURE_DATA (3).
 *                      False during decoder buffering: do nothing.
 * @param inSeekCooldown true if a hard-seek happened recently and the
 *                      decoder hasn't recovered yet.
 * @param canChangeRate false if a rate change happened more recently
 *                      than the throttle window. Throttling is what
 *                      keeps the audio pipeline from glitching.
 * @param tun           thresholds.
 */
export function decideDriftAction(
  drift: number,
  hostRate: number,
  currentRate: number,
  canMeasure: boolean,
  inSeekCooldown: boolean,
  canChangeRate: boolean,
  tun: DriftTunables = DEFAULT_DRIFT_TUNABLES,
): DriftAction {
  if (!canMeasure) return { kind: 'none' };
  const absDrift = Math.abs(drift);

  if (!inSeekCooldown && absDrift >= tun.hardDriftS) {
    // Hard seek to the host's expected position. The caller knows
    // expectedMediaTime; we just signal intent. We also reset to host
    // rate to avoid carrying over a nudge from before the seek.
    return { kind: 'hard-seek', toMediaTime: NaN }; // caller fills in
  }

  if (!inSeekCooldown && canChangeRate && absDrift >= tun.softDriftS) {
    // Proportional rate nudge against host rate. Magnitude scales
    // linearly from softDriftS up to hardDriftS, capped at
    // rateNudgeMax. Target is host_rate +/- delta, NOT
    // current_rate * (1 +/- delta), so nudges never compound across
    // 60 Hz frame ticks.
    const magnitude = Math.min(1, absDrift / tun.hardDriftS);
    const delta = tun.rateNudgeMax * magnitude;
    const target = hostRate * (1 - delta * Math.sign(drift));
    if (Math.abs(currentRate - target) > 0.005) {
      return { kind: 'rate-nudge', toRate: target };
    }
  }

  if (canChangeRate && absDrift < tun.deadbandS && Math.abs(currentRate - hostRate) > 0.005) {
    return { kind: 'restore-rate', toRate: hostRate };
  }

  return { kind: 'none' };
}
