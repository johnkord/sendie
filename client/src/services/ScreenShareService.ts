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

// Encoder-fanout cap. The sharer encodes the screen track once per peer
// connection (one RTCRtpSender per peer in a mesh, no SFU). Above this
// many receivers we refuse to start rather than thermally throttle the
// sender. v2 in the proposal switches to encoded-fanout so this cap can
// rise dramatically.
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
      // Audio for an already-claimed screen stream: notify subscribers so
      // the UI can re-detect audio presence and unhide the mute toggle.
      // The audio track itself attaches to the same MediaStream natively
      // (the browser merges by stream id), so the existing <video> just
      // starts playing it.
      if (kind === 'audio') {
        if (this.remoteStreamsByPeer.get(peerId) === stream) {
          for (const cb of this.streamSubscribers) cb(peerId);
        }
        return;
      }
      if (kind !== 'video') return;
      const peer = useAppStore.getState().peers.get(peerId);
      const announcedScreen = peer?.screenState?.streamId;
      if (announcedScreen && stream.id === announcedScreen) {
        this.remoteStreamsByPeer.set(peerId, stream);
        for (const cb of this.streamSubscribers) cb(peerId);
        return;
      }
      // Unknown stream: buffer briefly. Either a screen-state will land
      // and claim it, or a screen-state will land in ScreenShareService
      // and the buffer will time out harmlessly.
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
    // Re-announce our share to a peer as soon as their data channel
    // opens. Without this, a late joiner mid-share sees our ontrack but
    // never gets a screen-state message naming the streamId, so the
    // pending buffer would time out and the joiner would see nothing.
    multiPeerWebRTCService.on('onDataChannelOpen', (peerId) => {
      if (!this.active) return;
      const msg: DataChannelMessage = {
        type: 'screen-state',
        sharing: true,
        streamId: this.localStream?.id,
      };
      multiPeerWebRTCService.sendTo(peerId, JSON.stringify(msg));
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

  /**
   * Whether the browser will actually offer to capture audio along with
   * the screen. Chrome and Edge on desktop do; Firefox and Safari do not.
   * On Linux/macOS Chromium, only tab audio is available; on Windows and
   * ChromeOS, system-audio is also available. We use the systemAudio
   * constraint as a proxy for "this browser knows about screen-share
   * audio at all". Caller uses this to show or hide the audio toggle.
   */
  isAudioSupported(): boolean {
    if (typeof navigator === 'undefined') return false;
    const supported = navigator.mediaDevices?.getSupportedConstraints?.() ?? {};
    // systemAudio appears in supported constraints on Chromium-family
    // browsers; absent on Firefox and Safari.
    return Boolean((supported as Record<string, unknown>).systemAudio);
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(peerId: string): MediaStream | null {
    return this.remoteStreamsByPeer.get(peerId) ?? null;
  }

  /**
   * Number of OTHER peers currently sharing screen, observed from peer
   * state. Useful for the UI badge "someone else is sharing".
   */
  countOthersSharing(): number {
    let n = 0;
    const peers = useAppStore.getState().peers;
    for (const p of peers.values()) {
      if (p.screenState?.sharing) n++;
    }
    return n;
  }

  /**
   * Number of peers we would have to encode for if we started right now.
   * Drives the MAX_SCREEN_PEERS receiver-fanout cap.
   */
  private countReceivers(): number {
    return useAppStore.getState().peers.size;
  }

  /**
   * Prompt for screen capture and start sharing with every connected peer.
   * Refuses when at MAX_SCREEN_PEERS.
   *
   * @param withAudio  If true and supported, ask the browser to also
   *                   include audio (tab audio or system audio depending
   *                   on user choice in the picker). Chrome/Edge desktop
   *                   only; ignored elsewhere. The user still has the
   *                   final say via a checkbox in the picker.
   */
  async start(opts: { withAudio?: boolean } = {}): Promise<void> {
    if (this.active) return;
    if (!this.isSupported()) {
      const err = new Error('Screen sharing is not supported on this browser. Use a desktop browser.');
      this.events.onError?.(err);
      throw err;
    }
    if (this.countReceivers() > MAX_SCREEN_PEERS) {
      const err = new Error(
        `Too many peers to share to (${this.countReceivers()}); the encoder cap is ${MAX_SCREEN_PEERS}. ` +
        `Ask some peers to leave first, or use a smaller mesh.`,
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
      const wantAudio = !!opts.withAudio && this.isAudioSupported();
      const constraints = {
        video: {
          frameRate: { ideal: 30, max: 60 },
        },
        // audio:true asks the browser to *offer* tab/system audio; the
        // user still picks via the picker checkbox. If false, the
        // checkbox is suppressed entirely.
        audio: wantAudio,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        monitorTypeSurfaces: 'include',
        // include = offer to capture system audio when sharing entire
        // screen (user still has to opt in via the picker checkbox).
        // exclude = never offer it, even when the underlying browser
        // would. We set 'include' when the user asked for audio so the
        // picker on Windows/ChromeOS can offer system audio.
        systemAudio: wantAudio ? 'include' : 'exclude',
      } as DisplayMediaStreamOptions;
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      const [videoTrack] = stream.getVideoTracks();
      if (!videoTrack) {
        // Stop any other tracks we might have got back; should not
        // happen in practice but defensive.
        for (const t of stream.getTracks()) t.stop();
        throw new Error('Screen capture returned no video track');
      }
      // Pathological race: if the user dismissed the picker right after
      // accepting it, the returned track can already be in "ended" state
      // by the time our await unblocks. Clean up and bail rather than
      // pushing a dead track onto every peer connection.
      if (videoTrack.readyState === 'ended') {
        for (const t of stream.getTracks()) t.stop();
        this.events.onError?.(new Error('Screen share cancelled'));
        return;
      }
      this.localStream = stream;
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
      // If the user opted into capturing audio in the picker, send that
      // track too. We attach it to the same MediaStream so the receiver's
      // <video srcObject={stream}> element plays the audio automatically;
      // no separate <audio> element required.
      for (const audioTrack of stream.getAudioTracks()) {
        // Tab/system audio is high-fidelity content; turn off the
        // voice-tuned processing the WebRTC stack would otherwise apply.
        try {
          await audioTrack.applyConstraints({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          });
        } catch {
          // Browsers vary on which constraints they accept on a
          // display-media audio track; non-fatal.
        }
        // Tear down the audio track too if the user clicks the browser
        // "Stop sharing" banner (which fires 'ended' on the video track
        // first; we propagate to audio in the trackEndedHandler).
        multiPeerWebRTCService.addLocalTrack(audioTrack, stream);
      }
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
