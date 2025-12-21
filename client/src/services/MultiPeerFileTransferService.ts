import { multiPeerWebRTCService } from './MultiPeerWebRTCService';
import { cryptoService } from './CryptoService';
import { sanitizeFilename } from '../utils/formatters';
import streamSaver from 'streamsaver';
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
};

interface BroadcastTransfer {
  file: File;
  fileId: string;
  state: TransferState;
  targetPeers: string[];
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
  private currentBroadcast: BroadcastTransfer | null = null;
  private sendPaused = false;

  constructor() {
    // Listen for incoming data from all peers
    multiPeerWebRTCService.on('onDataChannelMessage', this.handleMessage.bind(this));
  }

  on<K extends keyof MultiPeerFileTransferEvents>(event: K, handler: MultiPeerFileTransferEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof MultiPeerFileTransferEvents>(event: K): void {
    delete this.events[event];
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
      
      // Start broadcasting chunks
      this.currentBroadcast = transfer;
      this.broadcastChunks(transfer, totalChunks);
    });
  }

  private async broadcastChunks(transfer: BroadcastTransfer, totalChunks: number): Promise<void> {
    const { file, fileId, state } = transfer;
    
    state.status = 'transferring';
    state.startTime = Date.now();
    this.events.onTransferProgress?.(state);

    let chunkIndex = 0;
    const reader = file.stream().getReader();
    let buffer = new Uint8Array(0);

    const sendNextChunk = async (): Promise<void> => {
      if (this.sendPaused) {
        // Wait for buffer to drain
        multiPeerWebRTCService.onBufferedAmountLow(() => {
          this.sendPaused = false;
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
        // All chunks sent
        const endMessage: DataChannelMessage = {
          type: 'file-end',
          fileId,
        };
        multiPeerWebRTCService.broadcast(JSON.stringify(endMessage));
        
        state.status = 'completed';
        this.events.onTransferComplete?.(state);
        this.broadcastTransfers.delete(fileId);
        this.currentBroadcast = null;
        transfer.resolve();
        return;
      }

      // Extract chunk
      const chunkSize = Math.min(CHUNK_SIZE, buffer.length);
      const chunk = buffer.slice(0, chunkSize);
      buffer = buffer.slice(chunkSize);

      // Send chunk header to all peers
      const chunkHeader: DataChannelMessage = {
        type: 'file-chunk',
        fileId,
        chunkIndex,
      };
      multiPeerWebRTCService.broadcast(JSON.stringify(chunkHeader));

      // Send chunk data to all peers
      multiPeerWebRTCService.broadcast(chunk.buffer);

      // Update progress
      state.bytesTransferred += chunk.length;
      const elapsed = (Date.now() - state.startTime!) / 1000;
      state.speed = elapsed > 0 ? state.bytesTransferred / elapsed : 0;
      this.events.onTransferProgress?.(state);

      chunkIndex++;

      // Check buffer and continue
      if (!multiPeerWebRTCService.isBufferLow()) {
        this.sendPaused = true;
        multiPeerWebRTCService.onBufferedAmountLow(() => {
          this.sendPaused = false;
          sendNextChunk();
        });
      } else {
        // Use setTimeout to prevent blocking
        setTimeout(sendNextChunk, 0);
      }
    };

    await sendNextChunk();
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
    }
  }

  /**
   * Initialize an incoming transfer from a specific peer
   */
  private async initializeIncomingTransfer(peerId: string, message: FileStartMessage): Promise<void> {
    // Sanitize filename from peer to prevent security issues
    const safeFileName = sanitizeFilename(message.fileName);

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

    // For large files, try to set up streaming to disk
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
      // Combine all chunks into a single blob (small files)
      const blob = new Blob(incoming.receivedChunks, { type: incoming.fileType });
      
      // Trigger download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = incoming.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
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
      broadcast.state.status = 'cancelled';
      this.events.onTransferError?.(fileId, new Error('Transfer cancelled'));
      this.broadcastTransfers.delete(fileId);
      
      if (this.currentBroadcast?.fileId === fileId) {
        this.currentBroadcast = null;
      }

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
