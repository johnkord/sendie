import { describe, expect, it } from 'vitest';
import type { DataChannelMessage } from '../types';
import {
  WATCH_PARTY_FORWARD_CHUNK_SIZE,
  WATCH_PARTY_MAX_ENCODED_CHUNK_LENGTH,
  WATCH_PARTY_MAX_MEDIA_BYTES,
  expectedWatchPartyChunkBytes,
  validateWatchPartyFileChunk,
  validateWatchPartyFileStart,
} from './watchPartyTransferPolicy';

const peerId = 'peer-host';

function startMessage(
  overrides: Partial<Extract<DataChannelMessage, { type: 'wp-file-start' }>> = {},
): Extract<DataChannelMessage, { type: 'wp-file-start' }> {
  const mediaSize = overrides.mediaSize ?? WATCH_PARTY_FORWARD_CHUNK_SIZE * 2;
  return {
    type: 'wp-file-start',
    sessionId: 'watch-session',
    hostPeerId: peerId,
    mediaName: 'movie.mp4',
    mediaSize,
    mediaType: 'video/mp4',
    totalChunks: Math.ceil(mediaSize / WATCH_PARTY_FORWARD_CHUNK_SIZE),
    ...overrides,
  };
}

const defaultStartPolicy = {
  peerVerified: true,
  roomHostOnly: false,
  roomHostPeerId: null,
  activeWatchPartyHostPeerId: null,
};

describe('watch-party transfer policy', () => {
  it('accepts internally consistent media metadata from a verified host', () => {
    expect(validateWatchPartyFileStart(peerId, startMessage(), defaultStartPolicy)).toBeNull();
  });

  it('rejects an unverified sender', () => {
    expect(validateWatchPartyFileStart(peerId, startMessage(), {
      ...defaultStartPolicy,
      peerVerified: false,
    })).toMatch(/verification/i);
  });

  it('rejects a sender that claims another peer is the host', () => {
    expect(validateWatchPartyFileStart(peerId, startMessage({ hostPeerId: 'someone-else' }), defaultStartPolicy))
      .toMatch(/claimed/i);
  });

  it('enforces room host-only sending', () => {
    expect(validateWatchPartyFileStart(peerId, startMessage(), {
      ...defaultStartPolicy,
      roomHostOnly: true,
      roomHostPeerId: 'room-host',
    })).toMatch(/room host/i);
  });

  it('rejects a competing host after a watch party is established', () => {
    expect(validateWatchPartyFileStart(peerId, startMessage(), {
      ...defaultStartPolicy,
      activeWatchPartyHostPeerId: 'active-host',
    })).toMatch(/already hosting/i);
  });

  it('rejects oversized media and inconsistent chunk counts', () => {
    expect(validateWatchPartyFileStart(peerId, startMessage({
      mediaSize: WATCH_PARTY_MAX_MEDIA_BYTES + 1,
      totalChunks: 1,
    }), defaultStartPolicy)).toMatch(/size/i);
    expect(validateWatchPartyFileStart(peerId, startMessage({ totalChunks: 1 }), defaultStartPolicy))
      .toMatch(/do not agree/i);
  });

  it('rejects non-media MIME types', () => {
    expect(validateWatchPartyFileStart(peerId, startMessage({ mediaType: 'text/html' }), defaultStartPolicy))
      .toMatch(/audio or video/i);
  });

  it('accepts only the next bounded chunk from the expected sender and session', () => {
    const message: Extract<DataChannelMessage, { type: 'wp-file-chunk-meta' }> = {
      type: 'wp-file-chunk-meta',
      sessionId: 'watch-session',
      chunkIndex: 3,
      data: 'AAAA',
    };
    const policy = {
      expectedPeerId: peerId,
      expectedSessionId: 'watch-session',
      nextChunkIndex: 3,
      totalChunks: 4,
    };

    expect(validateWatchPartyFileChunk(peerId, message, policy)).toBeNull();
    expect(validateWatchPartyFileChunk('attacker', message, policy)).toMatch(/unexpected peer/i);
    expect(validateWatchPartyFileChunk(peerId, { ...message, chunkIndex: 2 }, policy))
      .toMatch(/duplicated or out of order/i);
    expect(validateWatchPartyFileChunk(peerId, { ...message, chunkIndex: 4 }, policy))
      .toMatch(/outside/i);
    expect(validateWatchPartyFileChunk(peerId, {
      ...message,
      data: 'A'.repeat(WATCH_PARTY_MAX_ENCODED_CHUNK_LENGTH + 1),
    }, policy)).toMatch(/chunk-size limit/i);
  });

  it('computes exact final-chunk byte lengths', () => {
    const mediaSize = WATCH_PARTY_FORWARD_CHUNK_SIZE + 123;
    expect(expectedWatchPartyChunkBytes(mediaSize, 0)).toBe(WATCH_PARTY_FORWARD_CHUNK_SIZE);
    expect(expectedWatchPartyChunkBytes(mediaSize, 1)).toBe(123);
  });
});
