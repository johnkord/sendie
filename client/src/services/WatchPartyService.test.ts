import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataChannelMessage } from '../types';
import { useAppStore } from '../stores/appStore';

const harness = vi.hoisted(() => ({
  dataHandler: null as ((peerId: string, data: ArrayBuffer | string) => void) | null,
  verified: true,
  sendTo: vi.fn((_peerId: string, _data: ArrayBuffer | string) => true),
  broadcast: vi.fn(() => ({ success: [], failed: [] })),
}));

vi.mock('./MultiPeerWebRTCService', () => ({
  multiPeerWebRTCService: {
    on: vi.fn((event: string, handler: (peerId: string, data: ArrayBuffer | string) => void) => {
      if (event === 'onDataChannelMessage') harness.dataHandler = handler;
      return () => {};
    }),
    sendTo: harness.sendTo,
    broadcast: harness.broadcast,
    getOpenChannels: vi.fn(() => []),
    isDataChannelOpen: vi.fn(() => true),
    getBufferedAmount: vi.fn(() => 0),
    getCurrentRoundTripTime: vi.fn(async () => 0.01),
  },
}));

vi.mock('./VerificationService', () => ({
  verificationService: {
    isVerified: vi.fn(() => harness.verified),
  },
}));

vi.mock('./SignalingService', () => ({
  signalingService: {
    getLocalConnectionId: vi.fn(() => 'local-peer'),
  },
}));

vi.mock('./CryptoService', () => ({
  cryptoService: {
    generateFileId: vi.fn(() => 'watch-session'),
  },
}));

import { watchPartyService } from './WatchPartyService';

const peerId = 'remote-host';

function emit(message: DataChannelMessage): void {
  if (!harness.dataHandler) throw new Error('Watch-party data handler was not registered.');
  harness.dataHandler(peerId, JSON.stringify(message));
}

function startMessage(mediaSize = 4): Extract<DataChannelMessage, { type: 'wp-file-start' }> {
  return {
    type: 'wp-file-start',
    sessionId: 'watch-session',
    hostPeerId: peerId,
    mediaName: 'clip.mp4',
    mediaSize,
    mediaType: 'video/mp4',
    totalChunks: 1,
  };
}

function sentMessages(): DataChannelMessage[] {
  return harness.sendTo.mock.calls.map((call) => JSON.parse(String(call[1])) as DataChannelMessage);
}

describe('WatchPartyService forward receive protocol', () => {
  beforeEach(() => {
    watchPartyService.leave();
    watchPartyService.resetAcceptIncomingMedia();
    harness.verified = true;
    harness.sendTo.mockClear();
    harness.broadcast.mockClear();
    useAppStore.setState((state) => ({
      connection: {
        ...state.connection,
        isHostOnlySending: false,
        hostConnectionId: null,
      },
    }));
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:watch-party-test'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('declines unverified media before asking the user', () => {
    harness.verified = false;
    const accept = vi.fn(async () => true);
    watchPartyService.setAcceptIncomingMedia(accept);

    emit(startMessage());

    expect(accept).not.toHaveBeenCalled();
    expect(sentMessages()).toContainEqual({
      type: 'wp-file-decline',
      sessionId: 'watch-session',
    });
    expect(watchPartyService.getState().role).toBe('idle');
  });

  it('accepts, commits, and acknowledges exact media bytes', async () => {
    watchPartyService.setAcceptIncomingMedia(async () => true);
    emit(startMessage());

    await vi.waitFor(() => {
      expect(sentMessages()).toContainEqual({
        type: 'wp-file-accept',
        sessionId: 'watch-session',
      });
    });

    emit({
      type: 'wp-file-chunk-meta',
      sessionId: 'watch-session',
      chunkIndex: 0,
      data: btoa(String.fromCharCode(1, 2, 3, 4)),
    });
    emit({ type: 'wp-file-end', sessionId: 'watch-session' });

    await vi.waitFor(() => {
      expect(sentMessages()).toContainEqual({
        type: 'wp-file-ready',
        sessionId: 'watch-session',
      });
    });
    const state = watchPartyService.getState();
    expect(state.mode).toBe('local');
    expect(state.localFile?.name).toBe('clip.mp4');
    expect(state.localFile?.size).toBe(4);
    expect(state.playbackUrl).toBe('blob:watch-party-test');
  });

  it('declines a transfer whose decoded chunk length does not match metadata', async () => {
    watchPartyService.setAcceptIncomingMedia(async () => true);
    emit(startMessage());
    await vi.waitFor(() => expect(watchPartyService.getState().mode).toBe('forward'));

    emit({
      type: 'wp-file-chunk-meta',
      sessionId: 'watch-session',
      chunkIndex: 0,
      data: btoa(String.fromCharCode(1, 2, 3)),
    });

    expect(sentMessages()).toContainEqual({
      type: 'wp-file-decline',
      sessionId: 'watch-session',
    });
    expect(watchPartyService.getState().error).toMatch(/expected 4/i);
    expect(watchPartyService.getState().localFile).toBeNull();
  });

  it('notifies the sender when the viewer leaves during receipt', async () => {
    watchPartyService.setAcceptIncomingMedia(async () => true);
    emit(startMessage());
    await vi.waitFor(() => expect(watchPartyService.getState().mode).toBe('forward'));
    harness.sendTo.mockClear();

    watchPartyService.leave();

    expect(sentMessages()).toContainEqual({
      type: 'wp-file-decline',
      sessionId: 'watch-session',
    });
    expect(watchPartyService.getState().role).toBe('idle');
  });
});
