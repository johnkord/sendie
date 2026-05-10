// Session and Connection Types
export interface Session {
  id: string;
  createdAt: string;
  expiresAt: string;
  peerCount: number;
  maxPeers: number;
}

// Phase 6.1: response shape from POST /api/sessions. The plaintext join
// secret is delivered exactly once, in the URL fragment, and never persisted
// on the server (only a peppered HMAC of it).
export interface SessionCreationResponse extends Session {
  secret: string;
  absoluteExpiresAt: string;
  isLocked: boolean;
  isHostOnlySending: boolean;
}

// Per-peer connection state (for multi-peer mesh)
export type PeerConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';

export type PeerVerificationStatus = 'pending' | 'verified' | 'failed';

export interface PeerConnectionState {
  peerId: string;
  status: PeerConnectionStatus;
  dataChannelOpen: boolean;
  publicKeyJwk: string | null;
  sasCode: string | null;
  friendlyName: string | null;  // Human-friendly name derived from their public key
  verification: PeerVerificationStatus;  // Phase 2 bound-SAS verification state
  fingerprint: string | null;  // Remote DTLS fingerprint observed in SDP
  // Voice PoC: state of the remote peer's outgoing audio. `null` means we
  // have not received a voice-state message from them, treat as not sharing.
  voiceState: { sharing: boolean; muted: boolean } | null;
  // Video: state of the remote peer's outgoing video.
  // streamId disambiguates the peer's camera track from their screen-share
  // track (both arrive as kind=video). `null` until the peer's first
  // camera-state message lands.
  cameraState: { sharing: boolean; streamId?: string } | null;
  // Screen sharing: state of the remote peer's outgoing screen capture.
  // Same shape as cameraState; we keep it separate so the UI can render
  // a screen tile distinctly from camera tiles.
  screenState: { sharing: boolean; streamId?: string } | null;
}

export interface PeerInfo {
  peerId: string;
  publicKey: CryptoKey | null;
  verified: boolean;
}

// Signaling Message Types
export type SignalingMessage =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'public-key'; key: JsonWebKey }
  | { type: 'signature'; signature: string; challenge: string };

// Transfer Types
export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export type TransferStatus = 'pending' | 'transferring' | 'completed' | 'failed' | 'cancelled' | 'error';
export type TransferDirection = 'send' | 'receive';

export interface TransferState {
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  direction: TransferDirection;
  status: TransferStatus;
  bytesTransferred: number;
  startTime: number | null;
  speed: number; // bytes per second
  // Human-readable explanation for failed/cancelled transfers. Surfaced
  // in the UI so the receiver isn't left guessing why a 5GB transfer
  // dropped (e.g. Firefox blocked OPFS).
  errorMessage?: string;
}

export interface ChunkMessage {
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  data: ArrayBuffer;
}

// Data channel message types
export type FileStartMessage = { type: 'file-start'; fileId: string; fileName: string; fileSize: number; fileType: string; totalChunks: number };

export type DataChannelMessage =
  | FileStartMessage
  | { type: 'file-chunk'; fileId: string; chunkIndex: number }
  | { type: 'file-end'; fileId: string }
  // Receiver-to-sender ACK. Periodic (every N chunks). Sender uses this
  // to throttle: if it is more than M chunks ahead of the latest ACK,
  // pause until a fresh ACK arrives. Closes the gap left by RTCDataChannel
  // bufferedAmount, which only reflects local SCTP queue, not the
  // receiver's downstream backlog.
  | { type: 'file-progress'; fileId: string; chunksWritten: number }
  | { type: 'file-ack'; fileId: string; chunkIndex: number }
  | { type: 'file-accept'; fileId: string }
  | { type: 'file-decline'; fileId: string }
  | { type: 'transfer-cancel'; fileId: string }
  // Phase 2 verification protocol over the data channel
  | { type: 'verification-init'; nonce: string; fp: string; jwk: string }
  | { type: 'verification-sig'; signature: string }
  // Voice PoC: out-of-band mute-state propagation. The mute itself is
  // track.enabled = false (instant, no renegotiation); this message tells
  // the remote UI so it can show a 🔇 indicator. Pure UX hint; the
  // underlying audio is already silenced regardless of whether the
  // message arrives.
  | { type: 'voice-state'; muted: boolean; sharing: boolean }
  | { type: 'camera-state'; sharing: boolean; streamId?: string }
  // Screen-share state. streamId lets the receiver match an incoming
  // video track to the sender's intent (camera vs screen) since both
  // arrive as kind=video.
  | { type: 'screen-state'; sharing: boolean; streamId?: string }
  // Watch-party (synced media playback). See
  // docs/synced-media-playback-proposal.md for the full design.
  // 'wp-timeline' is the heartbeat carrying the host's authoritative
  // playback state. anchorMono is the host's AudioContext.currentTime
  // (in seconds) at the moment of send, plus an optional lookahead for
  // play/seek transitions; followers compute their own currentTime as
  //   anchorTime + (hostNow - anchorMono) * playbackRate when playing.
  // hostMono is the host's clock at send time, used for offset
  // estimation (alongside RTCStatsReport.currentRoundTripTime) without
  // a separate ping protocol.
  | {
      type: 'wp-timeline';
      seq: number;
      hostPeerId: string;
      sessionId: string;
      playing: boolean;
      anchorMono: number;
      anchorTime: number;
      playbackRate: number;
      hostMono: number;
      // Display-only metadata; receivers use it to confirm 'this is the
      // movie I have' and show a label. We don't enforce a hash match
      // because users often have the same movie with different bitrates
      // / encodes; trust the user.
      mediaName: string;
      mediaDuration: number; // seconds, or 0 if unknown
    }
  // Follower has loaded a local file and is ready, or is buffering, or
  // has left the watch party.
  | {
      type: 'wp-peer-state';
      sessionId: string;
      // 'idle' = no file loaded; 'ready' = file loaded, can play;
      // 'buffering' = playback temporarily stalled (readyState briefly
      // < HAVE_FUTURE_DATA for >2s).
      state: 'idle' | 'ready' | 'buffering';
      mediaTime?: number;  // current playback position, for seekbar dots
    }
  // Anyone can request to take over hosting; current host grants or
  // ignores. In v1 the host approves manually; democratic mode (v2)
  // would auto-grant.
  | { type: 'wp-host-request'; sessionId: string }
  | { type: 'wp-host-grant'; sessionId: string; newHostPeerId: string }
  // Live-stream mode (DEPRECATED in v2): host announces it is sharing
  // the rendered output of a media element via WebRTC tracks
  // (captureStream). Removed because Firefox-on-Linux can't decode
  // H.264, captureStream is uneven across browsers, and Mode C
  // (forward-then-play) is strictly better. Kept here so old
  // serialized messages don't crash the parser.
  | {
      type: 'wp-stream-start';
      sessionId: string;
      hostPeerId: string;
      streamId: string;
      mediaName: string;
      mediaDuration: number;
    }
  // Mode C (forward-then-play): host sends the file bytes to every
  // peer over the data channel, peers buffer in memory, then the room
  // enters synced-state playback (Mode A timeline algorithm) using
  // the resulting Blob URLs. Decoupled from MultiPeerFileTransferService
  // so it doesn't compete for OPFS / save-to-disk plumbing.
  | {
      type: 'wp-file-start';
      sessionId: string;
      hostPeerId: string;
      mediaName: string;
      mediaSize: number;
      mediaType: string;  // MIME, e.g. 'video/mp4'; receiver hints <video>
      totalChunks: number;
    }
  | {
      type: 'wp-file-chunk-meta';
      sessionId: string;
      chunkIndex: number;
      // Base64-encoded bytes for this chunk. We embed in JSON rather
      // than sending as a separate binary message so we don't fight
      // MultiPeerFileTransferService for ArrayBuffer ownership on
      // the shared data channel. 33% inflation is acceptable; the
      // win is total isolation.
      data: string;
    }
  | {
      type: 'wp-file-end';
      sessionId: string;
    }
  // Receiver -> sender ACK so host can throttle. Periodic, every N
  // chunks. Same idea as file-progress in MultiPeerFileTransferService.
  | {
      type: 'wp-file-ack';
      sessionId: string;
      chunkIndex: number;
    }
  // Host explicitly ends the session for everyone.
  | { type: 'wp-end'; sessionId: string };

// Crypto Types
export interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

export interface VerificationResult {
  verified: boolean;
  sasCode: string;
}

// Connection State
export type ConnectionStatus = 
  | 'disconnected'
  | 'connecting'
  | 'waiting-for-peer'
  | 'connected'
  | 'partially-connected'  // Some peers connected in multi-peer
  | 'verified'
  | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  sessionId: string | null;
  isInitiator: boolean;
  error: string | null;
  maxPeers: number;
  localFriendlyName: string | null;  // User's own friendly name for identification
  // Session control state
  isHost: boolean;  // Whether the current user is the session host
  hostConnectionId: string | null;  // Connection ID of the host
  isLocked: boolean;  // Whether the session is locked
  isHostOnlySending: boolean;  // Whether only the host can send files
}

// Multi-peer transfer tracking
export interface MultiPeerTransferState extends TransferState {
  targetPeers: string[];  // Peers receiving this file
  peerProgress: Record<string, number>;  // Progress per peer (bytes transferred)
  peerStatus: Record<string, TransferStatus>;  // Status per peer
}

// File queue types
export interface QueuedFile {
  id: string;
  file: File;
  isBroadcast: boolean;  // If true, sends to all new joiners; if false, one-time send
  addedAt: number;
}
