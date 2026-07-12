import { signalingService } from './SignalingService';

export type MultiPeerWebRTCEvents = {
  onPeerConnected: (peerId: string) => void;
  onPeerDisconnected: (peerId: string) => void;
  onDataChannelOpen: (peerId: string) => void;
  onDataChannelClose: (peerId: string) => void;
  onDataChannelMessage: (peerId: string, data: ArrayBuffer | string) => void;  // Chat channel uses a separate SCTP stream so file-transfer flow control
  // does not head-of-line block messages.
  onChatChannelOpen: (peerId: string) => void;
  onChatMessage: (peerId: string, data: string) => void;  onError: (peerId: string, error: Error) => void;
  // PoC: voice/video. Fires when the remote peer adds a media track.
  // The page wires this to a hidden <audio autoplay>/<video> element.
  onTrack: (peerId: string, stream: MediaStream, kind: 'audio' | 'video') => void;
  // PoC: bound-SAS invariant violation. Fires if a renegotiation arrives
  // with a DTLS fingerprint different from the one observed at first
  // verification. The page tears down the channel.
  onFingerprintInvariantViolated: (peerId: string, expected: string, got: string) => void;
};

interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

interface PeerConnectionInfo {
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  // Separate channel for human chat so file-transfer flow control does not
  // delay messages. Same DTLS / SCTP transport, different SCTP stream.
  chatChannel: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[];
  // Perfect-negotiation per-peer state. See
  // https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
  makingOffer: boolean;
  ignoreOffer: boolean;
  // The polite peer rolls back on glare. Determined by lexicographic
  // comparison of connection IDs so both ends agree without coordination.
  polite: boolean;
  // Bound-SAS invariant: pinned remote DTLS fingerprint. Set by
  // VerificationService when verification succeeds. Any subsequent
  // renegotiation whose remote SDP fingerprint differs is treated as a
  // possible MITM and the channel is torn down.
  pinnedRemoteFp: string | null;
}

/**
 * Multi-peer WebRTC service that manages connections to multiple peers
 * using a full-mesh topology.
 */
export class MultiPeerWebRTCService {
  private peerConnections: Map<string, PeerConnectionInfo> = new Map();
  // Events support multiple subscribers (the file-transfer service and the
  // voice service both want onDataChannelMessage / onPeerDisconnected /
  // onTrack). We hand out an unsubscribe function from on() so callers can
  // tear down cleanly on session leave.
  private events: { [K in keyof MultiPeerWebRTCEvents]?: Set<MultiPeerWebRTCEvents[K]> } = {};
  private iceServers: IceServerConfig[] = [];
  private initialized = false;
  // Local connection ID, set after the SignalR JoinSession call returns.
  // Used to determine the polite-peer role (lower-id peer is polite).
  private localConnectionId: string | null = null;
  // Local outbound audio/video tracks the page has asked us to share.
  // We add these to every existing peer connection plus any new ones.
  private localTracks: MediaStreamTrack[] = [];
  private localStream: MediaStream | null = null;
  // Per-track stream tag. localStream above is kept for backwards-compat
  // (single-stream callers use getLocalStream()), but when both camera and
  // screen are active we have two distinct streams and need to associate
  // each track with the right one for new-peer-join replays. Without this,
  // a peer joining mid-share would see both tracks fused under whichever
  // stream was most recently passed to addLocalTrack().
  private trackStreams: Map<MediaStreamTrack, MediaStream> = new Map();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    // Fetch ICE server configuration
    try {
      const response = await fetch('/api/ice-servers');
      this.iceServers = await response.json();
    } catch (error) {
      console.warn('Failed to fetch ICE servers, using defaults:', error);
      this.iceServers = [
        { urls: ['stun:stun.l.google.com:19302'] },
        { urls: ['stun:stun1.l.google.com:19302'] },
      ];
    }
    
    this.initialized = true;
  }

  /**
   * Subscribe to an event. Multiple subscribers are supported per event.
   * Returns an unsubscribe function.
   */
  on<K extends keyof MultiPeerWebRTCEvents>(event: K, handler: MultiPeerWebRTCEvents[K]): () => void {
    let set = this.events[event];
    if (!set) {
      set = new Set() as never;
      this.events[event] = set;
    }
    (set as Set<MultiPeerWebRTCEvents[K]>).add(handler);
    return () => {
      (this.events[event] as Set<MultiPeerWebRTCEvents[K]> | undefined)?.delete(handler);
    };
  }

  private emit<K extends keyof MultiPeerWebRTCEvents>(
    event: K,
    ...args: Parameters<MultiPeerWebRTCEvents[K]>
  ): void {
    const set = this.events[event] as Set<MultiPeerWebRTCEvents[K]> | undefined;
    if (!set) return;
    for (const handler of set) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (handler as (...a: any[]) => void)(...args);
      } catch (err) {
        console.error(`Handler for ${event} threw:`, err);
      }
    }
  }

  /**
   * Tell the service what our own SignalR connection ID is. Required for
   * deterministic polite-peer assignment in the perfect-negotiation pattern.
   */
  setLocalConnectionId(id: string): void {
    this.localConnectionId = id;
  }

  /**
   * Create a new peer connection for a specific peer.
   *
   * Sets up perfect-negotiation handlers (negotiationneeded, ICE candidate
   * forwarding, ondatachannel, ontrack). The actual offer is generated by
   * the negotiationneeded handler whenever the local description goes out
   * of sync with the remote — either at initial setup (when we add the
   * data channel below) or later when the page calls addLocalTrack.
   */
  createPeerConnection(peerId: string): RTCPeerConnection {
    // Close existing connection if any
    if (this.peerConnections.has(peerId)) {
      this.closePeerConnection(peerId);
    }

    const connection = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    const peerInfo: PeerConnectionInfo = {
      connection,
      dataChannel: null,
      chatChannel: null,
      pendingCandidates: [],
      makingOffer: false,
      ignoreOffer: false,
      // polite is resolved lazily by getPolite() below. Resolving here
      // would freeze in `false` if setLocalConnectionId() has not been
      // called yet, which would cause both peers to think they are
      // impolite (glare deadlock). The lazy form re-checks each time we
      // need it, so it is correct as long as setLocalConnectionId() has
      // been called by the time the first offer/answer arrives.
      polite: false,
      pinnedRemoteFp: null,
    };

    // Perfect-negotiation: every time our local description needs to change
    // (new data channel, new track, ICE restart, etc.), this fires and we
    // produce an offer. setLocalDescription() with no argument is the
    // "implicit" form that picks the right description type for us.
    connection.onnegotiationneeded = async () => {
      try {
        peerInfo.makingOffer = true;
        await connection.setLocalDescription();
        if (connection.localDescription?.sdp) {
          await signalingService.sendOfferTo(peerId, connection.localDescription.sdp);
        }
      } catch (err) {
        console.error(`negotiationneeded failed for ${peerId}:`, err);
      } finally {
        peerInfo.makingOffer = false;
      }
    };

    // ICE candidate handler - send to specific peer
    connection.onicecandidate = async (event) => {
      if (event.candidate) {
        try {
          await signalingService.sendIceCandidateTo(
            peerId,
            event.candidate.candidate,
            event.candidate.sdpMid,
            event.candidate.sdpMLineIndex
          );
        } catch (error) {
          console.error(`Failed to send ICE candidate to ${peerId}:`, error);
        }
      }
    };

    // Connection state change handler
    connection.oniceconnectionstatechange = () => {
      console.log(`ICE connection state for ${peerId}:`, connection.iceConnectionState);
      
      switch (connection.iceConnectionState) {
        case 'connected':
        case 'completed':
          this.emit('onPeerConnected', peerId);
          break;
        case 'disconnected':
        case 'failed':
        case 'closed':
          this.emit('onPeerDisconnected', peerId);
          break;
      }
    };

    // Handle incoming data channel (when we're the answerer).
    // Routed by label: 'fileTransfer' is the original payload channel,
    // 'chat' is for human messages.
    connection.ondatachannel = (event) => {
      console.log(`Received '${event.channel.label}' channel from ${peerId}`);
      if (event.channel.label === 'chat') {
        this.setupChatChannel(peerId, event.channel);
      } else {
        this.setupDataChannel(peerId, event.channel);
      }
    };

    // Handle incoming media tracks (audio/video).
    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      console.log(`Received ${event.track.kind} track from ${peerId}`);
      this.emit('onTrack', peerId, stream, event.track.kind as 'audio' | 'video');
    };

    this.peerConnections.set(peerId, peerInfo);

    // If we already have local tracks (the user enabled voice before this
    // peer joined), add them now. This will trigger negotiationneeded.
    for (const track of this.localTracks) {
      try {
        const stream = this.trackStreams.get(track) ?? this.localStream;
        if (stream) {
          connection.addTrack(track, stream);
        } else {
          connection.addTrack(track);
        }
      } catch (err) {
        console.warn(`Could not add existing local track to ${peerId}:`, err);
      }
    }

    return connection;
  }

  /**
   * Setup data channel for a peer
   */
  private setupDataChannel(peerId: string, channel: RTCDataChannel): void {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo) return;

    peerInfo.dataChannel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 64 * 1024;

    channel.onopen = () => {
      console.log(`Data channel opened with ${peerId}`);
      // Report connection established to server for TTL management
      signalingService.reportConnectionEstablished(peerId);
      this.emit('onDataChannelOpen', peerId);
    };

    channel.onclose = () => {
      console.log(`Data channel closed with ${peerId}`);
      // Report connection closed to server for TTL management
      signalingService.reportConnectionClosed(peerId);
      this.emit('onDataChannelClose', peerId);
    };

    channel.onerror = (error) => {
      console.error(`Data channel error with ${peerId}:`, error);
      this.emit('onError', peerId, new Error('Data channel error'));
    };

    channel.onmessage = (event) => {
      this.emit('onDataChannelMessage', peerId, event.data);
    };
  }

  /**
   * Set up a chat data channel for a peer. Separate from the main file
   * transfer channel so chunks and chat messages don't head-of-line block
   * each other.
   */
  private setupChatChannel(peerId: string, channel: RTCDataChannel): void {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo) return;
    peerInfo.chatChannel = channel;
    channel.onopen = () => {
      console.log(`Chat channel opened with ${peerId}`);
      this.emit('onChatChannelOpen', peerId);
    };
    channel.onclose = () => {
      console.log(`Chat channel closed with ${peerId}`);
    };
    channel.onerror = (error) => {
      console.error(`Chat channel error with ${peerId}:`, error);
    };
    channel.onmessage = (event) => {
      // Chat messages are JSON strings only.
      if (typeof event.data === 'string') {
        this.emit('onChatMessage', peerId, event.data);
      }
    };
  }

  /**
   * Initiate a connection to a specific peer (existing peer reaching out
   * to a newly-joined one). Creates the data channel; the perfect-negotiation
   * handler will produce the offer asynchronously.
   */
  async connectToPeer(peerId: string): Promise<void> {
    let peerInfo = this.peerConnections.get(peerId);

    if (!peerInfo) {
      this.createPeerConnection(peerId);
      peerInfo = this.peerConnections.get(peerId)!;
    }

    // Create data channel as initiator. This triggers negotiationneeded
    // which produces the offer.
    const channel = peerInfo.connection.createDataChannel('fileTransfer', {
      ordered: true,
    });
    this.setupDataChannel(peerId, channel);

    // Open the chat channel alongside file transfer. Same DTLS handshake,
    // separate SCTP stream so file flow control doesn't block chat.
    const chat = peerInfo.connection.createDataChannel('chat', {
      ordered: true,
    });
    this.setupChatChannel(peerId, chat);
  }

  /**
   * Back-compat shim. The page still calls createOfferTo today.
   * @deprecated use connectToPeer.
   */
  async createOfferTo(peerId: string): Promise<void> {
    return this.connectToPeer(peerId);
  }

  /**
   * Resolve whether the local peer should play the polite role for the given
   * peer. Lexicographic on connection IDs so both ends agree without
   * coordination. Returns false if our local connection ID is not yet known
   * — in that case the caller has set up the connection too eagerly and
   * glare can deadlock; we log a warning so the bug is visible.
   */
  private getPolite(peerId: string): boolean {
    if (!this.localConnectionId) {
      console.warn(`getPolite(${peerId}) called before setLocalConnectionId; defaulting to impolite`);
      return false;
    }
    return this.localConnectionId < peerId;
  }

  /**
   * Handle an incoming offer from a specific peer (perfect-negotiation).
   *
   * If we are mid-offer ourselves and we are the impolite peer, we ignore
   * the incoming offer; the polite peer will roll back theirs. Otherwise,
   * we accept the remote description (rolling back our local one if needed)
   * and respond.
   */
  async handleOffer(peerId: string, sdp: string): Promise<void> {
    let peerInfo = this.peerConnections.get(peerId);

    if (!peerInfo) {
      this.createPeerConnection(peerId);
      peerInfo = this.peerConnections.get(peerId)!;
    }

    const connection = peerInfo.connection;
    const description: RTCSessionDescriptionInit = { type: 'offer', sdp };

    // Glare detection: if we are the impolite peer mid-offer, ignore this
    // incoming offer. The remote (polite) peer will roll its own offer back.
    const polite = this.getPolite(peerId);
    const offerCollision =
      peerInfo.makingOffer || connection.signalingState !== 'stable';
    peerInfo.ignoreOffer = !polite && offerCollision;
    if (peerInfo.ignoreOffer) {
      console.log(`Ignoring offer from ${peerId} (impolite + glare)`);
      return;
    }

    await connection.setRemoteDescription(description);
    // Bound-SAS invariant check: if we have a pinned remote fingerprint
    // (verification has previously succeeded), the new SDP must match it.
    if (!this.checkFingerprintInvariant(peerId)) {
      // checkFingerprintInvariant already fired the event and torn down.
      return;
    }
    await this.processPendingCandidates(peerId);
    await connection.setLocalDescription();
    if (connection.localDescription?.sdp) {
      await signalingService.sendAnswerTo(peerId, connection.localDescription.sdp);
    }
  }

  /**
   * Handle an incoming answer from a specific peer (perfect-negotiation).
   */
  async handleAnswer(peerId: string, sdp: string): Promise<void> {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo) {
      throw new Error(`Peer connection not found for ${peerId}`);
    }

    await peerInfo.connection.setRemoteDescription({ type: 'answer', sdp });
    if (!this.checkFingerprintInvariant(peerId)) {
      return;
    }
    await this.processPendingCandidates(peerId);
  }

  /**
   * Handle an incoming ICE candidate from a specific peer
   */
  async handleIceCandidate(
    peerId: string, 
    candidate: string, 
    sdpMid: string | null, 
    sdpMLineIndex: number | null
  ): Promise<void> {
    const iceCandidate: RTCIceCandidateInit = {
      candidate,
      sdpMid,
      sdpMLineIndex,
    };

    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo) {
      console.warn(`No peer connection for ${peerId}, creating one`);
      this.createPeerConnection(peerId);
      this.peerConnections.get(peerId)!.pendingCandidates.push(iceCandidate);
      return;
    }

    if (!peerInfo.connection.remoteDescription) {
      // Queue the candidate until remote description is set
      peerInfo.pendingCandidates.push(iceCandidate);
      return;
    }

    try {
      await peerInfo.connection.addIceCandidate(iceCandidate);
    } catch (error) {
      // Per perfect-negotiation, swallow candidate errors when we ignored
      // the matching offer. Otherwise, surface.
      if (!peerInfo.ignoreOffer) {
        console.error(`Failed to add ICE candidate for ${peerId}:`, error);
      }
    }
  }

  /**
   * Process pending ICE candidates for a peer
   */
  private async processPendingCandidates(peerId: string): Promise<void> {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo) return;

    for (const candidate of peerInfo.pendingCandidates) {
      try {
        await peerInfo.connection.addIceCandidate(candidate);
      } catch (error) {
        console.error(`Failed to add pending ICE candidate for ${peerId}:`, error);
      }
    }
    peerInfo.pendingCandidates = [];
  }

  /**
   * Get the local DTLS fingerprint for a peer connection (from the local SDP).
   * Returns null if no localDescription is set yet.
   */
  getLocalFingerprint(peerId: string): string | null {
    const info = this.peerConnections.get(peerId);
    const sdp = info?.connection.localDescription?.sdp;
    if (!sdp) return null;
    const m = sdp.match(/^a=fingerprint:(\S+)\s+(\S+)/m);
    return m ? `${m[1].toLowerCase()} ${m[2].toLowerCase()}` : null;
  }

  /**
   * Get the remote DTLS fingerprint for a peer connection (from remote SDP).
   * Returns null if no remoteDescription is set yet.
   */
  getRemoteFingerprint(peerId: string): string | null {
    const info = this.peerConnections.get(peerId);
    const sdp = info?.connection.remoteDescription?.sdp;
    if (!sdp) return null;
    const m = sdp.match(/^a=fingerprint:(\S+)\s+(\S+)/m);
    return m ? `${m[1].toLowerCase()} ${m[2].toLowerCase()}` : null;
  }

  /**
   * Pin the remote DTLS fingerprint for a peer. Called by VerificationService
   * when bound-SAS verification succeeds. Subsequent renegotiations whose
   * remote SDP fingerprint differs are rejected.
   *
   * The DTLS connection itself does not change across SDP renegotiations,
   * so the fingerprint MUST stay constant for the lifetime of the channel.
   * If the signaling server attempts a MITM by rewriting fingerprints on
   * a renegotiation, this catches it.
   */
  pinRemoteFingerprint(peerId: string, fingerprint: string): void {
    const info = this.peerConnections.get(peerId);
    if (!info) return;
    info.pinnedRemoteFp = fingerprint.toLowerCase();
    console.log(`Pinned remote fingerprint for ${peerId}`);
  }

  /**
   * Verify that the current remote SDP fingerprint matches the pinned one.
   * Returns true if the invariant holds (or if no pin yet exists).
   * On violation, fires onFingerprintInvariantViolated and tears down the
   * connection.
   */
  private checkFingerprintInvariant(peerId: string): boolean {
    const info = this.peerConnections.get(peerId);
    if (!info?.pinnedRemoteFp) return true;
    const current = this.getRemoteFingerprint(peerId);
    if (!current) return true; // no remote desc yet, nothing to check
    if (current === info.pinnedRemoteFp) return true;

    console.error(
      `Fingerprint invariant violated for ${peerId}: expected ${info.pinnedRemoteFp}, got ${current}`,
    );
    this.emit('onFingerprintInvariantViolated', peerId, info.pinnedRemoteFp, current);
    this.closePeerConnection(peerId);
    return false;
  }

  // ----- Local media track management -----------------------------------

  /**
   * Add one local track to every existing peer connection (and to any
   * future ones that get created). The optional stream tag is forwarded
   * to addTrack so receivers can correlate audio + video into a single
   * MediaStream on the remote side.
   *
   * Triggers negotiationneeded on each peer connection.
   */
  addLocalTrack(track: MediaStreamTrack, stream?: MediaStream): void {
    if (this.localTracks.includes(track)) return;
    this.localTracks.push(track);
    if (stream) {
      this.localStream = stream;
      this.trackStreams.set(track, stream);
    }
    for (const [peerId, info] of this.peerConnections) {
      try {
        if (stream) {
          info.connection.addTrack(track, stream);
        } else {
          info.connection.addTrack(track);
        }
      } catch (err) {
        console.warn(`Could not add track to ${peerId}:`, err);
      }
    }
  }

  /**
   * Convenience: add every track from a MediaStream. Equivalent to calling
   * addLocalTrack() for each track.
   */
  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      this.addLocalTrack(track, stream);
    }
  }

  /**
   * Stop sharing a single track. Removes it from every peer connection
   * (which triggers renegotiation) and stops the underlying device.
   *
   * Order-of-ops matters: we remove from peer connections BEFORE stopping
   * tracks, otherwise getSenders().filter(sender.track === track) misses
   * because stopped tracks may compare unequally on some browsers.
   */
  removeLocalTrack(track: MediaStreamTrack): void {
    const idx = this.localTracks.indexOf(track);
    if (idx < 0) return;
    // 1. Remove the matching senders from every peer connection.
    for (const info of this.peerConnections.values()) {
      const senders = info.connection.getSenders();
      for (const sender of senders) {
        if (sender.track === track) {
          try {
            info.connection.removeTrack(sender);
          } catch (err) {
            console.warn('removeTrack failed:', err);
          }
        }
      }
    }
    // 2. Stop the device-side track.
    try {
      track.stop();
    } catch {
      // ignore
    }
    this.localTracks.splice(idx, 1);
    this.trackStreams.delete(track);
    if (this.localTracks.length === 0) {
      this.localStream = null;
    }
  }

  /**
   * Stop sharing every previously-added local track.
   */
  removeLocalStream(): void {
    // Copy because removeLocalTrack mutates the underlying array.
    for (const track of [...this.localTracks]) {
      this.removeLocalTrack(track);
    }
  }

  /**
   * Replace the currently-sent video track with a new one, in place,
   * across every peer connection. Uses RTCRtpSender.replaceTrack which
   * does NOT trigger renegotiation; the receiver's stream stays bound,
   * its track id changes underneath, and they see the new feed
   * seamlessly.
   *
   * Returns true if at least one sender was matched (in which case the
   * caller should not also call addLocalTrack), false if no matching
   * sender was found (in which case the caller falls back to
   * remove+add).
   */
  replaceLocalVideoTrack(newTrack: MediaStreamTrack): boolean {
    if (newTrack.kind !== 'video') return false;
    let matched = false;
    // Find the existing video track index in localTracks; replace there
    // so the trackStreams + localStream bookkeeping stays consistent.
    const oldIndex = this.localTracks.findIndex((t) => t.kind === 'video');
    if (oldIndex < 0) return false;
    const oldTrack = this.localTracks[oldIndex];
    const stream = this.trackStreams.get(oldTrack);

    for (const [peerId, info] of this.peerConnections) {
      try {
        const sender = info.connection
          .getSenders()
          .find((s) => s.track === oldTrack || s.track?.kind === 'video');
        if (sender) {
          // replaceTrack returns a Promise; we don't await per peer
          // because we want to fire them in parallel. Failures are
          // logged but non-fatal.
          sender.replaceTrack(newTrack).catch((err) => {
            console.warn(`replaceTrack failed for ${peerId}:`, err);
          });
          matched = true;
        }
      } catch (err) {
        console.warn(`replaceTrack threw for ${peerId}:`, err);
      }
    }

    if (matched) {
      this.localTracks[oldIndex] = newTrack;
      this.trackStreams.delete(oldTrack);
      if (stream) this.trackStreams.set(newTrack, stream);
    }
    return matched;
  }

  /**
   * Get the currently-shared local stream, if any. Useful for self-meter
   * and self-preview.
   */
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  /**
   * Send raw bytes (or string) to a specific peer.
   * @returns true if the data channel was open and the send was issued.
   */
  sendTo(peerId: string, data: ArrayBuffer | string): boolean {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo?.dataChannel || peerInfo.dataChannel.readyState !== 'open') {
      console.error(`Data channel not ready for ${peerId}`);
      return false;
    }

    try {
      peerInfo.dataChannel.send(data as ArrayBuffer);
      return true;
    } catch (error) {
      console.error(`Failed to send data to ${peerId}:`, error);
      return false;
    }
  }

  /**
   * Broadcast data to all connected peers with open data channels
   */
  broadcast(data: ArrayBuffer | string): { success: string[]; failed: string[] } {
    const success: string[] = [];
    const failed: string[] = [];

    for (const [peerId, peerInfo] of this.peerConnections) {
      if (peerInfo.dataChannel?.readyState === 'open') {
        try {
          peerInfo.dataChannel.send(data as ArrayBuffer);
          success.push(peerId);
        } catch (error) {
          console.error(`Failed to send to ${peerId}:`, error);
          failed.push(peerId);
        }
      } else {
        failed.push(peerId);
      }
    }

    return { success, failed };
  }

  /**
   * Send a chat message to a specific peer over the chat data channel.
   * @returns true if the channel was open and the send was issued.
   */
  sendChatTo(peerId: string, data: string): boolean {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo?.chatChannel || peerInfo.chatChannel.readyState !== 'open') {
      return false;
    }
    try {
      peerInfo.chatChannel.send(data);
      return true;
    } catch (error) {
      console.error(`Failed to send chat to ${peerId}:`, error);
      return false;
    }
  }

  /**
   * Broadcast a chat message to every peer whose chat channel is open.
   */
  broadcastChat(data: string): { success: string[]; failed: string[] } {
    const success: string[] = [];
    const failed: string[] = [];
    for (const [peerId, peerInfo] of this.peerConnections) {
      if (peerInfo.chatChannel?.readyState === 'open') {
        try {
          peerInfo.chatChannel.send(data);
          success.push(peerId);
        } catch (error) {
          console.error(`Failed to broadcast chat to ${peerId}:`, error);
          failed.push(peerId);
        }
      } else {
        failed.push(peerId);
      }
    }
    return { success, failed };
  }

  /**
   * Whether the chat channel is open for a peer.
   */
  isChatChannelOpen(peerId: string): boolean {
    const info = this.peerConnections.get(peerId);
    return info?.chatChannel?.readyState === 'open';
  }

  /**
   * Get all peers with open data channels
   */
  getOpenChannels(): string[] {
    return Array.from(this.peerConnections.entries())
      .filter(([, info]) => info.dataChannel?.readyState === 'open')
      .map(([peerId]) => peerId);
  }

  /**
   * Get all connected peer IDs
   */
  getConnectedPeers(): string[] {
    return Array.from(this.peerConnections.entries())
      .filter(([, info]) => {
        const state = info.connection.iceConnectionState;
        return state === 'connected' || state === 'completed';
      })
      .map(([peerId]) => peerId);
  }

  /**
   * Check if a specific peer has an open data channel
   */
  isDataChannelOpen(peerId: string): boolean {
    const peerInfo = this.peerConnections.get(peerId);
    return peerInfo?.dataChannel?.readyState === 'open' || false;
  }

  /**
   * Check if a specific peer is connected
   */
  isPeerConnected(peerId: string): boolean {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo) return false;
    const state = peerInfo.connection.iceConnectionState;
    return state === 'connected' || state === 'completed';
  }

  /**
   * Estimate the current round-trip time to a peer in seconds, or null
   * if no fresh sample is available. Pulls from the standard
   * RTCStatsReport (candidate-pair currentRoundTripTime), which the
   * underlying RTCPeerConnection maintains automatically while the
   * connection is active. Used by the watch-party clock-sync code so
   * we don't have to roll our own ping protocol.
   *
   * Returns null on browsers / setups where the stat is unavailable;
   * callers should fall back to a default (e.g. 100 ms) in that case.
   */
  async getCurrentRoundTripTime(peerId: string): Promise<number | null> {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo) return null;
    try {
      const stats = await peerInfo.connection.getStats();
      let rtt: number | null = null;
      // Prefer a 'nominated' candidate pair if present (the active
      // path); otherwise take the first pair with a sample.
      stats.forEach((report) => {
        if (report.type !== 'candidate-pair') return;
        const pair = report as RTCIceCandidatePairStats & { nominated?: boolean };
        if (typeof pair.currentRoundTripTime !== 'number') return;
        if (rtt === null || pair.nominated) {
          rtt = pair.currentRoundTripTime;
        }
      });
      return rtt;
    } catch {
      return null;
    }
  }

  /**
   * Get buffered amount for a specific peer's data channel
   */
  getBufferedAmount(peerId: string): number {
    const peerInfo = this.peerConnections.get(peerId);
    return peerInfo?.dataChannel?.bufferedAmount ?? 0;
  }

  /**
   * Check if buffer is low for all peers (for flow control)
   */
  isBufferLow(): boolean {
    for (const peerInfo of this.peerConnections.values()) {
      if (peerInfo.dataChannel) {
        if (peerInfo.dataChannel.bufferedAmount >= peerInfo.dataChannel.bufferedAmountLowThreshold) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Register a one-shot callback that fires when the given peer's data
   * channel reaches its bufferedAmountLow threshold. Replaces any prior
   * one-shot callback for the same peer (the caller is responsible for
   * pairing each pause with exactly one onBufferedAmountLow registration,
   * which is the natural shape for chunked-send loops).
   *
   * Per-peer rather than global: an earlier global form set the same
   * callback on every data channel, which meant concurrent sends to two
   * peers would clobber each other's wakeups and one peer would freeze
   * forever.
   */
  onBufferedAmountLow(peerId: string, callback: () => void): void {
    const info = this.peerConnections.get(peerId);
    if (!info?.dataChannel) return;
    info.dataChannel.onbufferedamountlow = callback;
  }

  /**
   * Close connection to a specific peer
   */
  closePeerConnection(peerId: string): void {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo) return;

    if (peerInfo.dataChannel) {
      peerInfo.dataChannel.close();
    }
    if (peerInfo.chatChannel) {
      peerInfo.chatChannel.close();
    }
    peerInfo.connection.close();
    this.peerConnections.delete(peerId);
  }

  /**
   * Close all peer connections
   */
  closeAllConnections(): void {
    for (const peerId of this.peerConnections.keys()) {
      this.closePeerConnection(peerId);
    }
  }

  /**
   * Check if any peer is connected
   */
  get hasConnectedPeers(): boolean {
    return this.getConnectedPeers().length > 0;
  }

  /**
   * Check if any data channel is open
   */
  get hasOpenDataChannels(): boolean {
    return this.getOpenChannels().length > 0;
  }

  /**
   * Get the number of connected peers
   */
  get connectedPeerCount(): number {
    return this.getConnectedPeers().length;
  }
}

export const multiPeerWebRTCService = new MultiPeerWebRTCService();
