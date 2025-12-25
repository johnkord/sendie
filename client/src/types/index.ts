// Session and Connection Types
export interface Session {
  id: string;
  createdAt: string;
  expiresAt: string;
  peerCount: number;
  maxPeers: number;
}

// Per-peer connection state (for multi-peer mesh)
export type PeerConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface PeerConnectionState {
  peerId: string;
  status: PeerConnectionStatus;
  dataChannelOpen: boolean;
  publicKeyJwk: string | null;
  sasCode: string | null;
  friendlyName: string | null;  // Human-friendly name derived from their public key
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
  | { type: 'file-ack'; fileId: string; chunkIndex: number }
  | { type: 'transfer-cancel'; fileId: string };

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
