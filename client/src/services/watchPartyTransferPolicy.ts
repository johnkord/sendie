import type { DataChannelMessage } from '../types';

export const WATCH_PARTY_FORWARD_CHUNK_SIZE = 16 * 1024;
export const WATCH_PARTY_MAX_MEDIA_BYTES = 16 * 1024 * 1024 * 1024;
export const WATCH_PARTY_MAX_MEMORY_BYTES = 256 * 1024 * 1024;
export const WATCH_PARTY_MAX_ENCODED_CHUNK_LENGTH =
  Math.ceil(WATCH_PARTY_FORWARD_CHUNK_SIZE / 3) * 4;

export type WatchPartyFileStartMessage = Extract<
  DataChannelMessage,
  { type: 'wp-file-start' }
>;

export type WatchPartyFileChunkMessage = Extract<
  DataChannelMessage,
  { type: 'wp-file-chunk-meta' }
>;

export interface WatchPartyStartPolicy {
  peerVerified: boolean;
  roomHostOnly: boolean;
  roomHostPeerId: string | null;
  activeWatchPartyHostPeerId: string | null;
}

export function validateWatchPartyFileStart(
  peerId: string,
  message: WatchPartyFileStartMessage,
  policy: WatchPartyStartPolicy,
): string | null {
  if (!policy.peerVerified) return 'The sender has not completed channel verification.';
  if (message.hostPeerId !== peerId) return 'The sender does not match the claimed watch-party host.';
  if (
    policy.roomHostOnly
    && (!policy.roomHostPeerId || peerId !== policy.roomHostPeerId)
  ) {
    return 'Only the room host may send media in this room.';
  }
  if (
    policy.activeWatchPartyHostPeerId
    && policy.activeWatchPartyHostPeerId !== peerId
  ) {
    return 'Another peer is already hosting this watch party.';
  }
  if (
    typeof message.sessionId !== 'string'
    || message.sessionId.length === 0
    || message.sessionId.length > 128
  ) {
    return 'Invalid watch-party session identifier.';
  }
  if (
    typeof message.mediaName !== 'string'
    || message.mediaName.length === 0
    || message.mediaName.length > 1024
  ) {
    return 'Invalid media filename.';
  }
  if (
    typeof message.mediaType !== 'string'
    || message.mediaType.length > 128
    || !/^(audio|video)\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/i.test(message.mediaType)
  ) {
    return 'Only valid audio or video media types may be forwarded.';
  }
  if (
    !Number.isSafeInteger(message.mediaSize)
    || message.mediaSize <= 0
    || message.mediaSize > WATCH_PARTY_MAX_MEDIA_BYTES
  ) {
    return 'The advertised media size is invalid or exceeds the supported limit.';
  }
  if (!Number.isSafeInteger(message.totalChunks) || message.totalChunks <= 0) {
    return 'The advertised chunk count is invalid.';
  }
  const expectedChunks = Math.ceil(message.mediaSize / WATCH_PARTY_FORWARD_CHUNK_SIZE);
  if (message.totalChunks !== expectedChunks) {
    return 'The advertised media size and chunk count do not agree.';
  }
  return null;
}

export interface WatchPartyChunkPolicy {
  expectedPeerId: string | null;
  expectedSessionId: string | null;
  nextChunkIndex: number;
  totalChunks: number;
}

export function validateWatchPartyFileChunk(
  peerId: string,
  message: WatchPartyFileChunkMessage,
  policy: WatchPartyChunkPolicy,
): string | null {
  if (!policy.expectedPeerId || peerId !== policy.expectedPeerId) {
    return 'Chunk came from an unexpected peer.';
  }
  if (!policy.expectedSessionId || message.sessionId !== policy.expectedSessionId) {
    return 'Chunk belongs to an unexpected watch-party session.';
  }
  if (!Number.isSafeInteger(message.chunkIndex)) return 'Chunk index is invalid.';
  if (message.chunkIndex < 0 || message.chunkIndex >= policy.totalChunks) {
    return 'Chunk index is outside the advertised range.';
  }
  if (message.chunkIndex !== policy.nextChunkIndex) {
    return 'Chunk is duplicated or out of order.';
  }
  if (
    typeof message.data !== 'string'
    || message.data.length === 0
    || message.data.length > WATCH_PARTY_MAX_ENCODED_CHUNK_LENGTH
  ) {
    return 'Encoded chunk is empty or exceeds the chunk-size limit.';
  }
  return null;
}

export function expectedWatchPartyChunkBytes(
  mediaSize: number,
  chunkIndex: number,
): number {
  const offset = chunkIndex * WATCH_PARTY_FORWARD_CHUNK_SIZE;
  return Math.min(WATCH_PARTY_FORWARD_CHUNK_SIZE, mediaSize - offset);
}
