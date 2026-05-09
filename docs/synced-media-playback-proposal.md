# Synced media playback ("watch party") for Sendie

Status: proposal, not yet implemented. Targets Sendie's existing P2P
mesh (2 to 8 peers, no SFU, no server-side state). Last updated
2026-05.

## 1. The problem, sized correctly

The user-visible feature: "we drag a movie file into Sendie and we
all watch it together at the same timestamp, with synced play, pause,
seek, and (eventually) chapter / track changes."

The hidden hard parts:

- **Clock skew between peers.** Two browsers' `performance.now()`
  values drift relative to each other by milliseconds per minute; over
  a 2 hour movie the worst case is seconds without correction.
- **Network latency, asymmetric.** RTT to your closest peer is
  rarely the same as RTT to your farthest peer in a 4 to 8 way mesh.
  A naive "play at this wall clock" command leaves the farthest peer
  behind from the moment they hit play.
- **Browser playback granularity.** `currentTime` reads and writes
  are usually accurate to a frame (33 ms at 30 fps); seeks are not
  instant; `playbackRate` adjustments take effect over hundreds of
  ms.
- **Buffering pauses.** One peer's cellular hiccup will pause their
  video; the others should NOT keep going if we want true sync.
- **Different bytes, same timestamp.** Each peer has the file
  locally (we already transfer files); they don't need to stream it.
  This is a substantial simplification over Disney+ Watch Party,
  Netflix Party, Twitch Watch Together, etc., all of which fight
  CDN-induced asymmetric buffering.

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
- Subtitle / track selection sync. Possible v2 once the basic
  timeline sync is solid.
- Rebroadcasting one peer's decoded video to others (would defeat
  the "everyone has the file" optimization).

## 3. The sync algorithm

Three layers, each with concrete tradeoffs.

### 3.1 Layer 1: Clock sync (peer-to-peer NTP-like exchange)

Sendie has no central time source. The simplest workable model is
**pairwise Cristian's algorithm** between the host and each follower
on the existing data channel:

```
Host                         Follower
  |  --- t1 (host monotonic) ---->  |
  |                                 |
  |  <--- t1, t2 (follower mono)--- |
  |                                 |
  | t3 = host now                   |
  |                                 |
```

The follower's offset relative to the host is approximately:
`offset = ((t2 - t1) + (t2 - t3)) / 2 = t2 - (t1 + t3) / 2`,
assuming symmetric RTT. Run this every 2 to 5 seconds over the
voice / chat data channel (low-volume keepalive traffic), keep a
rolling median of the last N samples to reject outliers.

**Tensions:**

- Cristian's algorithm is best for **low-jitter** networks (i.e. the
  RTT split is roughly even). On a flaky cellular link it produces
  bad samples; the median across multiple rounds rescues us.
- Full NTPv4 (Marzullo / Byzantine agreement, falseticker rejection)
  is overkill for a small mesh and would require multiple time
  sources. We have one source: the host. If the host's clock is bad,
  every follower is bad. Acceptable: the host is the same person who
  picked the movie.
- Resolution: tens of milliseconds, easily achievable in the
  browser. Anything tighter is wasted; `currentTime` writes can't
  use it.

**Recommended:** plain Cristian's between host and each follower,
median-of-9 rolling samples, 2-second poll interval. About 60 bytes
per round, negligible.

### 3.2 Layer 2: Transport — what we send

The host periodically broadcasts a **timeline state** message:

```ts
type TimelineState = {
  type: 'timeline';
  // Sequence number for last-write-wins on reorder.
  seq: number;
  // Logical play state.
  playing: boolean;
  // The host's currentTime at the host's monotonic time anchor.
  // Followers compute their own currentTime = anchorTime +
  // (now - anchorMono) * playbackRate when playing===true.
  anchorMono: number;     // host monotonic ms
  anchorTime: number;     // media currentTime in seconds
  playbackRate: number;   // usually 1.0; allow 0.5 / 1.25 / 1.5 / 2
  // Identity tracking: which file are we playing? File id from the
  // transfer service. A follower without this file ignores the
  // message and shows "not playing".
  fileId: string;
  // Optional: which peer is currently authoritative. Lets followers
  // detect a botched takeover.
  hostPeerId: string;
};
```

Key design decisions, contrasted:

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| Send `currentTime + wall clock` per tick | Simple, "just works" | Ignores playback-rate changes, drifts under variable RTT | Insufficient |
| Send `anchorTime + anchorMono`, follower computes drift | Correct under play / pause / rate change, robust to message loss | Requires layer 1 clock sync | **Pick this** |
| Send seek-target + go-when ready | Twitch model. Wait for all peers | Adds latency, but matches "watch party" intuition | Use as *augmentation*, not core |
| Stream encoded frames to followers (one-encode many-decode) | True frame-perfect sync | Defeats "everyone has the file" optimization; massive bandwidth | Skip |

The chosen primitive (anchorMono + anchorTime + playbackRate) maps
directly onto how DASH/HLS LL clients model live edge offset, and
is the same pattern Syncplay uses internally.

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

- **|drift| < 100 ms**: do nothing. Within human perception slack
  for non-musical content; correcting more aggressively causes
  visible playback rate wobble.
- **100 ms <= |drift| < 1 s**: nudge `playbackRate` up or down by
  ~5% for a couple of seconds. The browser resamples audio
  transparently (on every browser since 2018). This is what every
  serious watch-party player does (Plex, Jellyfin, Kodi, Syncplay).
- **|drift| >= 1 s**: hard `currentTime = expected` seek. Visible
  jump but unavoidable. Also runs on initial join, after pause /
  resume, and after seek commands from the host.

**Tension:** rate-nudging vs hard seek. Aggressive rate nudges keep
audio continuous but require careful hysteresis (don't oscillate);
aggressive hard seeks are more "correct" but jolt the user. Plex's
defaults (used in their Watch Together feature) are 50ms / 1s, very
similar. Defaulting to 100 ms / 1 s thresholds gives Sendie's
voice-overlay use case a little more slack so quick comments don't
trigger a re-sync.

## 4. Protocol shape (what messages flow when)

Three message types over the existing data channel:

```ts
type WatchPartyMessage =
  // Periodic broadcast from the active host. Sent every 2s during
  // playback, immediately on play / pause / seek / rate change, and
  // once on join.
  | TimelineState
  // Cristian's exchange.
  | { type: 'time-ping'; t1: number }
  | { type: 'time-pong'; t1: number; t2: number }
  // Follower -> host: 'I'm buffering, expected to resume by ~T'.
  // Host can choose to pause for everyone (default) or ignore.
  | { type: 'buffer-stall'; peerId: string; expectedResumeMono?: number }
  // Follower -> host: 'I want control'. Host ack'd or denied.
  // Mirrors the existing host-only-sending toggle.
  | { type: 'control-request'; peerId: string }
  | { type: 'control-grant'; peerId: string };
```

Volume: the `time-ping`/`time-pong` is the chatty one, ~30 messages
per minute per follower pair. At ~80 bytes each that's <30 KB/min
across an 8-peer mesh. Negligible against the existing voice and
file traffic.

## 5. Sources, alternatives, and what was rejected

### Existing-art comparison

| System | Sync mechanism | Distribution | Why we don't copy directly |
|---|---|---|---|
| **Syncplay** | TCP relay, server retains state, "wait for everyone" pause | Out of band — every viewer has the file already | Closest match. We replace the relay with mesh data channels. |
| **Plex Watch Together** | One server-side timeline, clients poll; 50 ms tolerance, rate-nudge then hard-seek | Plex server streams to clients | Sync algorithm is exactly what we want. Distribution model is server-mediated. |
| **Discord Watch Together** | Discord's stage server tracks timeline; clients receive YouTube embed control commands | YouTube CDN | Adds a host-side activity service we don't have. |
| **Twitch Watch Parties** | Twitch's amazon-prime-only with server-mediated state + pause-for-all | Centralized streaming | No applicability. |
| **Disney+ GroupWatch** | Custom Akamai-side timeline service | Their CDN | No applicability. |
| **Netflix Party / Teleparty** | Browser extension, polls each tab's `<video>` element, broadcasts via Firebase | Each viewer streams from Netflix | Closest commercial analog to "everyone has the bytes already". Uses server-relayed messages. |

The Syncplay paper and the Plex blog post on Watch Together are the
two best primary references. Both arrive at the same shape of
algorithm we're proposing, independently.

### Recent (2024 to 2026) research worth knowing

- **WebRTC Insertable Streams + frame-accurate timestamps**: a
  receiver-side clock recovery using RTP frame timestamps can sync
  to ~1 frame, but requires the host to actively encode-and-stream
  the video to followers. Defeats our "use the file you have"
  win; mentioned for completeness, rejected.
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
  live. Borrowed from the cursor overlay in
  [screen-sharing-proposal.md](screen-sharing-proposal.md).
  Bandwidth: same as voice cursor (~50 bytes/peer/sec). Reveals
  drift visually so users self-correct ("hey, I'll wait").
- **Together-since-the-start join semantics**. When a late joiner
  arrives mid-movie, default behavior is "join at room's
  currentTime, but offer a 'restart for everyone' button". The
  alternative — making the late joiner start at zero alone — is
  what Netflix Party defaults to, and it always feels wrong.
- **Subtitle BYO**: each peer can drop their own .vtt or .srt file,
  rendered locally on their video. No bandwidth cost; sidesteps
  the awkward "we have the movie but not subtitles in your
  language" problem.
- **Picture-in-Picture detach**. The `<video>` element supports the
  Document Picture-in-Picture API; let a peer pop the watch tile
  out of the Sendie tab so they can use other apps. Existing
  primitive, single button.

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

## 6. Implementation plan

Three vertical slices, each independently shippable.

### Slice 1: Sender-and-receiver wiring (1 sprint)

- New `WatchPartyService.ts` with the protocol from section 4.
- `useFile(file: File)` from the host: stores the file URL, sends
  the timeline initial state, and waits for at least one
  acknowledged peer.
- `<video src=...>` rendered receiver-side once a `file-end` for
  the named `fileId` lands AND a `timeline` message has been
  received. The existing OPFS / showSaveFilePicker streaming paths
  already give us a local file at the right time.
- Cristian's clock sync over the existing data channel.
- Drift watcher per the algorithm in section 3.3.
- `MediaSession` action handlers wired up.

### Slice 2: Group affordances (1 sprint)

- Per-peer ready / buffer / playhead-position dots on the seekbar.
- "Wait for everyone" toggle (default on for 3+ peers).
- Late-joiner UX: "join now at 1:23:45" or "restart for everyone".
- Reactions on the timeline.

### Slice 3: Polish and edge cases (smaller)

- Picture-in-Picture detach.
- Local-subtitles (.vtt / .srt drop).
- Democratic mode toggle (anyone can pause).
- Frame-accurate seek for short content via `requestVideoFrameCallback`
  on browsers that support it.

## 7. Failure modes and how we'll diagnose them

- **Drift accumulates beyond 1s repeatedly**: layer 1 clock sync is
  failing. Most likely: high-jitter cellular RTT making Cristian's
  estimate unstable. Diagnostic: surface RTT P95 in the per-peer
  status. Mitigation: increase the rolling-median window from 9 to
  17 samples on noisy links.
- **Audio glitches under rate-nudge**: should be inaudible at +/-
  5%; if reported, likely a Safari quirk on certain codecs.
  Mitigation: cap rate-nudge to +/- 3% on Safari. Manual feature
  flag.
- **Late joiner loops at 1s drift**: layer 3 hard-seeks every two
  seconds. Means the file isn't actually fully transferred yet.
  Diagnostic: the existing transfer-progress UI; gate watch-party
  start on `bytesTransferred === fileSize` per peer.
- **Host disconnects mid-movie**: pause everyone, surface a
  "promote next host" dialog that uses the same control-grant
  message from section 4. The protocol is symmetric; only the UI
  needs to know who the active host is.
- **Two peers think they're host (after a network partition healed)**:
  resolve via `seq` numbers in TimelineState; the lowest peerId at
  highest `seq` wins. Pure last-write-wins is too aggressive in a
  partition; this gives a deterministic winner.

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
function tick() {
  const expected = state.anchorTime
    + (hostNow() - state.anchorMono) / 1000
    * state.playbackRate;
  const drift = el.currentTime - expected;
  if (Math.abs(drift) > 1) {
    el.currentTime = expected;
    el.playbackRate = state.playbackRate;
  } else if (Math.abs(drift) > 0.1) {
    el.playbackRate = state.playbackRate * (1 - 0.05 * Math.sign(drift));
  } else {
    el.playbackRate = state.playbackRate;
  }
  if (state.playing && el.paused) el.play().catch(/* autoplay overlay */);
  if (!state.playing && !el.paused) el.pause();
  requestAnimationFrame(tick);
}
```

That's roughly 30 lines of TypeScript, calling into the messaging
and clock-sync primitives. The hard part isn't the code; it's the
protocol design above and the UX decisions about what to default.
