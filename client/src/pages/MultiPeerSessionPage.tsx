import { useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAppStore } from '../stores/appStore';
import { 
  signalingService, 
  multiPeerWebRTCService, 
  cryptoService, 
  multiPeerFileTransferService,
  verificationService,
  voiceService,
  cameraService,
  chatService
} from '../services';
import { 
  FileDropZone, 
  FileQueue,
  TransferProgress, 
  ConnectionStatusDisplay, 
  SessionLink, 
  UserHeader,
  PeerList,
  VoiceControls,
  CameraControls,
  RemoteVideos,
  ChatPanel,
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
    updateTransfer,
    queuedFiles,
    broadcastMode,
    autoReceive,
    removeQueuedFile,
    clearQueuedFiles,
    setBroadcastMode,
    setAutoReceive,
  } = useAppStore();
  
  const keyPairRef = useRef<KeyPair | null>(null);
  const localKeyJwkRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  // Track which peers have already received broadcast files
  const peersReceivedBroadcastRef = useRef<Set<string>>(new Set());
  // Phase 6.1 (audit C4): the join secret is in the URL fragment, captured
  // once on mount. We keep it in a ref so SessionLink can format the
  // shareable URL consistently and so any reconnect uses the same secret.
  const sessionSecretRef = useRef<string | null>(null);
  if (sessionSecretRef.current === null) {
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    const m = hash.match(/[#&]k=([A-Za-z0-9_-]+)/);
    sessionSecretRef.current = m ? m[1] : '';
  }

  // Set up incoming-file accept policy on mount.
  // Default: prompt the user per file; per-peer "accept all" is held in the service.
  // If the user has explicitly toggled autoReceive on, files from already-known
  // peers (status=connected) are accepted silently as a convenience.
  useEffect(() => {
    multiPeerFileTransferService.setAcceptIncomingFile(async (peerId, fileName, fileSize, _fileType) => {
      const { autoReceive: auto, peers: peersMap } = useAppStore.getState();
      // Auto-receive opt-in still respected, but only for already-connected peers
      // (i.e., not a brand-new joiner pushing a file before any human notices).
      const peerState = peersMap.get(peerId);
      if (auto && peerState?.status === 'connected') return true;
      const friendly = peerState?.friendlyName ?? `Peer ${peerId.substring(0, 8)}`;
      const sizeMb = (fileSize / 1024 / 1024).toFixed(2);
      const accept = window.confirm(
        `${friendly} wants to send you:\n\n` +
        `  ${fileName} (${sizeMb} MB)\n\n` +
        `Only accept files from peers you trust. Click OK to accept, Cancel to decline.`,
      );
      return accept;
    });
    multiPeerFileTransferService.setHostOnlySendingProviders(
      () => useAppStore.getState().connection.isHostOnlySending,
      () => useAppStore.getState().connection.hostConnectionId,
    );
    return () => {
      multiPeerFileTransferService.resetAcceptances();
    };
  }, []);

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
        // Note: onPublicKey is intentionally not registered. Phase 2 moved
        // identity verification to the data channel so the SAS is bound to
        // the DTLS endpoints — the signaling-server-mediated public key
        // exchange would only weaken that guarantee.
        signalingService.on('onSessionLocked', handleSessionLocked);
        signalingService.on('onSessionUnlocked', handleSessionUnlocked);
        signalingService.on('onKicked', handleKicked);
        signalingService.on('onHostOnlySendingEnabled', handleHostOnlySendingEnabled);
        signalingService.on('onHostOnlySendingDisabled', handleHostOnlySendingDisabled);

        // Setup multi-peer WebRTC event handlers
        multiPeerWebRTCService.on('onPeerConnected', handlePeerConnected);
        multiPeerWebRTCService.on('onPeerDisconnected', handlePeerDisconnected);
        multiPeerWebRTCService.on('onDataChannelOpen', handleDataChannelOpen);
        multiPeerWebRTCService.on('onDataChannelClose', handleDataChannelClose);

        // Phase 2 verification result handler: peers transition to verified
        // (showing the bound SAS) or failed (channel was closed by the
        // verification service; surface the warning to the user).
        //
        // We also dispatch queued/broadcast files HERE rather than from the
        // data-channel-open handler. The receiver's initializeIncomingTransfer
        // rejects files from unverified peers, so sending on open would cause
        // every queued/broadcast file to land as "Cancelled" until the SAS
        // verification finished. Waiting for verified state means the receive
        // path will accept the file-start.
        verificationService.on('onVerificationComplete', async (result) => {
          if (result.status !== 'verified') {
            updatePeer(result.peerId, {
              verification: 'failed',
              status: 'failed',
            });
            console.error(`Peer ${result.peerId} verification failed: ${result.reason}`);
            return;
          }

          const friendlyName = await cryptoService.generateFriendlyName(result.remoteJwk);
          updatePeer(result.peerId, {
            verification: 'verified',
            sasCode: result.sasCode,
            publicKeyJwk: result.remoteJwk,
            friendlyName,
          });

          // Dispatch any queued/broadcast files to this newly-verified peer.
          await dispatchPendingFilesToPeer(result.peerId);
        });

        // Setup file transfer event handlers
        multiPeerFileTransferService.on('onTransferStart', (transfer) => addTransfer(transfer));
        multiPeerFileTransferService.on('onTransferProgress', (transfer) => 
          updateTransfer(transfer.fileId, transfer)
        );
        multiPeerFileTransferService.on('onTransferComplete', (transfer) => 
          updateTransfer(transfer.fileId, transfer)
        );

        // Join the session
        const result = await signalingService.joinSession(sessionId, sessionSecretRef.current);
        
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
          isHostOnlySending: result.isHostOnlySending ?? false,
        });

        // PoC: tell the WebRTC service our own connection ID so it can
        // assign polite-peer roles deterministically. Must happen before
        // any peer connections are created.
        const localConnId = signalingService.getLocalConnectionId();
        if (localConnId) {
          multiPeerWebRTCService.setLocalConnectionId(localConnId);
        }

        // PoC: bound-SAS invariant. If a renegotiation arrives with a
        // different DTLS fingerprint, tear down with a destructive warning.
        multiPeerWebRTCService.on('onFingerprintInvariantViolated', (peerId, expected, got) => {
          console.error(`MITM detected on ${peerId}: fingerprint changed from ${expected} to ${got}`);
          updatePeer(peerId, { verification: 'failed', status: 'failed' });
        });

        // If there are existing peers, initiate connections to each
        if (result.existingPeers && result.existingPeers.length > 0) {
          for (const peerId of result.existingPeers) {
            console.log('Connecting to existing peer:', peerId);
            addPeer(peerId, { status: 'connecting' });
            await multiPeerWebRTCService.connectToPeer(peerId);
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
      signalingService.off('onSessionLocked');
      signalingService.off('onSessionUnlocked');
      signalingService.off('onKicked');
      signalingService.off('onHostOnlySendingEnabled');
      signalingService.off('onHostOnlySendingDisabled');
      multiPeerWebRTCService.off('onPeerConnected');
      multiPeerWebRTCService.off('onPeerDisconnected');
      multiPeerWebRTCService.off('onDataChannelOpen');
      multiPeerWebRTCService.off('onDataChannelClose');
      verificationService.off('onVerificationComplete');
      verificationService.reset();
      voiceService.reset();
      cameraService.reset();
      chatService.reset();
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
    verificationService.forget(peerId);
    removePeer(peerId);
    updateConnectionStatus();
  }, [removePeer, updateConnectionStatus]);

  const handleOffer = useCallback(async (peerId: string, sdp: string) => {
    console.log('Received offer from:', peerId);

    // Read peers from getState() rather than the captured closure value.
    // Renegotiations (e.g. voice start) re-fire onOffer for an existing
    // peer; a stale closure of `peers` could miss that and call addPeer,
    // which would reset verification/SAS/friendly-name. addPeer is now
    // also idempotent for defense-in-depth.
    if (!useAppStore.getState().peers.has(peerId)) {
      addPeer(peerId, { status: 'connecting' });
    }

    await multiPeerWebRTCService.handleOffer(peerId, sdp);
  }, [addPeer]);

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

  // WebRTC Event handlers
  const handlePeerConnected = useCallback((peerId: string) => {
    console.log('Peer connected:', peerId);
    updatePeer(peerId, { status: 'connected' });
    updateConnectionStatus();
  }, [updatePeer, updateConnectionStatus]);

  const handlePeerDisconnected = useCallback((peerId: string) => {
    console.log('Peer disconnected:', peerId);
    updatePeer(peerId, { status: 'disconnected', dataChannelOpen: false });
    // Tidy up any in-flight transfers to/from this peer so the UI doesn't
    // sit on a "waiting" state forever (the per-peer send loop checks this
    // anyway via isDataChannelOpen, but the cancellation state needs to be
    // reflected in the transfer record so checkTransferComplete fires).
    multiPeerFileTransferService.handlePeerDisconnected(peerId);
    verificationService.forget(peerId);
    updateConnectionStatus();
  }, [updatePeer, updateConnectionStatus]);

  // Dispatch queued and broadcast files to a peer once verification has
  // finished. Called from the verification-complete handler. Splitting this
  // out of handleDataChannelOpen is what makes broadcast actually work:
  // sending before verification finishes results in receiver rejection
  // (Phase 2 enforces verified peers only on the receive path).
  const dispatchPendingFilesToPeer = useCallback(async (peerId: string) => {
    const { broadcastMode, clearQueuedFiles, getBroadcastFiles, getOneTimeQueuedFiles } =
      useAppStore.getState();

    // "Is this the first verified peer in this session lifecycle?" If yes,
    // they get the one-time queued files. We answer it by checking that no
    // other open data channel currently belongs to a verified peer.
    const otherOpenChannels = multiPeerWebRTCService.getOpenChannels().filter(id => id !== peerId);
    const isFirstVerifiedPeer = otherOpenChannels.every(id => !verificationService.isVerified(id));

    if (isFirstVerifiedPeer) {
      const oneTimeFiles = getOneTimeQueuedFiles();
      if (oneTimeFiles.length > 0) {
        console.log(`Sending ${oneTimeFiles.length} queued files to first verified peer: ${peerId}`);
        for (const qf of oneTimeFiles) {
          try {
            await multiPeerFileTransferService.sendFileToPeer(qf.file, peerId);
          } catch (error) {
            console.error('Failed to send queued file:', error);
          }
        }
        clearQueuedFiles(false);
      }
    }

    // Send broadcast files to this newly-verified peer (idempotent: the
    // ref tracks which peers already received the broadcast set).
    if (broadcastMode && !peersReceivedBroadcastRef.current.has(peerId)) {
      const broadcastFiles = getBroadcastFiles();
      if (broadcastFiles.length > 0) {
        console.log(`Sending ${broadcastFiles.length} broadcast files to peer: ${peerId}`);
        peersReceivedBroadcastRef.current.add(peerId);
        for (const qf of broadcastFiles) {
          try {
            await multiPeerFileTransferService.sendFileToPeer(qf.file, peerId);
          } catch (error) {
            console.error('Failed to send broadcast file:', error);
          }
        }
      }
    }
  }, []);

  const handleDataChannelOpen = useCallback(async (peerId: string) => {
    console.log('Data channel opened with:', peerId);
    updatePeer(peerId, { dataChannelOpen: true });
    updateConnectionStatus();

    // Phase 2: kick off bound-SAS verification immediately. File transfers are
    // gated on verification success; if verification fails, the data channel
    // is torn down by the verification service.
    if (sessionId && keyPairRef.current && localKeyJwkRef.current) {
      try {
        await verificationService.start(
          peerId,
          sessionId,
          keyPairRef.current.privateKey,
          localKeyJwkRef.current,
        );
      } catch (err) {
        console.error(`Failed to start verification with ${peerId}:`, err);
      }
    }

    // Send queued files to new peer
    // NOTE: actual queued/broadcast file dispatch was moved to the
    // verification-complete handler. Sending here would arrive at the
    // receiver before verification finished, and the receiver rejects
    // files from unverified peers (Phase 2). See dispatchPendingFilesToPeer.
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
    voiceService.reset();
    cameraService.reset();
    chatService.reset();
    clearPeers();
    signalingService.disconnect();
    navigate('/', { state: { kicked: true } });
  }, [navigate, clearPeers]);

  const handleHostOnlySendingEnabled = useCallback(() => {
    console.log('Host-only sending enabled');
    setConnection({ isHostOnlySending: true });
  }, [setConnection]);

  const handleHostOnlySendingDisabled = useCallback(() => {
    console.log('Host-only sending disabled');
    setConnection({ isHostOnlySending: false });
  }, [setConnection]);

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

  const handleToggleHostOnlySending = useCallback(async () => {
    try {
      if (connection.isHostOnlySending) {
        const result = await signalingService.disableHostOnlySending();
        if (!result.success) {
          console.error('Failed to disable host-only sending:', result.error);
        }
      } else {
        const result = await signalingService.enableHostOnlySending();
        if (!result.success) {
          console.error('Failed to enable host-only sending:', result.error);
        }
      }
    } catch (error) {
      console.error('Failed to toggle host-only sending:', error);
    }
  }, [connection.isHostOnlySending]);

  // File handling - either queue files or send immediately based on state
  const handleFilesSelected = useCallback(async (files: File[]) => {
    const hasOpenChannels = multiPeerWebRTCService.hasOpenDataChannels;
    const { broadcastMode, addQueuedFile } = useAppStore.getState();
    
    // If no peers connected, queue the files
    if (!hasOpenChannels) {
      console.log(`Queueing ${files.length} files (broadcast mode: ${broadcastMode})`);
      for (const file of files) {
        addQueuedFile(file);
      }
      return;
    }

    // If broadcast mode is on, add to broadcast queue and send to all current peers
    if (broadcastMode) {
      console.log(`Adding ${files.length} files to broadcast queue and sending to current peers`);
      for (const file of files) {
        addQueuedFile(file);
        try {
          await multiPeerFileTransferService.broadcastFile(file);
        } catch (error) {
          console.error('Failed to broadcast file:', error);
        }
      }
      return;
    }

    // Normal mode: just broadcast to current peers
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
    voiceService.reset();
    cameraService.reset();
    chatService.reset();
    clearPeers();
    clearQueuedFiles();
    setBroadcastMode(false);
    navigate('/');
  }, [navigate, clearPeers, clearQueuedFiles, setBroadcastMode]);

  const handleDisconnectPeer = useCallback((peerId: string) => {
    multiPeerWebRTCService.closePeerConnection(peerId);
    removePeer(peerId);
    updateConnectionStatus();
  }, [removePeer, updateConnectionStatus]);

  // Toggle broadcast mode
  const handleToggleBroadcastMode = useCallback(() => {
    setBroadcastMode(!broadcastMode);
    // Reset the peers received tracking when turning on broadcast mode
    if (!broadcastMode) {
      peersReceivedBroadcastRef.current.clear();
    }
  }, [broadcastMode, setBroadcastMode]);

  // Toggle auto-receive
  const handleToggleAutoReceive = useCallback(() => {
    setAutoReceive(!autoReceive);
  }, [autoReceive, setAutoReceive]);

  const connectedPeerCount = Array.from(peers.values()).filter(p => p.status === 'connected').length;
  const isConnected = connection.status === 'connected' || connection.status === 'partially-connected';

  // Phase 2: only allow sending when every open data channel is also verified.
  // An unverified peer is either mid-verification or actively failing it; in
  // either case we refuse to expose file data.
  const allOpenChannelsVerified = Array.from(peers.values())
    .filter((p) => p.dataChannelOpen)
    .every((p) => p.verification === 'verified');

  // Can't send if host-only sending is enabled and you're not the host
  const hostOnlyRestricted = connection.isHostOnlySending && !connection.isHost;
  const canSendFiles =
    isConnected
    && multiPeerWebRTCService.hasOpenDataChannels
    && allOpenChannelsVerified
    && !hostOnlyRestricted;
  // Allow queueing files when alone in session (but not if host-only restricted)
  const canQueueFiles = !canSendFiles && peers.size === 0 && !hostOnlyRestricted;

  return (
    <div className="min-h-screen p-4 md:p-8 relative">
      <UserHeader />
      
      <div className="max-w-2xl mx-auto pt-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 
            className="text-2xl font-bold text-white cursor-pointer hover:text-gray-300 transition-colors"
            onClick={() => navigate('/')}
            title="Go to home page"
          >
            📤 Sendie
          </h1>
          <div className="flex items-center gap-4">
            {/* Auto-receive toggle */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Auto-receive</span>
              <button
                onClick={handleToggleAutoReceive}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  autoReceive ? 'bg-green-600' : 'bg-gray-600'
                }`}
                title={autoReceive ? 'Auto-receive enabled' : 'Auto-receive disabled'}
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                    autoReceive ? 'translate-x-5' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
            <button
              onClick={handleLeaveSession}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              title="Leave this session and return to home"
            >
              Leave Session
            </button>
          </div>
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
              <div className="flex items-center gap-2">
                <button
                  onClick={handleToggleHostOnlySending}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    connection.isHostOnlySending
                      ? 'bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 border border-purple-600/50'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
                  }`}
                  title={connection.isHostOnlySending ? 'Only you can send files' : 'Everyone can send files'}
                >
                  {connection.isHostOnlySending ? (
                    <>
                      <span>📤</span>
                      <span>Host Only</span>
                    </>
                  ) : (
                    <>
                      <span>👥</span>
                      <span>Everyone</span>
                    </>
                  )}
                </button>
                <button
                  onClick={handleToggleLock}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    connection.isLocked
                      ? 'bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-600/50'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
                  }`}
                  title={connection.isLocked ? 'Unlock session to allow new people to join' : 'Lock session to prevent new people from joining'}
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
            </div>
            <div className="mt-2 text-xs text-gray-500 space-y-1">
              {connection.isHostOnlySending && (
                <p>Only you can send files in this session.</p>
              )}
              {connection.isLocked && (
                <p>New people cannot join this session while it's locked.</p>
              )}
            </div>
          </div>
        )}

        {/* Locked Session Indicator (for non-hosts) */}
        {!connection.isHost && connection.isLocked && (
          <div className="mt-4 p-3 bg-gray-800/50 rounded-lg border border-gray-700 flex items-center gap-2">
            <span>🔒</span>
            <span className="text-sm text-gray-400">This session is locked by the host</span>
          </div>
        )}

        {/* Host-Only Sending Indicator (for non-hosts) */}
        {!connection.isHost && connection.isHostOnlySending && (
          <div className="mt-4 p-3 bg-gray-800/50 rounded-lg border border-purple-600/30 flex items-center gap-2">
            <span>📤</span>
            <span className="text-sm text-purple-400">Only the host can send files in this session</span>
          </div>
        )}

        {/* Session Link (for waiting for peers) */}
        {(connection.status === 'waiting-for-peer' || peers.size < connection.maxPeers - 1) && sessionId && !connection.isLocked && (
          <div className="mt-4">
            <SessionLink sessionId={sessionId} sessionSecret={sessionSecretRef.current ?? ''} />
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

        {/* Voice PoC: Start / Stop / Mute. Renders inert until the user
            explicitly clicks Start. Currently audio-only; see
            docs/voice-poc-notes.md and the realtime-av proposal. */}
        {peers.size > 0 && (
          <div className="mt-4 flex flex-wrap gap-3">
            <VoiceControls />
            <CameraControls />
          </div>
        )}

        {/* Remote video tiles for peers who are sharing camera. */}
        {peers.size > 0 && (
          <div className="mt-4">
            <RemoteVideos peers={peers} />
          </div>
        )}

        {/* Chat: separate data channel so file transfer flow control does
            not delay messages. Plain text only. */}
        {peers.size > 0 && (
          <div className="mt-4">
            <ChatPanel />
          </div>
        )}

        {/* File Queue & Broadcast Mode Toggle */}
        {(canSendFiles || canQueueFiles || queuedFiles.length > 0) && (
          <div className="mt-6">
            <FileQueue
              queuedFiles={queuedFiles}
              broadcastMode={broadcastMode}
              onRemoveFile={removeQueuedFile}
              onClearQueue={clearQueuedFiles}
              onToggleBroadcastMode={handleToggleBroadcastMode}
            />
          </div>
        )}

        {/* File Drop Zone */}
        <div className="mt-6">
          <FileDropZone
            onFilesSelected={handleFilesSelected}
            disabled={!canSendFiles && !canQueueFiles}
            disabledMessage={hostOnlyRestricted ? 'Only the host can send files in this session' : undefined}
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
          {connection.status === 'waiting-for-peer' && queuedFiles.length === 0 && (
            <p>Share the link above with others to connect and start transferring files.</p>
          )}
          {connection.status === 'waiting-for-peer' && queuedFiles.length > 0 && (
            <p>Files queued! They'll be sent automatically when someone joins.</p>
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
