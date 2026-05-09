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
    multiPeerWebRTCService.on('onTrack', (peerId, stream, kind) => {
      if (kind !== 'video') return;
      // Disambiguate camera vs screen-share streams (both arrive as
      // kind=video). Only claim the stream if the peer has announced this
      // streamId as their camera. If they have not announced anything yet,
      // tentatively accept (legacy behavior); the screen-state handler in
      // ScreenShareService will displace us if it turns out this stream is
      // their screen capture.
      const peer = useAppStore.getState().peers.get(peerId);
      const announcedCamera = peer?.cameraState?.streamId;
      const announcedScreen = peer?.screenState?.streamId;
      if (announcedScreen && stream.id === announcedScreen) return;
      if (announcedCamera && stream.id !== announcedCamera) return;
      this.remoteStreamsByPeer.set(peerId, stream);
      // Notify subscribers that a new stream is available for this peer.
      // RemoteVideos uses this to re-bind its <video> element rather than
      // relying on a re-render driven by cameraState (which can arrive on
      // the data channel before ontrack fires, leading to a stuck black tile).
      for (const cb of this.streamSubscribers) cb(peerId);
    });
    multiPeerWebRTCService.on('onPeerDisconnected', (peerId) => {
      this.remoteStreamsByPeer.delete(peerId);
      for (const cb of this.streamSubscribers) cb(peerId);
    });
    multiPeerWebRTCService.on('onDataChannelMessage', (peerId, data) => {
      if (typeof data !== 'string') return;
      try {
        const msg = JSON.parse(data) as DataChannelMessage;
        if (msg.type === 'camera-state') {
          useAppStore.getState().updatePeer(peerId, {
            cameraState: { sharing: msg.sharing, streamId: msg.streamId },
          });
        }
      } catch {
        // not for us
      }
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
