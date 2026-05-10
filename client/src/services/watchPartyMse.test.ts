import { describe, it, expect } from 'vitest';
import { isStreamableContainer } from './WatchPartyService';

/** Build a uint8 buffer matching the mp4 box layout: size (4 BE), type (4 ASCII), then padding. */
function box(type: string, payloadLen = 0): Uint8Array {
  const size = 8 + payloadLen;
  const buf = new Uint8Array(size);
  buf[0] = (size >> 24) & 0xff;
  buf[1] = (size >> 16) & 0xff;
  buf[2] = (size >> 8) & 0xff;
  buf[3] = size & 0xff;
  buf[4] = type.charCodeAt(0);
  buf[5] = type.charCodeAt(1);
  buf[6] = type.charCodeAt(2);
  buf[7] = type.charCodeAt(3);
  return buf;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('isStreamableContainer', () => {
  it('always says yes for webm', () => {
    expect(isStreamableContainer('video/webm', new Uint8Array(0))).toBe(true);
    expect(isStreamableContainer('video/webm; codecs="vp9"', new Uint8Array(8))).toBe(true);
  });

  it('always says no for unknown containers', () => {
    expect(isStreamableContainer('audio/wav', new Uint8Array(64))).toBe(false);
    expect(isStreamableContainer('video/x-matroska', new Uint8Array(64))).toBe(false);
  });

  it('mp4 with moov before mdat is streamable (faststart)', () => {
    const head = concat(
      box('ftyp', 24),
      box('moov', 1024),
      box('mdat', 4096),
    );
    expect(isStreamableContainer('video/mp4', head)).toBe(true);
  });

  it('mp4 with mdat before moov is not streamable', () => {
    const head = concat(
      box('ftyp', 24),
      box('mdat', 4096),
      // moov would be at the end but we never see it in the head buffer
    );
    expect(isStreamableContainer('video/mp4', head)).toBe(false);
  });

  it('mp4 with only ftyp in head is inconclusive (no)', () => {
    expect(isStreamableContainer('video/mp4', box('ftyp', 16))).toBe(false);
  });

  it('handles 64-bit large boxes', () => {
    // size=1 means a 64-bit largesize follows. Build a ftyp-then-largesize-mdat-then-moov.
    const ftyp = box('ftyp', 16);
    // mdat with 64-bit largesize
    const mdat = new Uint8Array(16);
    mdat[0] = 0; mdat[1] = 0; mdat[2] = 0; mdat[3] = 1; // size=1 marker
    mdat[4] = 'm'.charCodeAt(0);
    mdat[5] = 'd'.charCodeAt(0);
    mdat[6] = 'a'.charCodeAt(0);
    mdat[7] = 't'.charCodeAt(0);
    // 64-bit size = 16 (just the header)
    mdat[14] = 0;
    mdat[15] = 16;
    const head = concat(ftyp, mdat, box('moov', 16));
    // mdat is before moov so verdict is "no" regardless of largesize parsing,
    // but this exercises the 64-bit branch without mis-stepping.
    expect(isStreamableContainer('video/mp4', head)).toBe(false);
  });

  it('handles malformed boxes gracefully (returns false)', () => {
    // Box type 'free' (skip box; common padding), size = 4 (less than
    // the minimum 8), no moov/mdat in header. Should bail out without
    // looping.
    const bad = new Uint8Array(8);
    bad[3] = 4;
    bad[4] = 'f'.charCodeAt(0);
    bad[5] = 'r'.charCodeAt(0);
    bad[6] = 'e'.charCodeAt(0);
    bad[7] = 'e'.charCodeAt(0);
    expect(isStreamableContainer('video/mp4', bad)).toBe(false);
  });
});
