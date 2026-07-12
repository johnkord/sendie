import * as signalR from '@microsoft/signalr';

export type SignalingEvents = {
  onPeerJoined: (peerId: string) => void;
  onPeerLeft: (peerId: string) => void;
  onOffer: (peerId: string, sdp: string) => void;
  onAnswer: (peerId: string, sdp: string) => void;
  onIceCandidate: (peerId: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void;
  onPublicKey: (peerId: string, keyJwk: string) => void;
  onSignature: (peerId: string, signature: string, challenge: string) => void;
  // Session control events
  onSessionLocked: () => void;
  onSessionUnlocked: () => void;
  onKicked: () => void;
  onHostOnlySendingEnabled: () => void;
  onHostOnlySendingDisabled: () => void;
  onHostConnectionChanged: (hostConnectionId: string | null) => void;
  onReconnecting: (error: Error | null) => void;
  onReconnected: (connectionId: string | null) => void;
  onClosed: (error: Error | null) => void;
};

export class SignalingService {
  private connection: signalR.HubConnection | null = null;
  private events: Partial<SignalingEvents> = {};

  async connect(): Promise<void> {
    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      return;
    }

    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/signaling')
      .withAutomaticReconnect([0, 1000, 5000, 10000, 30000]) // Retry pattern for long-lived sessions
      .withStatefulReconnect()  // Enable stateful reconnect for seamless recovery
      .withServerTimeout(60000)  // 60 seconds server timeout (matches server config)
      .withKeepAliveInterval(15000)  // 15 seconds keep-alive (matches server config)
      .configureLogging(signalR.LogLevel.Information)
      .build();
    this.connection = connection;
    const isCurrentConnection = () => this.connection === connection;

    // Register event handlers
    connection.on('OnPeerJoined', (peerId: string) => {
      if (!isCurrentConnection()) return;
      this.events.onPeerJoined?.(peerId);
    });

    connection.on('OnPeerLeft', (peerId: string) => {
      if (!isCurrentConnection()) return;
      this.events.onPeerLeft?.(peerId);
    });

    connection.on('OnOffer', (peerId: string, sdp: string) => {
      if (!isCurrentConnection()) return;
      this.events.onOffer?.(peerId, sdp);
    });

    connection.on('OnAnswer', (peerId: string, sdp: string) => {
      if (!isCurrentConnection()) return;
      this.events.onAnswer?.(peerId, sdp);
    });

    connection.on('OnIceCandidate', (peerId: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => {
      if (!isCurrentConnection()) return;
      this.events.onIceCandidate?.(peerId, candidate, sdpMid, sdpMLineIndex);
    });

    connection.on('OnPublicKey', (peerId: string, keyJwk: string) => {
      if (!isCurrentConnection()) return;
      this.events.onPublicKey?.(peerId, keyJwk);
    });

    connection.on('OnSignature', (peerId: string, signature: string, challenge: string) => {
      if (!isCurrentConnection()) return;
      this.events.onSignature?.(peerId, signature, challenge);
    });

    // Session control events
    connection.on('OnSessionLocked', () => {
      if (!isCurrentConnection()) return;
      this.events.onSessionLocked?.();
    });

    connection.on('OnSessionUnlocked', () => {
      if (!isCurrentConnection()) return;
      this.events.onSessionUnlocked?.();
    });

    connection.on('OnKicked', () => {
      if (!isCurrentConnection()) return;
      this.events.onKicked?.();
    });

    connection.on('OnHostOnlySendingEnabled', () => {
      if (!isCurrentConnection()) return;
      this.events.onHostOnlySendingEnabled?.();
    });

    connection.on('OnHostOnlySendingDisabled', () => {
      if (!isCurrentConnection()) return;
      this.events.onHostOnlySendingDisabled?.();
    });

    connection.on('OnHostConnectionChanged', (hostConnectionId: string | null) => {
      if (!isCurrentConnection()) return;
      this.events.onHostConnectionChanged?.(hostConnectionId);
    });

    connection.onreconnecting((error) => {
      if (!isCurrentConnection()) return;
      this.events.onReconnecting?.(error ?? null);
    });

    connection.onreconnected((connectionId) => {
      if (!isCurrentConnection()) return;
      this.events.onReconnected?.(connectionId ?? null);
    });

    connection.onclose((error) => {
      if (!isCurrentConnection()) return;
      this.events.onClosed?.(error ?? null);
    });

    try {
      await connection.start();
      if (!isCurrentConnection()) await connection.stop();
    } catch (error) {
      if (isCurrentConnection()) this.connection = null;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    // Detach first. A new room may call connect() while this stop is still
    // awaiting transport shutdown; the old stop must never null out the new
    // HubConnection afterward.
    this.connection = null;
    await connection.stop();
  }

  /**
   * Get the local SignalR connection ID once the connection has started.
   * Returns null before connect() resolves. Used by MultiPeerWebRTCService
   * for deterministic polite-peer assignment in perfect negotiation.
   */
  getLocalConnectionId(): string | null {
    return this.connection?.connectionId ?? null;
  }

  on<K extends keyof SignalingEvents>(event: K, handler: SignalingEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof SignalingEvents>(event: K): void {
    delete this.events[event];
  }

  async joinSession(sessionId: string, secret?: string | null): Promise<{ 
    success: boolean; 
    isInitiator?: boolean; 
    existingPeers?: string[]; 
    isHost?: boolean;
    hostConnectionId?: string | null;
    maxPeers?: number;
    isLocked?: boolean;
    isHostOnlySending?: boolean;
    error?: string 
  }> {
    if (!this.connection) throw new Error('Not connected');
    // Phase 6.1 (audit C4): the join secret is required server-side. We pass
    // null when missing so the server returns a clean error rather than
    // throwing at the deserializer.
    return await this.connection.invoke('JoinSession', sessionId, secret ?? null);
  }

  async leaveSession(): Promise<void> {
    if (!this.connection) return;
    await this.connection.invoke('LeaveSession');
  }

  // Note: targeted *To variants below are the only WebRTC signaling methods used.
  // Broadcast variants (sendOffer/sendAnswer/sendIceCandidate/sendPublicKey) were removed
  // because the mesh client only ever uses targeted signaling.

  // ============================================
  // Targeted Signaling Methods (for mesh setup)
  // ============================================

  /**
   * Send WebRTC offer to a specific peer (used for mesh topology)
   */
  async sendOfferTo(targetPeerId: string, sdp: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendOfferTo', targetPeerId, sdp);
  }

  /**
   * Send WebRTC answer to a specific peer (used for mesh topology)
   */
  async sendAnswerTo(targetPeerId: string, sdp: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendAnswerTo', targetPeerId, sdp);
  }

  /**
   * Send ICE candidate to a specific peer (used for mesh topology)
   */
  async sendIceCandidateTo(targetPeerId: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendIceCandidateTo', targetPeerId, candidate, sdpMid, sdpMLineIndex);
  }

  /**
   * Send public key to a specific peer (used for per-peer verification)
   */
  async sendPublicKeyTo(targetPeerId: string, keyJwk: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendPublicKeyTo', targetPeerId, keyJwk);
  }

  // ============================================
  // Connection State Tracking (for TTL management)
  // ============================================

  /**
   * Report that a P2P WebRTC connection has been established with a peer.
   * This keeps the session alive while transfers may be in progress.
   */
  async reportConnectionEstablished(targetPeerId: string): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.invoke('ReportConnectionEstablished', targetPeerId);
    } catch (error) {
      console.warn('Failed to report connection established:', error);
    }
  }

  /**
   * Report that a P2P WebRTC connection has been closed with a peer.
   */
  async reportConnectionClosed(targetPeerId: string): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.invoke('ReportConnectionClosed', targetPeerId);
    } catch (error) {
      console.warn('Failed to report connection closed:', error);
    }
  }

  // ============================================
  // Session Control Methods (Host Powers)
  // ============================================

  /**
   * Lock the session to prevent new peers from joining.
   * Only the host can lock the session.
   */
  async lockSession(): Promise<{ success: boolean; error?: string }> {
    if (!this.connection) throw new Error('Not connected');
    return await this.connection.invoke('LockSession');
  }

  /**
   * Unlock the session to allow new peers to join.
   * Only the host can unlock the session.
   */
  async unlockSession(): Promise<{ success: boolean; error?: string }> {
    if (!this.connection) throw new Error('Not connected');
    return await this.connection.invoke('UnlockSession');
  }

  /**
   * Kick a peer from the session.
   * Only the host can kick peers.
   */
  async kickPeer(targetPeerId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.connection) throw new Error('Not connected');
    return await this.connection.invoke('KickPeer', targetPeerId);
  }

  /**
   * Enable host-only sending mode.
   * When enabled, only the host can send files.
   */
  async enableHostOnlySending(): Promise<{ success: boolean; error?: string }> {
    if (!this.connection) throw new Error('Not connected');
    return await this.connection.invoke('EnableHostOnlySending');
  }

  /**
   * Disable host-only sending mode.
   * When disabled, all peers can send files.
   */
  async disableHostOnlySending(): Promise<{ success: boolean; error?: string }> {
    if (!this.connection) throw new Error('Not connected');
    return await this.connection.invoke('DisableHostOnlySending');
  }

  get isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }
}

export const signalingService = new SignalingService();
