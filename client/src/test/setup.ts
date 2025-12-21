import '@testing-library/jest-dom';

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

// Mock crypto API
Object.defineProperty(globalThis, 'crypto', {
  value: {
    subtle: {
      generateKey: async () => ({
        publicKey: { type: 'public' },
        privateKey: { type: 'private' },
      }),
      exportKey: async () => ({ kty: 'EC', crv: 'P-256', x: 'test', y: 'test' }),
      importKey: async () => ({ type: 'public' }),
      sign: async () => new ArrayBuffer(64),
      verify: async () => true,
      digest: async () => new ArrayBuffer(32),
    },
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    },
  },
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
