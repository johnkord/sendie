import { describe, it, expect } from 'vitest';
import { cryptoService } from './CryptoService';

/**
 * Phase 2 regression tests: the bound SAS must
 *   1) be byte-identical regardless of which side computes it
 *   2) change if either fingerprint changes (the whole point of binding)
 *   3) be canonical across JWK property orderings
 */
describe('Bound SAS (Phase 2)', () => {
  const sessionId = 'abcdefghijklmnopqrstuv';
  const keyA = '{"kty":"EC","crv":"P-256","x":"AAAA","y":"BBBB"}';
  const keyB = '{"kty":"EC","crv":"P-256","x":"CCCC","y":"DDDD"}';
  const fpA = 'sha-256 aa:bb:cc:dd';
  const fpB = 'sha-256 ee:ff:00:11';

  it('produces identical SAS regardless of role', async () => {
    const sasFromA = await cryptoService.generateBoundSAS(keyA, keyB, fpA, fpB, sessionId);
    const sasFromB = await cryptoService.generateBoundSAS(keyB, keyA, fpB, fpA, sessionId);
    expect(sasFromA).toBe(sasFromB);
  });

  it('changes when a fingerprint is rewritten (MITM detection)', async () => {
    const honest = await cryptoService.generateBoundSAS(keyA, keyB, fpA, fpB, sessionId);
    const tampered = await cryptoService.generateBoundSAS(keyA, keyB, fpA, 'sha-256 99:99:99:99', sessionId);
    expect(honest).not.toBe(tampered);
  });

  it('canonicalizes JWK property order', async () => {
    const reordered = '{"y":"DDDD","x":"CCCC","crv":"P-256","kty":"EC"}';
    const sas1 = await cryptoService.generateBoundSAS(keyA, keyB, fpA, fpB, sessionId);
    const sas2 = await cryptoService.generateBoundSAS(keyA, reordered, fpA, fpB, sessionId);
    expect(sas1).toBe(sas2);
  });

  it('changes when sessionId changes (cross-session replay defense)', async () => {
    const a = await cryptoService.generateBoundSAS(keyA, keyB, fpA, fpB, sessionId);
    const b = await cryptoService.generateBoundSAS(keyA, keyB, fpA, fpB, 'wwwwwwwwwwwwwwwwwwwwww');
    expect(a).not.toBe(b);
  });

  it('extracts DTLS fingerprints from SDP', () => {
    const sdp = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=-',
      'a=fingerprint:sha-256 AB:CD:EF:01:23:45',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    ].join('\r\n');
    expect(cryptoService.extractDtlsFingerprint(sdp)).toBe('sha-256 ab:cd:ef:01:23:45');
  });
});

describe('Session URL paste regex (Phase 0 H4 regression)', () => {
  // The HomePage parsing of pasted URLs must accept base64url IDs containing
  // - and _, since ~50% of generated IDs do.
  const pattern = /\/s\/([A-Za-z0-9_-]+)/;

  it.each([
    ['https://sendie.example/s/Ab-cD_EFghIJklMNopQRst', 'Ab-cD_EFghIJklMNopQRst'],
    ['https://sendie.example/s/aaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaa'],
    ['/s/__----________----____', '__----________----____'],
  ])('captures %s', (input, expected) => {
    const match = input.match(pattern);
    expect(match?.[1]).toBe(expected);
  });
});
