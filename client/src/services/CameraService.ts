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
  private active = false;

  constructor() {
    multiPeerWebRTCService.on('onTrack', (peerId, stream, kind) => {
      if (kind !== 'video') return;
      this.remoteStreamsByPeer.set(peerId, stream);
      // The store doesn't hold the MediaStream directly (not serializable);
      // we just flip a flag so the UI re-renders to call getRemoteStream.
      useAppStore.getState().updatePeer(peerId, {
        voiceState: {
          ...(useAppStore.getState().peers.get(peerId)?.voiceState ?? { sharing: false, muted: false }),
        },
      });
    });
    multiPeerWebRTCService.on('onPeerDisconnected', (peerId) => {
      this.remoteStreamsByPeer.delete(peerId);
    });
    multiPeerWebRTCService.on('onDataChannelMessage', (peerId, data) => {
      if (typeof data !== 'string') return;
      try {
        const msg = JSON.parse(data) as DataChannelMessage;
        if (msg.type === 'camera-state') {
          useAppStore.getState().updatePeer(peerId, {
            cameraState: { sharing: msg.sharing },
          });
        }
      } catch {
        // not for us
      }
    });
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
    };
    multiPeerWebRTCService.broadcast(JSON.stringify(msg));
  }
}

export const cameraService = new CameraService();
