import * as signalR from '@microsoft/signalr';

export type SignalingEvents = {
  onPeerJoined: (peerId: string) => void;
  onPeerLeft: (peerId: string) => void;
  onOffer: (peerId: string, sdp: string) => void;
  onAnswer: (peerId: string, sdp: string) => void;
  onIceCandidate: (peerId: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void;
  onPublicKey: (peerId: string, keyJwk: string) => void;
  onSignature: (peerId: string, signature: string, challenge: string) => void;
  onFileMetadata: (peerId: string, fileId: string, fileName: string, fileSize: number, fileType: string) => void;
  onFileAccepted: (peerId: string, fileId: string) => void;
  onFileRejected: (peerId: string, fileId: string) => void;
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

    this.connection.on('OnFileMetadata', (peerId: string, fileId: string, fileName: string, fileSize: number, fileType: string) => {
      this.events.onFileMetadata?.(peerId, fileId, fileName, fileSize, fileType);
    });

    this.connection.on('OnFileAccepted', (peerId: string, fileId: string) => {
      this.events.onFileAccepted?.(peerId, fileId);
    });

    this.connection.on('OnFileRejected', (peerId: string, fileId: string) => {
      this.events.onFileRejected?.(peerId, fileId);
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

  async joinSession(sessionId: string): Promise<{ success: boolean; isInitiator?: boolean; existingPeers?: string[]; error?: string }> {
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

  async sendFileMetadata(fileId: string, fileName: string, fileSize: number, fileType: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('SendFileMetadata', fileId, fileName, fileSize, fileType);
  }

  async acceptFile(fileId: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('AcceptFile', fileId);
  }

  async rejectFile(fileId: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');
    await this.connection.invoke('RejectFile', fileId);
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

  get isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }
}

export const signalingService = new SignalingService();
