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
   * List available video input devices. Returns labels only when the
   * user has previously granted camera permission (browser privacy);
   * otherwise labels are empty strings and we have to display the
   * deviceId instead. Useful for surfacing OBS Virtual Camera, DroidCam,
   * external webcams, etc. as selectable options.
   *
   * Detection of OBS specifically: label contains 'OBS' (Windows /
   * macOS / Linux all use that prefix). The caller can highlight it.
   */
  async listDevices(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined'
        || typeof navigator.mediaDevices?.enumerateDevices !== 'function') {
      return [];
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  /**
   * Subscribe to device-list changes (camera plugged in or removed,
   * OBS Virtual Camera started or stopped). Returns an unsubscribe.
   */
  onDevicesChanged(cb: () => void): () => void {
    if (typeof navigator === 'undefined'
        || typeof navigator.mediaDevices?.addEventListener !== 'function') {
      return () => {};
    }
    navigator.mediaDevices.addEventListener('devicechange', cb);
    return () => navigator.mediaDevices.removeEventListener('devicechange', cb);
  }

  /**
   * Request camera permission and start sharing video with every connected
   * peer. Refuses if the room is already at MAX_VIDEO_PEERS.
   *
   * @param opts.deviceId  Optional device ID from listDevices(). If
   *                       omitted, the browser picks the default device,
   *                       which is usually the built-in webcam (NOT the
   *                       OBS Virtual Camera). Pass an explicit ID to
   *                       force OBS or another device.
   */
  async start(opts: { deviceId?: string } = {}): Promise<void> {
    if (this.active) return;
    if (this.countSharing() >= MAX_VIDEO_PEERS) {
      const err = new Error(
        `Too many video streams already (${MAX_VIDEO_PEERS} max). Ask someone to turn theirs off.`,
      );
      this.events.onError?.(err);
      throw err;
    }
    try {
      // ideal vs exact: ideal is a non-binding preference (browser will
      // pick the closest available device if the named one is gone),
      // exact would throw OverconstrainedError. ideal is the right call:
      // if the user picks OBS and then closes OBS mid-call, we degrade
      // to a real camera rather than failing.
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      };
      if (opts.deviceId) videoConstraints.deviceId = { ideal: opts.deviceId };
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
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
   * Switch to a different camera device while sharing. Stops the current
   * track, opens a new stream from the requested device, and replaces
   * the track on every peer connection's RTCRtpSender via replaceTrack
   * if available, falling back to remove+add.
   *
   * On iOS this is also how we expose the front/back camera switcher:
   * the user picks a device id from the dropdown without having to stop
   * and restart the share.
   */
  async switchDevice(deviceId: string): Promise<void> {
    if (!this.active) {
      // Not sharing yet; just remember the choice for next start().
      // Caller stores the deviceId in localStorage already.
      return;
    }
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: deviceId ? { ideal: deviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) {
        for (const t of newStream.getTracks()) t.stop();
        throw new Error('Switch returned no video track');
      }

      // Stop the old tracks but keep the same MediaStream object so
      // self-preview and remote-stream id continuity hold; receivers
      // that match on streamId would otherwise lose us.
      const oldTracks = this.localStream?.getVideoTracks() ?? [];
      const oldStream = this.localStream;

      // Try to replaceTrack on every peer's sender for a seamless swap
      // (no SDP renegotiation, no track-id change at the receiver).
      const replaced = multiPeerWebRTCService.replaceLocalVideoTrack?.(newTrack);

      if (!replaced) {
        // Fallback path: remove old, add new. Triggers renegotiation.
        for (const t of oldTracks) {
          multiPeerWebRTCService.removeLocalTrack(t);
        }
        multiPeerWebRTCService.addLocalTrack(newTrack, oldStream ?? newStream);
      }

      // Splice tracks into the existing local MediaStream so the
      // <video srcObject> binding doesn't blink.
      if (oldStream) {
        for (const t of oldTracks) {
          oldStream.removeTrack(t);
          t.stop();
        }
        oldStream.addTrack(newTrack);
        // Discard the wrapper stream, we only wanted its track.
        for (const t of newStream.getTracks()) {
          if (t !== newTrack) t.stop();
        }
      } else {
        this.localStream = newStream;
      }
      // Stream id may have changed if we swapped streams; re-broadcast.
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
