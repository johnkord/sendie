import { useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAppStore } from '../stores/appStore';
import { 
  signalingService, 
  multiPeerWebRTCService, 
  cryptoService, 
  multiPeerFileTransferService 
} from '../services';
import { 
  FileDropZone, 
  TransferProgress, 
  ConnectionStatusDisplay, 
  SessionLink, 
  UserHeader,
  PeerList 
} from '../components';
import type { KeyPair } from '../types';

export default function MultiPeerSessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  
  const { 
    connection, 
    setConnection, 
    peers,
    addPeer,
    updatePeer,
    removePeer,
    clearPeers,
    transfers, 
    addTransfer, 
    updateTransfer 
  } = useAppStore();
  
  const keyPairRef = useRef<KeyPair | null>(null);
  const localKeyJwkRef = useRef<string | null>(null);
  const initializedRef = useRef(false);

  // Initialize connection
  useEffect(() => {
    if (!sessionId || initializedRef.current) return;
    initializedRef.current = true;

    const init = async () => {
      try {
        setConnection({ status: 'connecting', sessionId });

        // Generate key pair for identity verification
        keyPairRef.current = await cryptoService.generateKeyPair();
        localKeyJwkRef.current = await cryptoService.exportPublicKey(keyPairRef.current.publicKey);

        // Initialize services
        await multiPeerWebRTCService.initialize();
        await signalingService.connect();

        // Setup signaling event handlers
        signalingService.on('onPeerJoined', handlePeerJoined);
        signalingService.on('onPeerLeft', handlePeerLeft);
        signalingService.on('onOffer', handleOffer);
        signalingService.on('onAnswer', handleAnswer);
        signalingService.on('onIceCandidate', handleIceCandidate);
        signalingService.on('onPublicKey', handlePublicKey);

        // Setup multi-peer WebRTC event handlers
        multiPeerWebRTCService.on('onPeerConnected', handlePeerConnected);
        multiPeerWebRTCService.on('onPeerDisconnected', handlePeerDisconnected);
        multiPeerWebRTCService.on('onDataChannelOpen', handleDataChannelOpen);
        multiPeerWebRTCService.on('onDataChannelClose', handleDataChannelClose);

        // Setup file transfer event handlers
        multiPeerFileTransferService.on('onTransferStart', (transfer) => addTransfer(transfer));
        multiPeerFileTransferService.on('onTransferProgress', (transfer) => 
          updateTransfer(transfer.fileId, transfer)
        );
        multiPeerFileTransferService.on('onTransferComplete', (transfer) => 
          updateTransfer(transfer.fileId, transfer)
        );

        // Join the session
        const result = await signalingService.joinSession(sessionId);
        
        if (!result.success) {
          setConnection({ status: 'error', error: result.error || 'Failed to join session' });
          return;
        }

        setConnection({ 
          status: 'waiting-for-peer', 
          isInitiator: result.isInitiator ?? false,
        });

        // If there are existing peers, initiate connections to each
        if (result.existingPeers && result.existingPeers.length > 0) {
          for (const peerId of result.existingPeers) {
            console.log('Creating offer to existing peer:', peerId);
            addPeer(peerId, { status: 'connecting' });
            await multiPeerWebRTCService.createOfferTo(peerId);
          }
          updateConnectionStatus();
        }
      } catch (error) {
        console.error('Initialization error:', error);
        setConnection({ 
          status: 'error', 
          error: error instanceof Error ? error.message : 'Connection failed' 
        });
      }
    };

    init();

    return () => {
      // Cleanup
      signalingService.off('onPeerJoined');
      signalingService.off('onPeerLeft');
      signalingService.off('onOffer');
      signalingService.off('onAnswer');
      signalingService.off('onIceCandidate');
      signalingService.off('onPublicKey');
      multiPeerWebRTCService.off('onPeerConnected');
      multiPeerWebRTCService.off('onPeerDisconnected');
      multiPeerWebRTCService.off('onDataChannelOpen');
      multiPeerWebRTCService.off('onDataChannelClose');
      multiPeerWebRTCService.closeAllConnections();
      clearPeers();
      signalingService.disconnect();
    };
  }, [sessionId]);

  // Helper to update overall connection status based on peer states
  const updateConnectionStatus = useCallback(() => {
    const connectedCount = multiPeerWebRTCService.connectedPeerCount;
    const hasOpenChannels = multiPeerWebRTCService.hasOpenDataChannels;
    
    if (connectedCount === 0) {
      setConnection({ status: 'waiting-for-peer' });
    } else if (hasOpenChannels) {
      setConnection({ status: 'connected' });
    } else {
      setConnection({ status: 'partially-connected' });
    }
  }, [setConnection]);

  // Signaling Event handlers
  const handlePeerJoined = useCallback(async (peerId: string) => {
    console.log('Peer joined:', peerId);
    addPeer(peerId, { status: 'connecting' });
    
    // Don't create an offer here - the joining peer will create offers to existing peers.
    // This prevents "glare" (both sides sending offers simultaneously).
    // We just wait for their offer.
    updateConnectionStatus();
  }, [addPeer, updateConnectionStatus]);

  const handlePeerLeft = useCallback((peerId: string) => {
    console.log('Peer left:', peerId);
    multiPeerWebRTCService.closePeerConnection(peerId);
    removePeer(peerId);
    updateConnectionStatus();
  }, [removePeer, updateConnectionStatus]);

  const handleOffer = useCallback(async (peerId: string, sdp: string) => {
    console.log('Received offer from:', peerId);
    
    // Add peer if not already known
    if (!peers.has(peerId)) {
      addPeer(peerId, { status: 'connecting' });
    }
    
    await multiPeerWebRTCService.handleOffer(peerId, sdp);
  }, [peers, addPeer]);

  const handleAnswer = useCallback(async (peerId: string, sdp: string) => {
    console.log('Received answer from:', peerId);
    await multiPeerWebRTCService.handleAnswer(peerId, sdp);
  }, []);

  const handleIceCandidate = useCallback(async (
    peerId: string, 
    candidate: string, 
    sdpMid: string | null, 
    sdpMLineIndex: number | null
  ) => {
    await multiPeerWebRTCService.handleIceCandidate(peerId, candidate, sdpMid, sdpMLineIndex);
  }, []);

  const handlePublicKey = useCallback(async (peerId: string, keyJwk: string) => {
    console.log('Received public key from:', peerId);
    
    // Generate SAS code for this peer
    if (localKeyJwkRef.current) {
      const sasCode = await cryptoService.generateSAS(localKeyJwkRef.current, keyJwk);
      updatePeer(peerId, { publicKeyJwk: keyJwk, sasCode });
    }
  }, [updatePeer]);

  // WebRTC Event handlers
  const handlePeerConnected = useCallback((peerId: string) => {
    console.log('Peer connected:', peerId);
    updatePeer(peerId, { status: 'connected' });
    updateConnectionStatus();
  }, [updatePeer, updateConnectionStatus]);

  const handlePeerDisconnected = useCallback((peerId: string) => {
    console.log('Peer disconnected:', peerId);
    updatePeer(peerId, { status: 'disconnected', dataChannelOpen: false });
    updateConnectionStatus();
  }, [updatePeer, updateConnectionStatus]);

  const handleDataChannelOpen = useCallback(async (peerId: string) => {
    console.log('Data channel opened with:', peerId);
    updatePeer(peerId, { dataChannelOpen: true });
    updateConnectionStatus();
    
    // Exchange public keys for verification
    if (localKeyJwkRef.current) {
      await signalingService.sendPublicKeyTo(peerId, localKeyJwkRef.current);
    }
  }, [updatePeer, updateConnectionStatus]);

  const handleDataChannelClose = useCallback((peerId: string) => {
    console.log('Data channel closed with:', peerId);
    updatePeer(peerId, { dataChannelOpen: false });
    updateConnectionStatus();
  }, [updatePeer, updateConnectionStatus]);

  // File handling - broadcast to all connected peers
  const handleFilesSelected = useCallback(async (files: File[]) => {
    if (!multiPeerWebRTCService.hasOpenDataChannels) {
      console.error('No open data channels');
      return;
    }

    for (const file of files) {
      try {
        await multiPeerFileTransferService.broadcastFile(file);
      } catch (error) {
        console.error('Failed to broadcast file:', error);
      }
    }
  }, []);

  const handleCancelTransfer = useCallback((fileId: string) => {
    multiPeerFileTransferService.cancelTransfer(fileId);
  }, []);

  const handleLeaveSession = useCallback(() => {
    signalingService.leaveSession();
    multiPeerWebRTCService.closeAllConnections();
    clearPeers();
    navigate('/');
  }, [navigate, clearPeers]);

  const handleDisconnectPeer = useCallback((peerId: string) => {
    multiPeerWebRTCService.closePeerConnection(peerId);
    removePeer(peerId);
    updateConnectionStatus();
  }, [removePeer, updateConnectionStatus]);

  const connectedPeerCount = Array.from(peers.values()).filter(p => p.status === 'connected').length;
  const isConnected = connection.status === 'connected' || connection.status === 'partially-connected';
  const canSendFiles = isConnected && multiPeerWebRTCService.hasOpenDataChannels;

  return (
    <div className="min-h-screen p-4 md:p-8 relative">
      <UserHeader />
      
      <div className="max-w-2xl mx-auto pt-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white">📤 Sendie</h1>
          <button
            onClick={handleLeaveSession}
            className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
          >
            Leave Session
          </button>
        </div>

        {/* Connection Status */}
        <ConnectionStatusDisplay
          status={connection.status}
          sessionId={connection.sessionId}
          connectedPeerCount={connectedPeerCount}
          maxPeers={connection.maxPeers}
          error={connection.error}
        />

        {/* Session Link (for waiting for peers) */}
        {(connection.status === 'waiting-for-peer' || peers.size < connection.maxPeers - 1) && sessionId && (
          <div className="mt-4">
            <SessionLink sessionId={sessionId} />
          </div>
        )}

        {/* Peer List */}
        {peers.size > 0 && (
          <div className="mt-4">
            <PeerList 
              peers={peers}
              onRemovePeer={handleDisconnectPeer}
            />
          </div>
        )}

        {/* File Drop Zone */}
        <div className="mt-6">
          <FileDropZone
            onFilesSelected={handleFilesSelected}
            disabled={!canSendFiles}
          />
        </div>

        {/* Active Transfers */}
        {transfers.length > 0 && (
          <div className="mt-6 space-y-3">
            <h2 className="text-lg font-semibold text-white">Transfers</h2>
            {transfers.map((transfer) => (
              <TransferProgress
                key={transfer.fileId}
                transfer={transfer}
                onCancel={
                  transfer.status === 'transferring' || transfer.status === 'pending'
                    ? () => handleCancelTransfer(transfer.fileId)
                    : undefined
                }
              />
            ))}
          </div>
        )}

        {/* Help Text */}
        <div className="mt-8 text-center text-gray-500 text-sm">
          {connection.status === 'waiting-for-peer' && (
            <p>Share the link above with others to connect and start transferring files.</p>
          )}
          {isConnected && (
            <p>
              Files are broadcast to all connected peers using WebRTC.
              <br />
              All transfers are end-to-end encrypted.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
