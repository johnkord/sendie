import { multiPeerWebRTCService } from './MultiPeerWebRTCService';
import { useAppStore } from '../stores/appStore';
import type { DataChannelMessage } from '../types';

/**
 * Camera (video) sharing service. Mirrors VoiceService for video tracks.
 *
 * Sharing video over a full mesh has a real CPU cost (every peer encodes
 * the local stream once per receiver). We cap the number of peers with
 * cameras on at MAX_VIDEO_PEERS; the page should refuse to enable video
 * when more peers are connected.
 *
 * Out of scope:
 *   - simulcast / scalable video coding (one stream per peer for now)
 *   - camera selection UI (default device only)
 *   - per-peer mute / pin
 *   - mobile Safari background-tab handling
 */

export const MAX_VIDEO_PEERS = 4;

export type CameraEvents = {
  onStarted: () => void;
  onStopped: () => void;
  onError: (err: Error) => void;
};

class CameraService {
  private events: Partial<CameraEvents> = {};
  private localStream: MediaStream | null = null;
  // Per-peer remote video tracks. The page renders these via <video>
  // elements bound through getRemoteStream(peerId).
  private remoteStreamsByPeer: Map<string, MediaStream> = new Map();
  // Subscribers notified when a remote stream is added or removed.
  // RemoteVideos uses this to bind <video>.srcObject independently of
  // React render timing.
  private streamSubscribers: Set<(peerId: string) => void> = new Set();
  private active = false;

  constructor() {
    // Buffer of incoming video streams whose owner has not yet announced
    // (via camera-state) which one is the camera. The announcement can
    // arrive AFTER ontrack on a slow data channel; without a buffer we
    // would either drop the camera or claim a screen-share track by
    // mistake. Symmetric to the same pattern in ScreenShareService.
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
      const announcedCamera = peer?.cameraState?.streamId;
      const announcedScreen = peer?.screenState?.streamId;
      // Disambiguate against an already-known screen stream.
      if (announcedScreen && stream.id === announcedScreen) return;
      if (announcedCamera && stream.id === announcedCamera) {
        this.remoteStreamsByPeer.set(peerId, stream);
        for (const cb of this.streamSubscribers) cb(peerId);
        return;
      }
      // Unknown stream: buffer briefly. Either a camera-state will land
      // and claim it, or a screen-state will land in ScreenShareService
      // and the buffer will time out harmlessly.
      if (!pendingByPeer.has(peerId)) pendingByPeer.set(peerId, new Map());
      pendingByPeer.get(peerId)!.set(stream.id, stream);
      sweepPending(peerId, stream.id);
    });
    multiPeerWebRTCService.on('onPeerDisconnected', (peerId) => {
      pendingByPeer.delete(peerId);
      this.remoteStreamsByPeer.delete(peerId);
      for (const cb of this.streamSubscribers) cb(peerId);
    });
    multiPeerWebRTCService.on('onDataChannelMessage', (peerId, data) => {
      if (typeof data !== 'string') return;
      try {
        const msg = JSON.parse(data) as DataChannelMessage;
        if (msg.type !== 'camera-state') return;
        useAppStore.getState().updatePeer(peerId, {
          cameraState: { sharing: msg.sharing, streamId: msg.streamId },
        });
        if (msg.sharing && msg.streamId) {
          // Promote a buffered stream that matches the announcement.
          const pending = pendingByPeer.get(peerId)?.get(msg.streamId);
          if (pending) {
            this.remoteStreamsByPeer.set(peerId, pending);
            pendingByPeer.get(peerId)!.delete(msg.streamId);
            for (const cb of this.streamSubscribers) cb(peerId);
          }
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
    // Re-announce our state to a peer as soon as their data channel
    // opens. Without this, a late joiner who arrives mid-share would
    // see our ontrack but never get a camera-state message identifying
    // which streamId is the camera, so the strict matching above would
    // drop the stream into the pending buffer and time out.
    multiPeerWebRTCService.on('onDataChannelOpen', (peerId) => {
      if (!this.active) return;
      const msg: DataChannelMessage = {
        type: 'camera-state',
        sharing: true,
        streamId: this.localStream?.id,
      };
      multiPeerWebRTCService.sendTo(peerId, JSON.stringify(msg));
    });
  }

  /**
   * Subscribe to remote-stream changes (added or removed). Fired with the
   * peer ID whenever a track arrives or that peer disconnects. Returns
   * an unsubscribe function.
   */
  onRemoteStreamChanged(cb: (peerId: string) => void): () => void {
    this.streamSubscribers.add(cb);
    return () => {
      this.streamSubscribers.delete(cb);
    };
  }

  on<K extends keyof CameraEvents>(event: K, handler: CameraEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof CameraEvents>(event: K): void {
    delete this.events[event];
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Local self-preview stream. Page binds to a <video muted autoplay>.
   */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /**
   * The MediaStream we received from a peer. Page binds to <video autoplay>.
   */
  getRemoteStream(peerId: string): MediaStream | null {
    return this.remoteStreamsByPeer.get(peerId) ?? null;
  }

  /**
   * Number of peers (including local if active) currently sharing video.
   * Used to decide whether starting / staying-on respects MAX_VIDEO_PEERS.
   */
  countSharing(): number {
    let n = this.active ? 1 : 0;
    const peers = useAppStore.getState().peers;
    for (const p of peers.values()) {
      if (p.cameraState?.sharing) n++;
    }
    return n;
  }

  /**
   * Request camera permission and start sharing video with every connected
   * peer. Refuses if the room is already at MAX_VIDEO_PEERS.
   */
  async start(): Promise<void> {
    if (this.active) return;
    if (this.countSharing() >= MAX_VIDEO_PEERS) {
      const err = new Error(
        `Too many video streams already (${MAX_VIDEO_PEERS} max). Ask someone to turn theirs off.`,
      );
      this.events.onError?.(err);
      throw err;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      this.localStream = stream;
      for (const track of stream.getVideoTracks()) {
        multiPeerWebRTCService.addLocalTrack(track, stream);
      }
      this.active = true;
      this.events.onStarted?.();
      this.broadcastState();
    } catch (err) {
      this.events.onError?.(err as Error);
      throw err;
    }
  }

  /**
   * Stop sharing video and release the camera.
   */
  async stop(): Promise<void> {
    if (!this.active) return;
    if (this.localStream) {
      for (const track of this.localStream.getVideoTracks()) {
        multiPeerWebRTCService.removeLocalTrack(track);
      }
    }
    this.localStream = null;
    this.active = false;
    this.events.onStopped?.();
    this.broadcastState();
  }

  /**
   * Tear everything down. Idempotent.
   */
  reset(): void {
    void this.stop();
    this.remoteStreamsByPeer.clear();
  }

  private broadcastState(): void {
    const msg: DataChannelMessage = {
      type: 'camera-state',
      sharing: this.active,
      streamId: this.localStream?.id,
    };
    multiPeerWebRTCService.broadcast(JSON.stringify(msg));
  }
}

export const cameraService = new CameraService();
