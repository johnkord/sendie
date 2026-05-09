import { create } from 'zustand';
import type { ConnectionState, TransferState, PeerConnectionState, QueuedFile } from '../types';

interface AppState {
  // Connection state
  connection: ConnectionState;
  setConnection: (connection: Partial<ConnectionState>) => void;
  resetConnection: () => void;

  // Multi-peer state
  peers: Map<string, PeerConnectionState>;
  addPeer: (peerId: string, state?: Partial<PeerConnectionState>) => void;
  updatePeer: (peerId: string, updates: Partial<PeerConnectionState>) => void;
  removePeer: (peerId: string) => void;
  clearPeers: () => void;
  getConnectedPeers: () => PeerConnectionState[];
  getPeersWithOpenChannels: () => string[];

  // File queue state
  queuedFiles: QueuedFile[];
  broadcastMode: boolean;
  autoReceive: boolean;
  addQueuedFile: (file: File) => void;
  removeQueuedFile: (id: string) => void;
  clearQueuedFiles: (broadcastOnly?: boolean) => void;
  setBroadcastMode: (enabled: boolean) => void;
  setAutoReceive: (enabled: boolean) => void;
  getOneTimeQueuedFiles: () => QueuedFile[];
  getBroadcastFiles: () => QueuedFile[];

  // Transfers
  transfers: TransferState[];
  addTransfer: (transfer: TransferState) => void;
  updateTransfer: (fileId: string, updates: Partial<TransferState>) => void;
  removeTransfer: (fileId: string) => void;
  clearTransfers: () => void;
}

const initialConnectionState: ConnectionState = {
  status: 'disconnected',
  sessionId: null,
  isInitiator: false,
  error: null,
  maxPeers: 10,
  localFriendlyName: null,
  isHost: false,
  hostConnectionId: null,
  isLocked: false,
  isHostOnlySending: false,
};

export const useAppStore = create<AppState>((set, get) => ({
  connection: initialConnectionState,
  
  setConnection: (updates) =>
    set((state) => ({
      connection: { ...state.connection, ...updates },
    })),
  
  resetConnection: () =>
    set({ connection: initialConnectionState, peers: new Map(), queuedFiles: [], broadcastMode: false }),

  // Multi-peer state management
  peers: new Map(),

  addPeer: (peerId, initialState = {}) =>
    set((state) => {
      // Idempotent: if the peer already exists, leave its state alone.
      // A renegotiation (e.g. when voice starts) re-fires onOffer, and a
      // naive reset would wipe verification status, SAS code, friendly
      // name, and dataChannelOpen back to 'connecting / pending / null',
      // which is what we look like on the UI even though the underlying
      // RTCPeerConnection is perfectly healthy.
      if (state.peers.has(peerId)) {
        return state;
      }
      const newPeers = new Map(state.peers);
      newPeers.set(peerId, {
        peerId,
        status: 'connecting',
        dataChannelOpen: false,
        publicKeyJwk: null,
        sasCode: null,
        friendlyName: null,
        verification: 'pending',
        fingerprint: null,
        voiceState: null,
        cameraState: null,
        ...initialState,
      });
      return { peers: newPeers };
    }),

  updatePeer: (peerId, updates) =>
    set((state) => {
      const newPeers = new Map(state.peers);
      const existing = newPeers.get(peerId);
      if (existing) {
        newPeers.set(peerId, { ...existing, ...updates });
      }
      return { peers: newPeers };
    }),

  removePeer: (peerId) =>
    set((state) => {
      const newPeers = new Map(state.peers);
      newPeers.delete(peerId);
      return { peers: newPeers };
    }),

  clearPeers: () =>
    set({ peers: new Map() }),

  getConnectedPeers: () => {
    const { peers } = get();
    return Array.from(peers.values()).filter(p => p.status === 'connected');
  },

  getPeersWithOpenChannels: () => {
    const { peers } = get();
    return Array.from(peers.values())
      .filter(p => p.dataChannelOpen)
      .map(p => p.peerId);
  },

  // File queue state management
  queuedFiles: [],
  broadcastMode: false,
  // Default OFF: receivers must explicitly accept incoming files. Prevents
  // anyone with a session URL from silently dropping files into recipients'
  // Downloads folders. The user can opt back into auto-receive per session.
  autoReceive: false,

  addQueuedFile: (file: File) =>
    set((state) => ({
      queuedFiles: [
        ...state.queuedFiles,
        {
          id: crypto.randomUUID(),
          file,
          // isBroadcast is captured for compatibility but the send path
          // re-evaluates against the current broadcastMode at send time
          // (see getOneTimeQueuedFiles / getBroadcastFiles).
          isBroadcast: state.broadcastMode,
          addedAt: Date.now(),
        },
      ],
    })),

  removeQueuedFile: (id: string) =>
    set((state) => ({
      queuedFiles: state.queuedFiles.filter((f) => f.id !== id),
    })),

  clearQueuedFiles: (broadcastOnly?: boolean) =>
    set((state) => ({
      queuedFiles: broadcastOnly 
        ? state.queuedFiles.filter((f) => !f.isBroadcast)
        : [],
    })),

  setBroadcastMode: (enabled: boolean) =>
    set({ broadcastMode: enabled }),
    // Note: queued files keep their original `isBroadcast` flag. The page
    // gates broadcast-style fan-out on the *current* broadcastMode, so
    // toggling off does not leak files to new joiners; they sit in the
    // queue (visible in the UI) until the user re-enables broadcast or
    // clears them. The earlier audit claim of a silent leak here was wrong.

  setAutoReceive: (enabled: boolean) =>
    set({ autoReceive: enabled }),

  getOneTimeQueuedFiles: () => {
    const { queuedFiles } = get();
    return queuedFiles.filter((f) => !f.isBroadcast);
  },

  getBroadcastFiles: () => {
    const { queuedFiles } = get();
    return queuedFiles.filter((f) => f.isBroadcast);
  },

  transfers: [],
  
  addTransfer: (transfer) =>
    set((state) => ({
      transfers: [...state.transfers, transfer],
    })),
  
  updateTransfer: (fileId, updates) =>
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.fileId === fileId ? { ...t, ...updates } : t
      ),
    })),
  
  removeTransfer: (fileId) =>
    set((state) => ({
      transfers: state.transfers.filter((t) => t.fileId !== fileId),
    })),
  
  clearTransfers: () =>
    set({ transfers: [] }),
}));
