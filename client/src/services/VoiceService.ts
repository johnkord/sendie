import { multiPeerWebRTCService } from './MultiPeerWebRTCService';
import { useAppStore } from '../stores/appStore';
import type { DataChannelMessage } from '../types';

/**
 * Voice PoC: minimal service that wraps getUserMedia + the receiving
 * <audio> elements per peer.
 *
 * Out of scope for the PoC: video, screen share, codec config, RED, simulcast,
 * background-tab handling on iOS Safari, TURN. See docs/voice-poc-notes.md.
 *
 * What it does:
 *   - start() asks for mic permission, hands the stream to MultiPeerWebRTCService
 *     (which adds the audio track to every peer connection, triggering
 *     negotiationneeded).
 *   - stop() removes the local stream and stops the tracks.
 *   - Receives ontrack from MultiPeerWebRTCService; attaches each remote
 *     stream to a hidden <audio autoplay> element keyed by peer ID.
 *   - mute(true|false) flips track.enabled. Instant; no renegotiation.
 *   - getLocalLevel() returns 0..1 amplitude of the local mic for self-meter.
 */

export type VoiceEvents = {
  onStarted: () => void;
  onStopped: () => void;
  onPeerStreamAdded: (peerId: string) => void;
  onPeerStreamRemoved: (peerId: string) => void;
  // Fired when a remote peer's <audio> element fails to autoplay (no prior
  // user gesture on the receiving side). The page can show a banner asking
  // the user to click anywhere to enable audio.
  onAutoplayBlocked: (peerId: string) => void;
  onError: (err: Error) => void;
};

class VoiceService {
  private events: Partial<VoiceEvents> = {};
  private localStream: MediaStream | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localAudioCtx: AudioContext | null = null;
  // One <audio> element per peer. We keep them detached from the DOM (autoplay
  // honors the prior gesture from clicking "Start voice"); attaching to DOM
  // is not required for playback.
  private remoteAudioByPeer: Map<string, HTMLAudioElement> = new Map();
  private active = false;

  constructor() {
    // Subscribe once for the lifetime of the page.
    multiPeerWebRTCService.on('onTrack', (peerId, stream, kind) => {
      if (kind !== 'audio') return;
      this.attachRemoteAudio(peerId, stream);
    });
    multiPeerWebRTCService.on('onPeerDisconnected', (peerId) => {
      this.detachRemoteAudio(peerId);
    });
    // Listen for inbound voice-state messages so the local UI can show
    // 'sharing' / 'muted' indicators on remote tiles. The mute itself is
    // already reflected in the audio (track.enabled = false silences
    // outgoing); this is purely a UX hint.
    multiPeerWebRTCService.on('onDataChannelMessage', (peerId, data) => {
      if (typeof data !== 'string') return;
      try {
        const msg = JSON.parse(data) as DataChannelMessage;
        if (msg.type === 'voice-state') {
          useAppStore.getState().updatePeer(peerId, {
            voiceState: { sharing: msg.sharing, muted: msg.muted },
          });
        }
      } catch {
        // Not JSON we care about; ignore.
      }
    });
    // When voice ends with a peer, clear their voice state.
    multiPeerWebRTCService.on('onPeerDisconnected', (peerId) => {
      const peers = useAppStore.getState().peers;
      if (peers.has(peerId)) {
        useAppStore.getState().updatePeer(peerId, { voiceState: null });
      }
    });
  }

  on<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof VoiceEvents>(event: K): void {
    delete this.events[event];
  }

  isActive(): boolean {
    return this.active;
  }

  isMuted(): boolean {
    if (!this.localStream) return false;
    const t = this.localStream.getAudioTracks()[0];
    return !!t && !t.enabled;
  }

  /**
   * Request mic permission and start sharing audio with every connected peer.
   * Idempotent: calling twice is a no-op.
   */
  async start(): Promise<void> {
    if (this.active) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.localStream = stream;
      for (const track of stream.getAudioTracks()) {
        multiPeerWebRTCService.addLocalTrack(track, stream);
      }

      // Self-meter: AnalyserNode on the local stream.
      try {
        this.localAudioCtx = new AudioContext();
        const src = this.localAudioCtx.createMediaStreamSource(stream);
        const analyser = this.localAudioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        this.localAnalyser = analyser;
      } catch (err) {
        // self-meter is nice-to-have; failure must not break voice
        console.warn('Self-meter init failed:', err);
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
   * Stop sharing audio with peers and release the mic.
   */
  async stop(): Promise<void> {
    if (!this.active) return;
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        multiPeerWebRTCService.removeLocalTrack(track);
      }
    }
    this.localStream = null;
    if (this.localAudioCtx) {
      try {
        await this.localAudioCtx.close();
      } catch {
        // ignore
      }
      this.localAudioCtx = null;
    }
    this.localAnalyser = null;
    this.active = false;
    this.events.onStopped?.();
    this.broadcastState();
  }

  /**
   * Mute or unmute the outgoing audio. No renegotiation; flips track.enabled.
   */
  setMuted(muted: boolean): void {
    if (!this.localStream) return;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !muted;
    }
    this.broadcastState();
  }

  /**
   * Sample the local mic amplitude (0..1) for the self-meter UI.
   */
  getLocalLevel(): number {
    if (!this.localAnalyser) return 0;
    const buf = new Uint8Array(this.localAnalyser.fftSize);
    this.localAnalyser.getByteTimeDomainData(buf);
    // RMS, scaled
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    return Math.min(1, rms * 4);
  }

  /**
   * Get the live MediaStream for a peer (for VU meters, etc.).
   */
  getRemoteStream(peerId: string): MediaStream | null {
    return this.remoteAudioByPeer.get(peerId)?.srcObject as MediaStream | null;
  }

  /**
   * Tear everything down. Call on session leave: stops local mic, removes
   * every <audio> element. Idempotent.
   */
  reset(): void {
    void this.stop();
    for (const peerId of [...this.remoteAudioByPeer.keys()]) {
      this.detachRemoteAudio(peerId);
    }
  }

  /**
   * Broadcast our current voice state (sharing / muted) to every peer over
   * the data channel. Pure UX hint; mute is already enforced locally on
   * the outgoing track.
   */
  private broadcastState(): void {
    const msg: DataChannelMessage = {
      type: 'voice-state',
      sharing: this.active,
      muted: this.isMuted(),
    };
    multiPeerWebRTCService.broadcast(JSON.stringify(msg));
  }

  // ------ private --------------------------------------------------------

  private attachRemoteAudio(peerId: string, stream: MediaStream): void {
    let el = this.remoteAudioByPeer.get(peerId);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      // Detached <audio> elements still play in modern browsers; keeping them
      // out of the DOM avoids any stray UI flash. If the receiver hasn't yet
      // produced a user gesture (i.e. they joined and the host started
      // talking before they clicked anything), play() is rejected and the
      // browser will start playing once the next gesture happens. We surface
      // that state to the page so a banner can be shown.
      this.remoteAudioByPeer.set(peerId, el);
    }
    el.srcObject = stream;
    // Try to play explicitly. If autoplay is blocked, we get a rejected
    // promise (typically NotAllowedError); the page can prompt the user.
    void el.play().catch((err: Error) => {
      if (err?.name === 'NotAllowedError' || err?.name === 'NotSupportedError') {
        console.warn(`Autoplay blocked for ${peerId}; user gesture required.`);
        this.events.onAutoplayBlocked?.(peerId);
      } else {
        console.warn(`Could not play remote audio for ${peerId}:`, err);
      }
    });
    this.events.onPeerStreamAdded?.(peerId);
  }

  private detachRemoteAudio(peerId: string): void {
    const el = this.remoteAudioByPeer.get(peerId);
    if (!el) return;
    el.pause();
    el.srcObject = null;
    this.remoteAudioByPeer.delete(peerId);
    this.events.onPeerStreamRemoved?.(peerId);
  }
}

export const voiceService = new VoiceService();
