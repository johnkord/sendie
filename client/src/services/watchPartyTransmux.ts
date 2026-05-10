/**
 * Browser-side mp4 -> fmp4 transmuxer using mp4box.js.
 *
 * Why: the receiver's MSE pipeline (F-progressive) requires fragmented
 * mp4 (fmp4 / CMAF), but most mp4 files in the wild are non-fragmented
 * (one giant `mdat`, even if `moov` is at the front). Without this
 * pass, the receiver waits for the full transfer before any frame
 * plays. With this pass, the host repackages the file into fmp4 in
 * memory before sending; the receiver's existing MSE path then works
 * unchanged.
 *
 * What it doesn't do: re-encode. Sample data is copied bit-for-bit
 * from the input into the output container. No quality loss, much
 * faster than re-encode.
 *
 * See docs/transmuxing-research.md for the analysis behind this
 * choice (mp4box.js vs ffmpeg.wasm vs custom muxer vs server-side).
 */

// We dynamic-import this module on demand, so the mp4box bundle is
// only paid for by users who actually start a watch-party in forward
// mode. Idle Sendie pays nothing.

// -------- Minimal type declaration for mp4box --------
//
// The npm package ships no types and the surface we use is small.
// Declaring just what we touch keeps the rest of the codebase honest.
type MP4Track = {
  id: number;
  codec: string;
  type: 'video' | 'audio' | string;
};
type MP4Info = {
  isFragmented: boolean;
  tracks: MP4Track[];
  mime?: string; // composite codec mime: 'video/mp4; codecs="avc1.X, mp4a.Y"'
};
type AppendableArrayBuffer = ArrayBuffer & { fileStart: number };
type InitSegment = { id: number; user: unknown; buffer: ArrayBuffer };
interface MP4File {
  onReady: (info: MP4Info) => void;
  onError: (err: string) => void;
  onMoovStart?: () => void;
  onSegment: (id: number, user: unknown, buffer: ArrayBuffer, sampleNumber: number, last: boolean) => void;
  appendBuffer(data: AppendableArrayBuffer): number;
  setSegmentOptions(trackId: number, user: unknown, opts: { nbSamples?: number; rapAlignement?: boolean }): void;
  initializeSegmentation(): InitSegment[];
  start(): void;
  flush(): void;
}
interface MP4BoxModule {
  createFile(keepMdatData?: boolean): MP4File;
}

/** Soft cap. Above this we skip transmux and fall back to wait-for-receipt. */
export const TRANSMUX_MAX_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
/**
 * Below this we skip transmux: the file is small enough that the
 * receiver finishes the C1 wait-for-full-receipt before transmux
 * would finish. 5 MB is conservative; on typical p2p data channels
 * (5-50 Mbps) a 5 MB transfer is 1-8 seconds, and transmux of a 5 MB
 * mp4 is sub-100ms, so we still benefit. We could remove this floor
 * entirely, but keeping it avoids the visible 'Preparing...' overlay
 * for trivial files where it would feel pointless.
 */
export const TRANSMUX_MIN_BYTES = 5 * 1024 * 1024; // 5 MB
/** Read chunk size for the input. Big enough to keep mp4box's parser busy without spiking JS heap. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB

export type TransmuxProgress = {
  /**
   * 0..1 overall transmux progress. Combines bytes-read from input
   * (~80% of the work) with segments-emitted past the read phase
   * (~20% trailing). Without this weighting, callers see 100% while
   * mp4box is still flushing remaining segments after the last read.
   */
  progress: number;
};

export interface TransmuxResult {
  /** Composite mime string (e.g. 'video/mp4; codecs="avc1.64001f, mp4a.40.2"'). */
  mediaType: string;
  /** The transmuxed output as a single Blob. Type matches mediaType-stripped-of-codecs. */
  blob: Blob;
}

export class TransmuxError extends Error {
  constructor(public reason: 'unsupported-input' | 'mp4box-error' | 'too-large', message: string) {
    super(message);
  }
}

/**
 * Decide quickly whether a file is worth transmuxing. We read just the
 * first 64 KB; mp4 headers are usually well below that. Returns:
 *
 * - 'skip-already-fragmented': WebM, or fmp4, or anything else where
 *   the receiver MSE path already works without our help.
 * - 'transmux': plain mp4 with one giant mdat. Worth transmuxing.
 * - 'unknown': we couldn't tell. Receiver falls back to C1.
 */
export async function classifyForTransmux(file: File): Promise<'skip-already-fragmented' | 'transmux' | 'unknown'> {
  if (file.type.includes('webm') || file.name.toLowerCase().endsWith('.webm')) {
    return 'skip-already-fragmented';
  }
  // Read enough to find moov and check for mvex.
  const headBytes = await file.slice(0, 64 * 1024).arrayBuffer();
  const head = new Uint8Array(headBytes);
  if (!hasMp4Signature(head)) return 'unknown';
  const fragmented = mp4HasMvex(head);
  return fragmented ? 'skip-already-fragmented' : 'transmux';
}

/** Return true if the head looks like an mp4/iso-bmff file (has 'ftyp'). */
function hasMp4Signature(head: Uint8Array): boolean {
  if (head.length < 8) return false;
  return head[4] === 0x66 /* f */
      && head[5] === 0x74 /* t */
      && head[6] === 0x79 /* y */
      && head[7] === 0x70 /* p */;
}

/**
 * Walk top-level boxes; if we hit moov, look inside it for mvex.
 * mvex (movie-extends) marks the file as fragmented for MSE purposes.
 */
function mp4HasMvex(head: Uint8Array): boolean {
  let offset = 0;
  while (offset + 8 <= head.length) {
    const size = readU32BE(head, offset);
    const type = String.fromCharCode(head[offset + 4], head[offset + 5], head[offset + 6], head[offset + 7]);
    if (type === 'moov') {
      const moovEnd = offset + (size === 0 ? head.length - offset : size);
      let inner = offset + 8;
      while (inner + 8 <= Math.min(moovEnd, head.length)) {
        const innerSize = readU32BE(head, inner);
        const innerType = String.fromCharCode(head[inner + 4], head[inner + 5], head[inner + 6], head[inner + 7]);
        if (innerType === 'mvex') return true;
        if (innerSize < 8) return false;
        inner += innerSize;
      }
      return false;
    }
    if (type === 'mdat') return false; // mdat before moov: not even moov-first, weird input
    if (size < 8) return false;
    offset += size;
  }
  return false;
}

function readU32BE(b: Uint8Array, off: number): number {
  return (b[off] * 0x1000000) + (b[off + 1] << 16) + (b[off + 2] << 8) + b[off + 3];
}

/**
 * Transmux an mp4 file to fragmented mp4 in memory. Resolves with a
 * Blob whose bytes are MSE-streamable.
 *
 * Implementation notes:
 * - Uses progressive `appendBuffer(buf)` with `buf.fileStart`. mp4box
 *   parses headers as data arrives; we don't have to load the whole
 *   file before starting.
 * - In `onReady` we configure each track for segmentation and grab
 *   the init segments. We then call `start()`, which causes
 *   `onSegment` to fire for every fragment.
 * - We collect init segments + every onSegment buffer into an array
 *   of `BlobPart`s and finalize as a single Blob at the end.
 * - The returned mime string is the composite from `info.mime`,
 *   suitable for `MediaSource.addSourceBuffer` and our
 *   wp-file-start announcement.
 *
 * @param file       the source File or Blob.
 * @param onProgress optional progress callback (rate-limited; not
 *                   per-chunk).
 * @param signal     AbortSignal to cancel mid-transmux.
 */
export async function transmuxToFmp4(
  file: File,
  onProgress?: (p: TransmuxProgress) => void,
  signal?: AbortSignal,
): Promise<TransmuxResult> {
  if (file.size > TRANSMUX_MAX_BYTES) {
    throw new TransmuxError('too-large', `File is ${(file.size / 1e9).toFixed(1)} GB; max for browser-side transmux is 1.5 GB.`);
  }

  // Dynamic import keeps the mp4box bundle (~35 KB gzipped) out of
  // the main bundle. Vite handles this automatically.
  const mp4boxModule = await import('mp4box') as unknown as MP4BoxModule;
  const mp4boxfile = mp4boxModule.createFile(/* keepMdatData = */ true);

  return new Promise<TransmuxResult>((resolve, reject) => {
    const parts: BlobPart[] = [];
    let mediaType: string | null = null;
    let segmentingStarted = false;
    let aborted = false;
    // Progress weighting: reading the input is ~80% of the work,
    // emitting segments after EOF is ~20%. We don't know the segment
    // count up front, so we just report 80% on read-complete and let
    // the caller see it climb to 100% as flush() returns.
    let readFraction = 0;
    let postReadFraction = 0;
    const reportProgress = () => {
      onProgress?.({
        progress: Math.min(1, readFraction * 0.8 + postReadFraction * 0.2),
      });
    };

    const abort = (reason: TransmuxError | Error) => {
      if (aborted) return;
      aborted = true;
      try { mp4boxfile.flush(); } catch { /* ignore */ }
      reject(reason);
    };

    if (signal) {
      if (signal.aborted) {
        abort(new TransmuxError('mp4box-error', 'Transmux aborted before start.'));
        return;
      }
      signal.addEventListener('abort', () => {
        abort(new TransmuxError('mp4box-error', 'Transmux aborted by caller.'));
      }, { once: true });
    }

    mp4boxfile.onError = (err: string) => abort(new TransmuxError('mp4box-error', err));

    mp4boxfile.onReady = (info: MP4Info) => {
      if (aborted) return;
      // Configure every track for segmentation. nbSamples ~ 1000 is
      // mp4box's default and gives ~1-second fragments at 24-30 fps,
      // which matches what fmp4 streaming services use.
      mediaType = info.mime ?? 'video/mp4';
      for (const track of info.tracks) {
        // Smaller fragments = lower time-to-first-frame on the
        // receiver. nbSamples=60 is roughly 2 seconds of video at
        // 30 fps, or 60-something audio frames; receiver can start
        // playing after the first fragment lands. mp4box's default
        // is 1000 (~33 s fragments) which would defeat the whole
        // point of progressive playback.
        mp4boxfile.setSegmentOptions(track.id, null, { nbSamples: 60 });
      }
      const initSegs = mp4boxfile.initializeSegmentation();
      for (const seg of initSegs) {
        const buf = new Uint8Array(seg.buffer);
        parts.push(buf);
      }
      mp4boxfile.onSegment = (_id, _user, buffer, _sampleNumber, _last) => {
        if (aborted) return;
        const u8 = new Uint8Array(buffer);
        parts.push(u8);
        // Each segment is roughly equal-size; bump postReadFraction
        // a little. We can't know the total count, so use a soft
        // exponential approach to 1.
        postReadFraction = 1 - (1 - postReadFraction) * 0.95;
        reportProgress();
      };
      // Begin emitting onSegment for any data already buffered, and
      // for incoming appendBuffer calls.
      mp4boxfile.start();
      segmentingStarted = true;
    };

    // Feed the file in 4 MB chunks. We use sequential reads via
    // file.slice().arrayBuffer() rather than a stream because we have
    // to set the synthetic .fileStart property on each ArrayBuffer.
    (async () => {
      try {
        let offset = 0;
        const total = file.size;
        while (offset < total) {
          if (aborted) return;
          const end = Math.min(offset + READ_CHUNK_BYTES, total);
          const slice = file.slice(offset, end);
          const buf = await slice.arrayBuffer();
          (buf as AppendableArrayBuffer).fileStart = offset;
          mp4boxfile.appendBuffer(buf as AppendableArrayBuffer);
          offset = end;
          readFraction = offset / total;
          reportProgress();
        }
        if (aborted) return;
        mp4boxfile.flush();
        // After flush, mp4box emits any remaining onSegment calls
        // synchronously before returning. We can finalize now.
        if (!segmentingStarted) {
          abort(new TransmuxError('unsupported-input', 'mp4box never reported a moov; cannot transmux.'));
          return;
        }
        postReadFraction = 1;
        reportProgress();
        const blobType = (mediaType ?? 'video/mp4').split(';')[0].trim();
        const blob = new Blob(parts, { type: blobType });
        resolve({ mediaType: mediaType ?? 'video/mp4', blob });
      } catch (err) {
        abort(err instanceof Error ? err : new TransmuxError('mp4box-error', String(err)));
      }
    })();
  });
}
