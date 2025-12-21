import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from './appStore';
import type { TransferState } from '../types';

describe('appStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useAppStore.setState({
      connection: {
        status: 'disconnected',
        sessionId: null,
        isInitiator: false,
        error: null,
        maxPeers: 5,
      },
      peers: new Map(),
      transfers: [],
    });
  });

  describe('connection state', () => {
    it('should have initial disconnected state', () => {
      const state = useAppStore.getState();
      
      expect(state.connection.status).toBe('disconnected');
      expect(state.connection.sessionId).toBeNull();
      expect(state.connection.isInitiator).toBe(false);
      expect(state.connection.error).toBeNull();
      expect(state.connection.maxPeers).toBe(5);
    });

    it('should update connection state partially', () => {
      const { setConnection } = useAppStore.getState();
      
      setConnection({ status: 'connecting', sessionId: 'test-session' });
      
      const state = useAppStore.getState();
      expect(state.connection.status).toBe('connecting');
      expect(state.connection.sessionId).toBe('test-session');
      expect(state.connection.maxPeers).toBe(5); // Should remain unchanged
    });

    it('should reset connection state', () => {
      const { setConnection, resetConnection, addPeer } = useAppStore.getState();
      
      setConnection({ 
        status: 'connected', 
        sessionId: 'test-session',
        maxPeers: 5
      });
      addPeer('peer-123');
      
      resetConnection();
      
      const state = useAppStore.getState();
      expect(state.connection.status).toBe('disconnected');
      expect(state.connection.sessionId).toBeNull();
      expect(state.connection.maxPeers).toBe(5);
    });

    it('should handle error state', () => {
      const { setConnection } = useAppStore.getState();
      
      setConnection({ status: 'error', error: 'Connection failed' });
      
      const state = useAppStore.getState();
      expect(state.connection.status).toBe('error');
      expect(state.connection.error).toBe('Connection failed');
    });

    it('should track initiator status', () => {
      const { setConnection } = useAppStore.getState();
      
      setConnection({ isInitiator: true });
      
      expect(useAppStore.getState().connection.isInitiator).toBe(true);
      
      setConnection({ isInitiator: false });
      
      expect(useAppStore.getState().connection.isInitiator).toBe(false);
    });
  });

  describe('peers state', () => {
    it('should have empty peers initially', () => {
      const state = useAppStore.getState();
      expect(state.peers.size).toBe(0);
    });

    it('should add a peer', () => {
      const { addPeer } = useAppStore.getState();
      
      addPeer('peer-123');
      
      const state = useAppStore.getState();
      expect(state.peers.size).toBe(1);
      expect(state.peers.has('peer-123')).toBe(true);
      expect(state.peers.get('peer-123')?.status).toBe('connecting');
    });

    it('should update a peer', () => {
      const { addPeer, updatePeer } = useAppStore.getState();
      
      addPeer('peer-123');
      updatePeer('peer-123', { 
        status: 'connected',
        sasCode: 'apple-banana-cherry-delta'
      });
      
      const state = useAppStore.getState();
      const peer = state.peers.get('peer-123');
      expect(peer?.status).toBe('connected');
      expect(peer?.sasCode).toBe('apple-banana-cherry-delta');
    });

    it('should remove a peer', () => {
      const { addPeer, removePeer } = useAppStore.getState();
      
      addPeer('peer-123');
      addPeer('peer-456');
      
      removePeer('peer-123');
      
      const state = useAppStore.getState();
      expect(state.peers.size).toBe(1);
      expect(state.peers.has('peer-123')).toBe(false);
      expect(state.peers.has('peer-456')).toBe(true);
    });

    it('should clear all peers', () => {
      const { addPeer, clearPeers } = useAppStore.getState();
      
      addPeer('peer-123');
      addPeer('peer-456');
      
      clearPeers();
      
      const state = useAppStore.getState();
      expect(state.peers.size).toBe(0);
    });

    it('should get connected peers', () => {
      const { addPeer, updatePeer, getConnectedPeers } = useAppStore.getState();
      
      addPeer('peer-123');
      addPeer('peer-456');
      updatePeer('peer-123', { status: 'connected' });
      
      const connected = getConnectedPeers();
      expect(connected.length).toBe(1);
      expect(connected[0].peerId).toBe('peer-123');
      expect(connected[0].status).toBe('connected');
    });
  });

  describe('transfers state', () => {
    const mockTransfer: TransferState = {
      fileId: 'file-123',
      fileName: 'test.pdf',
      fileSize: 1024,
      fileType: 'application/pdf',
      direction: 'send',
      status: 'pending',
      bytesTransferred: 0,
      startTime: null,
      speed: 0,
    };

    it('should have empty transfers initially', () => {
      const state = useAppStore.getState();
      expect(state.transfers).toEqual([]);
    });

    it('should add a transfer', () => {
      const { addTransfer } = useAppStore.getState();
      
      addTransfer(mockTransfer);
      
      const state = useAppStore.getState();
      expect(state.transfers).toHaveLength(1);
      expect(state.transfers[0]).toEqual(mockTransfer);
    });

    it('should add multiple transfers', () => {
      const { addTransfer } = useAppStore.getState();
      
      addTransfer(mockTransfer);
      addTransfer({ ...mockTransfer, fileId: 'file-456', fileName: 'test2.pdf' });
      
      const state = useAppStore.getState();
      expect(state.transfers).toHaveLength(2);
    });

    it('should update a transfer', () => {
      const { addTransfer, updateTransfer } = useAppStore.getState();
      
      addTransfer(mockTransfer);
      updateTransfer('file-123', { 
        status: 'transferring', 
        bytesTransferred: 512,
        speed: 100 
      });
      
      const state = useAppStore.getState();
      expect(state.transfers[0].status).toBe('transferring');
      expect(state.transfers[0].bytesTransferred).toBe(512);
      expect(state.transfers[0].speed).toBe(100);
      expect(state.transfers[0].fileName).toBe('test.pdf'); // Unchanged
    });

    it('should not update non-existent transfer', () => {
      const { addTransfer, updateTransfer } = useAppStore.getState();
      
      addTransfer(mockTransfer);
      updateTransfer('non-existent', { status: 'completed' });
      
      const state = useAppStore.getState();
      expect(state.transfers[0].status).toBe('pending');
    });

    it('should remove a transfer', () => {
      const { addTransfer, removeTransfer } = useAppStore.getState();
      
      addTransfer(mockTransfer);
      addTransfer({ ...mockTransfer, fileId: 'file-456' });
      
      removeTransfer('file-123');
      
      const state = useAppStore.getState();
      expect(state.transfers).toHaveLength(1);
      expect(state.transfers[0].fileId).toBe('file-456');
    });

    it('should clear all transfers', () => {
      const { addTransfer, clearTransfers } = useAppStore.getState();
      
      addTransfer(mockTransfer);
      addTransfer({ ...mockTransfer, fileId: 'file-456' });
      addTransfer({ ...mockTransfer, fileId: 'file-789' });
      
      clearTransfers();
      
      const state = useAppStore.getState();
      expect(state.transfers).toEqual([]);
    });

    it('should track transfer progress correctly', () => {
      const { addTransfer, updateTransfer } = useAppStore.getState();
      
      addTransfer(mockTransfer);
      
      // Simulate progress updates
      updateTransfer('file-123', { 
        status: 'transferring',
        startTime: Date.now(),
        bytesTransferred: 256,
        speed: 256
      });
      
      updateTransfer('file-123', { 
        bytesTransferred: 512,
        speed: 256
      });
      
      updateTransfer('file-123', { 
        bytesTransferred: 1024,
        status: 'completed'
      });
      
      const state = useAppStore.getState();
      expect(state.transfers[0].status).toBe('completed');
      expect(state.transfers[0].bytesTransferred).toBe(1024);
    });
  });
});
