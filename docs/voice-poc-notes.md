# Voice PoC — tracking notes

**Started:** May 2026
**Time-box:** 1 working day. If incomplete by end of day, stop and revise [docs/realtime-av-and-rich-chat-proposal.md](realtime-av-and-rich-chat-proposal.md) before writing the implementation plan.

## Hypothesis (this is what we are testing)

The proposal claims:

> Adding A/V to Sendie isn't a pivot. It's the natural use of the WebRTC connections we already maintain.

Specifically:
- `addTrack()` on existing `RTCPeerConnection`s plus a renegotiation will give us voice for free.
- The bound-SAS verification (Phase 2) survives renegotiation because the DTLS endpoint is the same.
- File transfer keeps working alongside voice (both use the same connection).

If those three hold, the proposal's effort estimates are real. If any one fails, the proposal needs revision before we commit two engineering weeks.

## Out of scope

Video. Screen share. Chat upgrades. SFrame. MLS. Recording. Watch-together. iOS Safari background-tab handling. TURN. Codec / bitrate config. Pretty UI.

## In scope

1. `getUserMedia({audio:true})` + a "Start voice" button.
2. `addTrack` on every existing peer connection. Triggers `negotiationneeded`.
3. Refactor offer/answer flow in [MultiPeerWebRTCService](../client/src/services/MultiPeerWebRTCService.ts) to perfect-negotiation pattern. (Not just for renegotiation — the *whole* flow has to switch.)
4. Polite peer = lower connection ID, lexicographic.
5. DTLS fingerprint invariant: store the fingerprint observed at first verification; reject any subsequent SDP whose fingerprint differs.
6. `pc.ontrack` → attach `MediaStream` to a hidden `<audio autoplay>` per peer.
7. Mute = `track.enabled = false`. Broadcast a `voice-mute` chat message so the receiver can show the mic icon. (Cheap; uses existing data channel.)
8. Self-meter via Web Audio `AnalyserNode` so the local user sees their mic is hot.

## Pass criteria

| # | Test | Pass |
|---|------|------|
| V1 | A and B both click Start Voice. Audio audible in both directions within 5s. | |
| V2 | A mutes. B's audio stops within 100ms; B sees A's "muted" indicator. | |
| V3 | Both peers still show "verified" status and matching SAS code after V1. | |
| V4 | Force fingerprint change on renegotiation (DevTools script). Bound-SAS detects and tears down. | |
| V5 | During an active call, A drops a file and B accepts it. Transfer completes; SHA256 matches. | |
| V6 | Both peers click Start Voice within ~100ms (glare). Call survives; both hear each other. | |

## Fail criteria → stop and revise proposal

- V3 or V4 fails → security model is broken.
- V5 fails → renegotiation interferes with the data channel.
- V6 deadlocks → perfect-negotiation pattern wasn't applied correctly.
- Effort > 1.5x day budget.

## Notes / surprises

(Filled in as we go.)

## Findings

(Filled in at the end.)
