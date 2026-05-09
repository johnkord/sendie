import { multiPeerWebRTCService } from './MultiPeerWebRTCService';
import { cryptoService } from './CryptoService';
import { verificationService } from './VerificationService';
import { sanitizeFilename } from '../utils/formatters';
import streamSaver from './streamSaverInit';
import type { TransferState, DataChannelMessage, FileStartMessage } from '../types';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const STREAMING_THRESHOLD = 100 * 1024 * 1024; // 100MB - files larger than this stream to disk

// Check if File System Access API is supported (Chrome/Edge)
const supportsFileSystemAccess = 'showSaveFilePicker' in window;

// StreamSaver.js works in all modern browsers as fallback
const supportsStreamSaver = typeof WritableStream !== 'undefined';

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
  useStreaming: boolean;
  streamingMethod: 'none' | 'file-system-access' | 'stream-saver';
  state: TransferState;
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
        multiPeerWebRTCService.onBufferedAmountLow(() => {
          transfer.perPeerPaused.delete(peerId);
          sendNextChunk();
        });
        return;
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
      this.recomputeAggregateProgress(transfer);

      chunkIndex++;

      // Per-peer flow control: only this peer pauses when its outbound buffer
      // is over the threshold. The data channel is configured with
      // bufferedAmountLowThreshold = 64 KiB; mirror that here so we keep the
      // pipe full without ballooning the channel's buffer.
      const BUFFER_HIGH_WATER = 64 * 1024;
      if (multiPeerWebRTCService.getBufferedAmount(peerId) > BUFFER_HIGH_WATER) {
        transfer.perPeerPaused.add(peerId);
        multiPeerWebRTCService.onBufferedAmountLow(() => {
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
   * Aggregate completion check. If every accepted peer has either finished
   * or the transfer was cancelled, finalize the transfer state.
   */
  private checkTransferComplete(transfer: BroadcastTransfer, cancelledByThisPeer: boolean): void {
    if (!this.broadcastTransfers.has(transfer.fileId)) return;

    const allDone = [...transfer.acceptedPeers].every((p) => transfer.completedPeers.has(p));
    if (!allDone) return;

    if (transfer.cancelled || (cancelledByThisPeer && transfer.acceptedPeers.size === transfer.completedPeers.size && transfer.acceptedPeers.size === 0)) {
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

      case 'transfer-cancel': {
        const key = `${peerId}:${message.fileId}`;
        const incoming = this.incomingTransfers.get(key);
        if (incoming) {
          incoming.state.status = 'cancelled';
          if (incoming.writable) {
            incoming.writable.abort().catch(() => {});
          }
          if (incoming.streamSaverWriter) {
            incoming.streamSaverWriter.abort().catch(() => {});
          }
          this.events.onTransferError?.(message.fileId, new Error('Transfer cancelled by sender'));
          this.incomingTransfers.delete(key);
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
      useStreaming: false,
      streamingMethod: 'none',
      state,
    };

    // For large files, try to set up streaming to disk.
    // For small files we will go through showSaveFilePicker on completion
    // (when supported); fall back to <a download> after the user already
    // explicitly accepted, so this is not a drive-by.
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
          console.log('File System Access cancelled, trying StreamSaver.js fallback');
        }
      }
      
      if (!incoming.useStreaming && supportsStreamSaver) {
        try {
          const fileStream = streamSaver.createWriteStream(safeFileName, {
            size: message.fileSize,
          });
          incoming.streamSaverWriter = fileStream.getWriter();
          incoming.useStreaming = true;
          incoming.streamingMethod = 'stream-saver';
          console.log(`Large file from ${peerId} (${(message.fileSize / 1024 / 1024).toFixed(1)}MB) - streaming via StreamSaver.js`);
        } catch (err) {
          console.log('StreamSaver.js failed, falling back to in-memory:', err);
        }
      }

      if (!incoming.useStreaming) {
        console.warn(`Large file from ${peerId} (${(message.fileSize / 1024 / 1024).toFixed(1)}MB) will be held in memory - may cause issues`);
      }
    }

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

  private async handleChunkData(peerId: string, data: ArrayBuffer): Promise<void> {
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

    // Stream to disk or store in memory based on method
    if (incoming.useStreaming) {
      try {
        if (incoming.streamingMethod === 'file-system-access' && incoming.writable) {
          await incoming.writable.write(data);
        } else if (incoming.streamingMethod === 'stream-saver' && incoming.streamSaverWriter) {
          await incoming.streamSaverWriter.write(new Uint8Array(data));
        }
      } catch (err) {
        console.error(`Error writing chunk from ${peerId} to disk:`, err);
        incoming.state.status = 'error';
        this.events.onTransferError?.(incoming.fileId, err as Error);
        return;
      }
    } else {
      incoming.receivedChunks.push(data);
    }

    incoming.state.bytesTransferred += data.byteLength;

    const elapsed = (Date.now() - incoming.state.startTime!) / 1000;
    incoming.state.speed = elapsed > 0 ? incoming.state.bytesTransferred / elapsed : 0;

    this.events.onTransferProgress?.(incoming.state);
  }

  private async completeIncomingTransfer(incoming: IncomingTransfer): Promise<void> {
    const key = `${incoming.peerId}:${incoming.fileId}`;

    if (incoming.useStreaming) {
      try {
        if (incoming.streamingMethod === 'file-system-access' && incoming.writable) {
          await incoming.writable.close();
          console.log(`File from ${incoming.peerId} saved directly to disk via File System Access API`);
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
      // their next iteration. Then notify peers and emit the UI event.
      broadcast.cancelled = true;
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
   */
  handlePeerDisconnected(peerId: string): void {
    for (const transfer of this.broadcastTransfers.values()) {
      if (transfer.acceptedPeers.has(peerId) && !transfer.completedPeers.has(peerId)) {
        transfer.completedPeers.add(peerId);
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
