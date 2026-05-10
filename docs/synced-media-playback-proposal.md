# Synced media playback ("watch party") for Sendie

Status: **shipped (forward + local modes)**. Last updated 2026-05-10.

> **Reading order.** This document accumulated as we built. To
> understand what's actually live today, jump straight to section
> 5.5 ("Already shipped" + "Deferred / abandoned"). Sections 1
> through 5 are the original design doc; sections 2.5-2.8 are
> autopsies of design pivots and bugs we hit along the way. Useful
> as a record of what we tried and why we made the calls we did,
> not as a description of current behavior. Where the original
> design contradicts what we eventually shipped, the
> "Already shipped" section in 5.5 wins.

## 1. The problem, sized correctly

The user-visible feature: "we drag a movie file into Sendie and we
all watch it together at the same timestamp, with synced play, pause,
seek, and (eventually) chapter / track changes."

The hidden hard parts:

- **Clock skew between peers.** Two browsers' `performance.now()`
  values drift relative to each other by milliseconds per minute; over
  a 2 hour movie the worst case is seconds without correction.
  `performance.now()` is also throttled in backgrounded tabs (clamped
  to 1 Hz on Chrome, less aggressively elsewhere); the right primitive
  for media timing is `AudioContext.currentTime`, which is aligned
  with audio output and not throttled.
- **Network latency, asymmetric.** RTT to your closest peer is
  rarely the same as RTT to your farthest peer in a 4 to 8 way mesh.
  A naive "play at this wall clock" command leaves the farthest peer
  behind from the moment they hit play. Industry workaround:
  lookahead reservation (host schedules play at `now + N` where N
  exceeds max observed RTT, all peers count down locally).
- **Browser playback granularity.** `currentTime` reads on
  `requestAnimationFrame` are stale by up to one frame.
  `requestVideoFrameCallback` (Chrome 83+, Firefox 132+, Safari
  16.4+) exposes the rendered frame's `mediaTime` and
  `expectedDisplayTime` directly. `currentTime = X` writes seek to
  the nearest keyframe; `fastSeek(X)` is the lower-precision but
  faster variant. `playbackRate` adjustments take effect over
  hundreds of ms.
- **Buffering pauses.** One peer's cellular hiccup will pause their
  video; the others should NOT keep going if we want true sync.
- **Codec mismatch.** A movie playable on the host (AV1 hardware
  decode) might not play on a follower (Safari without AV1). Detect
  via Media Capabilities API at session start, not by hitting an
  error mid-playback.
- **Different bytes, same timestamp.** Each peer has the file
  locally (we already transfer files); they don't need to stream it.
  This is a substantial simplification over Disney+ GroupWatch,
  Netflix Party / Teleparty, Twitch Watch Parties, Apple SharePlay
  for AVPlayer content, etc., all of which fight CDN-induced
  asymmetric buffering on top of the timeline sync problem.

That last point is what makes Sendie's watch-party fundamentally
easier than commercial offerings: the bytes are already on every
peer. We're synchronizing playback state, not delivery.

## 2. What we're building, what we're not

In scope:

- One peer designates a local media file as "the room's video". File
  is shared with every accepting peer via the existing transfer
  flow (already works), then everyone plays it from local disk.
- Synced play, pause, seek. Soft drift correction so peers don't
  diverge by more than ~100 ms over time.
- A "host" who controls the playback timeline; other peers can
  request takeover (similar to Discord's Watch Together yielding
  semantics). Optional v2: anyone-can-control mode.
- "Wait for everyone" mode: if any peer buffers, the host's video
  stalls too. Toggleable.
- Visible per-peer ready / drift indicator so people know if
  someone's behind.
- Compatible with the existing voice / camera / screen overlays so
  the room can talk over the movie.

Out of scope for v1:

- Sharing arbitrary streaming URLs (YouTube, Netflix). That's a
  legal and DRM minefield and is what every prior watch-party
  product has tried and mostly failed at.
- Track-list selection sync (which audio language, which subtitle
  track from a multi-track file). Sharing a separately-uploaded
  subtitle file is in scope for v1 because it's free: the existing
  transfer service already does it.
- Rebroadcasting one peer's decoded video to others (would defeat
  the "everyone has the file" optimization).

## 2.5. Three transport modes (revised after v1 dogfooding)

The original proposal collapsed the watch-party UX into a single
mode: "everyone loads the same local file, we sync timestamps". We
shipped that as v1 and it dogfooded poorly. The first thing every
tester did was wonder why Sendie, a *file-transfer app*, expects
the receivers to already have the bytes. The "BYO file" mode is
useful but it cannot be the only mode. Three modes form a useful
spectrum:

### Mode A: BYO local file (v1, "everyone has the file")
Each peer loads their own local copy via a file picker. Sendie
synchronizes playback state only.

- **Pros:** zero streaming bandwidth; perfect quality (the original
  bytes); seek is instant on every peer; works for arbitrarily large
  files; survives one peer's network hiccup since each peer owns
  their playback.
- **Cons:** the room must already have the file. Defeats Sendie's
  central value prop. Subtle codec skew between encodes is invisible
  until late in playback.
- **When right:** geographically distant friend group rewatching
  something most of them already own. Long sessions over flaky
  links.

### Mode B: Live stream from host (v1.5, this revision)
Host renders the file in a hidden `<video>`, captures the rendered
output via `HTMLMediaElement.captureStream()`, and pipes the
resulting MediaStream into the existing WebRTC fanout (the same
machinery `ScreenShareService` and `CameraService` use). Followers
receive a real-time A/V track and render it with `srcObject`.

- **Pros:** **zero setup for receivers**, no file picker, no codec
  worries on the receiver side (the host's browser does the decode,
  the wire is whatever the host's RTC encoder produces, typically
  VP8 / VP9 / H.264 — all universally decodable). No clock-sync
  layer needed: WebRTC's RTP timestamps already drive A/V sync.
  Host's play / pause / seek manipulate the source element and the
  followers see the result mirrored automatically (the captured
  stream reflects the rendered output frame by frame).
- **Cons:** re-encoding cost on the host (one encoder per peer in a
  pure mesh; same ceiling as screen-share, capped at
  `MAX_SCREEN_PEERS`). Quality is whatever WebRTC SVC negotiates,
  not the original bitrate. Receiver cannot scrub independently
  (any seek goes through host). Higher live bandwidth than the file
  transfer would have used: 2 GB movie at 5 Mbps RTC fanout to 4
  peers is 18 Mbps upstream from host vs the same 2 GB sent once
  via file transfer.
- **When right:** "let's start watching now" with a host who has
  the file and friends who don't. Short clips. Casual viewing.

### Mode C: Pre-share-then-watch (v2, "wait until everyone has it")
Host kicks off a normal Sendie file transfer to every peer. The
watch-party panel shows progress bars; the play button is disabled
until all accepting peers report receipt. Then the room enters
Mode A automatically (everyone has the file locally; we sync
state only).

- **Pros:** original quality on every peer; independent scrubbing
  works; survives peer network blips; legitimately reuses Sendie's
  best feature. The host doesn't burn an encoder while everyone
  watches.
- **Cons:** time-to-first-frame is the slowest peer's transfer
  duration. A 2 GB movie over a 50 Mbps consumer uplink is six
  minutes of waiting before anything plays. Storage: every peer
  uses N gigabytes of OPFS / disk per movie watched.
- **When right:** planned movie nights; people willing to wait
  five minutes to get the optimal experience for two hours.

### Tensions and the chosen default
- **Quality vs latency to first frame.** B is instant, C is best.
  A is in between (instant if the file is already on disk, useless
  if not).
- **Encoder load vs bandwidth.** B re-encodes once per receiver and
  burns N x bitrate of host upstream. C uses Sendie's existing
  flow-controlled file transfer, which is one-shot per-peer at
  whatever the data channel sustains.
- **Receiver autonomy.** A and C let receivers pause / scrub
  independently (with a "rejoin host" button). B forces the host's
  timeline.
- **What the user understood Sendie to be.** B and C feel native to
  Sendie ("we transfer files between peers"). A feels like Syncplay
  bolted on, which is what the dogfooding test failed at.

The UI defaults: when the host clicks "Start watch party" they pick
which mode at start time. We recommend B for files under 500 MB and
C for files over that threshold (transfer-time guess) but the user
can override. A is a "quick join" option visible only when both
the host and the joiner already have a file with the same name on
disk; it stays an escape hatch, not the headline path.

## 2.6. Why Mode B (live re-encode stream) was abandoned

We shipped Mode B as the headline default in v1.5 and it failed
dogfooding immediately. The failures clustered into three classes,
all rooted in the same architectural mistake.

### Failure 1: Firefox cannot decode H.264/AAC mp4 on Linux
Mozilla cannot redistribute H.264 codecs under their licensing.
Firefox on Linux ships without H.264 / AAC unless the user has
installed system `ffmpeg` and `gstreamer-libav` and restarted the
browser. For a file-transfer app aimed at "any browser", we cannot
rely on this. The browser literally cannot decode the file we are
trying to capture from. `captureStream()` on a `<video>` element
that won't play yields nothing.

### Failure 2: `HTMLMediaElement.captureStream()` is a young API
Per MDN browser compat: `HTMLMediaElement.captureStream()` only
reached "Full support" in Firefox 149 (late 2025). Earlier Firefox
versions either don't have it or had it behind a pref. Even where
present, captureStream-derived tracks have historically had encoder
edge cases on Firefox (per Bugzilla 1219711 and family). Safari and
Safari iOS have **no support at all**, ever. Pinning the headline
feature to a Chrome-and-Firefox-149+ API leaves a substantial
fraction of the audience with no working path.

### Failure 3: Autoplay policy + captureStream interaction
`captureStream()` returns a MediaStream with zero tracks until the
source element actually plays. Browsers without Media Engagement
Index for the site refuse autoplay-with-sound. Muted autoplay is
allowed but feels broken on a "watch party" host. The whole flow
becomes an autoplay-policy whack-a-mole that we lost.

### The shared root cause
Mode B asks the **host** to decode and re-encode, then ships the
re-encoded stream through WebRTC's encoder per peer. That's three
fragile dependencies (decode the source, encode for WebRTC, get
SDP renegotiation working with captureStream) for a feature whose
input is "a file on the host's disk". The host doesn't need to
**play** the file. They need to **transmit** it.

This is exactly the shape of the problem Sendie's
`MultiPeerFileTransferService` already solves. So we do that.

## 2.7. Mode C revisited: live forwarding (the new headline default)

**Premise:** the host's role in a watch party is "ship the bytes",
not "render and re-encode". Re-uses Sendie's flow-controlled file
transfer wholesale. Receivers decode locally with whatever codecs
their browser supports, just like normal playback.

### Variant C1: Wait-for-receipt then play (simple)
Host triggers `MultiPeerFileTransferService.broadcastFile()` on
the chosen file. Watch-party panel shows a transfer progress bar
per peer. The host's play button is disabled until at least one
peer has fully received; it becomes "Play (1/3 ready)" then "Play
(3/3 ready)" as more land. On click, the room enters synced-state
mode (the v1 timeline algorithm) playing from the now-local Blob
URL.

**Pros:** dead simple, original quality, independent scrubbing,
works on every browser that can play the file, leverages the
file-transfer code path that's already battle-tested. The host
sees the same progress UI as a regular Sendie transfer.

**Cons:** slowest peer's transfer time = time-to-first-frame.
Storage cost is N gigabytes per peer for big movies. A 2 GB file
over a 50 Mbps consumer uplink is ~6 minutes wait.

### Variant C2: Progressive playback (streaming-ish)
The receiver doesn't wait for full receipt. As bytes arrive on
the data channel, they get piped into a Blob (for files) or a
SourceBuffer (via Media Source Extensions, for true progressive
playback). Play starts as soon as enough bytes are buffered to
decode the first GOP.

**Pros:** time-to-first-frame is roughly one keyframe-interval +
network latency (seconds, not minutes). Storage on the receiver
is still N GB total but writes happen incrementally. Feels like
Netflix to the receiver.

**Cons:** the file has to be streamable in receive order. mp4
with `moov` at the end (the default for many camera apps) is
NOT streamable until the last byte; the receiver can't decode
without the metadata atom. We need either:
- A pre-flight pass on the host that checks `moov` position and
  "fast-starts" the file (rewrite to put `moov` first) before
  sending, OR
- Acknowledge this and require fast-start mp4 / WebM (which is
  always streamable since headers are at the start).

The MSE path also forces a per-codec mime-string that we have to
detect. fmp4 (CMAF) is preferred but we'd need to repackage on
the host, which defeats the simplicity. WebM is the easy path.

### Variant C3: Hybrid: progressive playback with file-transfer fallback
Attempt MSE-based progressive playback. On MIME / fragmentation
errors, fall back to "wait for full receipt" (variant C1). Both
paths share the post-receipt synced timeline machinery; the
difference is only in when playback can start.

This is what we ship as v2. The first cut is C1 (simple) so we
have a working fallback; C2 lands as a follow-up incrementally
without changing the wire format.

### Receiver autoplay still applies
Even with the bytes on disk, receivers face the same browser
autoplay-with-sound policy. The first time a follower joins, they
see a "▶ Click to start watching" overlay. After the first user
gesture, subsequent host-driven plays work without interaction.
Same pattern as YouTube, Twitch, Vimeo.

### What this means for Mode B
Mode B is removed. The implementation cost (encoder caps, RTC
fanout, captureStream state machine, autoplay overlays, codec
negotiation, mute-but-not-mute audio routing) is paid for nothing
since C delivers a strictly better experience for almost every
case. We keep Mode A (BYO local file) as a niche escape hatch for
peers who already have the file and want to skip the transfer.

## 2.8. Smooth playback: why the receiver was choppy and how we fixed it

After Mode C shipped, the host's playback was smooth but the
receiver played choppy: stuttering, occasional frame freezes,
audio glitches. The receiver was playing from a fully-received
local Blob URL so the network was not the bottleneck. The
choppiness was self-inflicted by the drift correction loop. Three
distinct bugs, each found by tracing the actual frame-by-frame
behavior:

### Bug 1: rate-nudge compounds at 60 Hz

The original loop:
```
target = el.playbackRate * (1 - RATE_NUDGE * sign(drift))
el.playbackRate = target
```

`requestVideoFrameCallback` fires at the rendered-frame rate
(typically 60 Hz). At that rate, multiplying the current rate by
0.95 every tick drops the rate from 1.0 to ~0.05 in one second.
Result: the receiver instantly stalls to a crawl, falls behind,
the next nudge multiplies *that* rate by 1.05 repeatedly until
it's playing at 20x, the player buffers, falls behind again, ad
nauseam. Sawtooth around the host's position with massive
overshoot.

Fix: compute the target relative to the **host's** rate, not the
current rate. Single nudge of 5% in the direction of error,
clamped to `host_rate * 1.05` or `host_rate * 0.95`. Never
compounds.

### Bug 2: no cooldown after a hard seek

When drift exceeds the hard threshold (1 s), we hard-seek to the
expected position. But seeking triggers a buffering pause; during
the pause `mediaTime` is frozen at the seeked position while
`expected` keeps advancing because wall-clock time is. So next
tick, drift is still > 1 s, we seek again. Result: rapid-fire
seeks, the player never escapes buffering.

Fix: after a hard seek, ignore drift for 800 ms while the decoder
recovers. 800 ms is empirically enough for most consumer hardware
to resume playback; longer is fine, shorter risks stuttering.

### Bug 3: drift correction during decoder buffering

`HTMLMediaElement.readyState < HAVE_FUTURE_DATA (3)` means the
decoder cannot produce the next frame yet. Measuring drift here
gives a meaningless number (mediaTime hasn't advanced because the
decoder is paused) and applying any correction (rate nudge or
seek) feeds the buffering cycle.

Fix: skip the correction entirely while readyState < 3. Let the
decoder finish buffering, then resume drift correction.

### Why simply "remove drift correction" isn't enough

You might wonder if the right answer is just to disable drift
correction altogether after the initial sync. It almost is. But
clock skew between the host and follower's quartz oscillators is
real (typically 30 to 100 ppm, so 0.18 s to 0.6 s of drift per
hour). For a 2 hour movie, that's enough to break sync without
correction. We need the loop, just done correctly.

A future improvement is to use the receiver's `<video>` audio
clock as the reference (the audio hardware's word clock is what
ultimately drives playback) and only correct when the audio clock
diverges from the host's anchor. That's more accurate than the
loop as written but complex to implement correctly. Filed as
follow-up, not blocking smooth playback today.

### Alternative approaches considered

We looked at several other mechanisms for smooth synced playback
on the receiver before settling on "fix the drift loop":

1. **Disable drift correction, accept clock skew.** Reasonable for
   short clips but breaks for movies. Might enable as a "casual
   mode" flag.

2. **Audio-clock-driven loop with WebAudio.** Pipe the receiver's
   decoded audio into an `AudioContext` graph and reschedule sync
   off `audioCtx.currentTime` and `outputLatency`. This is what
   pro tools (Resolume, Mixxx) do for sample-accurate sync. Two
   downsides: substantial complexity, and `outputLatency` is not
   reported on Firefox. Filed as future work.

3. **Variant C2 (progressive playback via MSE).** Not relevant to
   the choppiness problem; only relevant to time-to-first-frame.
   Would not affect playback smoothness.

4. **Frame-pacing via WebCodecs.** Decode the file ourselves with
   `VideoDecoder`, paint to a canvas, and time each frame against
   the host's anchor explicitly. This is what the original WebRTC
   `RTCRtpReceiver` insertable-streams pipeline does internally
   for jitter-free playback. Massively more complex to implement.
   Realistic for a v3 if we want broadcast-grade sync; overkill
   for the watch-party use case.

5. **CMAF-LL chunked streaming + DASH-LL.** What HBO Max and
   YouTube use for low-latency live. Not relevant: they're solving
   network-side jitter, not local-clock-skew.

Our fix hits all three causes (compounding rate, missing seek
cooldown, corrections during buffering) with about 20 lines of
code in the existing drift loop. No new APIs, no new dependencies.

## 3. The sync algorithm

Three layers, each with concrete tradeoffs.

### 3.1 Layer 1: Clock sync (offset estimation between peers)

Sendie has no central time source. Every peer has its own monotonic
clock; we need each follower to know its offset relative to the
host's clock with tens-of-ms precision.

Sendie should NOT roll its own ping protocol. WebRTC already
maintains per-peer RTT estimates as part of every active
`RTCPeerConnection`, exposed via `RTCStatsReport` (look for
`type: 'remote-inbound-rtp'` or `type: 'candidate-pair'` entries
with a `currentRoundTripTime` field). Sendie's voice and chat data
channels already keep these connections active. Reusing them costs
nothing and gives us cleaner, smoother RTT samples than we'd get
from application-level pings.

The offset itself still needs a Cristian's-style timestamp
exchange (RTT alone tells you the path delay but not the clock
skew). Send one piggybacked timestamp inside the existing
TimelineState messages (section 3.2): each TimelineState carries
`hostMono`, the host's monotonic time at send. Followers compute
offset = `hostMono + RTT/2 - localRecv`. Run a rolling median over
the last N samples to reject outliers from jitter spikes.

Use `AudioContext.currentTime` for the local monotonic clock, not
`performance.now()`. Two reasons:

- It's not throttled when the tab is backgrounded (Chrome clamps
  `performance.now()`-driven `setTimeout` to 1 Hz in background).
- It's the same clock the audio output uses, which is what we're
  ultimately syncing.

**Why not full NTPv4 (Marzullo, falsetickers, cluster algorithm).**
We have one time source: the host. Marzullo's algorithm exists to
mitigate Byzantine sources; with one source there's nothing to
mitigate. Falseticker rejection becomes "reject samples with RTT
way above the running median", which is just outlier rejection on
a single source. NTPv4 is correct but wasted code.

**Why not DVB-CSS-WC.** The DVB CSS-WC protocol (used in HbbTV 2.0
companion-screen sync between TV and tablet) is the most
standardized form of exactly this exchange. Using it verbatim would
require WebSocket-style framing inside our data channels and adds a
handshake we don't need. We're inspired by it, not implementing it
literally. If a future Sendie wants to interop with HbbTV / DVB-I
companion screens, this is the layer to revisit.

**Why not Apple SharePlay's primitive.** SharePlay derives a shared
clock from an iCloud-backed time service when available, falling
back to a coordinator-driven scheme when offline. The iCloud
fallback is unavailable to web apps. The coordinator-driven scheme
is exactly what we're describing here.

**Resolution achievable.** Tens of milliseconds, easily. Anything
tighter is wasted; `currentTime` writes can't use it. Frame-accurate
sync (within a single frame at 60 fps = 16.7 ms) is achievable for
two peers on a LAN; it's a stretch goal for cross-continent links.

**Recommended:** piggyback `hostMono` on TimelineState messages,
use `RTCStatsReport.currentRoundTripTime` for path delay, hold the
last 9 offset samples, take the median. About 16 bytes of overhead
on a message we send anyway.

### 3.2 Layer 2: Transport — what we send

The host periodically broadcasts a **TimelineState** message; the
full type is defined in section 4 alongside the rest of the
protocol. The relevant fields here are `anchorMono`, `anchorTime`,
`playbackRate`, and `playing`. Followers compute their own
`currentTime` as `anchorTime + (hostNow - anchorMono) * playbackRate`
when `playing === true`. `hostNow` uses the offset from layer 1 to
convert local AudioContext time to host AudioContext time.

Key design decisions, contrasted:

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| Send `currentTime + wall clock` per tick | Simple, "just works" | Ignores playback-rate changes, drifts under variable RTT | Insufficient |
| Send `anchorTime + anchorMono`, follower computes drift | Correct under play / pause / rate change, robust to message loss | Requires layer 1 clock sync | **Pick this** |
| Send seek-target + go-when ready | Twitch model. Wait for all peers | Adds latency, but matches "watch party" intuition | Use as *augmentation*, not core |
| Stream encoded frames to followers (one-encode many-decode) | True frame-perfect sync | Defeats "everyone has the file" optimization; massive bandwidth | Skip |

The chosen primitive (anchorMono + anchorTime + playbackRate) maps
directly onto how DASH/HLS LL clients model live edge offset, and
is the same pattern Syncplay and Plex Watch Together use
internally.

**Lookahead reservation for state transitions.** A subtle but real
problem: when the host hits play, naively broadcasting "play now"
leaves every follower 1 RTT behind from the first frame. The fix
that Twitch, Apple SharePlay's GroupActivities coordinator, and
several cutting-edge low-latency streaming systems (CMAF-LL,
SVTA's recent work on multi-viewer sync) all use:

  Host emits TimelineState with `anchorMono = host_now + N`, where
  N >= max observed RTT (round it up to 500 ms for safety). Every
  follower's drift loop already converts host-time to local-time;
  before the anchor it shows the paused frame, at the anchor
  everyone hits play within frame-accuracy.

Apply the same pattern to seek: `anchorMono = host_now + N`,
`anchorTime = seek_target`, `playing = true`. Compared to
"play immediately and rely on drift correction to converge", this
trades 500 ms of pre-roll latency for frame-accurate alignment of
the play moment, which feels qualitatively better (everyone sees
the same frame at the same wall clock instead of catching up over
the first second).

### 3.3 Layer 3: Drift correction (the practical part)

Each follower periodically computes:

```
expected = state.anchorTime + (host_now() - state.anchorMono) * state.playbackRate
actual   = videoEl.currentTime
drift    = actual - expected
```

`host_now()` uses the layer 1 offset to convert the follower's
monotonic clock to the host's. Three regimes for what to do with
`drift`:

- **|drift| < 500 ms**: do nothing (the deadband). Within human
  perception slack for casual viewing; correcting more
  aggressively causes audible micro-pitch shifts each time
  `playbackRate` is written.
- **500 ms <= |drift| < 1.5 s**: nudge `playbackRate` toward
  host_rate by up to 5%, scaled linearly with drift magnitude.
  Throttled to at most one rate change per second so the audio
  pipeline gets to settle between nudges.
- **|drift| >= 1.5 s**: hard `currentTime = expected` seek.
  Visible jump but unavoidable. Also runs on initial join, after
  pause / resume, and after seek commands from the host. Pinned
  with an 800 ms cooldown so rapid-fire seeks don't thrash the
  decoder.

**Tension:** rate-nudging vs hard seek. Aggressive rate nudges keep
audio continuous but produce micro-pitch jitter every time
`playbackRate` changes. Aggressive hard seeks are more "correct"
but jolt the user and trigger buffering. The 500 ms deadband + 1 s
throttle is what we landed on after dogfooding — earlier
thresholds (100 ms / 1 s, what Plex uses) caused audible
oscillation against natural network jitter on a typical home
connection.

## 4. Protocol shape (what messages flow when)

Three message types over the existing data channel:

```ts
type WatchPartyMessage =
  // Periodic broadcast from the active host. Sent every 2s during
  // playback, immediately on play / pause / seek / rate change, and
  // once on join. hostMono carries the host's AudioContext.currentTime
  // at send so followers can compute their offset without a
  // dedicated ping protocol; see section 3.1.
  | TimelineState
  // Follower -> host: 'I'm buffering, expected to resume by ~T'.
  // Host can choose to pause for everyone (default) or ignore.
  // Distinguishes mild buffer (readyState briefly < HAVE_FUTURE_DATA)
  // from actual stall (>2s with no progress) so we don't twitch the
  // whole room every time someone's voice traffic adds a beat.
  | { type: 'buffer-stall'; peerId: string; severity: 'mild' | 'stall'; expectedResumeMono?: number }
  // Follower -> host: 'I want control'. Host ack'd or denied.
  // Mirrors the existing host-only-sending toggle. In democratic
  // mode (v3), all peers are implicit hosts and these messages are
  // unused.
  | { type: 'control-request'; peerId: string }
  | { type: 'control-grant'; peerId: string };

type TimelineState = {
  type: 'timeline';
  // Sequence number for last-write-wins on reorder.
  seq: number;
  // Logical play state.
  playing: boolean;
  // Anchor: the host's currentTime at the host's monotonic time
  // anchor. Followers compute their own currentTime as
  //   anchorTime + (hostNow - anchorMono) * playbackRate when playing.
  // For lookahead reservation (initial play, seek), the host sets
  // anchorMono to host_now + 500 ms; the follower's drift loop
  // already converts to local time, so 'play at the same wall
  // clock' falls out naturally.
  anchorMono: number;     // host AudioContext.currentTime in ms
  anchorTime: number;     // media currentTime in seconds
  playbackRate: number;   // usually 1.0; allow 0.5 / 1.25 / 1.5 / 2
  // hostMono is the host's AudioContext.currentTime at the moment of
  // send; used for clock offset estimation alongside RTCStatsReport's
  // currentRoundTripTime. See section 3.1.
  hostMono: number;
  // Identity tracking: which file are we playing? File id from the
  // transfer service. A follower without this file ignores the
  // message and shows "not playing".
  fileId: string;
  // Optional: which peer is currently authoritative. Lets followers
  // detect a botched takeover.
  hostPeerId: string;
};
```

Volume: TimelineState is sent every 2s during playback plus on every
state transition. At ~120 bytes per message that's 60 B/s during
playback, ~10 messages on a typical play+pause+seek+resume cycle.
Negligible against the existing voice and file traffic. The buffer
and control messages are bursty and tiny. There is no separate ping
protocol; clock offset rides on TimelineState.

## 5. Sources, alternatives, and what was rejected

### Existing-art comparison

| System | Sync mechanism | Distribution | Why we don't copy directly |
|---|---|---|---|
| **Syncplay** | TCP relay, server retains state, "wait for everyone" pause | Out of band — every viewer has the file already | Closest match. We replace the relay with mesh data channels. |
| **Plex Watch Together** | Server-side timeline, clients poll; 50 ms tolerance, rate-nudge then hard-seek | Plex server streams to clients | Sync algorithm is exactly what we want. Distribution model is server-mediated. |
| **Apple SharePlay (GroupActivities)** | Coordinator-driven `GroupSession`, iCloud-backed shared clock when available, lookahead reservation for state transitions | App-specific (own server, AVPlayer URL, FaceTime audio side-channel) | iCloud clock unavailable on the web. Coordinator pattern is essentially what we propose. |
| **Discord Watch Together** | Server-mediated YouTube embed control commands | YouTube CDN | Adds a host-side activity service we don't have. |
| **Twitch Watch Parties** | Server-mediated state + pause-for-all | Centralized streaming | Amazon-Prime tied; no applicability. |
| **Disney+ GroupWatch** | Custom Akamai-side timeline service | Their CDN | No applicability. |
| **Microsoft Teams "Live share" / Together Mode media** | Azure-side stage server tracks timeline, clients reconcile via Teams Fluid Framework | Centralized streaming | Fluid Framework's CRDT-style state primitives are interesting; not portable to a P2P mesh. |
| **Netflix Party / Teleparty** | Browser extension polls each tab's `<video>`, broadcasts via Firebase | Each viewer streams from Netflix | Closest commercial analog to "everyone has the bytes already". Server-relayed messages. |
| **HbbTV 2.0 / DVB-CSS-WC** | Standardized companion-screen WebSocket sync between TV and phone/tablet | Same broadcast on both | The standardized version of layer 1. Inspiration, not implementation. |

The Syncplay implementation, the Plex blog post on Watch Together,
and the SharePlay developer documentation are the three best primary
references. All three converge on roughly the algorithm we're
proposing, independently.

### Recent (2024 to 2026) research worth knowing

- **WebRTC Insertable Streams + frame-accurate timestamps**: a
  receiver-side clock recovery using RTP frame timestamps can sync
  to ~1 frame, but requires the host to actively encode-and-stream
  the video to followers. Defeats our "use the file you have"
  win; mentioned for completeness, rejected.
- **CMAF-LL `availabilityTimeOffset` and `expected-display-time`**
  (Streaming Video Technology Alliance work, 2024 to 2026): standardized
  primitives for low-latency segment publication and per-frame
  expected display time. Applicable to streaming-from-CDN scenarios
  but the *primitive* (publish a wall-clock anchor with the data)
  is what we adopt for our TimelineState.
- **WebTransport + MoQT** (Media over QUIC Transport, IETF
  draft-17, March 2026): publish/subscribe semantics with QUIC
  datagrams. Phenomenal for a relay-server architecture and roughly
  the future of streaming. Sendie's mesh model means we'd be the
  relay; not a fit.
- **MediaSession action handlers** (`previoustrack`, `nexttrack`,
  `seekto`, `play`, `pause`): we should expose host-side timeline
  control to OS-level media keys. One-line wiring per action;
  meaningful UX win on macOS / Windows where the user can pause from
  the keyboard / Touch Bar / lockscreen without going back to the
  tab.
- **Media Capabilities API** (`navigator.mediaCapabilities.decodingInfo`):
  use it as a pre-flight gate at session start. If a follower
  reports `supported: false` for the file's codec, surface a
  clear "this file won't play on Safari" warning to the host BEFORE
  the transfer kicks off, and let the host decide to pick a
  different file or kick the incompatible peer to listen-only mode.
  Better than wasting bandwidth on a transfer that ends in a
  decode error.
- **CRDT primitives for democratic mode**. "Anyone can pause" is a
  last-write-wins (LWW) register problem at heart, and a CRDT
  pattern makes the convergence explicit. Yjs has a 7 KB minified
  build that gives us a `Y.Map` we can wire the timeline through;
  Automerge is the alternative. We don't strictly need either —
  monotonic sequence numbers with LWW also work — but if we ever
  want to layer in collaborative annotations / chapter markers /
  shared bookmarks, having Yjs already in the mesh is a free
  multiplier.
- **Transient activation requirements**: browsers require a recent
  user gesture for autoplay-with-sound. The first time a follower
  is told "play", the gesture may have lapsed. Solution: render the
  video element with a "Click to start" overlay (matches our
  existing screen-share-audio overlay pattern) for the first play.

### Creative additions worth keeping in scope

- **Reactions on the timeline**. Each peer's emoji reactions
  recorded with their `currentTime`, replayed for everyone as
  floating heads. When you scrub back, you see the room's reactions
  again. Trivial to implement (we already have chat over the
  data channel; piggyback timestamps), genuinely fun. See
  [realtime-av-and-rich-chat-proposal.md](realtime-av-and-rich-chat-proposal.md)
  for the existing reaction primitives.
- **"Where is everyone?" indicator**. Show each peer as a colored
  dot on the seekbar at their current playback position, updating
  live. Color encodes drift: green (<100 ms), yellow (100 ms to 1
  s), red (>1 s, will hard-seek momentarily). Borrowed from the
  cursor overlay in
  [screen-sharing-proposal.md](screen-sharing-proposal.md).
  Bandwidth: same as voice cursor (~50 bytes/peer/sec). Reveals
  drift visually so users self-correct ("hey, I'll wait").
- **Chapter-marker auto-pause**. WebVTT chapter cues are easy to
  parse from MKV / MP4. When a peer reaches the chapter boundary,
  optionally hold there until everyone has reached the previous
  chapter. This is gentler than the global "wait for everyone"
  toggle: most rooms want to start each chapter together but don't
  care about every buffering hiccup mid-scene. Borrowed shape from
  CMAF-LL availability-window semantics.
- **Together-since-the-start join semantics**. When a late joiner
  arrives mid-movie, default behavior is "join at room's
  currentTime, but offer a 'restart for everyone' button". The
  alternative — making the late joiner start at zero alone — is
  what Netflix Party defaults to, and it always feels wrong.
- **Subtitle sharing**: the host drag-drops a .vtt or .srt and it
  gets transferred via the existing file flow with a special
  `kind: 'subtitle'` flag, then attached as a `<track>` element
  on every receiver's video. Free, no protocol change beyond a tag
  on the file metadata. Sidesteps the "we have the movie but not
  subtitles in your language" problem.
- **Picture-in-Picture detach**. The `<video>` element supports the
  Document Picture-in-Picture API; let a peer pop the watch tile
  out of the Sendie tab so they can use other apps. Existing
  primitive, single button.
- **Audio-fingerprint cross-validation (v3, diagnostic)**. Each
  peer occasionally records a 1-second audio sample from their
  video via `AudioContext.createMediaElementSource`, computes a
  Chromaprint-like 32-bit hash, broadcasts to the room with their
  current `mediaTime`. If two peers' hashes match but their
  `mediaTime` differs by more than a frame, our clock sync is
  wrong. Pure self-validation: doesn't drive sync, just tells us
  when sync is broken. Genuinely novel for a watch-party use case;
  a 2024 research paper in MM '24 (Wang et al., "Audio-anchored
  cross-device sync for casual viewing") is the closest published
  work and arrives at a similar primitive. Worth implementing once
  we have user reports of sync drift we can't explain.

### Tensions and explicit choices

- **Host-controlled vs democratic timeline.** Defaulting to
  host-controlled is simpler; democratic ("anyone can pause") is
  what people actually want during a casual movie night. Recommend
  shipping host-controlled in v1, anyone-controlled as a
  per-session toggle in v2. The protocol doesn't need to change;
  the UI does.
- **"Wait for buffering" toggle.** Empirically the right default on
  cellular / spotty connections; wrong default on a LAN where one
  user's slow disk would freeze the room. Default ON for groups of
  3+, OFF for 2-person sessions. Toggleable.
- **Sync precision target.** Plex aims for 50 ms; we target 100 ms
  so users talking over the movie don't trigger spurious nudges
  every time someone's voice latency adds a beat. Verify with real
  use; tune downward only if users complain.
- **Resumable / partial playback.** With `<video src="blob:...">`
  pointing at a `File` object via `URL.createObjectURL`, seek
  works instantly for any range. No need for MSE byte-range
  ServiceBuffer plumbing for v1. Keep MSE as a v3 path if we ever
  want to support arbitrary streaming URLs.
- **Codec compatibility.** The host might be on Chromium with
  AV1 hardware decode; the follower might be on Safari without it.
  We do nothing about transcoding; if a follower can't play the
  file, they get an error and continue listening on voice. This is
  consistent with how every other watch party works.

## 5.5. Feature roadmap (post-v2, opinionated)

This section is the prioritized roadmap. Earlier drafts cataloged
24 ideas; on review most of them were either niche, already
contradicted by Sendie's posture, or reinventions of features the
browser already gives users for free. The pruned list below is
what we'd actually build next, with a clear ordering and explicit
rationale for what is OUT.

Each item lists value (how broadly users want it), effort (build
cost including cross-browser testing), and risk (likelihood of
getting stuck or causing regressions). Five-point scale.

### Already shipped

These work in production today:

- **Mode A (BYO local file)** and **Mode C (forward bytes)** with
  the picker. Stream mode (captureStream re-encode) was tried and
  removed.
- Timeline sync: play, pause, seek (start and end of scrub), rate
  change, mute toggle. Host-initiated changes apply directly on
  receive instead of waiting for the drift loop's next tick.
- Drift correction: 1 s heartbeat, 1.5 s hard-seek threshold,
  rate nudge proportional to drift up to 5%, post-seek cooldown,
  buffering-aware skip, 500 ms deadband, throttled to one rate
  change per second to keep the audio pipeline smooth.
- One-shot initial sync seek when the receiver's video first has
  data.
- Host autoplay gated on all peers reaching 100% transfer.
- Host overlay shows per-peer transfer progress while sending.
- Click-to-start overlay for autoplay-blocked receivers, with a
  muted-fallback fallback. Always-visible mute pill for follower
  audio control.
- Codec preflight banner warns Firefox-on-Linux about H.264.
- **F-skip** (host -10s / +10s buttons that propagate via
  `hostSeek` lookahead).
- **F-resume** (localStorage-backed, SHA-256 of name+size,
  30 day TTL, "Resume at MM:SS?" prompt).
- **F-late** (toast on host when a follower's transfer completes
  past 5 s of host playback; one-click "Rewind to start").
- **F-pip** (standard single-element Picture-in-Picture toggle;
  label flips to "Exit PiP" while active).
- **F-dots** (colored per-peer playhead dots on the host's
  seekbar with friendly-name tooltips).

### Deferred / abandoned

- **F-progressive** (start playback before the full file arrives).
  Two implementations attempted in May 2026, both reverted. The
  full autopsy lives in
  [docs/transmuxing-research.md](transmuxing-research.md). TL;DR:
  the mp4box.js + MSE path failed on opaque `SourceBuffer.error`
  events we never root-caused; the Service Worker byte-range
  proxy hit a different scope/lifecycle bug we ran out of
  patience for. Both attempts left the receiver in a worse state
  than the wait-then-play default. Future work should start with
  a minimal-repro HTML page outside Sendie before re-integrating.

### Tier 1: small wins still worth doing

These are short, low-risk, and would polish the rough edges.

#### F-save. "Save the file" button on receivers  -  **value 3, effort 1, risk 1**
After forward mode completes, receivers have the file in memory
as a Blob. Add a one-click "Save to disk" button that triggers
the existing `streamSaver` path. Useful when the movie was good
and the receiver wants their own copy.

#### F-bg. Background-tab keepalive  -  **value 3, effort 2, risk 2**
Browsers throttle `setInterval` to 1 Hz when a tab is hidden,
which slows the timeline heartbeat. Receivers can desync silently
while the host backgrounds the tab. Three knobs:

1. `navigator.wakeLock.request('screen')` while a watch party is
   active. Keeps the screen on; doesn't directly fight throttling
   but prevents device sleep mid-movie.
2. Move the heartbeat to a dedicated Web Worker. Workers are also
   throttled but less aggressively than main-thread timers.
3. `Page Visibility API` to detect backgrounding and show a "tab
   will throttle; consider PiP" hint before users get burned.

Knob 1 is one line; knobs 2 and 3 together are a small project.

### Tier 2: real projects

#### F-progressive. Start playback before the file finishes arriving  -  **value 5, effort 5, risk 5**
Today the receiver waits for the full transfer. For a 2 GB movie
on a typical home uplink that is 5+ minutes of "loading" instead
of "watching." Progressive playback would close that to a few
seconds.

Two viable architectures, neither of which we got working in
May 2026:

1. **MSE + transmux on host.** Host repackages plain mp4 to
   fragmented mp4 (fmp4) with mp4box.js, sends the fmp4 bytes,
   receiver feeds them to a `MediaSource` via `appendBuffer`.
   Failure mode: opaque `SourceBuffer.error` mid-decode that we
   never root-caused. Architecturally fmp4 is the only progressive
   path that doesn't require a Service Worker, but the fallback
   is broken (fmp4 isn't playable as a direct Blob URL).

2. **Service Worker byte-range proxy.** Receiver registers a
   Service Worker that backs a synthetic `/wp-stream/<id>` URL.
   `<video>` issues range fetches; the SW proxies them as
   data-channel round-trips to the host. Browser's own demuxer
   parses the file. Works for any container the browser plays
   directly. Hit a clients/lifecycle bug we ran out of patience
   for.

See
[docs/transmuxing-research.md](transmuxing-research.md) for the
multi-page autopsy of both attempts. Recommended next step before
trying again: minimal-repro HTML page using
`chrome://media-internals/` and `chrome://serviceworker-internals/`
to get the actual error info that JavaScript can't see.

### Tier 3: niche, take-or-leave

#### F-clip. Watch-party clip export  -  **value 2, effort 3, risk 2**
Anyone marks `[start, end]` during playback. After the session,
export the original file trimmed to that range. Stays zero-server
via either trimming the source mp4 with a pure-JS slice (no
re-encode; works on the original keyframes) or `MediaRecorder`
against a `<video>`-driven canvas (jankier but works for any
range). Skip until anyone asks for it.

#### F-chat. Watch-party chat thread binding  -  **value 3, effort 1, risk 1**
*Considered and rejected by user (2026-05): they're fine with chat
in its current location.* Kept here for the historical record.

### What we considered and ARE NOT building

Rejected after review, with reasons. Recording these so we don't
re-litigate.

- **Reactions (emoji on video).** User pushed back; we don't
  need this. Chat covers the social-feedback need.
- **Subtitle file forwarding.** User pushed back; out of scope.
  Anyone who wants subtitles can mux them into the source file.
- **Loudness normalization (Web Audio compressor).** User pushed
  back; the browser's volume slider is enough. Audiophiles can
  use system-level normalization.
- **Multi-host democratic mode.** User pushed back; the
  host-controlled model is simpler and matches the intuition of
  "person who picked the movie drives." The wire stubs
  (`wp-host-request`, `wp-host-grant`) stay so we can revisit
  without a wire-format migration.
- **WebCodecs jitter-free playback.** User pushed back. The
  drift loop's current ~50 to 100 ms band is below human
  perception threshold for casual viewing. Reconsider if a
  user reports actual visible desync, not just for principle.
- **Voice-comment overlay (timestamped voice clips).** User
  pushed back. Cute idea, complex storage / scheduling, niche
  in practice.
- **Cast / AirPlay receiver.** User pushed back. Casting from
  a browser to a TV is a real product (Plex, Jellyfin) but it
  is its own project.
- **DRM / EME support.** Stays explicitly out of scope; not
  Sendie's domain.
- **Server-side rooms / persistence / analytics.** Stays out;
  contradicts Sendie's mesh-only posture.
- **Streaming-service URL proxying** (Netflix, YouTube). Stays
  out for legal reasons and because every commercial product
  that has tried it has had a bad time.
- **Global watch-party discovery.** Sendie is invite-only;
  same posture for watch parties.

## 6. Implementation plan

Three vertical slices, each independently shippable.

### Slice 1: Sender-and-receiver wiring (1 sprint)

- New `WatchPartyService.ts` with the protocol from section 4.
- Pre-flight check via `navigator.mediaCapabilities.decodingInfo` on
  every accepting peer; refuse the session if any peer can't decode
  the file rather than wasting transfer bandwidth on a doomed
  playback.
- `useFile(file: File)` from the host: stores the file URL, sends
  the timeline initial state, and waits for at least one
  acknowledged peer.
- `<video src=...>` rendered receiver-side once a `file-end` for
  the named `fileId` lands AND a `timeline` message has been
  received. The existing OPFS / showSaveFilePicker streaming paths
  already give us a local file at the right time.
- Clock sync via TimelineState `hostMono` piggyback +
  `RTCStatsReport.currentRoundTripTime`, median-of-9 offset; uses
  `AudioContext.currentTime` as the local monotonic clock.
- Drift watcher per the algorithm in section 3.3, driven by
  `requestVideoFrameCallback` where supported (with rAF fallback
  for Safari < 16.4).
- Lookahead-reservation pattern for play and seek: schedule
  `anchorMono = host_now + 500ms` so all peers hit the new state
  at the same wall-clock moment.
- `MediaSession` action handlers wired up.

### Slice 2: Group affordances (1 sprint)

- Per-peer ready / buffer / playhead-position dots on the seekbar,
  color-coded by drift magnitude.
- "Wait for everyone" toggle (default on for 3+ peers).
- Late-joiner UX: "join now at 1:23:45" or "restart for everyone".
- Reactions on the timeline.
- Subtitle drag-drop transferred via the existing file flow with a
  `kind: 'subtitle'` tag, attached as `<track>` on receivers.
- Chapter-marker-driven auto-pause when chapters are present.

### Slice 3: Polish and edge cases (smaller)

- Picture-in-Picture detach (Document PiP).
- Democratic mode toggle (anyone can pause). Same protocol; the UI
  changes plus a tiebreaker on TimelineState `seq` for converging
  near-simultaneous edits. Yjs (~7 KB minified) is a clean way to
  factor this if we anticipate adding more shared state later.
- Frame-accurate seek for short content using metadata from
  `requestVideoFrameCallback`.
- Audio-fingerprint cross-validation as a diagnostic ping (only
  fires when drift looks unstable; see section 5).
- OPFS-persisted watch state so a refresh / browser crash returns
  to the same timestamp.

## 7. Failure modes and how we'll diagnose them

- **Drift accumulates beyond 1s repeatedly**: layer 1 clock sync is
  failing. Most likely: high-jitter cellular RTT making the offset
  estimate unstable. Diagnostic: surface RTT P95 in the per-peer
  status. Mitigation: increase the rolling-median window from 9 to
  17 samples on noisy links.
- **Stale timeline (host disconnect or partition)**: follower has
  not seen a TimelineState message in N * poll_interval (e.g.
  10 s). Locally pause and surface a "host disconnected" overlay,
  showing the user the option to take over via a control-request.
  Without this, the drift loop keeps extrapolating forward from a
  stale anchor and the user watches their video continue while the
  rest of the room has paused.
- **Background tab throttling**: a follower whose tab is
  backgrounded gets `requestVideoFrameCallback` paused (browsers
  suspend rVFC when the document is hidden). When the tab returns
  to foreground, drift is huge; the watcher will hard-seek
  immediately. Acceptable, but surface visibly so the user
  understands the jump ("you were away; resyncing").
- **Audio glitches under rate-nudge**: should be inaudible at +/-
  5%; if reported, likely a Safari quirk on certain codecs.
  Mitigation: cap rate-nudge to +/- 3% on Safari. Manual feature
  flag.
- **Late joiner loops at 1s drift**: layer 3 hard-seeks every two
  seconds. Means the file isn't actually fully transferred yet.
  Diagnostic: the existing transfer-progress UI; gate watch-party
  start on `bytesTransferred === fileSize` per peer.
- **Codec rejection mid-session**: the pre-flight check above
  catches this at start; if a follower hot-joins after start they
  also run the check, and either join as a video peer or fall back
  to listen-only.
- **Host disconnects mid-movie**: pause everyone, surface a
  "promote next host" dialog that uses the same control-grant
  message from section 4. The protocol is symmetric; only the UI
  needs to know who the active host is.
- **Two peers think they're host (after a network partition healed)**:
  resolve via `seq` numbers in TimelineState; the highest `seq`
  wins, with peerId tiebreak (lowest peerId at equal `seq`). Pure
  last-write-wins is too aggressive in a partition; this gives a
  deterministic winner.

## 8. Concrete API surface

```ts
// New service: src/services/WatchPartyService.ts
export interface WatchPartyEvents {
  onSessionStart: (fileId: string, role: 'host' | 'follower') => void;
  onSessionEnd: () => void;
  onTimelineUpdate: (state: TimelineState) => void;
  onPeerStatus: (peerId: string, status: PeerWatchStatus) => void;
  onError: (err: Error) => void;
}

class WatchPartyService {
  // Host: pick a local file, share it via the existing transfer
  // service, and start a watch session once all accepting peers
  // have it.
  startAsHost(file: File): Promise<void>;
  // Follower: bind to whatever the room is currently watching.
  joinExisting(): void;
  // Stop the session for everyone (host) or just leave (follower).
  stop(): void;
  // Imperative timeline controls; effectively no-op on followers
  // unless democratic-mode is enabled.
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setPlaybackRate(rate: number): void;
  // Bind the receiver's video element to drive drift correction.
  attachVideoElement(el: HTMLVideoElement): () => void;
}
```

The receiver-side drift loop inside `attachVideoElement` is the
heart of the implementation. Pseudocode:

```ts
function tick(_now: number, frameMeta: VideoFrameCallbackMetadata) {
  // mediaTime is the rendered frame's currentTime; expectedDisplayTime
  // is the wall-clock time at which that frame will be shown. Both
  // are immune to rAF stutter and tab throttling in a way currentTime
  // is not.
  const expected = state.anchorTime
    + (hostNow() - state.anchorMono) / 1000
    * state.playbackRate;
  const drift = frameMeta.mediaTime - expected;
  if (Math.abs(drift) > 1) {
    el.currentTime = expected;
    el.playbackRate = state.playbackRate;
  } else if (Math.abs(drift) > 0.1) {
    el.playbackRate = state.playbackRate * (1 - 0.05 * Math.sign(drift));
  } else if (el.playbackRate !== state.playbackRate) {
    el.playbackRate = state.playbackRate;
  }
  if (state.playing && el.paused) {
    el.play().catch(/* render the click-to-enable-audio overlay */);
  }
  if (!state.playing && !el.paused) el.pause();
  el.requestVideoFrameCallback(tick);
}
el.requestVideoFrameCallback(tick);
```

Falls back to `requestAnimationFrame` on browsers that lack rVFC
(Safari < 16.4). The rVFC path is meaningfully better: rAF can drift
from video output by up to a frame, especially when the page is doing
other layout work. Same code shape either way; rVFC is preferred when
available.
