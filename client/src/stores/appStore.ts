import { create } from 'zustand';
import type { ConnectionState, TransferState, PeerConnectionState } from '../types';

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
};

export const useAppStore = create<AppState>((set, get) => ({
  connection: initialConnectionState,
  
  setConnection: (updates) =>
    set((state) => ({
      connection: { ...state.connection, ...updates },
    })),
  
  resetConnection: () =>
    set({ connection: initialConnectionState, peers: new Map() }),

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
