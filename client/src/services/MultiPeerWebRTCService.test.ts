import { describe, it, expect, beforeEach, vi } from 'vitest';
import { multiPeerWebRTCService } from './MultiPeerWebRTCService';

// Stub the signaling service so we don't try to dial a real SignalR hub.
// Each test re-mocks the relevant outbound method.
vi.mock('./SignalingService', () => ({
  signalingService: {
    sendOfferTo: vi.fn().mockResolvedValue(undefined),
    sendAnswerTo: vi.fn().mockResolvedValue(undefined),
    sendIceCandidateTo: vi.fn().mockResolvedValue(undefined),
    reportConnectionEstablished: vi.fn().mockResolvedValue(undefined),
    reportConnectionClosed: vi.fn().mockResolvedValue(undefined),
  },
}));

// Helper: produce a minimal SDP with a known fingerprint string. The
// fingerprint regex in the service is `^a=fingerprint:(\S+)\s+(\S+)`, so
// we need exactly that line shape.
function sdpWithFingerprint(fp: string): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    `a=fingerprint:sha-256 ${fp}`,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    '',
  ].join('\r\n');
}

const FP_GENUINE = 'AB:CD:EF:01:23:45';
const FP_ATTACKER = 'AA:AA:AA:AA:AA:AA';

describe('MultiPeerWebRTCService perfect-negotiation', () => {
  beforeEach(async () => {
    multiPeerWebRTCService.closeAllConnections();
    await multiPeerWebRTCService.initialize();
  });

  it('assigns polite-peer role by lexicographic comparison of connection IDs', () => {
    // Local id 'aaa' vs peer 'zzz' → local is lower → local is polite.
    multiPeerWebRTCService.setLocalConnectionId('aaa');
    multiPeerWebRTCService.createPeerConnection('zzz');
    // We don't have a public getter for `polite`, but glare behavior
    // exercises it. See the glare test below.
    expect(multiPeerWebRTCService.isPeerConnected('zzz')).toBe(false);
  });

  it('checkFingerprintInvariant fires onFingerprintInvariantViolated when remote SDP fingerprint changes after pin', async () => {
    multiPeerWebRTCService.setLocalConnectionId('me');
    multiPeerWebRTCService.createPeerConnection('peer1');

    const violations: { peerId: string; expected: string; got: string }[] = [];
    multiPeerWebRTCService.on('onFingerprintInvariantViolated', (peerId, expected, got) => {
      violations.push({ peerId, expected, got });
    });

    // Simulate verification: handle an offer with the genuine fingerprint, then pin it.
    await multiPeerWebRTCService.handleOffer('peer1', sdpWithFingerprint(FP_GENUINE));
    expect(multiPeerWebRTCService.getRemoteFingerprint('peer1'))
      .toBe(`sha-256 ${FP_GENUINE.toLowerCase()}`);
    multiPeerWebRTCService.pinRemoteFingerprint('peer1', `sha-256 ${FP_GENUINE.toLowerCase()}`);

    // No violations yet.
    expect(violations).toHaveLength(0);

    // Now an attacker (or a buggy renegotiation) sends a new offer with a
    // different fingerprint. The service must catch it.
    await multiPeerWebRTCService.handleOffer('peer1', sdpWithFingerprint(FP_ATTACKER));

    expect(violations).toHaveLength(1);
    expect(violations[0].peerId).toBe('peer1');
    expect(violations[0].expected).toBe(`sha-256 ${FP_GENUINE.toLowerCase()}`);
    expect(violations[0].got).toBe(`sha-256 ${FP_ATTACKER.toLowerCase()}`);

    // Connection should have been closed by the invariant check.
    expect(multiPeerWebRTCService.isPeerConnected('peer1')).toBe(false);
  });

  it('checkFingerprintInvariant does NOT fire on legitimate renegotiation with the same fingerprint', async () => {
    multiPeerWebRTCService.setLocalConnectionId('me');
    multiPeerWebRTCService.createPeerConnection('peer1');

    const violations: unknown[] = [];
    multiPeerWebRTCService.on('onFingerprintInvariantViolated', (...args) => {
      violations.push(args);
    });

    await multiPeerWebRTCService.handleOffer('peer1', sdpWithFingerprint(FP_GENUINE));
    multiPeerWebRTCService.pinRemoteFingerprint('peer1', `sha-256 ${FP_GENUINE.toLowerCase()}`);

    // Legitimate renegotiation: same fingerprint, different SDP body.
    const renegotiatedSdp = sdpWithFingerprint(FP_GENUINE) + 'a=different-body\r\n';
    await multiPeerWebRTCService.handleOffer('peer1', renegotiatedSdp);

    expect(violations).toHaveLength(0);
  });

  it('unsubscribes only the listener that owns the disposer', async () => {
    multiPeerWebRTCService.setLocalConnectionId('me');
    const serviceViolations: string[] = [];
    const pageViolations: string[] = [];
    const unsubscribeService = multiPeerWebRTCService.on(
      'onFingerprintInvariantViolated',
      (peerId) => serviceViolations.push(peerId),
    );
    const unsubscribePage = multiPeerWebRTCService.on(
      'onFingerprintInvariantViolated',
      (peerId) => pageViolations.push(peerId),
    );

    const triggerViolation = async (peerId: string) => {
      multiPeerWebRTCService.createPeerConnection(peerId);
      await multiPeerWebRTCService.handleOffer(peerId, sdpWithFingerprint(FP_GENUINE));
      multiPeerWebRTCService.pinRemoteFingerprint(
        peerId,
        `sha-256 ${FP_GENUINE.toLowerCase()}`,
      );
      await multiPeerWebRTCService.handleOffer(peerId, sdpWithFingerprint(FP_ATTACKER));
    };

    await triggerViolation('first-room-peer');
    unsubscribePage();
    await triggerViolation('second-room-peer');
    unsubscribeService();

    expect(serviceViolations).toEqual(['first-room-peer', 'second-room-peer']);
    expect(pageViolations).toEqual(['first-room-peer']);
  });

  it('handleOffer ignores incoming offer when impolite peer is mid-offer (glare)', async () => {
    // 'me' > 'peer-aaa' lexicographically → local is impolite, peer is polite.
    // Wait: lexicographic — 'm' < 'p', so 'me' < 'peer-aaa'.
    // Use ids that make us impolite: 'zzz' vs 'aaa' → local 'zzz' is impolite.
    multiPeerWebRTCService.setLocalConnectionId('zzz');
    multiPeerWebRTCService.createPeerConnection('aaa');

    // Drive the connection into 'have-local-offer' state by simulating
    // a local offer: connectToPeer creates the data channel, which fires
    // negotiationneeded, which calls setLocalDescription, putting us in
    // 'have-local-offer'.
    await multiPeerWebRTCService.connectToPeer('aaa');
    // Wait a microtask cycle for the queued negotiationneeded to run.
    await new Promise((r) => setTimeout(r, 0));

    // Peer sends us an offer concurrently → glare. As impolite peer, we
    // should ignore it (no answer sent). We assert by checking that no
    // sendAnswerTo call was made for this peer.
    const { signalingService } = await import('./SignalingService');
    const sendAnswerTo = signalingService.sendAnswerTo as unknown as ReturnType<typeof vi.fn>;
    sendAnswerTo.mockClear();

    await multiPeerWebRTCService.handleOffer('aaa', sdpWithFingerprint(FP_GENUINE));
    expect(sendAnswerTo).not.toHaveBeenCalled();
  });

  it('handleOffer accepts and answers when polite peer is mid-offer (glare)', async () => {
    // Local 'aaa' < peer 'zzz' → local is polite.
    multiPeerWebRTCService.setLocalConnectionId('aaa');
    multiPeerWebRTCService.createPeerConnection('zzz');

    await multiPeerWebRTCService.connectToPeer('zzz');
    await new Promise((r) => setTimeout(r, 0));

    const { signalingService } = await import('./SignalingService');
    const sendAnswerTo = signalingService.sendAnswerTo as unknown as ReturnType<typeof vi.fn>;
    sendAnswerTo.mockClear();

    // Polite peer rolls back their own offer and answers the incoming one.
    await multiPeerWebRTCService.handleOffer('zzz', sdpWithFingerprint(FP_GENUINE));
    expect(sendAnswerTo).toHaveBeenCalledWith('zzz', expect.any(String));
  });
});
