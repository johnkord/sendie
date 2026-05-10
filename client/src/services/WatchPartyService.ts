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
// 1 s heartbeat. Drift can accumulate up to one heartbeat before
// the next correction; 1 s is the largest interval that keeps the
// receiver feeling 'in sync' subjectively. Smaller intervals burn
// data-channel bandwidth without proportional benefit.
const TIMELINE_HEARTBEAT_MS = 1000;

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
// 0.5 s used to be 1.0 s. With the smoother corrected drift loop
// (no compounding rate nudge, seek cooldown, no correction during
// buffering) hard seeks no longer thrash, so we can use them more
// aggressively and keep receivers within half a second of host.
const HARD_DRIFT_S = 0.5;
// Maximum rate deviation from host_rate. We scale linearly with
// drift magnitude so a 100 ms drift gives ~1% nudge while a 400 ms
// drift gives the full 5%. Constant 5% on every drift size means
// small drifts feel laggy to recover; proportional feels natural.
const RATE_NUDGE_MAX = 0.05;

// Rolling-median window for clock offset samples. Larger windows reject
// outliers better but lag behind real clock changes; 9 is a good
// balance for 2 s heartbeats (about 18 s of history).
const OFFSET_WINDOW = 9;

// Stale-timeline timeout. If we haven't seen a heartbeat in this long
// while expecting one (host disconnected, partition), pause locally
// and surface a "host disconnected" status. 3x the heartbeat plus a
// fudge factor for jittery links.
const STALE_TIMELINE_MS = TIMELINE_HEARTBEAT_MS * 3 + 1000;

// Encoder-fanout cap for stream mode. The host runs one WebRTC encoder
// per peer; matches the screen-share cap so the same hardware ceiling
// applies. Above this we refuse to start in stream mode and suggest
// local-file mode instead.
const MAX_STREAM_PEERS = 4;

export type WatchPartyRole = 'host' | 'follower' | 'idle';
// 'local' = each peer plays their own local copy. 'forward' = host sends
// the file bytes to peers via the data channel; peers play from the
// resulting in-memory Blob URL with the timeline algorithm. 'stream'
// (legacy, kept for type-compat) = captureStream-based live re-encode;
// removed from the UI in v2 because it's brittle on Firefox / Safari
// (see docs section 2.6).
export type WatchPartyMode = 'local' | 'forward' | 'stream';

// --- Mode C (forward) tuning ---

// Chunk size for the in-watch-party file forward. 16 KB is well below
// the SCTP message ceiling on every browser (Firefox tops out around
// 256 KB; Chrome 64 KB for some configs). Keep small to minimize
// head-of-line blocking with chat / timeline messages on the same
// channel.
const FORWARD_CHUNK_SIZE = 16 * 1024;
// Pause sending when local SCTP buffered amount exceeds this many
// bytes; resume after the channel drains. We poll instead of using
// the bufferedamountlow event because the file-transfer service
// also subscribes to that event.
const FORWARD_HIGH_WATERMARK = 8 * 1024 * 1024;

export interface WatchPartyState {
  // Stable id assigned at session start by the host. Followers ignore
  // messages with a different sessionId (e.g. a previous, abandoned
  // session whose stragglers are still in the air).
  sessionId: string | null;
  role: WatchPartyRole;
  // Transport mode. 'local' = each peer plays from a local file and
  // we sync timestamps. 'stream' = host streams rendered A/V to
  // followers via WebRTC tracks (no clock sync needed).
  mode: WatchPartyMode;
  hostPeerId: string | null;
  // Display-only metadata advertised by the host.
  mediaName: string | null;
  mediaDuration: number;
  // The user's locally-loaded file (host or follower in local mode).
  // null in stream mode for followers.
  localFile: File | null;
  // Stream id the host advertised in stream mode. Followers use this
  // to match incoming WebRTC tracks to this watch-party.
  // Repurposed in Mode C: kept null. (Field retained to keep the
  // serialized state shape stable while the UI migrates.)
  streamId: string | null;
  // Mode C: per-peer file-forward progress (0..1). Host: progress to
  // each follower. Follower: their own receive progress (single value
  // keyed by hostPeerId in the same map). null = not transferring.
  forwardProgress: Map<string, number>;
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
    mode: 'local',
    hostPeerId: null,
    mediaName: null,
    mediaDuration: 0,
    localFile: null,
    streamId: null,
    forwardProgress: new Map(),
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
  // Local-mono timestamp at which we last detected a host-initiated
  // state change (play/pause/seek/rate). The drift loop checks this
  // and clears its post-seek cooldown when a host action arrives,
  // so explicit user actions are never swallowed by the cooldown.
  private driftSeekCooldownClearedAt = 0;

  // -------- Stream mode (Mode B) state --------

  // Host: captureStream() output, retained so we can stop tracks on
  // leave. The source <video> itself is owned by the UI (we don't
  // need to remember it after wiring the stream).
  private streamCapture: MediaStream | null = null;
  // Host: object URL for the file. We own its lifecycle.
  private streamSourceObjectUrl: string | null = null;

  // Follower: incoming MediaStream from the host's RTC tracks. The UI
  // subscribes to changes and binds it to <video srcObject>.
  private remoteStream: MediaStream | null = null;
  private remoteStreamSubscribers: Set<() => void> = new Set();
  // Follower: pending tracks received before the wp-stream-start
  // announcement landed (similar to ScreenShareService's pending
  // buffer). Keyed by streamId. Swept on TTL or claim.
  private pendingRemoteStreams: Map<string, MediaStream> = new Map();

  // -------- Mode C (forward) state --------

  // Host: the file we are forwarding, kept until the session ends so
  // late joiners can request a re-send.
  private forwardSourceFile: File | null = null;
  // Host: per-peer chunks-acked counter.
  private forwardAckedByPeer: Map<string, number> = new Map();
  // Host: per-peer fan-out cancellers (so leave() can stop them).
  private forwardCancelByPeer: Map<string, () => void> = new Map();

  // Follower: incremental receive buffer. Cleared when the file is
  // assembled into a Blob.
  private receiveBuffers: Map<number, Uint8Array> = new Map();
  private receiveTotalChunks = 0;
  private receiveMimeType = 'video/mp4';
  private receiveFileName = '';
  // Follower: Blob URL for the assembled file. Revoked on leave.
  private receivedBlobUrl: string | null = null;
  // Follower: progress reported back to host every PROGRESS_ACK_EVERY chunks.
  private static readonly PROGRESS_ACK_EVERY = 32;

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
        if (this.state.mode === 'stream') {
          this.sendStreamStart(peerId);
        } else {
          this.sendTimeline(peerId);
        }
        // Mode C late-joiner: start a fresh forward to this peer.
        if (this.state.mode === 'forward' && this.forwardSourceFile) {
          void this.startForwardTo(peerId);
        }
      } else if (this.state.role !== 'idle' && this.state.sessionId) {
        this.broadcastPeerState();
      }
    });

    // Stream-mode: receive WebRTC media tracks from the host.
    // Pattern mirrors ScreenShareService: incoming track may arrive
    // before or after the wp-stream-start announcement.
    multiPeerWebRTCService.on('onTrack', (peerId, stream, _kind) => {
      if (this.state.role === 'follower' && this.state.mode === 'stream'
          && this.state.hostPeerId === peerId) {
        // We are expecting this. Claim if it matches the announced
        // streamId, or buffer briefly.
        if (this.state.streamId && stream.id === this.state.streamId) {
          this.remoteStream = stream;
          this.notifyRemoteStream();
          return;
        }
      }
      // Buffer for a few seconds in case the announcement is in
      // flight. Sweep TTL so non-watch-party tracks (camera, screen)
      // don't pile up here.
      this.pendingRemoteStreams.set(stream.id, stream);
      setTimeout(() => this.pendingRemoteStreams.delete(stream.id), 5000);
    });
  }

  /**
   * Subscribe to remote-stream changes (stream-mode followers). The UI
   * calls this and binds the stream to a <video srcObject> when the
   * callback fires.
   */
  onRemoteStreamChanged(cb: () => void): () => void {
    this.remoteStreamSubscribers.add(cb);
    return () => { this.remoteStreamSubscribers.delete(cb); };
  }

  getRemoteStream(): MediaStream | null { return this.remoteStream; }

  /** Number of MediaStreamTracks currently produced by captureStream() on the host. 0 = not streaming. */
  getStreamTrackCount(): number {
    return this.streamCapture?.getTracks().filter((t) => t.readyState === 'live').length ?? 0;
  }

  private notifyRemoteStream(): void {
    for (const cb of this.remoteStreamSubscribers) cb();
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
   *
   * @param mode  'local' (default) = each peer plays from a local copy
   *              of the file; we sync timestamps. 'stream' = host
   *              streams rendered A/V via WebRTC tracks; followers
   *              receive without needing a local copy.
   */
  async startAsHost(file: File, mode: WatchPartyMode = 'local'): Promise<void> {
    if (this.state.role !== 'idle') {
      throw new Error('Already in a watch party. Leave first.');
    }
    if (mode === 'stream') {
      const peerCount = this.connectedPeerCount();
      if (peerCount > MAX_STREAM_PEERS) {
        throw new Error(
          `Stream mode supports up to ${MAX_STREAM_PEERS} peers (you have ${peerCount}). ` +
          `Use local-file mode for larger rooms.`,
        );
      }
    }
    const sessionId = cryptoService.generateFileId();
    const myPeerId = this.getMyPeerId();
    this.state = {
      sessionId,
      role: 'host',
      mode,
      hostPeerId: myPeerId,
      mediaName: file.name,
      mediaDuration: 0, // populated when the video metadata loads
      localFile: file,
      streamId: null,
      forwardProgress: new Map(),
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
    if (mode === 'local') {
      // Send initial timeline so followers know what's happening.
      this.broadcastTimeline();
      this.startHeartbeat();
    } else if (mode === 'forward') {
      // Mode C: kick off a file forward to every currently-connected
      // peer. The timeline heartbeat ALSO starts so followers can
      // sync once they have the file. Late joiners will be picked up
      // in onDataChannelOpen.
      this.forwardSourceFile = file;
      this.startHeartbeat();
      for (const peerId of multiPeerWebRTCService.getOpenChannels()) {
        if (peerId === myPeerId) continue;
        void this.startForwardTo(peerId);
      }
    }
    // For stream mode: the UI must call attachStreamSourceElement() with
    // the host's <video>. captureStream and the wp-stream-start
    // announcement happen there, once we have an element to capture
    // from.
  }

  /**
   * Stream-mode: bind the host's <video> element. We call captureStream()
   * on it and pipe every track into the existing WebRTC fanout, then
   * announce wp-stream-start so followers can match the incoming tracks.
   * Returns an unbind function the UI MUST call on unmount.
   */
  attachStreamSourceElement(el: HTMLVideoElement): () => void {
    if (this.state.role !== 'host' || this.state.mode !== 'stream') {
      return () => {};
    }
    type CaptureEl = HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    const cEl = el as CaptureEl;
    const capture = cEl.captureStream?.bind(cEl) ?? cEl.mozCaptureStream?.bind(cEl);
    if (!capture) {
      this.surfaceError('Streaming not supported in this browser; switch to local-file mode.');
      return () => {};
    }
    // Mute the local element BEFORE capturing so we hit the
    // muted-autoplay path unconditionally. Per spec captureStream()
    // taps audio upstream of the mute stage, so peers still hear it.
    el.muted = true;
    // captureStream returns a live stream that gets tracks added as the
    // element starts playing. We add them to the mesh as they appear.
    // Critically: on Chromium captureStream returns an empty MediaStream
    // until the element actually starts playing, so we MUST kick off
    // playback or followers will see 'connecting...' forever.
    const stream = capture();
    this.streamCapture = stream;
    this.state = { ...this.state, streamId: stream.id };
    const wired = new Set<string>();
    const wireTrack = (track: MediaStreamTrack) => {
      if (wired.has(track.id)) return;
      wired.add(track.id);
      multiPeerWebRTCService.addLocalTrack(track, stream);
      // Re-announce so followers who joined before tracks materialized
      // can claim the now-flowing tracks; the streamId hasn't changed
      // but a fresh announcement helps the pending-buffer flow.
      this.broadcastStreamStart();
    };
    for (const t of stream.getTracks()) wireTrack(t);
    stream.addEventListener('addtrack', (ev) => wireTrack(ev.track));
    // Set duration when the element knows it, and start playback. The
    // file-pick click counts as a user gesture so autoplay-with-sound
    // is granted; if it isn't (e.g. iOS Safari quirks) we surface a
    // 'click to start' error and the user can hit the native play
    // button.
    const onLoadedMeta = () => {
      this.state = { ...this.state, mediaDuration: el.duration || 0 };
      this.emitState();
      this.broadcastStreamStart();
      // Force-mute before play(): unmuted autoplay is blocked on sites
      // without Media Engagement, which we cannot assume. Muted
      // autoplay always works. Per spec, captureStream() taps audio
      // upstream of the element's mute stage so peers still hear it.
      // The UI surfaces this and lets the host unmute for themselves.
      el.muted = true;
      el.play().then(() => {
        console.log('[watch-party] host play() ok; tracks=', this.streamCapture?.getTracks().length);
      }).catch((err) => {
        console.warn('[watch-party] host play() rejected even when muted:', err);
        this.surfaceError('Click the play button on your video to start streaming.');
      });
    };
    el.addEventListener('loadedmetadata', onLoadedMeta);
    // The video may already have loaded metadata by the time we attach
    // (loadedmetadata is one-shot and fires before this listener). Kick
    // playback in that case too.
    if (el.readyState >= 1 /* HAVE_METADATA */) {
      onLoadedMeta();
    }
    this.emitState();
    // Announce now so followers who already have a data channel can
    // match incoming tracks immediately. We may re-announce once
    // duration is known and once tracks land.
    this.broadcastStreamStart();
    return () => {
      el.removeEventListener('loadedmetadata', onLoadedMeta);
      // We do NOT stop the tracks here; leave() handles teardown so
      // the host can unmount/remount the element (e.g. fullscreen
      // toggle) without breaking the stream. If the user really wants
      // to end, they call leave().
    };
  }

  private broadcastStreamStart(): void {
    if (this.state.role !== 'host' || this.state.mode !== 'stream') return;
    if (!this.state.sessionId || !this.state.streamId) return;
    const msg: DataChannelMessage = {
      type: 'wp-stream-start',
      sessionId: this.state.sessionId,
      hostPeerId: this.state.hostPeerId ?? this.getMyPeerId(),
      streamId: this.state.streamId,
      mediaName: this.state.mediaName ?? '',
      mediaDuration: this.state.mediaDuration,
    };
    multiPeerWebRTCService.broadcast(JSON.stringify(msg));
  }

  private sendStreamStart(peerId: string): void {
    if (this.state.role !== 'host' || this.state.mode !== 'stream') return;
    if (!this.state.sessionId || !this.state.streamId) return;
    const msg: DataChannelMessage = {
      type: 'wp-stream-start',
      sessionId: this.state.sessionId,
      hostPeerId: this.state.hostPeerId ?? this.getMyPeerId(),
      streamId: this.state.streamId,
      mediaName: this.state.mediaName ?? '',
      mediaDuration: this.state.mediaDuration,
    };
    multiPeerWebRTCService.sendTo(peerId, JSON.stringify(msg));
  }

  private connectedPeerCount(): number {
    return multiPeerWebRTCService.getConnectedPeers().length;
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
    // Tear down stream-mode tracks if any.
    if (this.streamCapture) {
      for (const track of this.streamCapture.getTracks()) {
        try { multiPeerWebRTCService.removeLocalTrack(track); } catch { /* ignore */ }
        try { track.stop(); } catch { /* ignore */ }
      }
      this.streamCapture = null;
    }
    if (this.streamSourceObjectUrl) {
      URL.revokeObjectURL(this.streamSourceObjectUrl);
      this.streamSourceObjectUrl = null;
    }
    // Mode C teardown.
    for (const cancel of this.forwardCancelByPeer.values()) cancel();
    this.forwardCancelByPeer.clear();
    this.forwardAckedByPeer.clear();
    this.forwardSourceFile = null;
    this.receiveBuffers.clear();
    this.receiveTotalChunks = 0;
    if (this.receivedBlobUrl) {
      URL.revokeObjectURL(this.receivedBlobUrl);
      this.receivedBlobUrl = null;
    }
    this.stopHeartbeat();
    this.stopStaleWatchdog();
    if (this.driftLoopCancel) { this.driftLoopCancel(); this.driftLoopCancel = null; }
    this.state = {
      sessionId: null,
      role: 'idle',
      mode: 'local',
      hostPeerId: null,
      mediaName: null,
      mediaDuration: 0,
      localFile: null,
      streamId: null,
      forwardProgress: new Map(),
      lastTimelineAt: 0,
      error: null,
    };
    this.peers.clear();
    this.offsetSamplesByPeer.clear();
    this.lastTimeline = null;
    this.hostClockOffset = 0;
    this.videoEl = null;
    this.remoteStream = null;
    this.notifyRemoteStream();
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
      // Both 'seeking' (start of scrub) and 'seeked' (final position
      // after scrub completes) get broadcast. Without 'seeking',
      // followers only catch up after the host releases the scrubber,
      // which feels laggy on long drags. Both events are cheap.
      const onSeeking = () => this.broadcastTimeline();
      const onSeeked = () => this.broadcastTimeline();
      // Forward playback rate changes too (native browser controls
      // expose 0.5x/1x/1.5x/2x menus).
      const onRateChange = () => this.broadcastTimeline({ playbackRate: el.playbackRate });
      const onLoadedMeta = () => this.setMediaDuration(el.duration || 0);
      el.addEventListener('play', onPlay);
      el.addEventListener('pause', onPause);
      el.addEventListener('seeking', onSeeking);
      el.addEventListener('seeked', onSeeked);
      el.addEventListener('ratechange', onRateChange);
      el.addEventListener('loadedmetadata', onLoadedMeta);
      return () => {
        el.removeEventListener('play', onPlay);
        el.removeEventListener('pause', onPause);
        el.removeEventListener('seeking', onSeeking);
        el.removeEventListener('seeked', onSeeked);
        el.removeEventListener('ratechange', onRateChange);
        el.removeEventListener('loadedmetadata', onLoadedMeta);
        this.videoEl = null;
      };
    }
    // Follower: start the drift loop. Use rVFC if available, rAF as
    // fallback (Safari < 16.4).
    const stop = this.startDriftLoop(el);
    // One-shot initial sync: when the receiver's video first has
    // enough data to play, hard-seek to the host's expected position
    // immediately. Without this, the receiver starts at t=0 while
    // the host is N seconds in (host plays during transfer time),
    // and the drift loop has to wait for its hard threshold to fire.
    // Doing the sync once here, deterministically, makes startup
    // crisp.
    const initialSync = () => {
      const tl = this.lastTimeline;
      if (!tl || !tl.playing) return;
      const anchorMonoLocal = tl.anchorMono - this.hostClockOffset;
      const elapsed = Math.max(0, this.localMono() - anchorMonoLocal);
      const expected = tl.anchorTime + elapsed * tl.playbackRate;
      if (Math.abs(el.currentTime - expected) > 0.5) {
        try { el.currentTime = Math.max(0, expected); } catch { /* ignore */ }
      }
    };
    el.addEventListener('canplay', initialSync, { once: true });
    return () => {
      el.removeEventListener('canplay', initialSync);
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
    if (this.state.mode === 'stream') return; // stream mode has no timeline
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
      case 'wp-stream-start': return this.handleStreamStart(peerId, msg);
      case 'wp-file-start': return this.handleFileStart(peerId, msg);
      case 'wp-file-chunk-meta': return this.handleFileChunkMeta(peerId, msg);
      case 'wp-file-end': return this.handleFileEnd(peerId, msg);
      case 'wp-file-ack': return this.handleFileAck(peerId, msg);
      case 'wp-end': return this.handleEnd(peerId, msg);
      case 'wp-host-request': return this.handleHostRequest(peerId, msg);
      case 'wp-host-grant': return this.handleHostGrant(peerId, msg);
      default: return;
    }
  }

  private handleStreamStart(
    peerId: string,
    msg: Extract<DataChannelMessage, { type: 'wp-stream-start' }>,
  ): void {
    // Hosts receiving their own message via echo (shouldn't happen but
    // defensive): ignore.
    if (this.state.role === 'host') return;
    // Wrong session (stragglers from before).
    if (this.state.sessionId && msg.sessionId !== this.state.sessionId) return;
    // Discovery / refresh.
    this.state = {
      ...this.state,
      sessionId: msg.sessionId,
      role: 'follower',
      mode: 'stream',
      hostPeerId: msg.hostPeerId,
      mediaName: msg.mediaName,
      mediaDuration: msg.mediaDuration,
      streamId: msg.streamId,
      lastTimelineAt: this.localMono(),
      error: null,
    };
    // If we already received the matching track in the pending buffer,
    // promote it.
    const pending = this.pendingRemoteStreams.get(msg.streamId);
    if (pending) {
      this.remoteStream = pending;
      this.pendingRemoteStreams.delete(msg.streamId);
      this.notifyRemoteStream();
    }
    this.emitState();
    void peerId;
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
        mode: 'local',
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
    // Detect a host-initiated state change (play, pause, seek, rate
    // change). When this fires we want the drift loop to react
    // immediately, bypassing the post-seek cooldown that exists to
    // dampen the loop's own corrections. Without this, a host pause
    // or seek that lands during cooldown would be ignored for up to
    // 800 ms.
    const prev = this.lastTimeline;
    const hostChanged = !prev
      || prev.playing !== msg.playing
      || Math.abs(prev.anchorTime - msg.anchorTime) > 0.25
      || prev.playbackRate !== msg.playbackRate;
    this.lastTimeline = msg;
    if (hostChanged) this.driftSeekCooldownClearedAt = this.localMono();
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
    // Cooldown after a hard seek. Without this, the loop hard-seeks
    // every frame because buffering keeps mediaTime frozen while
    // 'expected' advances. 800 ms is enough for most decoders to
    // resume playback after a seek.
    let seekCooldownUntil = 0;
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

      // Skip correction entirely while we're not actually able to
      // play forward; readyState < HAVE_FUTURE_DATA (3) means decoder
      // is mid-buffering. Measuring drift here is meaningless and
      // applying corrections feeds the buffering loop.
      const canMeasure = el.readyState >= 3;
      // Clear the cooldown if a host-initiated state change arrived
      // since we set it. Explicit user actions should never be
      // swallowed by drift dampening.
      if (this.driftSeekCooldownClearedAt * 1000 > seekCooldownUntil - 800) {
        seekCooldownUntil = 0;
      }
      const inSeekCooldown = localNow * 1000 < seekCooldownUntil;

      if (canMeasure && !inSeekCooldown && Math.abs(drift) >= HARD_DRIFT_S) {
        // Hard seek. Pin a cooldown so we don't immediately re-seek
        // before the decoder can resume playback.
        try {
          el.currentTime = Math.max(0, expected);
          seekCooldownUntil = localNow * 1000 + 800;
        } catch {
          // ignore
        }
        // Reset to host rate; rate nudges from before the seek would
        // compound otherwise.
        if (el.playbackRate !== tl.playbackRate) el.playbackRate = tl.playbackRate;
      } else if (canMeasure && !inSeekCooldown && Math.abs(drift) >= SOFT_DRIFT_S) {
        // Rate nudge proportional to drift magnitude. A 100 ms drift
        // (right at the soft threshold) gets ~1% nudge; a 400 ms
        // drift hits the full 5% cap. Linear ramp between.
        // Critically: target is host_rate +/- delta, not
        // current_rate * (1 +/- delta), so we never compound across
        // 60 Hz frame ticks.
        const magnitude = Math.min(1, Math.abs(drift) / HARD_DRIFT_S);
        const delta = RATE_NUDGE_MAX * magnitude;
        const target = tl.playbackRate * (1 - delta * Math.sign(drift));
        if (Math.abs(el.playbackRate - target) > 0.005) el.playbackRate = target;
      } else if (canMeasure && Math.abs(el.playbackRate - tl.playbackRate) > 0.005) {
        // In sync; restore host rate exactly.
        el.playbackRate = tl.playbackRate;
      }

      // Honor playing state from host. If host says play and we're
      // paused, attempt play(). Try unmuted first (the user wanted
      // sound by default); if the browser denies autoplay-with-sound
      // (no Media Engagement Index), fall back to muted autoplay
      // which is universally allowed. The UI shows a 'tap to unmute'
      // pill so the user can grant audio with one click.
      if (tl.playing && el.paused && el.readyState >= 2) {
        el.play().catch(() => {
          if (!el.muted) {
            el.muted = true;
            el.play().catch(() => {
              this.surfaceError('Click the video to enable playback (browser autoplay policy).');
            });
          }
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

  // -------- Mode C: file-forward host side --------

  private async startForwardTo(peerId: string): Promise<void> {
    const file = this.forwardSourceFile;
    if (!file || this.state.role !== 'host') return;
    if (!multiPeerWebRTCService.isDataChannelOpen(peerId)) return;
    let cancelled = false;
    this.forwardCancelByPeer.set(peerId, () => { cancelled = true; });
    const totalChunks = Math.ceil(file.size / FORWARD_CHUNK_SIZE);
    const start: DataChannelMessage = {
      type: 'wp-file-start',
      sessionId: this.state.sessionId!,
      hostPeerId: this.state.hostPeerId!,
      mediaName: file.name,
      mediaSize: file.size,
      mediaType: file.type || 'video/mp4',
      totalChunks,
    };
    multiPeerWebRTCService.sendTo(peerId, JSON.stringify(start));
    this.forwardAckedByPeer.set(peerId, 0);
    this.state.forwardProgress.set(peerId, 0);
    this.emitState();
    for (let i = 0; i < totalChunks; i++) {
      if (cancelled) return;
      // Backpressure: wait until SCTP buffered bytes drop below the
      // low watermark. Conservative; we accept slower sends in
      // exchange for not exhausting browser-side buffers.
      while (
        !cancelled
        && multiPeerWebRTCService.getBufferedAmount(peerId) > FORWARD_HIGH_WATERMARK
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Also wait until receiver hasn't fallen too far behind on
      // ACKs. Lets us drop the chunked send if the receiver has
      // stalled.
      while (
        !cancelled
        && (this.forwardAckedByPeer.get(peerId) ?? 0) + 256 < i
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const slice = file.slice(i * FORWARD_CHUNK_SIZE, (i + 1) * FORWARD_CHUNK_SIZE);
      const buf = await slice.arrayBuffer();
      const b64 = bytesToBase64(new Uint8Array(buf));
      const msg: DataChannelMessage = {
        type: 'wp-file-chunk-meta',
        sessionId: this.state.sessionId!,
        chunkIndex: i,
        data: b64,
      };
      multiPeerWebRTCService.sendTo(peerId, JSON.stringify(msg));
      // Approximate progress (host's view) using i+1.
      this.state.forwardProgress.set(peerId, (i + 1) / totalChunks);
      // Throttle re-renders: emit state every 16 chunks.
      if (i % 16 === 0) this.emitState();
    }
    if (cancelled) return;
    const end: DataChannelMessage = {
      type: 'wp-file-end',
      sessionId: this.state.sessionId!,
    };
    multiPeerWebRTCService.sendTo(peerId, JSON.stringify(end));
    this.state.forwardProgress.set(peerId, 1);
    this.emitState();
    this.forwardCancelByPeer.delete(peerId);
  }

  // -------- Mode C: file-forward receiver side --------

  private handleFileStart(
    peerId: string,
    msg: Extract<DataChannelMessage, { type: 'wp-file-start' }>,
  ): void {
    if (this.state.role === 'host') return;
    if (this.state.sessionId && msg.sessionId !== this.state.sessionId) return;
    // Discovery: we weren't in a session and host just kicked off
    // forward.
    this.state = {
      ...this.state,
      sessionId: msg.sessionId,
      role: 'follower',
      mode: 'forward',
      hostPeerId: msg.hostPeerId,
      mediaName: msg.mediaName,
      mediaDuration: 0,
      lastTimelineAt: this.localMono(),
      error: null,
    };
    this.receiveBuffers = new Map();
    this.receiveTotalChunks = msg.totalChunks;
    this.receiveMimeType = msg.mediaType || 'video/mp4';
    this.receiveFileName = msg.mediaName;
    this.state.forwardProgress.set(this.state.hostPeerId ?? peerId, 0);
    this.emitState();
    this.startStaleWatchdog();
  }

  private handleFileChunkMeta(
    peerId: string,
    msg: Extract<DataChannelMessage, { type: 'wp-file-chunk-meta' }>,
  ): void {
    if (this.state.role !== 'follower' || this.state.mode !== 'forward') return;
    if (msg.sessionId !== this.state.sessionId) return;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(msg.data);
    } catch {
      return;
    }
    this.receiveBuffers.set(msg.chunkIndex, bytes);
    const received = this.receiveBuffers.size;
    const total = this.receiveTotalChunks || 1;
    this.state.forwardProgress.set(this.state.hostPeerId ?? peerId, received / total);
    if (received % WatchPartyService.PROGRESS_ACK_EVERY === 0 || received === total) {
      this.emitState();
      // ACK back to host so they can throttle.
      const ack: DataChannelMessage = {
        type: 'wp-file-ack',
        sessionId: this.state.sessionId!,
        chunkIndex: msg.chunkIndex,
      };
      multiPeerWebRTCService.sendTo(peerId, JSON.stringify(ack));
    }
  }

  private handleFileEnd(
    peerId: string,
    msg: Extract<DataChannelMessage, { type: 'wp-file-end' }>,
  ): void {
    void peerId;
    if (this.state.role !== 'follower' || this.state.mode !== 'forward') return;
    if (msg.sessionId !== this.state.sessionId) return;
    // Assemble all chunks into a single Blob in chunk-index order.
    const total = this.receiveTotalChunks;
    const parts: BlobPart[] = [];
    for (let i = 0; i < total; i++) {
      const part = this.receiveBuffers.get(i);
      if (!part) {
        this.surfaceError(`Missing chunk ${i} in transfer; cannot play.`);
        return;
      }
      parts.push(part);
    }
    const blob = new Blob(parts, { type: this.receiveMimeType });
    if (this.receivedBlobUrl) URL.revokeObjectURL(this.receivedBlobUrl);
    this.receivedBlobUrl = URL.createObjectURL(blob);
    // Synthesize a File so the existing local-mode UI can pick it up.
    const file = new File([blob], this.receiveFileName, { type: this.receiveMimeType });
    this.state = {
      ...this.state,
      localFile: file,
      // Once received, switch internally to 'local' mode for sync; the
      // timeline algorithm works the same.
      mode: 'local',
    };
    this.receiveBuffers.clear();
    this.emitState();
    this.broadcastPeerState();
  }

  private handleFileAck(
    peerId: string,
    msg: Extract<DataChannelMessage, { type: 'wp-file-ack' }>,
  ): void {
    if (this.state.role !== 'host') return;
    if (msg.sessionId !== this.state.sessionId) return;
    const prev = this.forwardAckedByPeer.get(peerId) ?? -1;
    if (msg.chunkIndex > prev) {
      this.forwardAckedByPeer.set(peerId, msg.chunkIndex);
    }
  }
}

// -------- Helpers --------

function bytesToBase64(bytes: Uint8Array): string {
  // Chunk the conversion so we don't blow the call-stack on big
  // arrays (String.fromCharCode.apply has an arg-count cap).
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const watchPartyService = new WatchPartyService();
