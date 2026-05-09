import { multiPeerWebRTCService } from './MultiPeerWebRTCService';
import { cryptoService } from './CryptoService';
import { verificationService } from './VerificationService';
import { sanitizeFilename } from '../utils/formatters';
import streamSaver from './streamSaverInit';
import type { TransferState, DataChannelMessage, FileStartMessage } from '../types';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const STREAMING_THRESHOLD = 100 * 1024 * 1024; // 100MB - files larger than this stream to disk

// ACK-based flow control. Sender pauses when it is more than
// FLOW_CONTROL_WINDOW chunks ahead of the latest ACK from this receiver.
// Receiver sends a fresh ACK every PROGRESS_ACK_INTERVAL committed chunks.
// At 64KB chunks, window=512 means the sender can be ~32MB ahead, which
// is enough to keep the pipe full but small enough to bound memory and
// stop a fast sender from outrunning a slow disk.
const PROGRESS_ACK_INTERVAL = 32;
const FLOW_CONTROL_WINDOW = 512;

// Check if File System Access API is supported (Chrome/Edge)
const supportsFileSystemAccess = 'showSaveFilePicker' in window;

// Origin Private File System: navigator.storage.getDirectory() exists in
// Firefox 111+, Chrome 86+, Safari 15.2+. We use it as the preferred
// fallback when showSaveFilePicker is not available, because it does NOT
// require a service worker (unlike StreamSaver) and works for arbitrarily
// large files. After the transfer completes, we deliver the file via
// <a download> from a Blob backed by the OPFS handle.
//
// We also require FileSystemFileHandle.prototype.createWritable, because
// older Firefox shipped getDirectory() before createWritable() and we'd
// otherwise fall through to StreamSaver after a partial setup.
const supportsOPFS = typeof navigator !== 'undefined'
  && typeof navigator.storage?.getDirectory === 'function'
  && typeof (globalThis as { FileSystemFileHandle?: { prototype?: { createWritable?: unknown } } })
    .FileSystemFileHandle?.prototype?.createWritable === 'function';

// Hard cap for the StreamSaver fallback path. Empirically this fails on
// Firefox somewhere in the few-hundred-MB range when its service worker
// is killed mid-stream; we have observed reproducible stalls around
// 370MB on multi-GB transfers. Rather than start a transfer that is
// statistically going to wedge, refuse upfront with an actionable error.
//
// Firefox is much more aggressive about killing SWs than Chromium
// (cf. StreamSaver issue #366, "firefox service worker stopped and
// partial download"). The maintainer of StreamSaver acknowledges this
// is not fixable from library code, so we hard-cap Firefox lower.
const isFirefox = typeof navigator !== 'undefined'
  && /firefox/i.test(navigator.userAgent ?? '');
const STREAMSAVER_MAX_RELIABLE_BYTES = isFirefox
  ? 256 * 1024 * 1024     // 256 MiB on Firefox; observed stalls at ~370MB.
  : 1 * 1024 * 1024 * 1024; // 1 GiB elsewhere.

// StreamSaver is the last-resort fallback. It pipes through a service
// worker, which Firefox kills aggressively under memory pressure or for
// long-running streams. Empirically reliable to a few hundred MB on
// Firefox; multi-GB transfers stall when the SW is killed mid-stream.
const supportsStreamSaver = typeof WritableStream !== 'undefined';

// If a streaming transfer makes no committed-bytes progress for this long,
// the watchdog tears it down with a clear error. Catches the
// 'StreamSaver SW was killed and writes hang forever' failure mode
// without forcing the user to wait indefinitely.
const WRITE_STALL_TIMEOUT_MS = 30_000;

export type MultiPeerFileTransferEvents = {
  onTransferStart: (transfer: TransferState) => void;
  onTransferProgress: (transfer: TransferState) => void;
  onTransferComplete: (transfer: TransferState) => void;
  onTransferError: (fileId: string, error: Error) => void;
  onIncomingFile: (peerId: string, fileId: string, fileName: string, fileSize: number, fileType: string) => void;
  onFileDeclined: (peerId: string, fileId: string) => void;
};

// Callback to decide whether to accept an incoming file.
// Returning true accepts the transfer; false declines it.
type AcceptIncomingFile = (
  peerId: string,
  fileName: string,
  fileSize: number,
  fileType: string,
) => Promise<boolean>;

// Callbacks for host-only-sending enforcement.
type HostOnlySendingCheck = () => boolean;
type HostConnectionIdProvider = () => string | null;

interface BroadcastTransfer {
  file: File;
  fileId: string;
  state: TransferState;
  targetPeers: string[];
  // Receivers that have accepted; chunks are only sent to these.
  // For broadcast we wait for at least one acceptance before sending data.
  acceptedPeers: Set<string>;
  // Receivers that explicitly declined; we stop tracking them.
  declinedPeers: Set<string>;
  // Per-peer completion. The transfer is finished only when every accepted
  // peer is in this set; otherwise a fast accepter would tear down state
  // that a slow accepter still needs.
  completedPeers: Set<string>;
  // Per-peer bytes-sent counter so the aggregated `state.bytesTransferred`
  // is accurate when the same file is being sent to multiple peers in parallel.
  perPeerBytes: Map<string, number>;
  // Per-peer flow-control pause flag. The shared sendPaused was wrong
  // because one slow peer would block sends to every other peer.
  perPeerPaused: Set<string>;
  // ACK-based flow control: how many chunks we have sent to each peer,
  // and the latest ACK we have received from them. If sent - ack >
  // FLOW_CONTROL_WINDOW, the per-peer loop pauses until a fresh ACK arrives.
  perPeerChunksSent: Map<string, number>;
  perPeerAckedChunks: Map<string, number>;
  // Resolvers waiting for a fresh ACK on a given peer (so the per-peer
  // loop can await a new ACK before resuming).
  perPeerAckWaiters: Map<string, () => void>;
  // Set by cancelTransfer; the per-peer send loop checks this each
  // iteration and exits early so we don't keep blasting chunks at a
  // peer after the user pressed cancel.
  cancelled: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface IncomingTransfer {
  peerId: string;  // Who is sending
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  totalChunks: number;
  receivedChunks: ArrayBuffer[];
  fileHandle: FileSystemFileHandle | null;
  writable: FileSystemWritableFileStream | null;
  streamSaverWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  // OPFS bookkeeping. opfsHandle is the FileSystemFileHandle inside the
  // origin-private filesystem; opfsName is the unique name we used so we
  // can remove it after delivery. opfsWritable is the backing writable
  // during transfer.
  opfsHandle: FileSystemFileHandle | null;
  opfsWritable: FileSystemWritableFileStream | null;
  opfsName: string | null;
  useStreaming: boolean;
  streamingMethod: 'none' | 'file-system-access' | 'stream-saver' | 'opfs';
  state: TransferState;
  // Tail of the write-queue promise chain. handleChunkData links new
  // writes onto this so they execute in arrival order against the
  // FileSystemWritableFileStream / StreamSaver writer (both reject
  // concurrent writes). This also makes bytesTransferred reflect actual
  // committed bytes, not just received bytes, so the UI is honest.
  writeQueueTail: Promise<void>;
  // Number of chunks we have actually committed. Sent back to the sender
  // as a periodic file-progress ACK so they can throttle.
  chunksWritten: number;
  // Last value of chunksWritten we ACKed back to the sender. We send
  // a fresh ACK every PROGRESS_ACK_INTERVAL committed chunks.
  lastAckedChunks: number;
  // Watchdog: if commits stall for too long while the channel is open,
  // tear down with a clear error rather than hanging forever. Especially
  // important for the StreamSaver path on Firefox, which can wedge when
  // its service worker is killed mid-stream.
  lastProgressAt: number;
  watchdogTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Multi-peer file transfer service that broadcasts files to all connected peers
 */
export class MultiPeerFileTransferService {
  private events: Partial<MultiPeerFileTransferEvents> = {};
  private broadcastTransfers: Map<string, BroadcastTransfer> = new Map();
  private incomingTransfers: Map<string, IncomingTransfer> = new Map();  // key: `${peerId}:${fileId}`
  // Default-deny: until a UI prompt is wired in, every incoming file is rejected.
  // The page injects an accept callback that prompts the user.
  private acceptIncomingFile: AcceptIncomingFile = async () => false;
  // Per-peer "accept all from this peer for this session" memo. Keyed by peerId.
  // This is service-scoped (cleared on closeAll/reset) and never persisted to Zustand.
  private acceptAllFromPeer: Set<string> = new Set();
  // Phase 1.4: enforce host-only-sending on the receiver. The page wires these.
  private isHostOnlySending: HostOnlySendingCheck = () => false;
  private getHostConnectionId: HostConnectionIdProvider = () => null;

  constructor() {
    // Listen for incoming data from all peers
    multiPeerWebRTCService.on('onDataChannelMessage', this.handleMessage.bind(this));
  }

  /**
   * Set a callback that decides whether to accept an incoming file.
   * The callback is awaited; UIs can use this to prompt the user.
   */
  setAcceptIncomingFile(handler: AcceptIncomingFile): void {
    this.acceptIncomingFile = handler;
  }

  /**
   * Mark a peer as pre-approved for the rest of this session ("Accept all").
   */
  acceptAllFrom(peerId: string): void {
    this.acceptAllFromPeer.add(peerId);
  }

  /**
   * Clear all per-peer pre-approvals (call on session leave).
   */
  resetAcceptances(): void {
    this.acceptAllFromPeer.clear();
  }

  /**
   * Provide host-only-sending enforcement state. Receivers reject files
   * from non-host peers when host-only-sending is on.
   */
  setHostOnlySendingProviders(
    isHostOnly: HostOnlySendingCheck,
    hostConnectionId: HostConnectionIdProvider,
  ): void {
    this.isHostOnlySending = isHostOnly;
    this.getHostConnectionId = hostConnectionId;
  }

  on<K extends keyof MultiPeerFileTransferEvents>(event: K, handler: MultiPeerFileTransferEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof MultiPeerFileTransferEvents>(event: K): void {
    delete this.events[event];
  }

  /**
   * Send a file to a specific peer (used for broadcast mode when new peers join)
   */
  async sendFileToPeer(file: File, peerId: string): Promise<void> {
    if (!multiPeerWebRTCService.isDataChannelOpen(peerId)) {
      throw new Error(`Data channel not open for peer: ${peerId}`);
    }

    const fileId = cryptoService.generateFileId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const state: TransferState = {
      fileId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      direction: 'send',
      status: 'pending',
      bytesTransferred: 0,
      startTime: null,
      speed: 0,
    };

    return new Promise((resolve, reject) => {
      const transfer: BroadcastTransfer = {
        file,
        fileId,
        state,
        targetPeers: [peerId],
        acceptedPeers: new Set(),
        declinedPeers: new Set(),
        completedPeers: new Set(),
        perPeerBytes: new Map(),
        perPeerPaused: new Set(),
        perPeerChunksSent: new Map(),
        perPeerAckedChunks: new Map(),
        perPeerAckWaiters: new Map(),
        cancelled: false,
        resolve,
        reject,
      };

      this.broadcastTransfers.set(fileId, transfer);
      this.events.onTransferStart?.(state);

      // Send file metadata to specific peer
      const metadata: DataChannelMessage = {
        type: 'file-start',
        fileId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        totalChunks,
      };

      multiPeerWebRTCService.sendTo(peerId, JSON.stringify(metadata));
      // Chunks are not sent until the receiver replies with file-accept.
      // See handleControlMessage(file-accept).
    });
  }

  /**
   * Send chunks to a specific peer.
   *
   * Multiple peers can be receiving the same `transfer` in parallel (broadcast
   * or queued-on-join), so all per-peer mutable state lives on the transfer
   * record (perPeerBytes, perPeerPaused, completedPeers) rather than on the
   * service. The aggregated `state.bytesTransferred` is the max across peers
   * so progress reflects the slowest accepter — i.e. when progress hits 100%
   * every accepter has the file.
   */
  private async sendChunksToPeer(transfer: BroadcastTransfer, totalChunks: number, peerId: string): Promise<void> {
    const { file, fileId, state } = transfer;

    if (state.status === 'pending') {
      state.status = 'transferring';
      state.startTime = Date.now();
      this.events.onTransferProgress?.(state);
    }

    let chunkIndex = 0;
    let peerBytes = 0;
    const reader = file.stream().getReader();
    let buffer = new Uint8Array(0);

    // Helper: stop sending to this peer and release resources.
    // Marks the peer "complete" so the aggregate completion check moves on.
    const finishPeer = (cancelled: boolean) => {
      transfer.completedPeers.add(peerId);
      reader.cancel().catch(() => {});
      this.checkTransferComplete(transfer, cancelled);
    };

    const sendNextChunk = async (): Promise<void> => {
      // Cancellation / disconnection short-circuits.
      if (transfer.cancelled) {
        finishPeer(true);
        return;
      }
      if (!multiPeerWebRTCService.isDataChannelOpen(peerId)) {
        // The peer left or their channel closed; stop without erroring the
        // whole transfer (other peers may still be receiving fine).
        finishPeer(true);
        return;
      }

      if (transfer.perPeerPaused.has(peerId)) {
        multiPeerWebRTCService.onBufferedAmountLow(peerId, () => {
          transfer.perPeerPaused.delete(peerId);
          sendNextChunk();
        });
        return;
      }

      // ACK-based flow control. RTCDataChannel.bufferedAmount only sees the
      // local SCTP queue; with a fast LAN to a slow disk, the receiver's
      // OS / browser queue can grow without bound while our bufferedAmount
      // stays small. Without this gate, a large file would let the sender
      // run thousands of chunks ahead of the receiver's commit cursor and
      // (depending on the streaming target) eventually error or hang.
      const sent = transfer.perPeerChunksSent.get(peerId) ?? 0;
      const acked = transfer.perPeerAckedChunks.get(peerId) ?? 0;
      if (sent - acked >= FLOW_CONTROL_WINDOW) {
        await new Promise<void>((resolve) => {
          transfer.perPeerAckWaiters.set(peerId, resolve);
        });
        // Re-check cancellation/closure after waking; nothing else changed.
        if (transfer.cancelled) {
          finishPeer(true);
          return;
        }
      }

      // Read more data if needed
      while (buffer.length < CHUNK_SIZE) {
        const { done, value } = await reader.read();
        if (done) break;

        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;
      }

      if (buffer.length === 0 && chunkIndex >= totalChunks) {
        // All chunks for this peer sent.
        const endMessage: DataChannelMessage = {
          type: 'file-end',
          fileId,
        };
        multiPeerWebRTCService.sendTo(peerId, JSON.stringify(endMessage));

        transfer.perPeerBytes.set(peerId, peerBytes);
        this.recomputeAggregateProgress(transfer);
        finishPeer(false);
        return;
      }

      // Extract chunk
      const chunkSize = Math.min(CHUNK_SIZE, buffer.length);
      const chunk = buffer.slice(0, chunkSize);
      buffer = buffer.slice(chunkSize);

      // Send chunk header to peer
      const chunkHeader: DataChannelMessage = {
        type: 'file-chunk',
        fileId,
        chunkIndex,
      };
      multiPeerWebRTCService.sendTo(peerId, JSON.stringify(chunkHeader));

      // Send chunk data to peer
      multiPeerWebRTCService.sendTo(peerId, chunk.buffer);

      // Update per-peer counter and aggregate progress.
      peerBytes += chunk.length;
      transfer.perPeerBytes.set(peerId, peerBytes);
      transfer.perPeerChunksSent.set(peerId, chunkIndex + 1);
      this.recomputeAggregateProgress(transfer);

      chunkIndex++;

      // Per-peer flow control: only this peer pauses when its outbound buffer
      // is over the threshold. The data channel is configured with
      // bufferedAmountLowThreshold = 64 KiB; mirror that here so we keep the
      // pipe full without ballooning the channel's buffer.
      const BUFFER_HIGH_WATER = 64 * 1024;
      if (multiPeerWebRTCService.getBufferedAmount(peerId) > BUFFER_HIGH_WATER) {
        transfer.perPeerPaused.add(peerId);
        multiPeerWebRTCService.onBufferedAmountLow(peerId, () => {
          transfer.perPeerPaused.delete(peerId);
          sendNextChunk();
        });
      } else {
        setTimeout(sendNextChunk, 0);
      }
    };

    await sendNextChunk();
  }

  /**
   * Aggregate completion check. The transfer is finalized only when every
   * target peer has reached a terminal state:
   *   - declined the transfer (in declinedPeers), OR
   *   - accepted and completed (in completedPeers), OR
   *   - disconnected before completing (treated as completed via
   *     handlePeerDisconnected so we don't hang).
   *
   * The earlier "all accepted peers completed" check was wrong when accepts
   * arrived serially: a fast first receiver could complete before slower
   * receivers had clicked Accept, satisfying the vacuous "every accepter
   * is done" check. The transfer would be deleted, and subsequent
   * file-accept messages would be dropped because lookup returned undefined.
   * Symptom: only the first receiver ever got the file.
   */
  private checkTransferComplete(transfer: BroadcastTransfer, cancelledByThisPeer: boolean): void {
    if (!this.broadcastTransfers.has(transfer.fileId)) return;

    // Every target must have a terminal state.
    const allTargetsResolved = transfer.targetPeers.every(
      (p) => transfer.declinedPeers.has(p) || transfer.completedPeers.has(p),
    );
    if (!allTargetsResolved) return;

    // Of the accepters, every one must have completed.
    const allAcceptersCompleted = [...transfer.acceptedPeers].every(
      (p) => transfer.completedPeers.has(p),
    );
    if (!allAcceptersCompleted) return;

    if (transfer.cancelled || (cancelledByThisPeer && transfer.acceptedPeers.size === 0)) {
      transfer.state.status = 'cancelled';
    } else {
      transfer.state.status = 'completed';
      transfer.state.bytesTransferred = transfer.state.fileSize;
    }
    this.events.onTransferComplete?.(transfer.state);
    this.broadcastTransfers.delete(transfer.fileId);
    transfer.resolve();
  }

  /**
   * Aggregate progress across all peers receiving a transfer. We report the
   * minimum bytes-transferred, so 100% means every accepter has the bytes.
   * The speed estimate is total-bytes-sent / wall-clock so it reflects total
   * outbound throughput on this side.
   */
  private recomputeAggregateProgress(transfer: BroadcastTransfer): void {
    const { state, perPeerBytes, acceptedPeers } = transfer;
    if (acceptedPeers.size === 0) return;

    let minBytes = Number.POSITIVE_INFINITY;
    let totalBytes = 0;
    for (const peerId of acceptedPeers) {
      const b = perPeerBytes.get(peerId) ?? 0;
      if (b < minBytes) minBytes = b;
      totalBytes += b;
    }
    if (!Number.isFinite(minBytes)) minBytes = 0;

    state.bytesTransferred = minBytes;
    if (state.startTime) {
      const elapsed = (Date.now() - state.startTime) / 1000;
      state.speed = elapsed > 0 ? totalBytes / elapsed : 0;
    }
    this.events.onTransferProgress?.(state);
  }

  /**
   * Broadcast a file to all connected peers with open data channels
   */
  async broadcastFile(file: File): Promise<void> {
    const openChannels = multiPeerWebRTCService.getOpenChannels();
    
    if (openChannels.length === 0) {
      throw new Error('No connected peers to send file to');
    }

    const fileId = cryptoService.generateFileId();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const state: TransferState = {
      fileId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      direction: 'send',
      status: 'pending',
      bytesTransferred: 0,
      startTime: null,
      speed: 0,
    };

    return new Promise((resolve, reject) => {
      const transfer: BroadcastTransfer = {
        file,
        fileId,
        state,
        targetPeers: [...openChannels],
        acceptedPeers: new Set(),
        declinedPeers: new Set(),
        completedPeers: new Set(),
        perPeerBytes: new Map(),
        perPeerPaused: new Set(),
        perPeerChunksSent: new Map(),
        perPeerAckedChunks: new Map(),
        perPeerAckWaiters: new Map(),
        cancelled: false,
        resolve,
        reject,
      };

      this.broadcastTransfers.set(fileId, transfer);
      this.events.onTransferStart?.(state);

      // Send file metadata to all peers
      const metadata: DataChannelMessage = {
        type: 'file-start',
        fileId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        totalChunks,
      };

      multiPeerWebRTCService.broadcast(JSON.stringify(metadata));
      // Chunks are not sent until at least one receiver replies with
      // file-accept; see handleControlMessage(file-accept).
    });
  }

  private handleMessage(peerId: string, data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      // JSON message
      try {
        const message = JSON.parse(data) as DataChannelMessage;
        this.handleControlMessage(peerId, message);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    } else {
      // Binary chunk data
      this.handleChunkData(peerId, data);
    }
  }

  private currentIncomingFileId: Map<string, string> = new Map();  // peerId -> fileId

  private handleControlMessage(peerId: string, message: DataChannelMessage): void {
    switch (message.type) {
      case 'file-start': {
        this.initializeIncomingTransfer(peerId, message);
        break;
      }

      case 'file-accept': {
        // A receiver has approved an outbound transfer; start chunking.
        const transfer = this.broadcastTransfers.get(message.fileId);
        if (!transfer) break;
        if (transfer.acceptedPeers.has(peerId)) break;
        transfer.acceptedPeers.add(peerId);
        // For broadcast, we send to every accepted peer individually so a
        // single decline doesn't block other recipients. For 1:1 (sendFileToPeer)
        // there is only one target.
        const totalChunks = Math.ceil(transfer.file.size / CHUNK_SIZE);
        this.sendChunksToPeer(transfer, totalChunks, peerId).catch((err) => {
          console.error(`Send to ${peerId} failed:`, err);
        });
        break;
      }

      case 'file-decline': {
        const transfer = this.broadcastTransfers.get(message.fileId);
        if (!transfer) break;
        transfer.declinedPeers.add(peerId);
        this.events.onFileDeclined?.(peerId, message.fileId);
        // If every target either declined or already finished, resolve.
        const allResolved = transfer.targetPeers.every(
          (id) => transfer.declinedPeers.has(id) || transfer.acceptedPeers.has(id),
        );
        if (allResolved && transfer.acceptedPeers.size === 0) {
          transfer.state.status = 'cancelled';
          this.events.onTransferComplete?.(transfer.state);
          this.broadcastTransfers.delete(transfer.fileId);
          transfer.resolve();
        }
        break;
      }

      case 'file-chunk': {
        // Store the file ID for the next binary chunk from this peer
        this.currentIncomingFileId.set(peerId, message.fileId);
        break;
      }

      case 'file-end': {
        const key = `${peerId}:${message.fileId}`;
        const incoming = this.incomingTransfers.get(key);
        if (incoming) {
          this.completeIncomingTransfer(incoming);
        }
        break;
      }

      case 'file-progress': {
        // Receiver tells us how many chunks they have committed. We use
        // this to bound how far ahead the sender can run.
        const transfer = this.broadcastTransfers.get(message.fileId);
        if (!transfer) break;
        const prev = transfer.perPeerAckedChunks.get(peerId) ?? 0;
        if (message.chunksWritten > prev) {
          transfer.perPeerAckedChunks.set(peerId, message.chunksWritten);
          // Wake the per-peer loop if it was waiting for an ACK.
          const waiter = transfer.perPeerAckWaiters.get(peerId);
          if (waiter) {
            transfer.perPeerAckWaiters.delete(peerId);
            waiter();
          }
        }
        break;
      }

      case 'transfer-cancel': {
        // Symmetric: either side can send this. Receiver-side abort
        // (e.g. watchdog tripped on a StreamSaver stall) sends this so
        // the sender doesn't sit forever waiting for ACKs that will
        // never come.
        const key = `${peerId}:${message.fileId}`;
        const incoming = this.incomingTransfers.get(key);
        if (incoming) {
          incoming.state.status = 'cancelled';
          if (incoming.watchdogTimer) {
            clearInterval(incoming.watchdogTimer);
            incoming.watchdogTimer = null;
          }
          if (incoming.writable) {
            incoming.writable.abort().catch(() => {});
          }
          if (incoming.opfsWritable) {
            incoming.opfsWritable.abort().catch(() => {});
          }
          if (incoming.streamSaverWriter) {
            incoming.streamSaverWriter.abort().catch(() => {});
          }
          this.events.onTransferError?.(message.fileId, new Error('Transfer cancelled by sender'));
          this.incomingTransfers.delete(key);
        }

        // Sender-side: if a receiver aborted, treat that peer as having
        // declined/finished so the broadcast can move on instead of
        // hanging on flow-control window forever.
        const broadcast = this.broadcastTransfers.get(message.fileId);
        if (broadcast) {
          const waiter = broadcast.perPeerAckWaiters.get(peerId);
          if (waiter) {
            broadcast.perPeerAckWaiters.delete(peerId);
            waiter();
          }
          if (broadcast.acceptedPeers.has(peerId)) {
            broadcast.completedPeers.add(peerId);
          } else {
            broadcast.declinedPeers.add(peerId);
            this.events.onFileDeclined?.(peerId, message.fileId);
          }
          this.events.onTransferError?.(
            message.fileId,
            new Error(`Receiver ${peerId} aborted the transfer (likely a streaming stall on their browser).`),
          );
          this.checkTransferComplete(broadcast, true);
        }
        break;
      }

      // Phase 2 verification messages are handled by the VerificationService.
      case 'verification-init':
      case 'verification-sig':
        verificationService.handleMessage(peerId, message).catch((err) => {
          console.error(`Verification dispatch failed for ${peerId}:`, err);
        });
        break;
    }
  }

  /**
   * Initialize an incoming transfer from a specific peer
   */
  private async initializeIncomingTransfer(peerId: string, message: FileStartMessage): Promise<void> {
    // Phase 2: refuse incoming files from unverified peers. The sender's UI
    // also gates outbound sends on verification, but a malicious or modified
    // client could skip that check; the receiver enforces independently.
    if (!verificationService.isVerified(peerId)) {
      console.warn(`Refusing file from unverified peer ${peerId}: ${message.fileName}`);
      multiPeerWebRTCService.sendTo(
        peerId,
        JSON.stringify({ type: 'file-decline', fileId: message.fileId }),
      );
      this.events.onFileDeclined?.(peerId, message.fileId);
      return;
    }

    // C2: enforce host-only sending on the receiver. UI hint -> hard rule.
    if (this.isHostOnlySending() && peerId !== this.getHostConnectionId()) {
      console.log(`Host-only sending is on; declining file from non-host ${peerId}: ${message.fileName}`);
      multiPeerWebRTCService.sendTo(
        peerId,
        JSON.stringify({ type: 'file-decline', fileId: message.fileId }),
      );
      this.events.onFileDeclined?.(peerId, message.fileId);
      return;
    }

    // Sanitize filename from peer to prevent security issues.
    // Used in both the prompt and the eventual save.
    const safeFileName = sanitizeFilename(message.fileName);

    // Decide whether to accept. Order: per-peer pre-approval -> auto-receive
    // store flag (legacy opt-in) -> per-file user prompt.
    const accepted = await this.shouldAcceptFile(
      peerId,
      safeFileName,
      message.fileSize,
      message.fileType,
    );

    if (!accepted) {
      console.log(`Declined file from ${peerId}: ${safeFileName}`);
      multiPeerWebRTCService.sendTo(
        peerId,
        JSON.stringify({ type: 'file-decline', fileId: message.fileId }),
      );
      this.events.onFileDeclined?.(peerId, message.fileId);
      return;
    }

    const state: TransferState = {
      fileId: message.fileId,
      fileName: safeFileName,
      fileSize: message.fileSize,
      fileType: message.fileType,
      direction: 'receive',
      status: 'transferring',
      bytesTransferred: 0,
      startTime: Date.now(),
      speed: 0,
    };

    const isLargeFile = message.fileSize > STREAMING_THRESHOLD;

    const incoming: IncomingTransfer = {
      peerId,
      fileId: message.fileId,
      fileName: safeFileName,
      fileSize: message.fileSize,
      fileType: message.fileType,
      totalChunks: message.totalChunks,
      receivedChunks: [],
      fileHandle: null,
      writable: null,
      streamSaverWriter: null,
      opfsHandle: null,
      opfsWritable: null,
      opfsName: null,
      useStreaming: false,
      streamingMethod: 'none',
      state,
      writeQueueTail: Promise.resolve(),
      chunksWritten: 0,
      lastAckedChunks: 0,
      lastProgressAt: Date.now(),
      watchdogTimer: null,
    };

    // Streaming setup. Order of preference:
    //   1. showSaveFilePicker (Chrome/Edge): user picks a file, we stream
    //      directly to disk. Most reliable.
    //   2. OPFS (Firefox 111+, Safari 15.2+): write into the origin private
    //      filesystem, then deliver as a Blob via <a download> on
    //      completion. No service worker. No size dialog. Reliable for
    //      multi-GB files where StreamSaver fails.
    //   3. StreamSaver: pipes through a service worker. Empirically fails
    //      on Firefox at ~hundreds of MB when the SW is killed mid-stream.
    //      Last resort.
    //   4. In-memory: refused over IN_MEMORY_LIMIT to avoid OOM.
    if (isLargeFile) {
      if (supportsFileSystemAccess) {
        try {
          const fileHandle = await window.showSaveFilePicker({
            suggestedName: safeFileName,
            types: [{
              description: 'File',
              accept: { [message.fileType || 'application/octet-stream']: [] },
            }],
          });
          incoming.fileHandle = fileHandle;
          incoming.writable = await fileHandle.createWritable();
          incoming.useStreaming = true;
          incoming.streamingMethod = 'file-system-access';
          console.log(`Large file from ${peerId} (${(message.fileSize / 1024 / 1024).toFixed(1)}MB) - streaming via File System Access API`);
        } catch (err) {
          console.log('File System Access cancelled, trying OPFS fallback:', err);
        }
      }

      if (!incoming.useStreaming && supportsOPFS) {
        // Always request persistent storage before opening an OPFS
        // writable for a large file. On Firefox in particular this is
        // the difference between "5GB write completes" and "write throws
        // QuotaExceededError around N hundred MB". `persist()` returns
        // false (or `null` in some implementations) when the user
        // declines, but Firefox auto-grants for sites the user has
        // installed/bookmarked, and otherwise will prompt. We try and
        // continue regardless; if quota actually runs out the write
        // will throw and the watchdog/abortIncoming will surface a
        // clean error.
        //
        // We deliberately do NOT call estimate() and gate on it: the
        // reported quota lags reality on Firefox (it's a soft, evictable
        // tier until persist is granted) and we'd skip OPFS for files
        // that would actually fit. Better to try and let the OS say no.
        try {
          if (typeof navigator.storage?.persist === 'function'
            && typeof navigator.storage?.persisted === 'function') {
            const already = await navigator.storage.persisted();
            if (!already) {
              const granted = await navigator.storage.persist();
              console.log(`OPFS persistent storage ${granted ? 'granted' : 'denied'} (continuing either way)`);
            }
          }
        } catch (err) {
          console.log('persist() request failed; continuing:', err);
        }

        try {
          const root = await navigator.storage.getDirectory();
          // Use a unique name so concurrent transfers do not collide.
          const opfsName = `sendie-${message.fileId}-${safeFileName}`;
          const handle = await root.getFileHandle(opfsName, { create: true });
          const writable = await handle.createWritable();
          incoming.opfsHandle = handle;
          incoming.opfsWritable = writable;
          incoming.opfsName = opfsName;
          incoming.useStreaming = true;
          incoming.streamingMethod = 'opfs';
          console.log(`Large file from ${peerId} (${(message.fileSize / 1024 / 1024).toFixed(1)}MB) - streaming via OPFS`);
        } catch (err) {
          console.log('OPFS streaming failed, trying StreamSaver fallback:', err);
        }
      }

      // Firefox + StreamSaver = silent stall (StreamSaver issue #366).
      // If we got here on Firefox, OPFS already failed; falling further
      // to StreamSaver is worse than refusing with a clear message.
      if (!incoming.useStreaming && isFirefox) {
        console.warn('Refusing to use StreamSaver on Firefox; SW lifecycle makes it unreliable.');
        multiPeerWebRTCService.sendTo(
          peerId,
          JSON.stringify({ type: 'file-decline', fileId: message.fileId }),
        );
        this.events.onTransferError?.(
          message.fileId,
          new Error(
            `Could not open a reliable streaming target on Firefox. ` +
            `OPFS (Origin Private File System) is required for large transfers, ` +
            `but it is unavailable here (likely Private Browsing, an old Firefox version, ` +
            `or storage permission was denied). ` +
            `Try a normal (non-private) Firefox 111+ window, or use Chrome/Edge.`,
          ),
        );
        return;
      }

      if (!incoming.useStreaming && supportsStreamSaver) {
        if (message.fileSize > STREAMSAVER_MAX_RELIABLE_BYTES) {
          // Refuse rather than start something that will stall. Surfaces
          // a real error to the user instead of an indefinite hang.
          console.warn(
            `Refusing ${(message.fileSize / 1024 / 1024 / 1024).toFixed(2)}GB file via StreamSaver: ` +
            `above the ${(STREAMSAVER_MAX_RELIABLE_BYTES / 1024 / 1024 / 1024).toFixed(0)}GB reliable cap on this browser.`,
          );
          multiPeerWebRTCService.sendTo(
            peerId,
            JSON.stringify({ type: 'file-decline', fileId: message.fileId }),
          );
          this.events.onTransferError?.(
            message.fileId,
            new Error(
              `File is ${(message.fileSize / 1024 / 1024 / 1024).toFixed(2)}GB. ` +
              `Your browser only supports the StreamSaver fallback, which is unreliable above ~1GB. ` +
              `Use Chrome or Edge (which support direct-to-disk streaming via showSaveFilePicker) for files this large, ` +
              `or update Firefox to 111 or newer for OPFS support.`,
            ),
          );
          return;
        }
        try {
          const fileStream = streamSaver.createWriteStream(safeFileName, {
            size: message.fileSize,
          });
          incoming.streamSaverWriter = fileStream.getWriter();
          incoming.useStreaming = true;
          incoming.streamingMethod = 'stream-saver';
          console.log(`Large file from ${peerId} (${(message.fileSize / 1024 / 1024).toFixed(1)}MB) - streaming via StreamSaver.js (may stall on multi-GB)`);
        } catch (err) {
          console.log('StreamSaver.js failed:', err);
        }
      }

      // In-memory cap: 512MB. Above this we refuse rather than OOM the tab.
      const IN_MEMORY_LIMIT = 512 * 1024 * 1024;
      if (!incoming.useStreaming && message.fileSize > IN_MEMORY_LIMIT) {
        console.warn(`File too large for in-memory fallback; declining`);
        multiPeerWebRTCService.sendTo(
          peerId,
          JSON.stringify({ type: 'file-decline', fileId: message.fileId }),
        );
        this.events.onTransferError?.(
          message.fileId,
          new Error(
            `File is ${(message.fileSize / 1024 / 1024 / 1024).toFixed(1)}GB and your browser does not support a streaming download method. Try Chrome/Edge for files this large.`,
          ),
        );
        return;
      }
      if (!incoming.useStreaming) {
        console.warn(`Large file from ${peerId} (${(message.fileSize / 1024 / 1024).toFixed(1)}MB) will be held in memory - may cause issues`);
      }
    }

    // Watchdog: poll lastProgressAt; if no committed bytes for too long
    // while the channel is still open, abort with a clear message.
    incoming.watchdogTimer = setInterval(() => {
      if (Date.now() - incoming.lastProgressAt < WRITE_STALL_TIMEOUT_MS) return;
      if (incoming.state.status === 'completed' || incoming.state.status === 'cancelled') return;
      console.error(
        `Transfer ${incoming.fileId} stalled for ${WRITE_STALL_TIMEOUT_MS / 1000}s ` +
        `via ${incoming.streamingMethod}. Aborting.`,
      );
      this.abortIncoming(incoming, new Error(
        `Transfer stalled. The browser stopped accepting writes. ` +
        (incoming.streamingMethod === 'stream-saver'
          ? 'This is a known limitation of the StreamSaver fallback for very large files on Firefox. Try Chrome/Edge for multi-GB transfers.'
          : 'Disk may be full or write quota exhausted.'),
      ));
    }, 5_000);

    const key = `${peerId}:${message.fileId}`;
    this.incomingTransfers.set(key, incoming);
    this.events.onIncomingFile?.(peerId, message.fileId, safeFileName, message.fileSize, message.fileType);
    this.events.onTransferStart?.(state);

    // Tell the sender we accepted. The sender waits for this before
    // transmitting any chunks (Phase 1 sender backpressure).
    multiPeerWebRTCService.sendTo(
      peerId,
      JSON.stringify({ type: 'file-accept', fileId: message.fileId }),
    );
  }

  /**
   * Decide whether to accept an incoming file. Centralizes the policy:
   *   1. If the user pre-approved this peer for the session, accept silently.
   *   2. Else delegate to the page-supplied callback (which prompts the user).
   *   3. The page's callback may consult the autoReceive store flag itself,
   *      but the service-level default is to ask.
   */
  private async shouldAcceptFile(
    peerId: string,
    fileName: string,
    fileSize: number,
    fileType: string,
  ): Promise<boolean> {
    if (this.acceptAllFromPeer.has(peerId)) return true;
    try {
      return await this.acceptIncomingFile(peerId, fileName, fileSize, fileType);
    } catch (err) {
      console.error('Accept callback threw; defaulting to decline:', err);
      return false;
    }
  }

  private handleChunkData(peerId: string, data: ArrayBuffer): void {
    const fileId = this.currentIncomingFileId.get(peerId);
    if (!fileId) {
      console.error(`Received chunk data from ${peerId} without file ID`);
      return;
    }

    const key = `${peerId}:${fileId}`;
    const incoming = this.incomingTransfers.get(key);
    if (!incoming) {
      console.error(`Unknown file ID from ${peerId}:`, fileId);
      return;
    }

    // Serialize writes through the per-transfer queue. Critical for two
    // reasons:
    //   1. FileSystemWritableFileStream and StreamSaver's writer both
    //      reject concurrent writes (some browsers throw InvalidStateError,
    //      some silently drop). Without serialization, big files showed
    //      as "750MB sent / 64KB received" because most chunks faulted
    //      on the receiver and the sender kept blasting.
    //   2. bytesTransferred should reflect actually-committed bytes, not
    //      arrived bytes. Otherwise the UI claims success while data is
    //      still queued in front of a slow disk and an error mid-stream
    //      would lose chunks the UI already counted.
    incoming.writeQueueTail = incoming.writeQueueTail.then(async () => {
      try {
        if (incoming.useStreaming) {
          if (incoming.streamingMethod === 'file-system-access' && incoming.writable) {
            await incoming.writable.write(data);
          } else if (incoming.streamingMethod === 'opfs' && incoming.opfsWritable) {
            await incoming.opfsWritable.write(data);
          } else if (incoming.streamingMethod === 'stream-saver' && incoming.streamSaverWriter) {
            await incoming.streamSaverWriter.write(new Uint8Array(data));
          }
        } else {
          incoming.receivedChunks.push(data);
        }
        incoming.state.bytesTransferred += data.byteLength;
        incoming.chunksWritten += 1;
        incoming.lastProgressAt = Date.now();
        const elapsed = (Date.now() - incoming.state.startTime!) / 1000;
        incoming.state.speed = elapsed > 0
          ? incoming.state.bytesTransferred / elapsed
          : 0;
        this.events.onTransferProgress?.(incoming.state);
        // Periodic ACK back to the sender so they can throttle. Sent
        // every PROGRESS_ACK_INTERVAL committed chunks. The sender uses
        // this to enforce a sliding window and not run miles ahead of
        // the receiver's commit cursor.
        if (incoming.chunksWritten - incoming.lastAckedChunks >= PROGRESS_ACK_INTERVAL) {
          incoming.lastAckedChunks = incoming.chunksWritten;
          multiPeerWebRTCService.sendTo(
            incoming.peerId,
            JSON.stringify({
              type: 'file-progress',
              fileId: incoming.fileId,
              chunksWritten: incoming.chunksWritten,
            }),
          );
        }
      } catch (err) {
        console.error(`Error writing chunk from ${peerId} to disk:`, err);
        incoming.state.status = 'error';
        this.events.onTransferError?.(incoming.fileId, err as Error);
      }
    });
  }

  /**
   * Tear down a stalled or failed incoming transfer. Called by the
   * watchdog when no committed bytes have landed for too long.
   *
   * Steps, in order:
   *   1. Stop the watchdog so it can't re-fire while we're cleaning up.
   *   2. Abort whichever writer is in flight so any pending write()
   *      promises reject promptly. opfsWritable.abort() also discards
   *      the partial OPFS file.
   *   3. Remove the OPFS entry by name (best-effort; abort() should
   *      handle it but be defensive).
   *   4. Tell the sender to stop. Without this they sit at +window
   *      ahead of our last ACK forever, which is the original bug.
   *   5. Surface the error to the UI and drop the transfer.
   */
  private abortIncoming(incoming: IncomingTransfer, error: Error): void {
    const key = `${incoming.peerId}:${incoming.fileId}`;
    if (!this.incomingTransfers.has(key)) return; // already torn down

    if (incoming.watchdogTimer) {
      clearInterval(incoming.watchdogTimer);
      incoming.watchdogTimer = null;
    }

    if (incoming.writable) incoming.writable.abort().catch(() => {});
    if (incoming.opfsWritable) incoming.opfsWritable.abort().catch(() => {});
    if (incoming.streamSaverWriter) incoming.streamSaverWriter.abort().catch(() => {});

    if (incoming.opfsName) {
      navigator.storage.getDirectory()
        .then((root) => root.removeEntry(incoming.opfsName!))
        .catch(() => {});
    }

    // Best-effort: tell the sender we're done so they don't hang on the
    // flow-control window waiting for ACKs from a dead writer.
    if (multiPeerWebRTCService.isDataChannelOpen(incoming.peerId)) {
      try {
        multiPeerWebRTCService.sendTo(
          incoming.peerId,
          JSON.stringify({ type: 'transfer-cancel', fileId: incoming.fileId }),
        );
      } catch {
        // ignore; channel may have closed underneath us
      }
    }

    incoming.state.status = 'error';
    this.events.onTransferError?.(incoming.fileId, error);
    this.incomingTransfers.delete(key);
  }

  private async completeIncomingTransfer(incoming: IncomingTransfer): Promise<void> {
    const key = `${incoming.peerId}:${incoming.fileId}`;

    // Stop the stall watchdog: we are entering completion logic.
    if (incoming.watchdogTimer) {
      clearInterval(incoming.watchdogTimer);
      incoming.watchdogTimer = null;
    }

    // Wait for every queued write to land before we close the stream.
    // Otherwise close() races with in-flight writes and either truncates
    // the file or throws InvalidStateError.
    await incoming.writeQueueTail;

    if (incoming.useStreaming) {
      try {
        if (incoming.streamingMethod === 'file-system-access' && incoming.writable) {
          await incoming.writable.close();
          console.log(`File from ${incoming.peerId} saved directly to disk via File System Access API`);
        } else if (incoming.streamingMethod === 'opfs' && incoming.opfsWritable && incoming.opfsHandle) {
          await incoming.opfsWritable.close();
          // Deliver the file via <a download> from the OPFS-backed Blob.
          // The browser streams from the OPFS handle, so memory stays
          // bounded even for multi-GB files.
          const file = await incoming.opfsHandle.getFile();
          const url = URL.createObjectURL(file);
          const a = document.createElement('a');
          a.href = url;
          a.download = incoming.fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          // Defer cleanup so the browser has time to start the download.
          // Keeping the OPFS entry around for a few minutes also means
          // a dropped download can be re-saved by the user if our session
          // is still active.
          setTimeout(() => {
            URL.revokeObjectURL(url);
            if (incoming.opfsName) {
              navigator.storage.getDirectory()
                .then((root) => root.removeEntry(incoming.opfsName!))
                .catch(() => {});
            }
          }, 5 * 60 * 1000);
          console.log(`File from ${incoming.peerId} saved via OPFS + <a download>`);
        } else if (incoming.streamingMethod === 'stream-saver' && incoming.streamSaverWriter) {
          await incoming.streamSaverWriter.close();
          console.log(`File from ${incoming.peerId} saved directly to disk via StreamSaver.js`);
        }
      } catch (err) {
        console.error('Error closing file stream:', err);
        incoming.state.status = 'error';
        this.events.onTransferError?.(incoming.fileId, err as Error);
        return;
      }
    } else {
      // Combine all chunks into a single blob (small files).
      const blob = new Blob(incoming.receivedChunks, { type: incoming.fileType });

      // Phase 1.3: prefer showSaveFilePicker even for small files when
      // available so the user remains in control of where bytes land.
      // The user has already accepted the transfer at this point; if they
      // cancel the save dialog we drop the file.
      let saved = false;
      if (supportsFileSystemAccess) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: incoming.fileName,
            types: [{
              description: 'File',
              accept: { [incoming.fileType || 'application/octet-stream']: [] },
            }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          saved = true;
        } catch (err) {
          // User cancelled or API unavailable; fall through to <a download>.
          // Note: AbortError is the typical "user cancelled" path.
          console.log('showSaveFilePicker not used:', (err as Error)?.name ?? err);
        }
      }

      if (!saved) {
        // Fallback path. Already gated by the explicit user accept in
        // initializeIncomingTransfer, so this is no longer a drive-by.
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = incoming.fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      // Free memory
      incoming.receivedChunks = [];
    }

    incoming.state.status = 'completed';
    this.events.onTransferComplete?.(incoming.state);
    this.incomingTransfers.delete(key);
  }

  cancelTransfer(fileId: string): void {
    const broadcast = this.broadcastTransfers.get(fileId);
    if (broadcast) {
      // Mark cancelled first so any in-flight sendNextChunk loops exit on
      // their next iteration. Wake any per-peer loops that are blocked
      // waiting for an ACK so they observe the cancellation flag.
      broadcast.cancelled = true;
      for (const [, waiter] of broadcast.perPeerAckWaiters) waiter();
      broadcast.perPeerAckWaiters.clear();
      broadcast.state.status = 'cancelled';
      this.events.onTransferError?.(fileId, new Error('Transfer cancelled'));
      this.broadcastTransfers.delete(fileId);

      // Notify all peers
      const cancelMessage: DataChannelMessage = {
        type: 'transfer-cancel',
        fileId,
      };
      multiPeerWebRTCService.broadcast(JSON.stringify(cancelMessage));
    }

    // Also check incoming transfers (need to iterate since key includes peerId)
    for (const [key, incoming] of this.incomingTransfers.entries()) {
      if (incoming.fileId === fileId) {
        incoming.state.status = 'cancelled';
        if (incoming.writable) {
          incoming.writable.abort().catch(() => {});
        }
        if (incoming.streamSaverWriter) {
          incoming.streamSaverWriter.abort().catch(() => {});
        }
        this.events.onTransferError?.(fileId, new Error('Transfer cancelled'));
        this.incomingTransfers.delete(key);
      }
    }
  }

  /**
   * Notify the service that a peer has disconnected. Active outbound
   * transfers to that peer are tidied up so they don't hang in
   * "waiting for slow peer" forever.
   *
   * Three cases:
   *   - peer was actively receiving (in acceptedPeers but not completedPeers):
   *     mark them completed so the aggregate completion check moves on.
   *   - peer was a target who never accepted or declined: treat as decline
   *     so the transfer can finalize for the remaining peers.
   *   - peer had nothing in flight: nothing to do.
   */
  handlePeerDisconnected(peerId: string): void {
    for (const transfer of this.broadcastTransfers.values()) {
      // Wake the per-peer ACK waiter (if any) so the loop notices the
      // disconnect rather than blocking forever for an ACK from a peer
      // that's gone.
      const waiter = transfer.perPeerAckWaiters.get(peerId);
      if (waiter) {
        transfer.perPeerAckWaiters.delete(peerId);
        waiter();
      }

      const wasReceiving = transfer.acceptedPeers.has(peerId)
        && !transfer.completedPeers.has(peerId);
      const wasUnresolved = transfer.targetPeers.includes(peerId)
        && !transfer.acceptedPeers.has(peerId)
        && !transfer.declinedPeers.has(peerId);

      if (wasReceiving) {
        transfer.completedPeers.add(peerId);
        this.checkTransferComplete(transfer, true);
      } else if (wasUnresolved) {
        transfer.declinedPeers.add(peerId);
        this.events.onFileDeclined?.(peerId, transfer.fileId);
        this.checkTransferComplete(transfer, true);
      }
    }
    // Forget any incoming transfer in flight from this peer.
    for (const [key, incoming] of this.incomingTransfers.entries()) {
      if (incoming.peerId === peerId) {
        if (incoming.writable) incoming.writable.abort().catch(() => {});
        if (incoming.streamSaverWriter) incoming.streamSaverWriter.abort().catch(() => {});
        incoming.state.status = 'cancelled';
        this.events.onTransferError?.(incoming.fileId, new Error('Peer disconnected'));
        this.incomingTransfers.delete(key);
      }
    }
  }

  getTransfer(fileId: string): TransferState | null {
    const broadcast = this.broadcastTransfers.get(fileId);
    if (broadcast) return broadcast.state;

    // Check incoming transfers
    for (const incoming of this.incomingTransfers.values()) {
      if (incoming.fileId === fileId) {
        return incoming.state;
      }
    }

    return null;
  }

  getAllTransfers(): TransferState[] {
    const transfers: TransferState[] = [];
    
    for (const broadcast of this.broadcastTransfers.values()) {
      transfers.push(broadcast.state);
    }
    
    for (const incoming of this.incomingTransfers.values()) {
      transfers.push(incoming.state);
    }
    
    return transfers;
  }
}

export const multiPeerFileTransferService = new MultiPeerFileTransferService();
