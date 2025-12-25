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
      const newPeers = new Map(state.peers);
      newPeers.set(peerId, {
        peerId,
        status: 'connecting',
        dataChannelOpen: false,
        publicKeyJwk: null,
        sasCode: null,
        friendlyName: null,
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
  autoReceive: true,

  addQueuedFile: (file: File) =>
    set((state) => ({
      queuedFiles: [
        ...state.queuedFiles,
        {
          id: crypto.randomUUID(),
          file,
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
