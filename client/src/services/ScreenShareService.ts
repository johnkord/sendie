import { multiPeerWebRTCService } from './MultiPeerWebRTCService';
import { useAppStore } from '../stores/appStore';
import type { DataChannelMessage } from '../types';

/**
 * Screen share service. Mirrors CameraService but uses getDisplayMedia()
 * and is tuned for screen content (text legibility over motion smoothness).
 *
 * v1 implementation, deliberately boring: one encoder per peer via
 * RTCPeerConnection.addTrack. See docs/screen-sharing-proposal.md for the
 * v2/v3 plan (encoded fanout via RTCRtpScriptTransform; WebCodecs +
 * data-channel screen pipe).
 *
 * Tuning highlights:
 *   - contentHint='text' tells the WebRTC stack to use a screen-content
 *     rate controller. Without this, every browser smears small text under
 *     temporal denoising tuned for camera feeds.
 *   - selfBrowserSurface='exclude' prevents the user from accidentally
 *     picking the Sendie tab itself (which would create an infinite
 *     hall-of-mirrors). Chrome-only; ignored harmlessly elsewhere.
 *   - surfaceSwitching='include' lets the sender hot-swap which tab is
 *     shared without re-prompting. Chrome-only.
 *   - We do NOT request audio from the share. Tab/system audio capture is
 *     Chrome-only and inconsistent; the existing voice path covers mic.
 *
 * Mesh fanout cap: MAX_SCREEN_PEERS limits concurrent shares to what a
 * modern laptop's encoder can sustain. Above this we refuse rather than
 * thermally throttle the sender.
 */

// Only one peer typically shares their screen at a time, but the protocol
// itself is symmetric and N-encoder fanout is what burns CPU. The cap is
// on the number of receivers; if more peers than this are in the room
// we refuse a fresh start.
export const MAX_SCREEN_PEERS = 4;

export type ScreenShareEvents = {
  onStarted: () => void;
  onStopped: () => void;
  onError: (err: Error) => void;
};

class ScreenShareService {
  private events: Partial<ScreenShareEvents> = {};
  private localStream: MediaStream | null = null;
  // Per-peer remote screen-share tracks. Tile rendering reads from here
  // via getRemoteStream(peerId).
  private remoteStreamsByPeer: Map<string, MediaStream> = new Map();
  // Subscribers notified when a remote stream is added or removed.
  // RemoteScreens uses this to bind <video>.srcObject independently of
  // React render timing.
  private streamSubscribers: Set<(peerId: string) => void> = new Set();
  private active = false;
  // Cleanup callback bound to the device-side track ending. The browser
  // ends the track when the user clicks the browser-supplied "Stop sharing"
  // banner, which we MUST observe and tear down state for.
  private trackEndedHandler: (() => void) | null = null;

  constructor() {
    // Buffer of incoming video streams whose owner hasn't yet announced
    // (via screen-state) which one is the screen share. The announcement
    // can arrive AFTER ontrack on a slow data channel, so without a
    // buffer we'd silently drop the screen track and the receiver would
    // see nothing. Keyed by peerId+streamId; we sweep entries whenever a
    // screen-state message lands or after ANNOUNCE_BUFFER_TTL_MS to
    // avoid retaining tracks that turned out to be cameras.
    const ANNOUNCE_BUFFER_TTL_MS = 5_000;
    const pendingByPeer: Map<string, Map<string, MediaStream>> = new Map();
    const sweepPending = (peerId: string, streamId: string) => {
      setTimeout(() => {
        pendingByPeer.get(peerId)?.delete(streamId);
      }, ANNOUNCE_BUFFER_TTL_MS);
    };

    multiPeerWebRTCService.on('onTrack', (peerId, stream, kind) => {
      if (kind !== 'video') return;
      const peer = useAppStore.getState().peers.get(peerId);
      const announcedScreen = peer?.screenState?.streamId;
      if (announcedScreen && stream.id === announcedScreen) {
        this.remoteStreamsByPeer.set(peerId, stream);
        for (const cb of this.streamSubscribers) cb(peerId);
        return;
      }
      // Not yet known whether this is camera or screen. Buffer briefly so
      // a late-arriving screen-state can still claim it. Camera tracks
      // also pass through here harmlessly; CameraService claims them on
      // its own onTrack handler in parallel.
      if (!pendingByPeer.has(peerId)) pendingByPeer.set(peerId, new Map());
      pendingByPeer.get(peerId)!.set(stream.id, stream);
      sweepPending(peerId, stream.id);
    });
    multiPeerWebRTCService.on('onPeerDisconnected', (peerId) => {
      pendingByPeer.delete(peerId);
      if (this.remoteStreamsByPeer.delete(peerId)) {
        for (const cb of this.streamSubscribers) cb(peerId);
      }
    });
    multiPeerWebRTCService.on('onDataChannelMessage', (peerId, data) => {
      if (typeof data !== 'string') return;
      try {
        const msg = JSON.parse(data) as DataChannelMessage;
        if (msg.type !== 'screen-state') return;
        useAppStore.getState().updatePeer(peerId, {
          screenState: { sharing: msg.sharing, streamId: msg.streamId },
        });
        if (msg.sharing && msg.streamId) {
          // Promote a buffered stream if the announcement names one we
          // already received but couldn't classify.
          const pending = pendingByPeer.get(peerId)?.get(msg.streamId);
          if (pending) {
            this.remoteStreamsByPeer.set(peerId, pending);
            pendingByPeer.get(peerId)!.delete(msg.streamId);
          }
          for (const cb of this.streamSubscribers) cb(peerId);
        }
        if (!msg.sharing) {
          if (this.remoteStreamsByPeer.delete(peerId)) {
            for (const cb of this.streamSubscribers) cb(peerId);
          }
        }
      } catch {
        // not for us
      }
    });
  }

  /**
   * Subscribe to remote-stream changes. Returns an unsubscribe function.
   */
  onRemoteStreamChanged(cb: (peerId: string) => void): () => void {
    this.streamSubscribers.add(cb);
    return () => {
      this.streamSubscribers.delete(cb);
    };
  }

  on<K extends keyof ScreenShareEvents>(event: K, handler: ScreenShareEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof ScreenShareEvents>(event: K): void {
    delete this.events[event];
  }

  isActive(): boolean {
    return this.active;
  }

  isSupported(): boolean {
    // getDisplayMedia is unavailable on iOS Safari and Android browsers.
    // Caller (UI) renders a disabled button with a tooltip when this
    // returns false rather than letting the user click and fail.
    return typeof navigator !== 'undefined'
      && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(peerId: string): MediaStream | null {
    return this.remoteStreamsByPeer.get(peerId) ?? null;
  }

  /**
   * Number of peers (including local if active) currently sharing screen.
   */
  countSharing(): number {
    let n = this.active ? 1 : 0;
    const peers = useAppStore.getState().peers;
    for (const p of peers.values()) {
      if (p.screenState?.sharing) n++;
    }
    return n;
  }

  /**
   * Prompt for screen capture and start sharing with every connected peer.
   * Refuses when at MAX_SCREEN_PEERS.
   */
  async start(): Promise<void> {
    if (this.active) return;
    if (!this.isSupported()) {
      const err = new Error('Screen sharing is not supported on this browser. Use a desktop browser.');
      this.events.onError?.(err);
      throw err;
    }
    if (this.countSharing() >= MAX_SCREEN_PEERS) {
      const err = new Error(
        `Too many screen shares already (${MAX_SCREEN_PEERS} max). Ask someone to stop sharing first.`,
      );
      this.events.onError?.(err);
      throw err;
    }
    try {
      // Cast: TypeScript's lib.dom.d.ts does not yet expose all the
      // DisplayMediaStreamOptions tuning knobs (selfBrowserSurface,
      // surfaceSwitching, monitorTypeSurfaces). Browsers that recognize
      // these accept them; browsers that don't (Firefox, Safari) ignore
      // unknown properties harmlessly per the Screen Capture spec.
      const constraints = {
        video: {
          frameRate: { ideal: 30, max: 60 },
        },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        monitorTypeSurfaces: 'include',
        systemAudio: 'exclude',
      } as DisplayMediaStreamOptions;
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      this.localStream = stream;
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) {
        throw new Error('Screen capture returned no video track');
      }
      // Tell the encoder this is screen content. Without this, browsers
      // apply temporal noise reduction tuned for camera feeds, which
      // smears text. Major impact, single line of code.
      videoTrack.contentHint = 'text';

      // The browser surfaces a "Stop sharing" banner that ends the track
      // when the user clicks it. Bind a one-shot handler so we tear down
      // peer-side state without waiting for a UI roundtrip.
      this.trackEndedHandler = () => {
        this.stop().catch(() => {});
      };
      videoTrack.addEventListener('ended', this.trackEndedHandler);

      multiPeerWebRTCService.addLocalTrack(videoTrack, stream);
      this.active = true;
      this.events.onStarted?.();
      this.broadcastState();
    } catch (err) {
      // The user cancelling the picker throws AbortError or NotAllowedError.
      // Treat both as a benign no-op rather than a blaring error toast.
      const e = err as DOMException;
      if (e?.name === 'AbortError' || e?.name === 'NotAllowedError') {
        // user-cancelled; surface as a soft error so the UI can clear loading state
        this.events.onError?.(new Error('Screen share cancelled'));
        return;
      }
      this.events.onError?.(err as Error);
      throw err;
    }
  }

  /**
   * Stop sharing the screen and release the capture.
   */
  async stop(): Promise<void> {
    if (!this.active) return;
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        if (this.trackEndedHandler) {
          track.removeEventListener('ended', this.trackEndedHandler);
        }
        multiPeerWebRTCService.removeLocalTrack(track);
      }
    }
    this.trackEndedHandler = null;
    this.localStream = null;
    this.active = false;
    this.events.onStopped?.();
    this.broadcastState();
  }

  /**
   * Tear everything down. Idempotent. Used on session leave.
   */
  reset(): void {
    void this.stop();
    this.remoteStreamsByPeer.clear();
  }

  private broadcastState(): void {
    const msg: DataChannelMessage = {
      type: 'screen-state',
      sharing: this.active,
      streamId: this.localStream?.id,
    };
    multiPeerWebRTCService.broadcast(JSON.stringify(msg));
  }
}

export const screenShareService = new ScreenShareService();
