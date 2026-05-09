# Sendie beyond file transfer: real-time A/V, chat, and rich media sessions

**Date:** May 2026 (revised after deep-dive into related work)
**Status:** Proposal / design exploration
**Companion to:** [security-audit-2026-05.md](security-audit-2026-05.md), [security-remediation-plan.md](security-remediation-plan.md)

> Revision note: this version integrates findings from cutting-edge work in the space: MLS (RFC 9420), SFrame (RFC 9605, August 2024), the W3C WebRTC Encoded Transform spec, and shipped systems like Element Call (Matrix), Jitsi end-to-end-encryption, Zoom's E2EE pivot, and Signal's small-group calling. The original proposal stands; the additions are mostly tightening claims and naming the primitives that already exist for problems we were going to invent ad-hoc.

## Where Sendie sits in the WebRTC E2EE landscape (new)

This is the section I would have wanted to read before writing the original proposal. It changes one of my earlier conclusions.

### The mesh-vs-SFU axis isn't binary anymore

The industry's E2EE story has converged on **three primitives**, each fixing a different problem:

1. **DTLS-SRTP** between WebRTC endpoints. Encrypts every hop. Falls apart the moment an SFU terminates DTLS to forward streams; the SFU sees plaintext media. (Sendie does not have an SFU, so this is fine for us today.)
2. **MLS** ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html), July 2023). Group key agreement with forward secrecy and post-compromise security in `O(log N)` work, scaling to thousands. Gives every member of a group an `epoch_secret` that no non-member can derive, and a clean way to rotate when membership changes.
3. **SFrame** ([RFC 9605](https://www.rfc-editor.org/rfc/rfc9605), August 2024). Per-frame AEAD on the encoded media payload itself, *underneath* whatever transport you're using. SFrame is what makes "E2EE through an SFU" actually work: the SFU sees RTP headers (so it can route) but never the decrypted frame.

Browsers expose this composition through the W3C **Encoded Transform** API ([editor's draft](https://w3c.github.io/webrtc-encoded-transform/)). Of particular note: `RTCSFrameSenderTransform` is being baked directly into the platform, with cipher-suite picker (`AES_128_CTR_HMAC_SHA256_80` etc.), `setEncryptionKey`/`addDecryptionKey` methods, and a worker-based `RTCRtpScriptTransform` for arbitrary per-frame transforms. This means a Sendie session can layer SFrame on top of DTLS without us shipping any cryptography ourselves — the browser does it.

### What this means for Sendie's bound SAS

My original conclusion was: "don't build an SFU; the bound SAS is uniquely valuable." That conclusion is **half right**. Refined version:

- The bound SAS authenticates the *DTLS endpoints*. It catches a server that rewrites `a=fingerprint` lines.
- SFrame authenticates the *encoded media itself*. It catches a server that re-encrypts traffic at any layer above the frame.
- These are complementary, not competitive. SFrame keys can be derived from MLS via [`MLS-Exporter`](https://www.rfc-editor.org/rfc/rfc9420.html#section-8.5) (RFC 9420 §8.5), and that combination is exactly what Element Call ships in Matrix as of 2024.

If I were starting Sendie's group-call story today, I would not pick "DTLS plus bound SAS" *or* "MLS plus SFrame." I would compose them: bound SAS authenticates the DTLS handshake (catches the cheapest MITM), MLS handles group keying so it survives membership churn, and SFrame is enabled even in mesh mode — not because we need it for the mesh, but because:

1. **It future-proofs us against ever needing an SFU.** We can add a TURN server, a relay, or even a real SFU later without losing E2EE. Today's "never" is tomorrow's "actually we need this for mobile background tabs."
2. **It defends against malicious peers, not just servers.** A peer in a 5-way call could surreptitiously forward decrypted media to a sixth party. SFrame doesn't prevent that (any peer with the key can decrypt) but pairing it with MLS-issued ephemeral per-epoch keys means the leak window is bounded by the next epoch change.
3. **It moves the trusted-computing-base downward.** Per-frame AEAD in a worker means a compromised renderer process can't trivially read media stream contents the way it can read DOM state.

### Tensions worth naming

The related work isn't unanimous, and the disagreements are instructive:

- **Latency vs. forward secrecy.** MLS commits cost a round trip. In a real-time call you don't want to block playback on a Commit landing at every peer. Element Call's compromise: process MLS messages out-of-band on a separate signaling channel, advance media keys when the new epoch arrives, but never delay frames waiting for the handshake. We can do the same; we already have the WSS signaling channel separate from the DTLS data path.
- **"Trust the SFU not to read media" vs. "trust the SFU not to fragment the group."** SFrame stops the SFU from reading frames, but it does not stop the SFU from selectively dropping or replaying frames per receiver to mount partitioning attacks. RFC 9605 §7.4 makes this explicit. In a Sendie *mesh* this is moot; if we ever add a relay, this is a footnote we have to write into the threat model.
- **MLS group size vs. "send a Commit on every join."** RFC 9420 says MLS scales to thousands, but each Commit is `O(log N)` work plus a handshake message per recipient. For Sendie's 10-peer cap, this is invisible. For a future where Sendie runs broadcast-style "rooms," the math gets interesting and the answer is probably "don't go there; that's not the product."
- **MLS ratchet tree leaks membership to whoever holds it.** The tree contains every member's leaf node and credentials. Anyone who gets a `GroupInfo` learns who is in the group. The MLS spec calls this out (§16.4.3). Sendie's signaling server already learns the membership of a session today, so this is not a new leak — but it is a regression versus a hypothetical "server doesn't even know who joined" design that we never had anyway.
- **Sender keys vs. MLS for keying.** RFC 9605 §5 describes both. Sender keys are simpler (each sender ships their own key over an existing E2E-secure channel). MLS is heavier but gives you proper group AKE. For Sendie's 10-peer cap, sender keys are sufficient; but we already have a pairwise E2E-secure data channel per peer pair, so the *natural* mapping is "distribute one MLS-style group key per session over the verified data channels."

### What I would not adopt from related work

- **Matrix's CONIKS-style key transparency.** Element Call uses Matrix identities and a key server. Sendie's allow-list-of-Discord-IDs is simpler and matches the threat model better. Adding key transparency pulls in a public log and an auditing protocol that we don't need.
- **Signal-style "sealed sender" metadata stripping.** Beautiful in messaging, doesn't translate to real-time media because the SignalR connection is long-lived and identifies you anyway.
- **Jitsi Videobridge JWT-based auth on the SFU.** We don't have an SFU; if we ever do, this is a fine pattern. Until then, irrelevant.

## What we'd add, in priority order

### 1. Voice (audio-only call)

Easiest to ship, highest value, lowest CPU. Mesh up to ~10 peers comfortably with Opus.

What changes in code:

- Add `getUserMedia({ audio: true })` behind a "Start voice" button with an explicit permission flow that mirrors the existing per-file accept prompt: the user clicks, the browser prompts, the local UI shows a self-meter so the user sees their mic is hot.
- For each existing peer connection, call `pc.addTrack(audioTrack, localStream)` for every track in the local stream. Trigger a renegotiation: `negotiationneeded` fires, we createOffer / setLocalDescription / send via the targeted `SendOfferTo` we already have.
- On the other side: `pc.ontrack` fires; we attach the inbound `MediaStream` to a hidden `<audio autoplay>` element per peer.
- Mute = `track.enabled = false` (instant, no renegotiation). UI toggle button per peer's outbound track.

What this needs from our existing code:

- `MultiPeerWebRTCService` already creates `RTCPeerConnection` with our ICE config. It already wires `signalingService.sendOfferTo` and `sendAnswerTo`. We need to enable late renegotiation: today the offer/answer exchange happens once on connect. We need to:
  1. Implement the [perfect-negotiation pattern](https://w3c.github.io/webrtc-pc/#perfect-negotiation-example) to handle simultaneous offers ("glare"). The host (or whoever has the lower connectionId, deterministically) takes the polite role.
  2. Re-extract the DTLS fingerprint after every renegotiation and re-check it against the verified value. The DTLS connection itself does not change across SDP renegotiations, but we should assert this rather than assume it; if a fingerprint ever shifts mid-session, we tear the channel down with a verification-failed message identical to the initial-handshake path.

What this implies for security promises:

- The bound SAS still authenticates the channel because the DTLS endpoint is the same one the SAS was computed against. We need a one-line invariant check on renegotiation; that's it.
- The signaling server still cannot decrypt audio. SFU-based products cannot make that claim by default.
- **Optional, deferred:** wrap the outbound audio in `RTCSFrameSenderTransform` ([editor's draft](https://w3c.github.io/webrtc-encoded-transform/#sframe)). The browser handles it; we just call `setEncryptionKey(key, keyId)` with a key derived from a session-scoped secret. This adds per-frame AEAD on top of DTLS at essentially zero CPU cost (Opus frames are tiny). I would ship voice without this and add it as a flag once the API is in stable Chrome/Firefox/Safari (today: Chrome/Firefox stable; Safari behind a flag as of mid-2025). Mark in code as `TODO(sframe)` so future-us doesn't reinvent it.

Mesh ceiling for voice: encoding Opus at ~32 kbit/s × N-1 peers is trivial CPU. Audio mesh comfortably scales to the existing 10-peer cap. No SFU needed.

### 2. Video

Same mechanism (`addTrack` for video), much higher cost. Honest constraints:

- Mesh + video at 720p costs the sender N-1 simultaneous encodes. Modern laptops do 3-4 outbound streams; phones drop frames at 2-3.
- Recommended cap: 4 peers for video-on, 10 for audio-only. The session UI should display the ceiling and gracefully degrade ("video paused for new joiner; ask the room to step down to audio").

What we add:

- `getUserMedia({ video: { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } } })`.
- Simulcast on the outbound transceiver: `pc.addTransceiver(videoTrack, { sendEncodings: [{ rid: 'low', scaleResolutionDownBy: 4 }, { rid: 'mid', scaleResolutionDownBy: 2 }, { rid: 'high' }] })`. Each receiver picks the layer it wants. This is the closest a mesh gets to the bandwidth efficiency of an SFU — the sender ships three quality layers in parallel and the network drops the ones it can't carry.
- Adaptive layout: 2 peers → side-by-side; 3-4 → 2×2 grid; > 4 → audio-only fallback with a "request video" button.
- Keep `replaceTrack` available so users can swap cameras (e.g., front to rear on mobile) without renegotiation.

### 3. Screen share

`getDisplayMedia({ video: true, audio: { suppressLocalAudioPlayback: true } })`. Same `addTrack` flow as a webcam but with the screen-capture browser prompt.

Two interesting wrinkles:

- The W3C spec mandates that the user choose the surface every time; we cannot persist permission. That's fine for our threat model.
- One peer screen-sharing is much cheaper for everyone than everyone webcamming. A common pattern in code-review / pair-programming is one share + voice. Surface this prominently in the UI ("Start screen share" alongside "Start voice").
- The `contentHint` API lets us mark the track as `motion` (game/video) or `detail` (text/code review). We should set `detail` when sharing a window/tab so encoders prioritize sharpness over framerate. Free quality win.

A creative addition: **shared cursor overlay**. When someone shares their screen, every receiver can broadcast their pointer position over the existing data channel, drawn as a colored dot with the peer's friendly name. Trivial to implement, transformatively useful for code reviews. No video bandwidth cost.

### 4. Chat

The cheapest thing in this proposal. We already have a data channel.

- Open a second labeled data channel `'chat'` per peer connection (so file-transfer flow control doesn't head-of-line block chat). One additional `createDataChannel('chat', { ordered: true })` on the initiator side; receiver picks it up via `ondatachannel` matched on label.
- Message format: `{ id, ts, peerId, body, attachments? }`. Body is plain text; attachments reference files transferred via the existing pipeline (more on this below).
- Storage: in-memory only, in the page state, cleared on session leave. Add a "Download transcript" button that exports JSON or markdown.
- Markdown rendering with a strict subset (headings, bold, italic, code, links, lists). Use a sanitizer; no raw HTML; no remote images by default.

Worth noting: chat messages travel through the same DTLS-encrypted, SAS-verified data channel as files. We get end-to-end-encrypted, server-blind chat for free. That is, on its own, a feature people pay other companies money for.

### 5. Rich chat: voice notes, inline images, link previews, reactions

This is where it stops being a clone of every other tool.

#### Voice notes

Press-and-hold record button. We use `MediaRecorder` with `mimeType: 'audio/webm;codecs=opus'`. On release, the resulting Blob goes through the existing `MultiPeerFileTransferService` as a file with `type: 'audio/webm'` and a chat message that references it. Receivers see an inline player. The "rejection" flow from Phase 1 still applies — voice notes are files; receivers can still decline.

Cost to build: nearly zero, given the file pipeline. One UI component, one MediaRecorder integration. Wins because:

- Transcription is a privacy-relevant feature. Sendie's voice notes never go to a server, so they don't get auto-transcribed. Whisper-on-device transcription could be added optionally on the receiver side.
- Asynchronous voice in an ephemeral session is genuinely interesting UX — you can leave a voice note for someone who joins later in a long-running session.

#### Inline images / file previews

Reuse the file transfer accept prompt. If the file is `image/*` and small (say < 2 MiB), inline-preview after accept. If it's `video/*` or `audio/*`, render a `<video>` / `<audio>` player. Larger files keep the existing save-file flow.

Decline-by-default still applies. The accept prompt should add a "Show inline" option for safe types when sender = verified.

#### Link previews

Tricky. Generating link previews requires fetching the URL, which leaks the user's IP and the URL itself to the linked origin. Three options:

1. **Don't.** Render the link as plain text with a tooltip explaining why we don't preview. Most defensible.
2. **Receiver-side, opt-in per link.** Click to expand; the receiver's browser fetches the OpenGraph metadata. The sender doesn't know whether anyone fetched.
3. **Sender-side, embedded in the message.** Sender's browser fetches before sending and includes the OG metadata in the chat message. Avoids each receiver leaking their IP, but the sender does. And the metadata can be tampered with by a malicious sender.

I'd ship (1) by default, (2) as an opt-in, never (3). The "private chat" promise is more valuable than the convenience of a thumbnail.

#### Reactions

Emoji reactions on chat messages. Trivial chat-channel message: `{ type: 'reaction', target: messageId, emoji: '👍' }`. Render as inline counts with hover-for-names.

### 6. Watch together (creative)

The bandwidth profile of group video streaming in a mesh is bad. The bandwidth profile of group video *playback* in a mesh, where each peer plays a local copy in lockstep, is great.

How it works:

- Host drops a video file. Existing transfer pipeline ships it to every accepter. (The file is encrypted in flight, and verified-identity gates it.)
- Once everyone has it, host opens a "watch together" panel. We use the chat channel to broadcast `{ type: 'playback', action: 'play'|'pause'|'seek', position, ts }`.
- Each peer's browser plays the local file using a `<video>` element, with a small tolerance window for clock skew (~150 ms is imperceptible).
- Voice channel stays on top so people can talk over the video.

**Prior art and why this is interesting in Sendie specifically:**

- **Teleparty (formerly Netflix Party)** intercepts the streaming service's player. Only works if everyone has a Netflix account. Sendie users have a file.
- **SyncTube / Cytube** sync a YouTube embed via a central WebSocket server. The server arbitrates time. The video itself comes from YouTube's CDN. Sendie has no central server arbitrating time and no CDN; both functions are P2P.
- **Discord Watch Together** restreams the host's screen via Discord's SFU, which is bandwidth-expensive and gives Discord access to the content. Sendie ships the file once.
- **Matrix Element Call "Live Location"-style sync extensions** — closest in spirit to what we want, but Matrix has a homeserver in the loop. Sendie does not.

The combination of "file is already shipped" + "chat channel is already E2EE" + "no server in the time-sync loop" is the unusual thing. It works *better* in Sendie than in any SFU-based product because we already paid the bandwidth cost once during the file transfer; subsequent re-watches are free.

It also makes the host-only-sending feature more meaningful: in a watch-party context, only the host can drop the playlist; viewers can pause for themselves but only the host can `seek` for everyone.

One genuinely subtle problem: **clock sync without a server.** Two reasonable approaches:

1. **Master clock.** Host's `performance.now()` is authoritative; viewers compute offset using a few round-trip pings over the data channel (NTP-lite). Drift correction once per second. Simple, slightly host-skewed.
2. **Vector clock.** Every peer broadcasts their playback position; receivers smooth toward the median. Robust to one bad clock; harder to reason about.

I'd ship (1). Watch-together is a leisure feature, not a blockchain.

### 7. Voice activity detection / "active speaker" tile

When 3+ peers have audio, the UI should highlight whoever is currently speaking. Web Audio API + `AnalyserNode` on the inbound stream gives us amplitude; smoothing + threshold gives us VAD; the page state holds an "active speaker" id. Free, no server needed.

When combined with screen share, this gives the screen-sharer a clear signal of who is asking a question — which is the single most missing affordance in code-review tools.

### 8. End-of-call transcript and recording

Two flavors:

- **Transcript** (text). Already free if we add chat; add timestamped "call started" / "X joined" events.
- **Recording** (audio/video). Local to the recording user only; we use `MediaRecorder` on the local `MediaStream` created from received tracks. Critically, **everyone in the call must explicitly consent** before any peer can record, just like Zoom/Meet. Implementation: when one peer wants to record, they send a chat-channel `{ type: 'recording-request' }`. The UI shows a "X wants to record" toast on every other peer; consent is required from each. Refusal blocks the recording UI.

This is not a security feature — once audio is in someone's RAM they can record it however they like with OS tools. But the social signal matters and the UI should be honest about it.

## Architecture changes

What needs to land in the existing codebase:

| Component | Today | Change |
|---|---|---|
| `MultiPeerWebRTCService` | Single offer/answer at connect, one data channel | Multi-channel (`fileTransfer`, `chat`); negotiation-needed listener; perfect-negotiation glare resolution |
| `VerificationService` | Runs once on data-channel open | Re-checks DTLS fingerprint after every renegotiation; tears channel down if it changes |
| New `MediaService` | n/a | Wraps `getUserMedia`, `getDisplayMedia`, track lifecycle, mute/replace, transceiver/simulcast config |
| New `ChatService` | n/a | Owns the `chat` data channel; emits messages; persists nothing |
| `MultiPeerFileTransferService` | Files only | Add `kind: 'file' | 'voice-note' | 'image' | 'video'` so the chat pane can render appropriately |
| Page UI | One drop zone | Tabs or a unified pane: peer tiles (with video / voice meters), chat pane, drop zone, watch-together panel |
| `appStore` | Connection, peers, transfers, queued files | Plus `chatMessages`, `localMedia: { audio?, video?, screen? }`, `remoteMedia: Map<peerId, ...>`, `recordingConsent: Map<peerId, boolean>` |

Server changes are minimal. The hub already forwards SDP via the `*To` methods; renegotiation just sends more of those. No protocol additions.

## Threat model considerations

I want to be explicit about what changes and what doesn't:

| Surface | Today | After A/V |
|---|---|---|
| Server can read file payloads | No | No |
| Server can read audio/video | n/a | No (same DTLS) |
| Server can read chat | n/a | No (same DTLS) |
| Bound SAS authenticates the channel | Yes | Yes, plus per-renegotiation re-check |
| Malicious peer can send unwanted media | n/a | Yes — they can `addTrack` and we get a track. **Receiver consent gate required.** |
| Malicious peer can spam chat | n/a | Yes. Rate-limit per-peer chat messages on the receiver side, identical pattern to file rate limits. |
| Recording without consent | n/a | Always possible at OS level. UI consent prompt + visible recording indicator on every tile. Don't over-promise. |

The big new ask is **per-track consent**. Today, files require explicit accept. Video/audio tracks should require the same the first time a peer goes hot in a session. Subsequent mutes/unmutes by the same peer are silent.

A creative-but-real risk: a peer screen-sharing can frame a captured area to overlap one of the receiver's controls, then convince the receiver to "click here". We mitigate by never letting received media drive any user-interactive action; received video is `<video>` inside a sandboxed element, period.

## Mesh limits, honestly

For sizing decisions, here's the rough envelope per peer:

| Workload | Outbound encode cost | Inbound decode cost | Reasonable cap |
|---|---|---|---|
| Voice only | (N-1) × Opus 32 kbit/s | (N-1) × Opus | 10 (the existing session cap) |
| Voice + 720p video | (N-1) × VP9 ~1 Mbit/s with simulcast | (N-1) × VP9 | 4 |
| Screen share + voice (one sharer) | 1 × VP9 ~2 Mbit/s + (N-1) × Opus | 1 × VP9 + (N-1) × Opus | 8 |
| File transfer in flight | bound by data channel | bound by data channel | 10 |

If the project ever grows past these, the right answer is *not* to add an SFU to Sendie. An SFU would have to terminate DTLS, breaking the bound-SAS guarantee and the "server cannot wiretap" promise. The right answer is to lean into smaller groups (the "private 1:1" or "tight team of 4" use case) and explicitly position Sendie as not-Zoom. There are 50 SFU-based group call apps. There are zero with bound-SAS verification by default.

## What I'd build first

A two-week vertical slice:

1. **Week 1:** voice mesh up to 4 peers, with mute / leave-call controls and per-peer audio meters. Implement perfect negotiation and the post-renegotiation fingerprint check. Update `Verification.test.ts` to assert re-check semantics.
2. **Week 2:** chat over a separate data channel, voice notes via the file pipeline, and a "Download transcript" button.

Two weeks of work gets us 80% of what people actually want from a call tool. Video, screen share, and watch-together are the second pass. Recording is third.

## What I'd never build

- **Cloud recording.** Kills "files never touch a server."
- **Server-side link unfurling.** The IP-leak problem above; also pulls Sendie into being a content fetcher.
- **Server-side message archival.** Kills ephemerality.
- **Automatic transcription with a remote model.** Use a local Whisper-on-device option if anything.
- **Phone dial-in.** Pulls in PSTN providers, pulls in a TURN-style relay that breaks E2EE in spirit.
- **Matrix-style federation.** Adds a homeserver-shaped trusted party; Sendie's whole point is the server is *not* trusted with content.
- **"Trusted" SFU pattern (where the SFU only sees SFrame ciphertext).** This is technically clean and Element Call ships it, but for Sendie it would mean adding a server component, paying its hosting costs, and convincing users that the SFU "can't see anything" — which is a story we currently don't have to tell because there is no SFU. The day we hit a hard mesh-CPU ceiling and users are asking for 20-person calls, this is the right answer. Until then it's a future problem.

Each one of those would individually unwind something in the threat model the rest of the product depends on.

## Open questions for the project

1. **Identity strength.** The bound SAS is per-pair. In a 4-peer call, there are 6 pairwise SAS codes. Showing all six is noise. Do we display only "all peers verified" / "some unverified" and surface the per-peer view on click? I think yes; this is a UX call worth running by users. **Update from research:** MLS §8.7's `epoch_authenticator` is the group-level analogue of our SAS. If we adopt MLS for keying, we get a single per-epoch authenticator for free, and the UX simplifies to "compare this one phrase, once per session." Strong argument for adopting MLS even at our group sizes.
2. **Voice quality on weak networks.** Without an SFU, packet loss compensation is per-pair. Do we adopt RED (RFC 2198) for Opus to recover gracefully? Browsers support it; just need to enable.
3. **Should join-by-link grant call permission?** Currently a join means "you can transfer files in this session". Calls feel more invasive (microphone is hot). I lean toward: joining lets you observe and chat, but starting your camera/mic still requires the host to enable A/V for the session, which is then a single permission for everyone. This mirrors Zoom's "participant audio off" default.
4. **Mobile.** Background tabs lose `RTCPeerConnection` capability on iOS Safari. Voice calls in particular need a "keep awake" hint or a screen-on indication. Audible audio output mostly handles this; worth verifying.
5. **MLS adoption timing.** Adopting MLS now means a `~50KB` library (e.g. `mls-rs` compiled to WASM, or `openmls`). It pays off the moment we have any of: (a) keys-survive-disconnects requirement, (b) groups bigger than ~5, (c) need to provably evict a peer. Today none of those apply. I would re-evaluate at the *next* design point that makes any of them true — e.g. "persistent session that survives a peer reload" — and not before. The bound-SAS-over-pairwise-data-channels approach we already have is sufficient for now.
6. **Encoded Transform API readiness.** As of mid-2025, `RTCRtpScriptTransform` is widely shipped, `RTCSFrameSenderTransform` is in the editor's draft (W3C webrtc-encoded-transform, April 2026 draft) but not yet in stable browsers. We can polyfill with the script-transform fallback (manually run AES-GCM in a worker) but the per-frame integration adds complexity. I'd defer SFrame until the dedicated transform ships in two of three browsers.

## Closing

Adding A/V to Sendie isn't a pivot. It's the natural use of the WebRTC connections we already maintain, which already have the unique cryptographic property nobody else ships. Files plus calls plus chat in a single ephemeral session, with the signaling server cryptographically locked out of the content, is a design point the rest of the market hasn't taken because the rest of the market wants a server-side recording feature for sales-call transcripts.

We don't. That's the whole point.

**The thing the related work taught me:** the primitives are already standardized. MLS for group keying. SFrame for per-frame AEAD. Encoded Transform for the API surface. The bound SAS we already shipped is the piece that's *not* standard, and it's the piece that makes the other primitives load-bearing instead of decorative — because without an authenticated channel, MLS just tells you that some five people share a key. Together they tell you that *those specific five people* share that key, and the server can't change which five.

That is a sentence I have not seen any other product confidently write.

## References

- [RFC 9420 — The Messaging Layer Security (MLS) Protocol](https://www.rfc-editor.org/rfc/rfc9420.html), July 2023.
- [RFC 9605 — Secure Frame (SFrame): Lightweight Authenticated Encryption for Real-Time Media](https://www.rfc-editor.org/rfc/rfc9605), August 2024.
- [W3C WebRTC Encoded Transform](https://w3c.github.io/webrtc-encoded-transform/), Editor's Draft, April 2026.
- [W3C WebRTC: Real-Time Communication in Browsers](https://w3c.github.io/webrtc-pc/), "perfect negotiation" pattern.
- [W3C Screen Capture](https://www.w3.org/TR/screen-capture/), Working Draft, July 2025.
- [WebRTC Extended Use Cases](https://w3c.github.io/webrtc-nv-use-cases/), "Untrusted JavaScript Cloud Conferencing" (N27).
- Element Call (Matrix.org) E2EE design notes — background reading on MLS-over-real-time-media.
- [RFC 8723 — Double Encryption Procedures for SRTP](https://www.rfc-editor.org/rfc/rfc8723), the SFrame-predecessor approach we're skipping.
