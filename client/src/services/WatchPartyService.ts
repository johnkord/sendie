import { multiPeerWebRTCService } from './MultiPeerWebRTCService';
import { signalingService } from './SignalingService';
import { cryptoService } from './CryptoService';
import type { DataChannelMessage } from '../types';

/**
 * Synced media playback ("watch party") service.
 *
 * Implements v1 of docs/synced-media-playback-proposal.md:
 *
 *   - Each peer loads a local video file via the file picker. We do
 *     not transfer the bytes inside the watch-party flow; the
 *     existing MultiPeerFileTransferService still exists for users
 *     who need to share. Trust-the-user that the files are the same
 *     movie.
 *   - One peer is the "host" with authoritative timeline. Host sends
 *     wp-timeline messages over the existing data channel; followers
 *     run a drift loop on every rendered frame to converge.
 *   - Clock offset is estimated by piggybacking the host's
 *     AudioContext.currentTime on each timeline message and combining
 *     with RTCStatsReport.currentRoundTripTime; no separate ping
 *     protocol.
 *   - Lookahead reservation for play / seek transitions (anchorMono is
 *     set 500 ms in the future) so all peers begin playback at the
 *     same wall-clock instant rather than catching up.
 *
 * Out of scope for v1 (see proposal sections 3.4, 5, 6 for plan):
 *   - Reactions on the timeline, chapter-marker auto-pause,
 *     audio-fingerprint cross-validation
 *   - Document Picture-in-Picture detach
 *   - Subtitle file sharing
 *   - Democratic mode (anyone can pause); v1 is host-controlled with
 *     an explicit transfer-host flow
 */

// How often the host re-broadcasts its timeline state during playback.
// 2 s is enough for follower drift to be corrected continuously without
// flooding the data channel; on every state transition (play/pause/seek/
// rate change) we send immediately regardless.
const TIMELINE_HEARTBEAT_MS = 2000;

// Lookahead in seconds for state transitions. The host schedules play
// or seek at hostMono + this offset so the follower's drift loop has
// time to converge before the moment of transition. 500 ms exceeds
// realistic public-internet RTTs while staying short enough that users
// don't notice the pre-roll.
const TRANSITION_LOOKAHEAD_S = 0.5;

// Drift correction thresholds (seconds).
//   < SOFT_DRIFT_S        : do nothing (within human perception slack)
//   SOFT_DRIFT_S..HARD_S  : nudge playbackRate by +/- 5 percent
//   >= HARD_DRIFT_S       : hard seek (jolts the user, but converges)
// Plex / Jellyfin / Syncplay use 50 ms / 1 s; we use 100 ms / 1 s so
// brief voice-traffic blips don't trigger spurious nudges.
const SOFT_DRIFT_S = 0.1;
const HARD_DRIFT_S = 1.0;
const RATE_NUDGE = 0.05;

// Rolling-median window for clock offset samples. Larger windows reject
// outliers better but lag behind real clock changes; 9 is a good
// balance for 2 s heartbeats (about 18 s of history).
const OFFSET_WINDOW = 9;

// Stale-timeline timeout. If we haven't seen a heartbeat in this long
// while expecting one (host disconnected, partition), pause locally
// and surface a "host disconnected" status. 3x the heartbeat plus a
// fudge factor for jittery links.
const STALE_TIMELINE_MS = TIMELINE_HEARTBEAT_MS * 3 + 1000;

export type WatchPartyRole = 'host' | 'follower' | 'idle';

export interface WatchPartyState {
  // Stable id assigned at session start by the host. Followers ignore
  // messages with a different sessionId (e.g. a previous, abandoned
  // session whose stragglers are still in the air).
  sessionId: string | null;
  role: WatchPartyRole;
  hostPeerId: string | null;
  // Display-only metadata advertised by the host.
  mediaName: string | null;
  mediaDuration: number;
  // The user's locally-loaded file. null until they pick one.
  localFile: File | null;
  // Last-seen heartbeat info (followers only).
  lastTimelineAt: number;
  // Most recent error message surfaced for the UI; cleared on next
  // successful action.
  error: string | null;
}

export interface WatchPartyPeerInfo {
  peerId: string;
  state: 'idle' | 'ready' | 'buffering';
  // Optional last-known mediaTime, used for seekbar dots.
  mediaTime?: number;
  // Estimated drift relative to the host's authoritative timeline,
  // computed locally by aggregating stats. Set only on followers'
  // self-report; UI displays as a colored dot.
  drift?: number;
}

export type WatchPartyEvents = {
  onStateChange: (state: Readonly<WatchPartyState>) => void;
  onPeersChange: (peers: ReadonlyMap<string, WatchPartyPeerInfo>) => void;
  onError: (err: Error) => void;
};

class WatchPartyService {
  private state: WatchPartyState = {
    sessionId: null,
    role: 'idle',
    hostPeerId: null,
    mediaName: null,
    mediaDuration: 0,
    localFile: null,
    lastTimelineAt: 0,
    error: null,
  };
  // Per-peer status, including ourselves. Receivers update from
  // wp-peer-state messages; the host publishes its own state on every
  // change so the follower UI can see the room ready-state.
  private peers: Map<string, WatchPartyPeerInfo> = new Map();
  private events: Partial<WatchPartyEvents> = {};
  // Rolling clock-offset samples per peer. Followers maintain one
  // entry per host (almost always a single host); hosts are
  // bystanders here.
  private offsetSamplesByPeer: Map<string, number[]> = new Map();
  // Last-applied host clock offset (seconds). Add to local
  // AudioContext.currentTime to get host time.
  private hostClockOffset = 0;

  // Lazily-instantiated AudioContext for the monotonic clock. iOS
  // Safari requires a user gesture before any AudioContext is
  // 'running', but it'll happily report currentTime in 'suspended'
  // state too, so we don't actually need to start it. Reuse a single
  // instance to avoid leaking.
  private audioCtx: AudioContext | null = null;

  // Reference to the bound video element. Set by the UI via
  // attachVideoElement when it mounts the player. Used by both host
  // (to read local state and broadcast) and followers (to drive drift
  // correction).
  private videoEl: HTMLVideoElement | null = null;
  // Cancel handle for the bound rVFC / rAF loop.
  private driftLoopCancel: (() => void) | null = null;
  // Heartbeat timer, host only.
  private heartbeatTimer: number | null = null;
  // Watchdog for stale timeline messages, follower only.
  private staleTimelineTimer: number | null = null;
  // Monotonic seq counter used by the host. Followers ignore older
  // seqs; on partition recovery, highest seq wins with peerId as
  // tiebreak.
  private nextSeq = 0;
  // Last received timeline (followers): the source of truth for the
  // drift loop. Hosts ignore this; their authoritative state lives on
  // the video element.
  private lastTimeline: Extract<DataChannelMessage, { type: 'wp-timeline' }> | null = null;

  constructor() {
    multiPeerWebRTCService.on('onDataChannelMessage', (peerId, data) => {
      if (typeof data !== 'string') return;
      let msg: DataChannelMessage;
      try {
        msg = JSON.parse(data) as DataChannelMessage;
      } catch {
        return;
      }
      this.handleMessage(peerId, msg);
    });
    multiPeerWebRTCService.on('onPeerDisconnected', (peerId) => {
      this.peers.delete(peerId);
      this.offsetSamplesByPeer.delete(peerId);
      // If the host disconnected, stop the session locally and let
      // the user know. We don't auto-promote in v1; the user explicitly
      // takes over via the host-request flow.
      if (this.state.role === 'follower' && this.state.hostPeerId === peerId) {
        this.surfaceError('Host disconnected from watch party.');
        this.leave();
      }
      this.emitPeers();
    });
    // Re-announce our state when a new peer's data channel opens, so
    // a late joiner sees us in the right state without waiting for the
    // next heartbeat.
    multiPeerWebRTCService.on('onDataChannelOpen', (peerId) => {
      if (this.state.role === 'host' && this.state.sessionId) {
        this.sendTimeline(peerId);
      } else if (this.state.role !== 'idle' && this.state.sessionId) {
        this.broadcastPeerState();
      }
    });
  }

  on<K extends keyof WatchPartyEvents>(event: K, handler: WatchPartyEvents[K]): void {
    this.events[event] = handler;
  }
  off<K extends keyof WatchPartyEvents>(event: K): void {
    delete this.events[event];
  }

  getState(): Readonly<WatchPartyState> { return this.state; }
  getPeers(): ReadonlyMap<string, WatchPartyPeerInfo> { return this.peers; }
  /** Most recently observed clock offset (host time minus local time), seconds. */
  getHostClockOffset(): number { return this.hostClockOffset; }

  /**
   * Local AudioContext.currentTime in SECONDS. Two reasons we use this
   * over performance.now():
   *   - Not throttled in backgrounded tabs (browsers clamp
   *     performance.now()-driven setTimeout to 1 Hz when hidden).
   *   - Same clock that drives audio output, which is what we are
   *     ultimately syncing. Audio drift makes lip-sync break first.
   */
  private localMono(): number {
    if (!this.audioCtx) {
      try {
        this.audioCtx = new (window.AudioContext || (window as unknown as {
          webkitAudioContext: typeof AudioContext;
        }).webkitAudioContext)();
      } catch {
        // Fallback: performance.now() in seconds. Worse but viable.
        return performance.now() / 1000;
      }
    }
    return this.audioCtx.currentTime;
  }

  // -------- Host: start / control --------

  /**
   * Become the host: pick a local file (the caller already obtained it
   * via a file picker / drop) and start a new session. Broadcasts an
   * initial paused timeline at currentTime=0. Followers will see
   * 'host loaded movie X' and load their own file.
   */
  async startAsHost(file: File): Promise<void> {
    if (this.state.role !== 'idle') {
      throw new Error('Already in a watch party. Leave first.');
    }
    const sessionId = cryptoService.generateFileId();
    const myPeerId = this.getMyPeerId();
    this.state = {
      sessionId,
      role: 'host',
      hostPeerId: myPeerId,
      mediaName: file.name,
      mediaDuration: 0, // populated when the video metadata loads
      localFile: file,
      lastTimelineAt: this.localMono(),
      error: null,
    };
    // Host starts in 'ready' (we have a file) but mediaTime=0 / paused.
    // mediaDuration is filled in by the UI via setMediaDuration once
    // the video element has loaded metadata.
    this.peers.set(myPeerId, { peerId: myPeerId, state: 'ready', mediaTime: 0 });
    this.nextSeq = 0;
    this.emitState();
    this.emitPeers();
    // Send initial timeline so followers know what's happening.
    this.broadcastTimeline();
    this.startHeartbeat();
  }

  /**
   * Set the host's media duration once the <video> element knows it.
   * Causes a heartbeat so followers learn the duration.
   */
  setMediaDuration(seconds: number): void {
    if (this.state.role !== 'host') return;
    if (this.state.mediaDuration === seconds) return;
    this.state = { ...this.state, mediaDuration: seconds };
    this.emitState();
    this.broadcastTimeline();
  }

  /**
   * Host: kick off play. Uses lookahead reservation: schedule the play
   * moment slightly in the future so all peers hit it at the same wall
   * clock rather than catching up over the first second of playback.
   */
  hostPlay(): void {
    if (this.state.role !== 'host' || !this.videoEl) return;
    // Use the lookahead so receivers see anchorMono > hostMono and
    // their drift loop holds them paused at anchorTime until the
    // moment of transition.
    this.broadcastTimeline({
      playing: true,
      anchorTimeOverride: this.videoEl.currentTime,
      lookahead: TRANSITION_LOOKAHEAD_S,
    });
    // Schedule the local play to fire at exactly the lookahead
    // moment too, keeping the host aligned with the followers.
    setTimeout(() => {
      void this.videoEl?.play().catch(() => {
        // autoplay policy may reject if no user gesture in chain;
        // surface so UI can render a click-to-play overlay.
        this.surfaceError('Browser blocked auto-play; click the video to start.');
      });
    }, TRANSITION_LOOKAHEAD_S * 1000);
  }

  hostPause(): void {
    if (this.state.role !== 'host' || !this.videoEl) return;
    this.videoEl.pause();
    this.broadcastTimeline({
      playing: false,
      anchorTimeOverride: this.videoEl.currentTime,
    });
  }

  hostSeek(seconds: number): void {
    if (this.state.role !== 'host' || !this.videoEl) return;
    this.videoEl.currentTime = Math.max(0, Math.min(seconds, this.videoEl.duration || seconds));
    // Re-broadcast immediately so followers seek too. If we were
    // playing, lookahead reservation gives us frame-accurate alignment
    // on the new position.
    const wasPlaying = !this.videoEl.paused;
    this.broadcastTimeline({
      playing: wasPlaying,
      anchorTimeOverride: this.videoEl.currentTime,
      lookahead: wasPlaying ? TRANSITION_LOOKAHEAD_S : 0,
    });
  }

  hostSetPlaybackRate(rate: number): void {
    if (this.state.role !== 'host' || !this.videoEl) return;
    this.videoEl.playbackRate = rate;
    this.broadcastTimeline({
      playing: !this.videoEl.paused,
      anchorTimeOverride: this.videoEl.currentTime,
      playbackRate: rate,
    });
  }

  /**
   * Anyone: leave the watch party. Host triggers wp-end so followers
   * tear down too; followers just stop listening.
   */
  leave(): void {
    if (this.state.sessionId && this.state.role === 'host') {
      multiPeerWebRTCService.broadcast(JSON.stringify({
        type: 'wp-end',
        sessionId: this.state.sessionId,
      } satisfies DataChannelMessage));
    }
    this.stopHeartbeat();
    this.stopStaleWatchdog();
    if (this.driftLoopCancel) { this.driftLoopCancel(); this.driftLoopCancel = null; }
    this.state = {
      sessionId: null,
      role: 'idle',
      hostPeerId: null,
      mediaName: null,
      mediaDuration: 0,
      localFile: null,
      lastTimelineAt: 0,
      error: null,
    };
    this.peers.clear();
    this.offsetSamplesByPeer.clear();
    this.lastTimeline = null;
    this.hostClockOffset = 0;
    this.videoEl = null;
    this.emitState();
    this.emitPeers();
  }

  // -------- Follower: load + bind --------

  /**
   * Follower: pick a local file matching the host's announced movie.
   * Caller supplies the File from a picker / drop. After this we
   * advertise 'ready' to the room.
   */
  setFollowerFile(file: File): void {
    if (this.state.role !== 'follower' && this.state.role !== 'idle') {
      // Ignore on host; they already have a file.
      return;
    }
    if (this.state.role === 'idle') {
      // No host advertised yet; nothing to do.
      this.surfaceError('No active watch party to join.');
      return;
    }
    this.state = { ...this.state, localFile: file };
    this.emitState();
    this.broadcastPeerState();
  }

  /**
   * Bind to the rendered <video> element. Called by the UI on mount.
   * Returns an unbind function that the caller MUST run on unmount,
   * including before remounting (e.g. when switching from host to
   * follower role). Drives the drift loop for followers and ferries
   * play/pause events from the host's element back into the
   * timeline.
   */
  attachVideoElement(el: HTMLVideoElement): () => void {
    this.videoEl = el;
    if (this.state.role === 'host') {
      // Hosts don't run a drift loop; they ARE the timeline. Just
      // capture metadata and forward play/pause events as timeline
      // messages so followers stay aligned with manual <video>
      // controls (e.g. native browser play button, MediaSession).
      const onPlay = () => this.broadcastTimeline({ playing: true });
      const onPause = () => this.broadcastTimeline({ playing: false });
      const onSeeked = () => this.broadcastTimeline();
      const onLoadedMeta = () => this.setMediaDuration(el.duration || 0);
      el.addEventListener('play', onPlay);
      el.addEventListener('pause', onPause);
      el.addEventListener('seeked', onSeeked);
      el.addEventListener('loadedmetadata', onLoadedMeta);
      return () => {
        el.removeEventListener('play', onPlay);
        el.removeEventListener('pause', onPause);
        el.removeEventListener('seeked', onSeeked);
        el.removeEventListener('loadedmetadata', onLoadedMeta);
        this.videoEl = null;
      };
    }
    // Follower: start the drift loop. Use rVFC if available, rAF as
    // fallback (Safari < 16.4).
    const stop = this.startDriftLoop(el);
    return () => {
      stop();
      this.videoEl = null;
    };
  }

  // -------- Internal: timeline broadcast --------

  private broadcastTimeline(opts?: {
    playing?: boolean;
    anchorTimeOverride?: number;
    lookahead?: number;
    playbackRate?: number;
  }): void {
    if (this.state.role !== 'host' || !this.state.sessionId) return;
    const lookahead = opts?.lookahead ?? 0;
    const playing = opts?.playing ?? (this.videoEl ? !this.videoEl.paused : false);
    const anchorTime = opts?.anchorTimeOverride ?? this.videoEl?.currentTime ?? 0;
    const playbackRate = opts?.playbackRate ?? this.videoEl?.playbackRate ?? 1;
    const hostMono = this.localMono();
    const msg: DataChannelMessage = {
      type: 'wp-timeline',
      seq: this.nextSeq++,
      hostPeerId: this.state.hostPeerId ?? this.getMyPeerId(),
      sessionId: this.state.sessionId,
      playing,
      anchorMono: hostMono + lookahead,
      anchorTime,
      playbackRate,
      hostMono,
      mediaName: this.state.mediaName ?? '',
      mediaDuration: this.state.mediaDuration,
    };
    multiPeerWebRTCService.broadcast(JSON.stringify(msg));
  }

  private sendTimeline(peerId: string): void {
    if (this.state.role !== 'host' || !this.state.sessionId || !this.videoEl) return;
    const hostMono = this.localMono();
    const msg: DataChannelMessage = {
      type: 'wp-timeline',
      seq: this.nextSeq++,
      hostPeerId: this.state.hostPeerId ?? this.getMyPeerId(),
      sessionId: this.state.sessionId,
      playing: !this.videoEl.paused,
      anchorMono: hostMono,
      anchorTime: this.videoEl.currentTime,
      playbackRate: this.videoEl.playbackRate,
      hostMono,
      mediaName: this.state.mediaName ?? '',
      mediaDuration: this.state.mediaDuration,
    };
    multiPeerWebRTCService.sendTo(peerId, JSON.stringify(msg));
  }

  private broadcastPeerState(): void {
    if (!this.state.sessionId || this.state.role === 'idle') return;
    const peerState: 'idle' | 'ready' | 'buffering' = this.state.localFile ? 'ready' : 'idle';
    const mediaTime = this.videoEl?.currentTime;
    const msg: DataChannelMessage = {
      type: 'wp-peer-state',
      sessionId: this.state.sessionId,
      state: peerState,
      mediaTime,
    };
    multiPeerWebRTCService.broadcast(JSON.stringify(msg));
    // Also keep our own peer entry in sync.
    const myId = this.getMyPeerId();
    this.peers.set(myId, {
      peerId: myId,
      state: peerState,
      mediaTime,
    });
    this.emitPeers();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.broadcastTimeline();
    }, TIMELINE_HEARTBEAT_MS);
  }
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startStaleWatchdog(): void {
    this.stopStaleWatchdog();
    this.staleTimelineTimer = window.setInterval(() => {
      if (this.state.role !== 'follower') return;
      const sinceMs = (this.localMono() - this.state.lastTimelineAt) * 1000;
      if (sinceMs > STALE_TIMELINE_MS) {
        this.surfaceError('Lost sync with host (no recent heartbeat). Pausing locally.');
        if (this.videoEl && !this.videoEl.paused) this.videoEl.pause();
      }
    }, 1000);
  }
  private stopStaleWatchdog(): void {
    if (this.staleTimelineTimer !== null) {
      clearInterval(this.staleTimelineTimer);
      this.staleTimelineTimer = null;
    }
  }

  // -------- Internal: incoming messages --------

  private handleMessage(peerId: string, msg: DataChannelMessage): void {
    switch (msg.type) {
      case 'wp-timeline': return this.handleTimeline(peerId, msg);
      case 'wp-peer-state': return this.handlePeerState(peerId, msg);
      case 'wp-end': return this.handleEnd(peerId, msg);
      case 'wp-host-request': return this.handleHostRequest(peerId, msg);
      case 'wp-host-grant': return this.handleHostGrant(peerId, msg);
      default: return;
    }
  }

  private handleTimeline(
    peerId: string,
    msg: Extract<DataChannelMessage, { type: 'wp-timeline' }>,
  ): void {
    // First-time discovery: we weren't in a session and now someone is
    // hosting one. Move to follower with their session id.
    if (this.state.role === 'idle') {
      this.state = {
        ...this.state,
        sessionId: msg.sessionId,
        role: 'follower',
        hostPeerId: msg.hostPeerId,
        mediaName: msg.mediaName,
        mediaDuration: msg.mediaDuration,
        lastTimelineAt: this.localMono(),
      };
      this.emitState();
      this.startStaleWatchdog();
    }
    // Wrong session (stragglers from before).
    if (msg.sessionId !== this.state.sessionId) return;
    // We are the host receiving our own echo somehow; ignore.
    if (this.state.role === 'host') return;
    // LWW with seq + peerId tiebreak.
    if (this.lastTimeline) {
      if (msg.seq < this.lastTimeline.seq) return;
      if (msg.seq === this.lastTimeline.seq && msg.hostPeerId > this.lastTimeline.hostPeerId) return;
    }
    this.lastTimeline = msg;
    // Update offset estimate.
    this.recordOffsetSample(peerId, msg.hostMono);
    // Refresh metadata if the host learned the duration.
    if (msg.mediaDuration && msg.mediaDuration !== this.state.mediaDuration) {
      this.state = { ...this.state, mediaDuration: msg.mediaDuration };
    }
    if (msg.hostPeerId !== this.state.hostPeerId) {
      // Host changed; remember the new one.
      this.state = { ...this.state, hostPeerId: msg.hostPeerId };
    }
    this.state = {
      ...this.state,
      lastTimelineAt: this.localMono(),
      error: null, // any live heartbeat clears 'lost sync' errors
    };
    this.emitState();
  }

  private handlePeerState(
    peerId: string,
    msg: Extract<DataChannelMessage, { type: 'wp-peer-state' }>,
  ): void {
    if (msg.sessionId !== this.state.sessionId) return;
    this.peers.set(peerId, {
      peerId,
      state: msg.state,
      mediaTime: msg.mediaTime,
    });
    this.emitPeers();
  }

  private handleEnd(
    peerId: string,
    msg: Extract<DataChannelMessage, { type: 'wp-end' }>,
  ): void {
    if (msg.sessionId !== this.state.sessionId) return;
    if (this.state.hostPeerId !== peerId) return; // only the host can end
    this.surfaceError('Host ended the watch party.');
    this.leave();
  }

  // v1 placeholders for the host-takeover flow. Wired into the UI in
  // a follow-up; the protocol shape is finalized here so we don't have
  // to migrate later.
  private handleHostRequest(_peerId: string, _msg: Extract<DataChannelMessage, { type: 'wp-host-request' }>): void {
    // Future: surface a prompt to the current host with [Grant]/[Deny].
  }
  private handleHostGrant(_peerId: string, _msg: Extract<DataChannelMessage, { type: 'wp-host-grant' }>): void {
    // Future: if msg.newHostPeerId === me, role = host; else update hostPeerId.
  }

  // -------- Internal: clock-offset estimation --------

  private async recordOffsetSample(peerId: string, hostMono: number): Promise<void> {
    // hostMono is the host's AudioContext.currentTime at send. The
    // wire delay is approximately RTT/2 (Cristian's assumption: even
    // split). Combined estimate of host's clock at this instant:
    //   estimatedHostNow = hostMono + RTT/2
    // Offset (host time minus local time at receive):
    //   offset = estimatedHostNow - localMono()
    const localNow = this.localMono();
    const rtt = await multiPeerWebRTCService.getCurrentRoundTripTime(peerId);
    // Fall back to 0.1 s (typical public-internet RTT) if WebRTC stats
    // didn't yield a sample. Better than throwing the sample away;
    // the median across many samples will smooth this.
    const oneWay = (rtt ?? 0.1) / 2;
    const sample = (hostMono + oneWay) - localNow;

    let arr = this.offsetSamplesByPeer.get(peerId);
    if (!arr) {
      arr = [];
      this.offsetSamplesByPeer.set(peerId, arr);
    }
    arr.push(sample);
    if (arr.length > OFFSET_WINDOW) arr.shift();

    // Median of the rolling window. Sort a copy; arrays are tiny.
    const sorted = [...arr].sort((a, b) => a - b);
    this.hostClockOffset = sorted[Math.floor(sorted.length / 2)];
  }

  // -------- Internal: drift loop (followers only) --------

  private startDriftLoop(el: HTMLVideoElement): () => void {
    let cancelled = false;
    let lastReportedMediaTime = -1;
    let lastReportSentAt = 0;
    // rVFC support detection. Safari 16.4+, Chrome 83+, Firefox 132+.
    type FrameMeta = { mediaTime: number };
    type RVFCEl = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (_now: number, m: FrameMeta) => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    const rvfcEl = el as RVFCEl;
    const hasRVFC = typeof rvfcEl.requestVideoFrameCallback === 'function';

    const tickShared = (frameMediaTime: number) => {
      if (cancelled) return;
      const tl = this.lastTimeline;
      if (!tl) return;

      // Convert host's anchorMono to local mono using the offset.
      // anchorMono is host AudioContext.currentTime when timeline was
      // emitted; offset = hostTime - localTime, so:
      //   anchorMonoInLocal = anchorMono - offset
      const anchorMonoLocal = tl.anchorMono - this.hostClockOffset;
      const localNow = this.localMono();
      const elapsed = tl.playing ? Math.max(0, localNow - anchorMonoLocal) : 0;
      const expected = tl.anchorTime + elapsed * tl.playbackRate;

      const drift = frameMediaTime - expected;

      if (Math.abs(drift) >= HARD_DRIFT_S) {
        // Hard seek. Only do it when we are within seekable range; if
        // the user is buffering, the seek will fail loudly and we let
        // the next iteration retry.
        try {
          el.currentTime = Math.max(0, expected);
        } catch {
          // ignore
        }
        if (el.playbackRate !== tl.playbackRate) el.playbackRate = tl.playbackRate;
      } else if (Math.abs(drift) >= SOFT_DRIFT_S) {
        // Rate nudge. Sign(drift) > 0 means we are ahead -> slow down.
        const target = tl.playbackRate * (1 - RATE_NUDGE * Math.sign(drift));
        if (Math.abs(el.playbackRate - target) > 0.001) el.playbackRate = target;
      } else if (el.playbackRate !== tl.playbackRate) {
        el.playbackRate = tl.playbackRate;
      }

      // Honor playing state from host. If host says play and we're
      // paused, attempt play(); a rejection (autoplay) is surfaced as
      // an error so the UI can show a click-to-play overlay.
      if (tl.playing && el.paused && el.readyState >= 2) {
        el.play().catch(() => {
          this.surfaceError('Click the video to enable playback (browser autoplay policy).');
        });
      } else if (!tl.playing && !el.paused) {
        el.pause();
      }

      // Emit our peer-state every ~1 s so the host can render seekbar
      // dots without a flood of messages.
      if (localNow - lastReportSentAt > 1.0
          && Math.abs(frameMediaTime - lastReportedMediaTime) > 0.5) {
        lastReportedMediaTime = frameMediaTime;
        lastReportSentAt = localNow;
        this.broadcastPeerState();
      }
    };

    if (hasRVFC && rvfcEl.requestVideoFrameCallback) {
      const tick = (_now: number, meta: FrameMeta) => {
        tickShared(meta.mediaTime);
        if (!cancelled) rvfcEl.requestVideoFrameCallback!(tick);
      };
      rvfcEl.requestVideoFrameCallback(tick);
    } else {
      const tick = () => {
        tickShared(el.currentTime);
        if (!cancelled) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    this.driftLoopCancel = () => { cancelled = true; };
    return this.driftLoopCancel;
  }

  // -------- Helpers --------

  private surfaceError(msg: string): void {
    this.state = { ...this.state, error: msg };
    this.emitState();
    this.events.onError?.(new Error(msg));
  }

  private getMyPeerId(): string {
    // Must match the peerId emitted by MultiPeerWebRTCService's
    // onDataChannelMessage callback, which is the signaling
    // connection id (NOT the user-visible friendly name). Fallback
    // 'self' is only used in the degenerate single-peer test case
    // where signaling has not yet assigned an id.
    return signalingService.getLocalConnectionId() ?? 'self';
  }

  private emitState(): void { this.events.onStateChange?.(this.state); }
  private emitPeers(): void { this.events.onPeersChange?.(this.peers); }

  /**
   * Tear down on session leave. Idempotent.
   */
  reset(): void {
    this.leave();
  }
}

export const watchPartyService = new WatchPartyService();
