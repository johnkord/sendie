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

// Mock RTCPeerConnection
class MockRTCPeerConnection {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceConnectionState = 'new';
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;

  createDataChannel() {
    return new MockRTCDataChannel();
  }

  async createOffer() {
    return { type: 'offer', sdp: 'mock-sdp-offer' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'mock-sdp-answer' };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = desc;
  }

  async addIceCandidate() {}

  close() {}
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
