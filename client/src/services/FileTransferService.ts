import { webrtcService } from './WebRTCService';
import { cryptoService } from './CryptoService';
import streamSaver from 'streamsaver';
import type { TransferState, DataChannelMessage, FileStartMessage } from '../types';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const STREAMING_THRESHOLD = 100 * 1024 * 1024; // 100MB - files larger than this stream to disk

// Check if File System Access API is supported (Chrome/Edge)
const supportsFileSystemAccess = 'showSaveFilePicker' in window;

// StreamSaver.js works in all modern browsers as fallback
const supportsStreamSaver = typeof WritableStream !== 'undefined';

export type FileTransferEvents = {
  onTransferStart: (transfer: TransferState) => void;
  onTransferProgress: (transfer: TransferState) => void;
  onTransferComplete: (transfer: TransferState) => void;
  onTransferError: (fileId: string, error: Error) => void;
  onIncomingFile: (fileId: string, fileName: string, fileSize: number, fileType: string) => void;
};

interface PendingTransfer {
  file: File;
  fileId: string;
  state: TransferState;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface IncomingTransfer {
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  totalChunks: number;
  receivedChunks: ArrayBuffer[]; // Used for small files (in-memory)
  fileHandle: FileSystemFileHandle | null; // Used for large files (File System Access API)
  writable: FileSystemWritableFileStream | null; // Used for large files (File System Access API)
  streamSaverWriter: WritableStreamDefaultWriter<Uint8Array> | null; // Used for large files (StreamSaver.js fallback)
  useStreaming: boolean;
  streamingMethod: 'none' | 'file-system-access' | 'stream-saver';
  state: TransferState;
}

export class FileTransferService {
  private events: Partial<FileTransferEvents> = {};
  private pendingTransfers: Map<string, PendingTransfer> = new Map();
  private incomingTransfers: Map<string, IncomingTransfer> = new Map();
  private currentSendTransfer: PendingTransfer | null = null;
  private sendPaused = false;

  constructor() {
    // Listen for incoming data
    webrtcService.on('onDataChannelMessage', this.handleMessage.bind(this));
  }

  on<K extends keyof FileTransferEvents>(event: K, handler: FileTransferEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof FileTransferEvents>(event: K): void {
    delete this.events[event];
  }

  /**
   * Send a file to the connected peer
   */
  async sendFile(file: File): Promise<void> {
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
      const transfer: PendingTransfer = {
        file,
        fileId,
        state,
        resolve,
        reject,
      };

      this.pendingTransfers.set(fileId, transfer);
      this.events.onTransferStart?.(state);

      // Send file metadata
      const metadata: DataChannelMessage = {
        type: 'file-start',
        fileId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        totalChunks,
      };

      webrtcService.send(JSON.stringify(metadata));
      
      // Start sending chunks
      this.currentSendTransfer = transfer;
      this.sendChunks(transfer, totalChunks);
    });
  }

  private async sendChunks(transfer: PendingTransfer, totalChunks: number): Promise<void> {
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
        webrtcService.onBufferedAmountLow(() => {
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
        webrtcService.send(JSON.stringify(endMessage));
        
        state.status = 'completed';
        this.events.onTransferComplete?.(state);
        this.pendingTransfers.delete(fileId);
        this.currentSendTransfer = null;
        transfer.resolve();
        return;
      }

      // Extract chunk
      const chunkSize = Math.min(CHUNK_SIZE, buffer.length);
      const chunk = buffer.slice(0, chunkSize);
      buffer = buffer.slice(chunkSize);

      // Send chunk header
      const chunkHeader: DataChannelMessage = {
        type: 'file-chunk',
        fileId,
        chunkIndex,
      };
      webrtcService.send(JSON.stringify(chunkHeader));

      // Send chunk data
      webrtcService.send(chunk.buffer);

      // Update progress
      state.bytesTransferred += chunk.length;
      const elapsed = (Date.now() - state.startTime!) / 1000;
      state.speed = elapsed > 0 ? state.bytesTransferred / elapsed : 0;
      this.events.onTransferProgress?.(state);

      chunkIndex++;

      // Check buffer and continue
      if (!webrtcService.isBufferLow) {
        this.sendPaused = true;
        webrtcService.onBufferedAmountLow(() => {
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

  private handleMessage(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      // JSON message
      try {
        const message = JSON.parse(data) as DataChannelMessage;
        this.handleControlMessage(message);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    } else {
      // Binary chunk data
      this.handleChunkData(data);
    }
  }

  private currentIncomingFileId: string | null = null;

  private handleControlMessage(message: DataChannelMessage): void {
    switch (message.type) {
      case 'file-start': {
        this.initializeIncomingTransfer(message);
        break;
      }

      case 'file-chunk': {
        // Store the file ID for the next binary chunk
        this.currentIncomingFileId = message.fileId;
        break;
      }

      case 'file-end': {
        const incoming = this.incomingTransfers.get(message.fileId);
        if (incoming) {
          this.completeIncomingTransfer(incoming);
        }
        break;
      }

      case 'transfer-cancel': {
        const incoming = this.incomingTransfers.get(message.fileId);
        if (incoming) {
          incoming.state.status = 'cancelled';
          // Clean up streaming resources if active
          if (incoming.writable) {
            incoming.writable.abort().catch(() => {});
          }
          if (incoming.streamSaverWriter) {
            incoming.streamSaverWriter.abort().catch(() => {});
          }
          this.events.onTransferError?.(message.fileId, new Error('Transfer cancelled by sender'));
          this.incomingTransfers.delete(message.fileId);
        }
        break;
      }
    }
  }

  /**
   * Initialize an incoming transfer, setting up streaming for large files
   */
  private async initializeIncomingTransfer(message: FileStartMessage): Promise<void> {
    const state: TransferState = {
      fileId: message.fileId,
      fileName: message.fileName,
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
      fileId: message.fileId,
      fileName: message.fileName,
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
      // Try File System Access API first (Chrome/Edge - allows user to choose location)
      if (supportsFileSystemAccess) {
        try {
          const fileHandle = await window.showSaveFilePicker({
            suggestedName: message.fileName,
            types: [{
              description: 'File',
              accept: { [message.fileType || 'application/octet-stream']: [] },
            }],
          });
          incoming.fileHandle = fileHandle;
          incoming.writable = await fileHandle.createWritable();
          incoming.useStreaming = true;
          incoming.streamingMethod = 'file-system-access';
          console.log(`Large file (${(message.fileSize / 1024 / 1024).toFixed(1)}MB) - streaming via File System Access API`);
        } catch (err) {
          // User cancelled - try StreamSaver.js fallback
          console.log('File System Access cancelled, trying StreamSaver.js fallback');
        }
      }
      
      // Fallback to StreamSaver.js (works on Firefox/Safari)
      if (!incoming.useStreaming && supportsStreamSaver) {
        try {
          const fileStream = streamSaver.createWriteStream(message.fileName, {
            size: message.fileSize,
          });
          incoming.streamSaverWriter = fileStream.getWriter();
          incoming.useStreaming = true;
          incoming.streamingMethod = 'stream-saver';
          console.log(`Large file (${(message.fileSize / 1024 / 1024).toFixed(1)}MB) - streaming via StreamSaver.js`);
        } catch (err) {
          console.log('StreamSaver.js failed, falling back to in-memory:', err);
        }
      }

      if (!incoming.useStreaming) {
        console.warn(`Large file (${(message.fileSize / 1024 / 1024).toFixed(1)}MB) will be held in memory - may cause issues`);
      }
    }

    this.incomingTransfers.set(message.fileId, incoming);
    this.events.onIncomingFile?.(message.fileId, message.fileName, message.fileSize, message.fileType);
    this.events.onTransferStart?.(state);
  }

  private async handleChunkData(data: ArrayBuffer): Promise<void> {
    if (!this.currentIncomingFileId) {
      console.error('Received chunk data without file ID');
      return;
    }

    const incoming = this.incomingTransfers.get(this.currentIncomingFileId);
    if (!incoming) {
      console.error('Unknown file ID:', this.currentIncomingFileId);
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
        console.error('Error writing chunk to disk:', err);
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
    if (incoming.useStreaming) {
      // Close the appropriate stream - data is already on disk
      try {
        if (incoming.streamingMethod === 'file-system-access' && incoming.writable) {
          await incoming.writable.close();
          console.log('File saved directly to disk via File System Access API');
        } else if (incoming.streamingMethod === 'stream-saver' && incoming.streamSaverWriter) {
          await incoming.streamSaverWriter.close();
          console.log('File saved directly to disk via StreamSaver.js');
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
    this.incomingTransfers.delete(incoming.fileId);
  }

  cancelTransfer(fileId: string): void {
    const pending = this.pendingTransfers.get(fileId);
    if (pending) {
      pending.state.status = 'cancelled';
      this.events.onTransferError?.(fileId, new Error('Transfer cancelled'));
      this.pendingTransfers.delete(fileId);
      
      if (this.currentSendTransfer?.fileId === fileId) {
        this.currentSendTransfer = null;
      }

      // Notify peer
      const cancelMessage: DataChannelMessage = {
        type: 'transfer-cancel',
        fileId,
      };
      webrtcService.send(JSON.stringify(cancelMessage));
    }

    const incoming = this.incomingTransfers.get(fileId);
    if (incoming) {
      incoming.state.status = 'cancelled';
      // Clean up streaming resources if active
      if (incoming.writable) {
        incoming.writable.abort().catch(() => {});
      }
      if (incoming.streamSaverWriter) {
        incoming.streamSaverWriter.abort().catch(() => {});
      }
      this.events.onTransferError?.(fileId, new Error('Transfer cancelled'));
      this.incomingTransfers.delete(fileId);
    }
  }

  getTransfer(fileId: string): TransferState | null {
    const pending = this.pendingTransfers.get(fileId);
    if (pending) return pending.state;

    const incoming = this.incomingTransfers.get(fileId);
    if (incoming) return incoming.state;

    return null;
  }

  getAllTransfers(): TransferState[] {
    const transfers: TransferState[] = [];
    
    for (const pending of this.pendingTransfers.values()) {
      transfers.push(pending.state);
    }
    
    for (const incoming of this.incomingTransfers.values()) {
      transfers.push(incoming.state);
    }
    
    return transfers;
  }
}

export const fileTransferService = new FileTransferService();
