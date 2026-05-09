import { multiPeerWebRTCService } from './MultiPeerWebRTCService';
import { cryptoService } from './CryptoService';
import type { DataChannelMessage } from '../types';

/**
 * Phase 2 — Bound-SAS verification protocol.
 *
 * For each peer, after the data channel is open we run a short two-message
 * exchange (over the data channel, not the signaling server):
 *
 *   peer  ─── verification-init { nonce, fp, jwk } ───►  other
 *   other ─── verification-init { nonce, fp, jwk } ───►  peer
 *
 *   peer  ─── verification-sig  { signature(payload) } ─►  other
 *   other ─── verification-sig  { signature(payload) } ─►  peer
 *
 * Both sides verify the other's signature over a payload that includes:
 *   - a domain tag
 *   - the session ID
 *   - canonicalized JWKs of both peers
 *   - both peers' nonces (so neither side can replay the other's signature)
 *   - both peers' DTLS fingerprints (binding the verification to the actual
 *     transport, which is the whole point — see audit C1)
 *
 * If the signature verifies AND the asserted DTLS fingerprint matches what
 * we observed in the SDP, the peer is verified.
 *
 * If anything fails, or the exchange does not complete within VERIFY_TIMEOUT_MS,
 * we surface a verification failure to the page so the user is warned and the
 * data channel is torn down.
 */

export type VerificationResult =
  | { peerId: string; status: 'verified'; sasCode: string; remoteJwk: string }
  | { peerId: string; status: 'failed'; reason: string };

export type VerificationEvents = {
  onVerificationStarted: (peerId: string) => void;
  onVerificationComplete: (result: VerificationResult) => void;
};

const VERIFY_TIMEOUT_MS = 10_000;

interface PeerVerificationContext {
  peerId: string;
  // Inputs
  sessionId: string;
  privateKey: CryptoKey;
  localKeyJwk: string;
  // Local nonce we sent
  nonceLocal: string;
  // Their nonce, fingerprint, JWK (filled in on init receive)
  nonceRemote: string | null;
  remoteFp: string | null;
  remoteJwk: string | null;
  // Their signature once received
  remoteSignature: string | null;
  // Bookkeeping
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  // Whether we've already sent our signature
  signatureSent: boolean;
}

class VerificationService {
  private contexts: Map<string, PeerVerificationContext> = new Map();
  private events: Partial<VerificationEvents> = {};
  private results: Map<string, VerificationResult> = new Map();
  // Buffer messages received before start() has been called for a peer.
  // The data channel can fire 'open' on both sides at almost the same time;
  // the remote can send verification-init before our handleDataChannelOpen
  // microtask has run start() locally. Without buffering those messages
  // would be silently dropped and the verification would time out.
  private pending: Map<string, DataChannelMessage[]> = new Map();

  on<K extends keyof VerificationEvents>(event: K, handler: VerificationEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof VerificationEvents>(event: K): void {
    delete this.events[event];
  }

  /**
   * Get the verification result for a peer, if any.
   */
  getResult(peerId: string): VerificationResult | null {
    return this.results.get(peerId) ?? null;
  }

  /**
   * Whether a peer is fully verified (passed the bound-SAS protocol).
   */
  isVerified(peerId: string): boolean {
    return this.results.get(peerId)?.status === 'verified';
  }

  /**
   * Start verification with a peer. Call this immediately after the data
   * channel is open. Idempotent: calling twice for the same peer is a no-op.
   */
  async start(
    peerId: string,
    sessionId: string,
    privateKey: CryptoKey,
    localKeyJwk: string,
  ): Promise<void> {
    if (this.contexts.has(peerId) || this.results.has(peerId)) return;

    // Generate a 256-bit nonce.
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonceLocal = arrayToBase64(nonceBytes);

    const localFp = multiPeerWebRTCService.getLocalFingerprint(peerId);
    if (!localFp) {
      this.fail(peerId, 'no local DTLS fingerprint available');
      return;
    }

    const ctx: PeerVerificationContext = {
      peerId,
      sessionId,
      privateKey,
      localKeyJwk,
      nonceLocal,
      nonceRemote: null,
      remoteFp: null,
      remoteJwk: null,
      remoteSignature: null,
      startedAt: Date.now(),
      timeoutHandle: setTimeout(() => this.fail(peerId, 'verification timed out'), VERIFY_TIMEOUT_MS),
      signatureSent: false,
    };
    this.contexts.set(peerId, ctx);
    this.events.onVerificationStarted?.(peerId);

    const initMsg: DataChannelMessage = {
      type: 'verification-init',
      nonce: nonceLocal,
      fp: localFp,
      jwk: localKeyJwk,
    };
    multiPeerWebRTCService.sendTo(peerId, JSON.stringify(initMsg));

    // Replay any messages that arrived before start() was called.
    const buffered = this.pending.get(peerId);
    if (buffered) {
      this.pending.delete(peerId);
      for (const m of buffered) {
        // Sequential await: the protocol is order-sensitive
        // (verification-init must be processed before verification-sig).
        await this.handleMessage(peerId, m);
      }
    }
  }

  /**
   * Dispatch an incoming verification message from a peer.
   */
  async handleMessage(peerId: string, message: DataChannelMessage): Promise<void> {
    if (message.type !== 'verification-init' && message.type !== 'verification-sig') return;

    const ctx = this.contexts.get(peerId);
    if (!ctx) {
      // We haven't called start() yet for this peer. Don't drop the message;
      // buffer it and replay once start() runs. Also ignore once a result
      // exists (verification already terminated).
      if (this.results.has(peerId)) return;
      const list = this.pending.get(peerId) ?? [];
      list.push(message);
      // Cap the buffer so a malicious peer cannot exhaust memory by spamming
      // us before our start() runs.
      if (list.length > 8) {
        this.fail(peerId, 'too many verification messages before start');
        this.pending.delete(peerId);
        return;
      }
      this.pending.set(peerId, list);
      return;
    }

    if (message.type === 'verification-init') {
      // Validate the asserted fingerprint matches what we observed in SDP.
      const observedRemoteFp = multiPeerWebRTCService.getRemoteFingerprint(peerId);
      if (!observedRemoteFp) {
        this.fail(peerId, 'no remote DTLS fingerprint available');
        return;
      }
      if (observedRemoteFp !== message.fp.toLowerCase()) {
        // The peer is asserting a different fingerprint than the one in the
        // SDP we received. That can only happen if the signaling server
        // rewrote one of them. Either way: refuse.
        this.fail(peerId, 'remote fingerprint does not match SDP');
        return;
      }
      ctx.nonceRemote = message.nonce;
      ctx.remoteFp = message.fp.toLowerCase();
      ctx.remoteJwk = message.jwk;

      // Now that we have both nonces, we can sign and send our signature.
      await this.sendSignature(ctx);
    } else if (message.type === 'verification-sig') {
      ctx.remoteSignature = message.signature;
      // Only attempt verification once we have everything.
      await this.tryFinalize(ctx);
    }
  }

  /**
   * Forget a peer's verification state (e.g. on disconnect or session leave).
   */
  forget(peerId: string): void {
    const ctx = this.contexts.get(peerId);
    if (ctx?.timeoutHandle) clearTimeout(ctx.timeoutHandle);
    this.contexts.delete(peerId);
    this.results.delete(peerId);
    this.pending.delete(peerId);
  }

  /**
   * Forget every peer's state.
   */
  reset(): void {
    for (const ctx of this.contexts.values()) {
      if (ctx.timeoutHandle) clearTimeout(ctx.timeoutHandle);
    }
    this.contexts.clear();
    this.results.clear();
    this.pending.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async sendSignature(ctx: PeerVerificationContext): Promise<void> {
    if (ctx.signatureSent) return;
    if (!ctx.remoteJwk || !ctx.nonceRemote || !ctx.remoteFp) return;

    const localFp = multiPeerWebRTCService.getLocalFingerprint(ctx.peerId);
    if (!localFp) {
      this.fail(ctx.peerId, 'no local DTLS fingerprint available');
      return;
    }

    const payload = cryptoService.buildAuthPayload(
      ctx.localKeyJwk,
      ctx.remoteJwk,
      localFp,
      ctx.remoteFp,
      ctx.nonceLocal,
      ctx.nonceRemote,
      ctx.sessionId,
    );
    const sig = await cryptoService.signBytes(ctx.privateKey, payload);
    ctx.signatureSent = true;
    const msg: DataChannelMessage = { type: 'verification-sig', signature: sig };
    multiPeerWebRTCService.sendTo(ctx.peerId, JSON.stringify(msg));

    // It's possible the remote signature arrived before we sent ours.
    await this.tryFinalize(ctx);
  }

  private async tryFinalize(ctx: PeerVerificationContext): Promise<void> {
    if (!ctx.remoteSignature || !ctx.remoteJwk || !ctx.remoteFp || !ctx.nonceRemote) return;

    const localFp = multiPeerWebRTCService.getLocalFingerprint(ctx.peerId);
    if (!localFp) {
      this.fail(ctx.peerId, 'no local DTLS fingerprint available');
      return;
    }

    // We sign with (local nonce, remote nonce). They sign with their (local, remote),
    // which from our perspective is (their nonce, our nonce). So the payload we
    // verify swaps the nonce order vs ours.
    const payload = cryptoService.buildAuthPayload(
      ctx.remoteJwk,    // their JWK is "local" in the payload they signed
      ctx.localKeyJwk,
      ctx.remoteFp,
      localFp,
      ctx.nonceRemote,
      ctx.nonceLocal,
      ctx.sessionId,
    );

    let remoteKey: CryptoKey;
    try {
      remoteKey = await cryptoService.importPublicKey(ctx.remoteJwk);
    } catch (err) {
      this.fail(ctx.peerId, `bad remote JWK: ${(err as Error).message}`);
      return;
    }

    const ok = await cryptoService.verifyBytes(remoteKey, ctx.remoteSignature, payload);
    if (!ok) {
      this.fail(ctx.peerId, 'signature verification failed');
      return;
    }

    // Compute the bound SAS so the UI can show it.
    const sas = await cryptoService.generateBoundSAS(
      ctx.localKeyJwk,
      ctx.remoteJwk,
      localFp,
      ctx.remoteFp,
      ctx.sessionId,
    );

    if (ctx.timeoutHandle) clearTimeout(ctx.timeoutHandle);
    this.contexts.delete(ctx.peerId);

    // Pin the remote DTLS fingerprint observed at verification time. Any
    // subsequent renegotiation whose SDP fingerprint differs is treated as
    // a possible MITM and the connection is torn down (PoC: voice/video).
    multiPeerWebRTCService.pinRemoteFingerprint(ctx.peerId, ctx.remoteFp);

    const result: VerificationResult = {
      peerId: ctx.peerId,
      status: 'verified',
      sasCode: sas,
      remoteJwk: ctx.remoteJwk,
    };
    this.results.set(ctx.peerId, result);
    this.events.onVerificationComplete?.(result);
  }

  private fail(peerId: string, reason: string): void {
    const ctx = this.contexts.get(peerId);
    if (ctx?.timeoutHandle) clearTimeout(ctx.timeoutHandle);
    this.contexts.delete(peerId);
    const result: VerificationResult = { peerId, status: 'failed', reason };
    this.results.set(peerId, result);
    console.warn(`Verification failed for ${peerId}: ${reason}`);
    this.events.onVerificationComplete?.(result);
    // Tear down the data channel — the user's audit instinct should not be
    // \"trust the green light anyway\". A failed verification is destructive.
    try {
      multiPeerWebRTCService.closePeerConnection(peerId);
    } catch (err) {
      console.warn(`Failed to close peer connection for ${peerId}:`, err);
    }
  }
}

function arrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export const verificationService = new VerificationService();
