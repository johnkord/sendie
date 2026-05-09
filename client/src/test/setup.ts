import '@testing-library/jest-dom';
import { webcrypto } from 'node:crypto';

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Wire WebCrypto for tests. The default jsdom environment does not expose
// crypto.subtle, and the previous stub returned all-zero buffers from
// digest/sign/verify which made bound-SAS tests pass vacuously (every key
// produced the same SAS). Use Node's webcrypto so cryptographic invariants
// are exercised.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
});

// Mock RTCPeerConnection. Supports just enough of the perfect-negotiation
// surface for unit tests: signalingState transitions, the implicit
// setLocalDescription() form, addTrack/removeTrack/getSenders, and
// onnegotiationneeded / ontrack callbacks.
class MockRTCPeerConnection {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  signalingState: 'stable' | 'have-local-offer' | 'have-remote-offer' | 'closed' = 'stable';
  iceConnectionState = 'new';
  // Tracks added via addTrack are exposed here so tests can inspect.
  private senders: { track: MediaStreamTrack | null; replaceTrack: () => Promise<void> }[] = [];
  // Allow tests to influence what createOffer/createAnswer return.
  static nextSdp: string | null = null;

  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((event: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;

  createDataChannel() {
    // Schedule negotiationneeded asynchronously, like real browsers.
    queueMicrotask(() => this.onnegotiationneeded?.());
    return new MockRTCDataChannel();
  }

  addTrack(track: MediaStreamTrack, _stream?: MediaStream): unknown {
    const sender = { track, replaceTrack: async () => {} };
    this.senders.push(sender);
    queueMicrotask(() => this.onnegotiationneeded?.());
    return sender;
  }

  removeTrack(sender: { track: MediaStreamTrack | null }) {
    const idx = this.senders.indexOf(sender as never);
    if (idx >= 0) {
      this.senders[idx].track = null;
      queueMicrotask(() => this.onnegotiationneeded?.());
    }
  }

  getSenders() {
    return this.senders;
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: MockRTCPeerConnection.nextSdp ?? 'mock-sdp-offer' };
  }

  async createAnswer() {
    return { type: 'answer' as const, sdp: MockRTCPeerConnection.nextSdp ?? 'mock-sdp-answer' };
  }

  async setLocalDescription(desc?: RTCSessionDescriptionInit) {
    // Implicit form: pick offer or answer based on signalingState.
    if (!desc) {
      const type: 'offer' | 'answer' = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
      desc = { type, sdp: MockRTCPeerConnection.nextSdp ?? `mock-sdp-${type}` };
    }
    this.localDescription = desc;
    this.signalingState = desc.type === 'offer'
      ? 'have-local-offer'
      : (this.signalingState === 'have-remote-offer' ? 'stable' : this.signalingState);
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = desc;
    if (desc.type === 'offer') {
      this.signalingState = 'have-remote-offer';
    } else if (desc.type === 'answer') {
      this.signalingState = 'stable';
    }
  }

  async addIceCandidate() {}

  close() {
    this.signalingState = 'closed';
  }
}

class MockRTCDataChannel {
  readyState = 'open';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;

  send() {}
  close() {}
}

(globalThis as unknown as { RTCPeerConnection: typeof MockRTCPeerConnection }).RTCPeerConnection = MockRTCPeerConnection;
