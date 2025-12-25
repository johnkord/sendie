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
  PeerList,
  Footer 
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

        // Generate our friendly name from our public key
        const localFriendlyName = await cryptoService.generateFriendlyName(localKeyJwkRef.current);
        setConnection({ localFriendlyName });

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
        signalingService.on('onSessionLocked', handleSessionLocked);
        signalingService.on('onSessionUnlocked', handleSessionUnlocked);
        signalingService.on('onKicked', handleKicked);

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
          // Check for rate limit error
          const errorMsg = result.error || 'Failed to join session';
          const isRateLimited = errorMsg.includes('Rate limit exceeded');
          const isLocked = errorMsg.includes('Session is locked');
          
          if (isRateLimited) {
            const match = errorMsg.match(/(\d+)\s*seconds?/);
            const retryAfter = match ? parseInt(match[1], 10) : 60;
            setConnection({ 
              status: 'error', 
              error: `Too many join attempts. Please wait ${retryAfter} seconds before trying again.`
            });
          } else if (isLocked) {
            setConnection({ 
              status: 'error', 
              error: '🔒 This session is locked. The host has prevented new people from joining.'
            });
          } else {
            setConnection({ status: 'error', error: errorMsg });
          }
          return;
        }

        setConnection({ 
          status: 'waiting-for-peer', 
          isInitiator: result.isInitiator ?? false,
          isHost: result.isHost ?? false,
          hostConnectionId: result.hostConnectionId ?? null,
          isLocked: result.isLocked ?? false,
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
        
        // Check for rate limit error
        const errorMsg = error instanceof Error ? error.message : 'Connection failed';
        const isRateLimited = errorMsg.includes('Rate limit exceeded');
        
        if (isRateLimited) {
          const match = errorMsg.match(/(\d+)\s*seconds?/);
          const retryAfter = match ? parseInt(match[1], 10) : 60;
          setConnection({ 
            status: 'error', 
            error: `⏱️ Too many requests. Please wait ${retryAfter} seconds before trying again.`
          });
        } else {
          setConnection({ 
            status: 'error', 
            error: errorMsg
          });
        }
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
      signalingService.off('onSessionLocked');
      signalingService.off('onSessionUnlocked');
      signalingService.off('onKicked');
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
    
    // Generate SAS code and friendly name for this peer
    if (localKeyJwkRef.current) {
      const sasCode = await cryptoService.generateSAS(localKeyJwkRef.current, keyJwk);
      const friendlyName = await cryptoService.generateFriendlyName(keyJwk);
      updatePeer(peerId, { publicKeyJwk: keyJwk, sasCode, friendlyName });
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

  // Session Control Event Handlers
  const handleSessionLocked = useCallback(() => {
    console.log('Session locked by host');
    setConnection({ isLocked: true });
  }, [setConnection]);

  const handleSessionUnlocked = useCallback(() => {
    console.log('Session unlocked by host');
    setConnection({ isLocked: false });
  }, [setConnection]);

  const handleKicked = useCallback(() => {
    console.log('You have been kicked from the session');
    multiPeerWebRTCService.closeAllConnections();
    clearPeers();
    signalingService.disconnect();
    navigate('/', { state: { kicked: true } });
  }, [navigate, clearPeers]);

  // Session Control Actions (Host Only)
  const handleToggleLock = useCallback(async () => {
    try {
      if (connection.isLocked) {
        const result = await signalingService.unlockSession();
        if (!result.success) {
          console.error('Failed to unlock session:', result.error);
        }
      } else {
        const result = await signalingService.lockSession();
        if (!result.success) {
          console.error('Failed to lock session:', result.error);
        }
      }
    } catch (error) {
      console.error('Failed to toggle session lock:', error);
    }
  }, [connection.isLocked]);

  const handleKickPeer = useCallback(async (peerId: string) => {
    try {
      const result = await signalingService.kickPeer(peerId);
      if (!result.success) {
        console.error('Failed to kick peer:', result.error);
      }
    } catch (error) {
      console.error('Failed to kick peer:', error);
    }
  }, []);

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

        {/* Session Controls (Host Only) */}
        {connection.isHost && (
          <div className="mt-4 p-4 bg-gray-800/50 rounded-lg border border-gray-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-yellow-400">👑</span>
                <span className="text-sm font-medium text-gray-300">Host Controls</span>
              </div>
              <button
                onClick={handleToggleLock}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  connection.isLocked
                    ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-600/50'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
                }`}
              >
                {connection.isLocked ? (
                  <>
                    <span>🔒</span>
                    <span>Locked</span>
                  </>
                ) : (
                  <>
                    <span>🔓</span>
                    <span>Unlocked</span>
                  </>
                )}
              </button>
            </div>
            {connection.isLocked && (
              <p className="mt-2 text-xs text-gray-500">
                New people cannot join this session while it's locked.
              </p>
            )}
          </div>
        )}

        {/* Locked Session Indicator (for non-hosts) */}
        {!connection.isHost && connection.isLocked && (
          <div className="mt-4 p-3 bg-gray-800/50 rounded-lg border border-gray-700 flex items-center gap-2">
            <span>🔒</span>
            <span className="text-sm text-gray-400">This session is locked by the host</span>
          </div>
        )}

        {/* Session Link (for waiting for peers) */}
        {(connection.status === 'waiting-for-peer' || peers.size < connection.maxPeers - 1) && sessionId && !connection.isLocked && (
          <div className="mt-4">
            <SessionLink sessionId={sessionId} />
          </div>
        )}

        {/* Peer List */}
        {(peers.size > 0 || connection.localFriendlyName) && (
          <div className="mt-4">
            <PeerList 
              peers={peers}
              localFriendlyName={connection.localFriendlyName}
              onRemovePeer={handleDisconnectPeer}
              onKickPeer={connection.isHost ? handleKickPeer : undefined}
              isHost={connection.isHost}
              hostConnectionId={connection.hostConnectionId}
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

        <Footer />
      </div>
    </div>
  );
}
