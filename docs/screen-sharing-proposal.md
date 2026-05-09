# Screen sharing in Sendie: design proposal

Status: proposal, not yet implemented. Targets a Sendie-shaped use case
(small mesh, 2 to 8 peers, P2P over WebRTC, no SFU). Last updated 2026-05.

## 1. What we're building, and what we're not

In scope:

- One peer captures their screen, window, or browser tab and streams it
  to every other peer in the mesh.
- Receivers see the share in a primary video pane; existing voice and
  webcam feeds continue alongside.
- A lightweight presence layer (cursor, raise hand) over the existing
  data channel.
- End-to-end frame encryption using insertable streams, consistent with
  Sendie's "the server sees nothing" stance.

Out of scope for v1:

- Mobile sender. `getDisplayMedia` is not implemented on iOS Safari,
  Chrome Android, or Firefox Android; this is a hard platform fact, not
  something we can polyfill.
- Recording. `MediaRecorder` is trivial to add later; do not couple it
  to the share path.
- Drawing/annotations on the captured pixels. Hot user request, but
  it's a separate composition pipeline. Defer.
- SFU / cloud relay. Sendie is intentionally mesh-only.

## 2. Capture: choosing the right `getDisplayMedia` knobs

Spec coverage in 2026 is uneven. The base call is Baseline; the
useful options are mostly Chrome-only and we have to design around
that.

### 2.1 Baseline call

```ts
const stream = await navigator.mediaDevices.getDisplayMedia({
  video: { frameRate: { ideal: 30, max: 60 } },
  // 2.2: audio is intentionally off here; see below.
  audio: false,
  // 2.3: privacy and self-capture hardening, all Chrome-only but
  // ignored harmlessly elsewhere.
  selfBrowserSurface: 'exclude',     // no infinite hall-of-mirrors
  surfaceSwitching: 'include',       // user can switch tab without re-prompting
  monitorTypeSurfaces: 'include',    // allow "entire screen" if user wants it
  systemAudio: 'exclude',            // see 2.2
});
const [track] = stream.getVideoTracks();
track.contentHint = 'detail'; // or 'text' for code-review sessions
```

The `contentHint` setting is the single highest-leverage line. The
WebRTC stack switches to a screen-content rate controller, holds
detail at low motion, and stops sending an updated frame when nothing
has changed. Without it, every modern stack will treat your tab like a
camera feed and smear text under temporal denoise. Set it.

### 2.2 Audio: don't try to capture it on Sendie

Tab and system audio capture is Chrome/Edge only. Firefox and Safari
do not support it. If we expose a "share audio" toggle, half our users
hit it and get nothing.

The right move is: **mic and tab/system audio are separate capabilities
in the UI**. Mic stays in the existing voice path. If we want
"share what's playing on your screen" we ship that later, Chrome-only,
behind a feature detect. Don't build a fragile cross-browser story
around system audio in v1.

### 2.3 Privacy hardening

Three Chrome-only options worth setting (they no-op elsewhere):

- `selfBrowserSurface: 'exclude'`: prevents the user from accidentally
  picking the Sendie tab itself.
- `monitorTypeSurfaces: 'include'`: leave full-screen as an option but
  do not silently suppress it; users in code-review want it.
- `surfaceSwitching: 'include'`: lets the sender hot-swap which tab is
  shared without re-prompting. Removes the most common interruption.

We will *not* set `preferCurrentTab` because Sendie is not a slide
deck app and showing the receiver Sendie's own UI defeats the point.

### 2.4 Cutting-edge capture options we could adopt

These are all Chrome-desktop only as of mid-2026. Worth knowing about
but should not gate the v1 ship.

- **Captured Surface Control** (Chrome 134+): the sharer can grant a
  receiver scroll/zoom control of the captured tab. For pair-programming
  and code review this is a legitimate "wow" feature. Requires a
  permission prompt on the sharer side every session.
- **Element Capture** (Chrome 132+): capture just one DOM subtree
  rather than the whole tab. Useful when Sendie itself hosts the thing
  being shared (e.g. an in-app whiteboard); not useful for general
  screen sharing.
- **Region Capture**: crop a rectangle of a tab. Lower fidelity than
  Element Capture in the modern stack; skip.
- **Capture Handle**: lets the captured page advertise metadata
  (origin, app name) to the capturer. Only matters once Sendie is
  *the captured app* in someone else's tool, not now.

Implementation note: gate each behind a `'in' window` feature detect
and degrade silently. None should be required.

## 3. Codec choice: AV1 > VP9 > VP8 for screen content

For screen content the codec story is unusually clean.

| Codec | Screen-content tooling | Hardware enc on senders | Receiver decode | Verdict |
|---|---|---|---|---|
| AV1 | Yes, screen-content tools (palette, IBC) | Spotty (Intel 12th+, AMD RDNA3+, Apple M3+) | Universal SW; HW decode common | Best image quality at given bitrate, but encoder burns CPU on older senders |
| VP9 | Yes, profile 0 with screen-content extensions | Common on recent Intel/Nvidia | Universal | Best balance for v1 |
| H.264 | No screen-content profile | Universal HW | Universal | Smears text. Avoid. |
| VP8 | No | Universal | Universal | Last-resort interop. |

Default: prefer VP9, fall back to whatever both ends offer. AV1 in a
flagged path. Use `RTCRtpSender.getCapabilities('video').codecs` and
`setCodecPreferences()` to bias the SDP, do not hardcode a codec.

Senders with a hardware AV1 encoder (M3+ or recent x86) are the case
worth pursuing; for them, encoding at 2 Mbit/s 1440p with screen-content
tools on is genuinely cheap and gives crisp text every receiver can
decode. Detect via `await VideoEncoder.isConfigSupported({ codec: 'av01.0.04M.08' })`
and prefer when both ends agree.

## 4. The mesh fanout problem (the actual hard thing)

This is the part most P2P screen-share writeups handwave.

When the sharer adds the screen track to N peer connections via
`pc.addTrack(track, stream)`, **each peer connection gets its own
`RTCRtpSender`, each with its own encoder instance**. The sharer
encodes the same screen N times.

For Sendie's target (2 to 8 peers), this is the binding constraint:

| Peers | VP9 1440p30 encode load | Sustainable? |
|---|---|---|
| 1 | ~15% of one perf core | yes |
| 4 | ~50% to 60% of one perf core | yes on a modern laptop |
| 8 | ~120% to 200% (oversubscribes a core) | marginal; thermal throttling kicks in |

Three approaches to ducking the cliff, ordered by complexity:

### 4.1 Lower the per-peer ceiling

Easiest. Cap simultaneous receivers to 4 with screen sharing on, with
a UI message ("ask everyone to disable webcams / step down to audio").
Combine with a 1.5 Mbit/s default and 24 fps cap.

### 4.2 Encoded-frame fanout via WebCodecs + insertable streams

The right answer for v2. Pseudocode:

```ts
// In a worker:
const encoder = new VideoEncoder({
  output: (chunk, meta) => { broadcastEncodedChunk(chunk, meta); },
  error: (e) => { /* ... */ },
});
encoder.configure({
  codec: 'vp09.00.10.08',
  width: 1920, height: 1080,
  framerate: 30,
  bitrate: 1_800_000,
  latencyMode: 'realtime',
  contentHint: 'text',
});

// Pipe screen frames in once.
const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
// ...encoder.encode(frame)...

// On each peer's RTCRtpSender, attach an RTCRtpScriptTransform that
// pulls already-encoded chunks from a shared queue rather than letting
// the WebRTC stack run a second encoder.
sender.transform = new RTCRtpScriptTransform(worker, { peerId });
```

Net effect: one encode, N packetizations. Cuts CPU roughly Nx, and as
a bonus the encoded bitstream is identical per receiver, which makes
E2EE (section 5) practically free.

The catch: this only works because `RTCRtpScriptTransform` became
Baseline in 2025 (Chrome 141, Firefox 117, Safari 15.4). Don't ship it
without a fallback path that uses the boring `addTrack` flow on
browsers that don't have it.

### 4.3 SVC with K-SVC layer dropping per-peer

A single L1T3 SVC stream can be selectively forwarded such that a
slow receiver gets fewer temporal layers. In a mesh this requires
manual per-peer layer selection and is fiddly. Worth it for production
SFU work, overkill for Sendie. Skip.

## 4a. Alternatives to RTP that the room deserves to hear

The N-encoder problem and Sendie's overall "the server sees nothing"
posture make a few non-WebRTC paths worth a serious look. None are
the v1 answer; one or two could be the v2 or v3 answer.

### 4a.1 WebCodecs + RTCDataChannel: skip RTP entirely

RTP is a 30-year-old protocol with mature jitter buffering, NACK,
PLI, and congestion control built into the browser's media stack. We
get all of that for free with `addTrack`. But we also pay for it: an
encoder per peer, a packetization layer per peer, and an RTP layer
that assumes one logical stream per receiver.

A different shape, now possible because WebCodecs is Baseline
everywhere except old Safari:

```
  getDisplayMedia                              
        |                                      
        v                                      
  MediaStreamTrackProcessor (worker)           
        |                                      
        v                                      
  VideoEncoder (one instance, in worker)       
        |                                      
        v                                      
  EncodedVideoChunk (per frame)                
        |                                      
        v                                      
  framing + per-peer E2EE wrap (worker)        
        |                                      
        v                                      
  for each peer: pc.dataChannel.send(bytes)    
```

Receivers reverse: data-channel `onmessage` -> unwrap -> `VideoDecoder`
-> `VideoFrame` -> draw to `<canvas>` or via `MediaStreamTrackGenerator`.

What we win:

- One encode, N sends. Same CPU savings as the encoded-fanout pattern
  in section 4.2, but without the `RTCRtpScriptTransform` plumbing.
- E2EE is trivial: the bytes we already control are the ones we
  encrypt before `dataChannel.send()`. No need to leave an unencrypted
  prefix for the packetizer.
- Per-peer flow control is the same SCTP back-pressure model we
  already use for files. We have all that code and it works.
- Sender-side priority knobs (dropping P-frames first under stress)
  are exposed directly because the encoded chunks are JS-visible.

What we lose, and have to re-implement:

- Jitter buffer. Frames will arrive out of order or late; we have to
  decide when to drop vs wait. Not hard for screen content (low
  motion, mostly key-frame-aligned), genuinely hard for live camera.
- Loss recovery. Data channels are reliable+ordered by default in
  Sendie; we'd want to switch the share channel to unreliable
  (`maxRetransmits: 0` with `ordered: false`) and add our own forward
  error correction or key-frame-on-loss request protocol.
- Congestion control. SCTP has its own, but it is tuned for files and
  generic data, not live media. We'd need to back off bitrate via
  `VideoEncoder.configure({ bitrate })` based on observed RTT and
  data-channel bufferedAmount growth. Doable, not free.
- Browser jitter compensation, audio sync, A/V sync if we add audio.
  None of those matter for screen + voice in our model where voice
  goes over the existing voice path.

Verdict: this is a genuine architectural alternative that fits Sendie
better than RTP for screen content specifically. Screen sharing is
low-motion, high-detail, mostly idempotent at the frame level, and
often paired with a separate voice path. Camera and voice should
stay on RTP because the jitter-buffer and A/V-sync work the browser
does is genuine value for those payloads. **Recommended as v3 once
v1 (boring `addTrack`) and v2 (encoded fanout) have shipped and we
have real telemetry.**

### 4a.2 DOM sync / co-browsing instead of pixel streaming

The most creative alternative is to not stream pixels at all.

For code review, slide presentations, or any web-app demo, a
fundamentally cheaper approach is to serialize the DOM (and CSS, and
render-relevant state) and reconstruct it on the receiver side. The
bandwidth savings are dramatic: a 1080p tab at 30 fps is 1.5 Mbit/s
of video, but the same tab as compressed DOM diffs is typically a few
dozen KiB/s, with text remaining infinitely crisp at any zoom level.

For a peer-to-peer tool with code-review as a flagship use case, this
is arguably the right answer for that one workflow:

- Sharer captures a target subtree (Element Capture's `RestrictionTarget`
  conceptually maps cleanly onto "this is the captured DOM root").
- Periodic MutationObserver-driven diffs serialized to JSON-Patch or
  an equivalent structural diff format.
- Receiver reconstructs into a sandboxed iframe with `srcdoc` and
  applies diffs.
- Click and scroll positions piggyback on the existing data channel.

What it can't do: capture a non-Sendie tab, capture a window, or
capture the entire screen. Same-origin only, by browser security
design. So this is not a replacement for screen sharing; it is a
**complement** for the case "share what's in this Sendie panel". One
concrete v3+ feature: Sendie hosts an in-app whiteboard / code editor
/ markdown preview, and DOM-syncs that subtree to peers. Pixel
sharing (section 2 to 5) covers everything else.

### 4a.3 WebTransport + relay (rejected, but worth naming)

WebTransport is now Baseline 2026, with HTTP/3 datagrams and
QUIC streams. With a server-side relay, MoQ Transport (IETF draft 17,
March 2026) gives publish/subscribe semantics that map naturally onto
screen-sharing fanout: the publisher uploads one encoded copy, the
relay distributes.

This is the architecture every commercial video product is moving
to. It is **incompatible with Sendie's mesh / P2P promise**: it
requires running a relay, that relay sees the bytes (unless we layer
E2EE on top, which is what the MoQ spec encourages but does not
standardize), and it converts Sendie from "two browsers and a
signaling server" into "two browsers and a media server".

We should not adopt this. We should mention it in the doc so the
decision to stay mesh is explicit and revisitable.

### 4a.4 Crop before encode (creative win, low cost)

A detail that pays off across all approaches: shrink the captured
frame before encoding. The user often wants "this window" but ends
up sharing the whole screen because the window picker is fiddly.
With a `MediaStreamTrackProcessor` in a worker we can downscale or
crop frames to the target window's bounds before they hit the
encoder. Two consequences:

- Bitrate savings of 4x to 10x for typical "share just this terminal
  window" use cases.
- Privacy: notification toasts, system tray, and other surfaces
  outside the target rectangle are dropped before any peer sees a
  byte.

This composes with section 4a.1 (the encode is in a worker already)
or with the boring `addTrack` path if we do it via the `processor`
=> `generator` => `addTrack(generator.track)` chain. Cheap. Ship
in v1 if the API surface allows.

## 5. End-to-end frame encryption

Sendie's brand commitment is "the server sees nothing". The signaling
server already cannot decrypt the SCTP payload, but the SDP it relays
includes DTLS fingerprints, and a malicious server could substitute
fingerprints during initial offer/answer. We pin DTLS fingerprints
already (commit 05dbf7d), but for media we should also encrypt frames
end to end so that even a compromised TURN relay (if we ever add one)
cannot read pixels.

`RTCRtpScriptTransform` is the mechanism. The flow:

1. The verification handshake (existing `VerificationService`) gives
   us a per-peer shared secret.
2. Derive an HKDF-SHA256 frame key per direction per peer.
3. In an `RTCRtpSender.transform` worker, AES-GCM encrypt the encoded
   frame payload, prepend a 12-byte nonce + 4-byte sequence.
4. In `RTCRtpReceiver.transform`, decrypt symmetrically.
5. Rotate keys on a timer (every 5 minutes) and on peer rejoin.

Caveat: WebRTC needs to read the first few bytes of each payload to
do RTP packetization correctly. The standard pattern is to leave the
first "unencrypted prefix" bytes in the clear (1 byte for VP9, 10 for
H.264/AV1). The MDN encoded-transform examples cover this; we can
copy the pattern.

This applies to webcam and voice tracks too. It is generic media
hardening; screen sharing is just the first feature where the value
is obvious enough to justify the extra moving parts.

## 6. Presence and creative low-cost features

The screen share is the canvas; the data channel is where the value
add lives. None of these need video bandwidth.

- **Shared cursor overlay.** Each receiver broadcasts their pointer
  position relative to a normalized 0-to-1 coordinate space derived
  from the captured surface dimensions. The sharer's UI overlays a
  colored dot per peer with their friendly name. Cost: ~50 bytes per
  peer per frame at 30 Hz, negligible. Value for code review:
  enormous. Ship in v1.
- **Click ghosts.** A receiver clicking emits a one-shot ripple at
  their cursor position, visible to everyone. The sharer can decide
  whether clicks "count"; on Chrome with Captured Surface Control we
  could plumb this through to actual scroll/click on the tab. v2.
- **Reactions strip.** Emoji reactions piped through the existing
  chat data channel, rendered as transient overlays on the share.
- **Spotlight.** The sharer selects a peer's cursor as "spotlight"
  and that pointer renders larger/brighter. Useful for guided demos.
- **Highlight with mouse.** A hold-and-drag from the sharer paints a
  fading rectangle visible to everyone. Implemented in canvas overlay,
  no video pipeline change.
- **Captured Surface Control bridge.** Chrome only. The sharer can
  toggle "let receivers control my scroll" per peer. This is
  unusually creative for a web app: receivers genuinely co-pilot the
  sharer's tab. Gate behind explicit per-receiver consent on the
  sharer's UI. The v2 prize.

## 7. UX shape

### 7.1 Sharer

- Big primary button "Share screen" alongside "Voice" and "Camera".
- Picker honors `surfaceSwitching: 'include'` so users can change
  tabs mid-share without restarting.
- Top-of-screen banner: "You are sharing (entire screen | window |
  tab)". Click to stop. Mirrors the browser's own banner for clarity.
- A small per-peer "viewer list" with cursor color swatches.

### 7.2 Receiver

- The shared video occupies a primary pane; webcam feeds shrink to a
  filmstrip.
- Cursor moves on the receiver's local canvas overlay get echoed via
  data channel.
- Document Picture-in-Picture button: detach the share into a floating
  always-on-top window (Chrome 116+). Big productivity win for users
  with a single monitor.
- Quality indicator: hovering shows current resolution, fps, codec.
  Gives a debugging hook when something looks wrong without forcing
  the user into DevTools.

### 7.3 Mobile

`getDisplayMedia` is unsupported. The Sendie session page should:

- Show a disabled "Screen share" button with a tooltip "desktop
  browser only" rather than a confusing failure.
- Continue to receive shares fine (decode works on mobile).

## 8. Reliability and failure modes

- Sharer's encoder stalls (most common on lower-end Linux+Wayland):
  detect via `RTCStatsReport` polling; if `framesEncoded` stops
  advancing for 5 seconds while the channel is open, stop the
  share with a clear error and offer to restart.
- Per-peer congestion: the existing `bufferedAmountLow` per-peer
  pause logic does not help here because media is RTP, not SCTP. Use
  `RTCRtpSender.getStats()` per-peer; if `nackCount` plus
  `pliCount` spikes for a single peer, drop their layer (24 fps to
  15, 1.5 Mbit/s to 800 Kbit/s) before downgrading the whole share.
- The watchdog pattern from large-file transfers maps cleanly: stall
  detection per peer, surface a real error instead of silent hang.
- Permission revocation: if the user stops sharing via the browser's
  own banner, the track ends. Listen on `track.onended` and tear down
  cleanly across all peers.

## 9. Implementation plan

The honest order of operations:

1. **Spike** (1 to 2 days): naive `getDisplayMedia` plus `addTrack` on
   one peer pair. Validate that VP9 with `contentHint = 'text'` looks
   acceptable for code review at 1.5 Mbit/s. Verify Firefox sender to
   Firefox receiver works (mesh has no SFU, both must agree on codec).
2. **Mesh fanout, 4-peer cap** (1 sprint): wire into existing
   `MultiPeerWebRTCService`, surface in UI, add per-peer stats poll.
   Ship.
3. **Cursor overlay + Document PiP** (small): pure additions on top
   of (2).
4. **Insertable streams pipeline** (1 sprint, gated): encoded fanout
   in a worker. Ship behind a feature flag while we measure.
5. **E2EE frame encryption** (1 sprint): generalize the scheme from
   section 5 across all media tracks at once. Big enough win to
   justify a security-audit-2026-N follow-up.
6. **Captured Surface Control + Chrome-only flourishes** (small but
   delightful): only after (1)-(5) are stable.

## 10. Tensions and open questions

- **Codec mandate vs interop.** Firefox sender and Safari receiver
  share VP9 reliably; AV1 requires both to negotiate it. Picking a
  codec at the SDP layer per-peer means receivers may see different
  quality. Acceptable.
- **RTP vs WebCodecs+DataChannel.** RTP is the boring, correct
  default and what v1 ships. The WebCodecs+DataChannel path (4a.1)
  is architecturally cleaner for screen content and lets us drop a
  whole codec-agnostic plumbing layer, but commits us to writing
  jitter buffer and FEC code. Right answer is to ship RTP, measure
  pain points, and only switch the screen-share-specific path if
  encoded-fanout via insertable streams turns out to be insufficient.
- **Pixel sharing vs DOM sync.** Pixel sharing is universal but
  expensive. DOM sync (4a.2) is order-of-magnitude cheaper for the
  one use case where it applies (in-app subtrees). Don't conflate
  them; they solve different problems. Build pixel sharing first;
  add DOM sync as an in-Sendie feature for whiteboard/editor when
  those exist.
- **Encoded-fanout vs simplicity.** The naive N-encoders approach
  ships in days; the encoded-fanout approach is the right architecture
  but cuts in months. Build (1) first, demonstrate the pain at 8
  peers, then justify (4).
- **E2EE applies to voice and webcam too.** Doing it only for screen
  is awkward. The cost of doing it for all media is not much higher
  once the worker plumbing exists. Recommend tackling it once across
  the media path.
- **Captured Surface Control is a sharp tool.** Letting another peer
  drive scroll on your tab is genuinely powerful but also genuinely
  scary. UI must make per-peer consent explicit and revocable; do
  not hide it behind a single global toggle.
- **Mesh vs relay.** WebTransport+MoQ (4a.3) is the industry direction
  but breaks Sendie's "server sees nothing" promise. The decision to
  stay mesh is intentional; document it so we can revisit if and
  when group sizes outgrow what mesh can carry.
- **iOS sender remains impossible until Apple ships
  `getDisplayMedia`.** No sign of it; this is a known platform gap,
  not a Sendie defect. Communicate it once, in the disabled-button
  tooltip, and stop apologizing.

## 11. Concrete API surface

```ts
// New service: src/services/ScreenShareService.ts
export interface ScreenShareEvents {
  onShareStart: (track: MediaStreamTrack) => void;
  onShareStop: (reason: 'user' | 'permission-revoked' | 'error') => void;
  onPeerStats: (peerId: string, stats: PeerShareStats) => void;
  onRemoteShareStart: (peerId: string, stream: MediaStream) => void;
  onRemoteShareStop: (peerId: string) => void;
}

class ScreenShareService {
  start(opts?: ShareOptions): Promise<void>;     // wraps getDisplayMedia
  stop(): Promise<void>;
  setQuality(p: 'auto' | 'detail' | 'text'): void;
  // v2:
  enableEncodedFanout(): Promise<boolean>;       // RTCRtpScriptTransform path
  enableE2EE(keys: PerPeerKeys): Promise<void>;  // worker frame encryption
}
```

The data-channel cursor protocol piggybacks on the existing
`ChatService` channel:

```ts
type CursorMessage =
  | { type: 'cursor-move'; x: number; y: number; ts: number }
  | { type: 'cursor-leave' }
  | { type: 'cursor-click'; x: number; y: number };
```

x and y are 0-to-1 normalized; receivers multiply by their rendered
share dimensions. This survives sharer resolution changes for free.
