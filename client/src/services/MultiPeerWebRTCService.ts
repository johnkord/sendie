import { signalingService } from './SignalingService';

export type MultiPeerWebRTCEvents = {
  onPeerConnected: (peerId: string) => void;
  onPeerDisconnected: (peerId: string) => void;
  onDataChannelOpen: (peerId: string) => void;
  onDataChannelClose: (peerId: string) => void;
  onDataChannelMessage: (peerId: string, data: ArrayBuffer | string) => void;
  onError: (peerId: string, error: Error) => void;
};

interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

interface PeerConnectionInfo {
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[];
}

/**
 * Multi-peer WebRTC service that manages connections to multiple peers
 * using a full-mesh topology.
 */
export class MultiPeerWebRTCService {
  private peerConnections: Map<string, PeerConnectionInfo> = new Map();
  private events: Partial<MultiPeerWebRTCEvents> = {};
  private iceServers: IceServerConfig[] = [];
  private initialized = false;

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

  on<K extends keyof MultiPeerWebRTCEvents>(event: K, handler: MultiPeerWebRTCEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof MultiPeerWebRTCEvents>(event: K): void {
    delete this.events[event];
  }

  /**
   * Create a new peer connection for a specific peer
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
      pendingCandidates: [],
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
          this.events.onPeerConnected?.(peerId);
          break;
        case 'disconnected':
        case 'failed':
        case 'closed':
          this.events.onPeerDisconnected?.(peerId);
          break;
      }
    };

    // Handle incoming data channel (when we're the answerer)
    connection.ondatachannel = (event) => {
      console.log(`Received data channel from ${peerId}`);
      this.setupDataChannel(peerId, event.channel);
    };

    this.peerConnections.set(peerId, peerInfo);
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
      this.events.onDataChannelOpen?.(peerId);
    };

    channel.onclose = () => {
      console.log(`Data channel closed with ${peerId}`);
      // Report connection closed to server for TTL management
      signalingService.reportConnectionClosed(peerId);
      this.events.onDataChannelClose?.(peerId);
    };

    channel.onerror = (error) => {
      console.error(`Data channel error with ${peerId}:`, error);
      this.events.onError?.(peerId, new Error('Data channel error'));
    };

    channel.onmessage = (event) => {
      this.events.onDataChannelMessage?.(peerId, event.data);
    };
  }

  /**
   * Create and send an offer to a specific peer
   */
  async createOfferTo(peerId: string): Promise<void> {
    let peerInfo = this.peerConnections.get(peerId);
    
    if (!peerInfo) {
      this.createPeerConnection(peerId);
      peerInfo = this.peerConnections.get(peerId)!;
    }

    const connection = peerInfo.connection;

    // Create data channel as initiator
    const channel = connection.createDataChannel('fileTransfer', {
      ordered: true,
    });
    this.setupDataChannel(peerId, channel);

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);

    if (offer.sdp) {
      await signalingService.sendOfferTo(peerId, offer.sdp);
    }
  }

  /**
   * Handle an incoming offer from a specific peer
   */
  async handleOffer(peerId: string, sdp: string): Promise<void> {
    let peerInfo = this.peerConnections.get(peerId);
    
    if (!peerInfo) {
      this.createPeerConnection(peerId);
      peerInfo = this.peerConnections.get(peerId)!;
    }

    const connection = peerInfo.connection;

    await connection.setRemoteDescription({
      type: 'offer',
      sdp,
    });

    // Process any pending ICE candidates
    await this.processPendingCandidates(peerId);

    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);

    if (answer.sdp) {
      await signalingService.sendAnswerTo(peerId, answer.sdp);
    }
  }

  /**
   * Handle an incoming answer from a specific peer
   */
  async handleAnswer(peerId: string, sdp: string): Promise<void> {
    const peerInfo = this.peerConnections.get(peerId);
    if (!peerInfo) {
      throw new Error(`Peer connection not found for ${peerId}`);
    }

    await peerInfo.connection.setRemoteDescription({
      type: 'answer',
      sdp,
    });

    // Process any pending ICE candidates
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
      console.error(`Failed to add ICE candidate for ${peerId}:`, error);
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
   * Send data to a specific peer
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
   * Get all peers with open data channels
   */
  getOpenChannels(): string[] {
    return Array.from(this.peerConnections.entries())
      .filter(([_, info]) => info.dataChannel?.readyState === 'open')
      .map(([peerId]) => peerId);
  }

  /**
   * Get all connected peer IDs
   */
  getConnectedPeers(): string[] {
    return Array.from(this.peerConnections.entries())
      .filter(([_, info]) => {
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
   * Set callback for when any peer's buffer becomes low
   */
  onBufferedAmountLow(callback: () => void): void {
    for (const peerInfo of this.peerConnections.values()) {
      if (peerInfo.dataChannel) {
        peerInfo.dataChannel.onbufferedamountlow = callback;
      }
    }
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
