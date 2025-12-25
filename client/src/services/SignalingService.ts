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
};

export class SignalingService {
  private connection: signalR.HubConnection | null = null;
  private events: Partial<SignalingEvents> = {};

  async connect(): Promise<void> {
    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      return;
    }

    this.connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/signaling')
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Information)
      .build();

    // Register event handlers
    this.connection.on('OnPeerJoined', (peerId: string) => {
      this.events.onPeerJoined?.(peerId);
    });

    this.connection.on('OnPeerLeft', (peerId: string) => {
      this.events.onPeerLeft?.(peerId);
    });

    this.connection.on('OnOffer', (peerId: string, sdp: string) => {
      this.events.onOffer?.(peerId, sdp);
    });

    this.connection.on('OnAnswer', (peerId: string, sdp: string) => {
      this.events.onAnswer?.(peerId, sdp);
    });

    this.connection.on('OnIceCandidate', (peerId: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => {
      this.events.onIceCandidate?.(peerId, candidate, sdpMid, sdpMLineIndex);
    });

    this.connection.on('OnPublicKey', (peerId: string, keyJwk: string) => {
      this.events.onPublicKey?.(peerId, keyJwk);
    });

    this.connection.on('OnSignature', (peerId: string, signature: string, challenge: string) => {
      this.events.onSignature?.(peerId, signature, challenge);
    });

    // Session control events
    this.connection.on('OnSessionLocked', () => {
      this.events.onSessionLocked?.();
    });

    this.connection.on('OnSessionUnlocked', () => {
      this.events.onSessionUnlocked?.();
    });

    this.connection.on('OnKicked', () => {
      this.events.onKicked?.();
    });

    this.connection.on('OnHostOnlySendingEnabled', () => {
      this.events.onHostOnlySendingEnabled?.();
    });

    this.connection.on('OnHostOnlySendingDisabled', () => {
      this.events.onHostOnlySendingDisabled?.();
    });

    await this.connection.start();
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.stop();
      this.connection = null;
    }
  }

  on<K extends keyof SignalingEvents>(event: K, handler: SignalingEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof SignalingEvents>(event: K): void {
    delete this.events[event];
  }

  async joinSession(sessionId: string): Promise<{ 
    success: boolean; 
    isInitiator?: boolean; 
    existingPeers?: string[]; 
    isHost?: boolean;
    hostConnectionId?: string;
    isLocked?: boolean;
    isHostOnlySending?: boolean;
    error?: string 
  }> {
    if (!this.connection) throw new Error('Not connected');
    return await this.connection.invoke('JoinSession', sessionId);
  }

  async leaveSession(): Promise<void> {
    if (!this.connection) return;
    await this.connection.invoke('LeaveSession');
  }

  async sendOffer(sdp: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendOffer', sdp);
  }

  async sendAnswer(sdp: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendAnswer', sdp);
  }

  async sendIceCandidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendIceCandidate', candidate, sdpMid, sdpMLineIndex);
  }

  async sendPublicKey(keyJwk: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendPublicKey', keyJwk);
  }

  async sendSignature(signature: string, challenge: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendSignature', signature, challenge);
  }

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
