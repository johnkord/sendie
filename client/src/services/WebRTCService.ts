import { signalingService } from './SignalingService';

export type WebRTCEvents = {
  onConnected: () => void;
  onDisconnected: () => void;
  onDataChannelOpen: () => void;
  onDataChannelClose: () => void;
  onDataChannelMessage: (data: ArrayBuffer | string) => void;
  onError: (error: Error) => void;
};

interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export class WebRTCService {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private events: Partial<WebRTCEvents> = {};
  private iceServers: IceServerConfig[] = [];
  private pendingCandidates: RTCIceCandidateInit[] = [];

  async initialize(): Promise<void> {
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
  }

  on<K extends keyof WebRTCEvents>(event: K, handler: WebRTCEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof WebRTCEvents>(event: K): void {
    delete this.events[event];
  }

  createPeerConnection(): RTCPeerConnection {
    if (this.peerConnection) {
      this.closePeerConnection();
    }

    this.peerConnection = new RTCPeerConnection({
      iceServers: this.iceServers,
    });

    this.peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        try {
          await signalingService.sendIceCandidate(
            event.candidate.candidate,
            event.candidate.sdpMid,
            event.candidate.sdpMLineIndex
          );
        } catch (error) {
          console.error('Failed to send ICE candidate:', error);
        }
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', this.peerConnection?.iceConnectionState);
      
      switch (this.peerConnection?.iceConnectionState) {
        case 'connected':
        case 'completed':
          this.events.onConnected?.();
          break;
        case 'disconnected':
        case 'failed':
        case 'closed':
          this.events.onDisconnected?.();
          break;
      }
    };

    this.peerConnection.ondatachannel = (event) => {
      console.log('Received data channel');
      this.setupDataChannel(event.channel);
    };

    return this.peerConnection;
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';

    // Set buffer threshold for flow control
    this.dataChannel.bufferedAmountLowThreshold = 64 * 1024;

    this.dataChannel.onopen = () => {
      console.log('Data channel opened');
      this.events.onDataChannelOpen?.();
    };

    this.dataChannel.onclose = () => {
      console.log('Data channel closed');
      this.events.onDataChannelClose?.();
    };

    this.dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
      this.events.onError?.(new Error('Data channel error'));
    };

    this.dataChannel.onmessage = (event) => {
      this.events.onDataChannelMessage?.(event.data);
    };
  }

  async createOffer(): Promise<void> {
    if (!this.peerConnection) {
      throw new Error('Peer connection not initialized');
    }

    // Create data channel as initiator
    const channel = this.peerConnection.createDataChannel('fileTransfer', {
      ordered: true, // Reliable, ordered delivery
    });
    this.setupDataChannel(channel);

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    if (offer.sdp) {
      await signalingService.sendOffer(offer.sdp);
    }
  }

  async handleOffer(sdp: string): Promise<void> {
    if (!this.peerConnection) {
      this.createPeerConnection();
    }

    await this.peerConnection!.setRemoteDescription({
      type: 'offer',
      sdp,
    });

    // Process any pending ICE candidates
    await this.processPendingCandidates();

    const answer = await this.peerConnection!.createAnswer();
    await this.peerConnection!.setLocalDescription(answer);

    if (answer.sdp) {
      await signalingService.sendAnswer(answer.sdp);
    }
  }

  async handleAnswer(sdp: string): Promise<void> {
    if (!this.peerConnection) {
      throw new Error('Peer connection not initialized');
    }

    await this.peerConnection.setRemoteDescription({
      type: 'answer',
      sdp,
    });

    // Process any pending ICE candidates
    await this.processPendingCandidates();
  }

  async handleIceCandidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): Promise<void> {
    const iceCandidate: RTCIceCandidateInit = {
      candidate,
      sdpMid,
      sdpMLineIndex,
    };

    if (!this.peerConnection?.remoteDescription) {
      // Queue the candidate until remote description is set
      this.pendingCandidates.push(iceCandidate);
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(iceCandidate);
    } catch (error) {
      console.error('Failed to add ICE candidate:', error);
    }
  }

  private async processPendingCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates) {
      try {
        await this.peerConnection?.addIceCandidate(candidate);
      } catch (error) {
        console.error('Failed to add pending ICE candidate:', error);
      }
    }
    this.pendingCandidates = [];
  }

  send(data: ArrayBuffer | string): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      console.error('Data channel not ready');
      return false;
    }

    try {
      if (typeof data === 'string') {
        this.dataChannel.send(data);
      } else {
        this.dataChannel.send(data);
      }
      return true;
    } catch (error) {
      console.error('Failed to send data:', error);
      return false;
    }
  }

  get bufferedAmount(): number {
    return this.dataChannel?.bufferedAmount ?? 0;
  }

  get isBufferLow(): boolean {
    if (!this.dataChannel) return false;
    return this.dataChannel.bufferedAmount < this.dataChannel.bufferedAmountLowThreshold;
  }

  onBufferedAmountLow(callback: () => void): void {
    if (this.dataChannel) {
      this.dataChannel.onbufferedamountlow = callback;
    }
  }

  closePeerConnection(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.pendingCandidates = [];
  }

  get isConnected(): boolean {
    return this.peerConnection?.iceConnectionState === 'connected' ||
           this.peerConnection?.iceConnectionState === 'completed';
  }

  get isDataChannelOpen(): boolean {
    return this.dataChannel?.readyState === 'open';
  }
}

export const webrtcService = new WebRTCService();
