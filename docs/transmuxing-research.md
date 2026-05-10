# Browser-side transmuxing for progressive playback

Status: research. Last updated 2026-05.

## The question

Mode C / forward sends file bytes from host to receiver and the receiver
plays them. Today the receiver must wait for the full transfer
(variant C1) before starting playback. Variant C2 (MSE-based
progressive playback) ships, but only for fragmented mp4 (fmp4 / CMAF)
and WebM — which is approximately *zero percent* of the files real
users have on disk.

The dominant case is regular ("plain") mp4 from a phone, OBS, ffmpeg's
default output, Premiere, DaVinci Resolve, Camtasia. These have
`moov`-at-front (faststart) but ARE NOT MSE-compatible: their `mdat`
is one giant box, not split into per-fragment `moof+mdat` pairs, so
`SourceBuffer.appendBuffer` rejects arbitrary slices of it.

So: can we transmux plain mp4 to fmp4 in the browser, on the host,
fast enough to feel like real progressive playback? And what are the
alternatives?

## TL;DR recommendation

Yes, browser-side transmuxing with **mp4box.js** is realistic and a
clear win for files under ~2 GB. Add it as an opt-in host-side
preflight pass:

- Bundle cost: ~340 KB gzipped, dynamically imported only when
  needed (not on idle / non-watch-party paths).
- Time cost on host: ~5 to 30 seconds of CPU on first
  transmux per file, depending on size. Subsequent watches of the
  same file get cached in memory.
- Quality cost: zero. Transmuxing copies samples bit-for-bit
  into a different container; no re-encode, no quality loss.
- Memory cost: high. mp4box.js holds the full input + output in
  memory (it's not streaming-capable in the way we'd want).
  This is the binding constraint.

The win is huge: 2 GB movie goes from ~6 minutes of "loading
0/100%" to 5-30 seconds of "transmuxing" + immediate playback.

There's a creative alternative worth considering: **don't transmux
at all, send-with-byte-ranges**. Sketched below.

## The transmuxing landscape

### mp4box.js (GPAC project)

The canonical tool. Mature, well-maintained C codebase compiled to
WebAssembly; same library used by `dashif.js` and many media-research
projects.

- **What it does for us:** parse plain mp4 headers, rewrite into fmp4
  with `mvex` declarations and `moof`/`mdat` fragments. The sample
  data isn't re-encoded, just rearranged.
- **API:** `mp4box.MP4File` is callback-driven. You feed it chunks
  via `appendBuffer(arrayBuffer, isLast)`, register callbacks for
  `onReady` (gives you tracks + codec strings), `onSegment` (gives
  you fmp4 fragments to forward), `onError`.
- **Bundle:** ~1.4 MB minified, ~340 KB gzipped. Dynamic-import only
  when watch-party starts in forward mode. Idle Sendie cost: 0.
- **Browser support:** anywhere with WebAssembly + `MediaSource`
  (i.e. everywhere we already target).
- **Speed:** I'm not aware of a published benchmark for the
  remux-only path (vs full demux/parse), but the workload is
  cache-friendly: read a header, copy sample data verbatim into a
  new container. Empirically users report ~50-200 MB/s on modern
  laptops for similar tools (mux.js, FFmpeg.wasm in copy mode).
- **Memory:** mp4box.js v0.5+ supports incremental parsing, but
  the `onSegment` flow still holds growing buffers if you don't
  drain them fast. Realistic budget: 2x the source file size in
  RAM during the transmux. On a 2 GB file that's 4 GB which
  ChromeOS / iPad Safari will refuse.
- **License:** LGPL. Bundling is fine for client-side JS (no
  static linking issue), but worth noting.

### mux.js (Brightcove)

Originally part of `videojs-contrib-hls`. Pure JavaScript, no WASM.

- Smaller bundle (~80 KB gzipped) but **only handles MPEG-2 TS
  -> fmp4**, not mp4 -> fmp4. We'd need an additional step
  (TS demux first), which we don't have a source for here.
  Disqualified for our use case.

### FFmpeg.wasm

The full FFmpeg compiled to WASM.

- **What it does:** literally everything. Including the
  `ffmpeg -i in.mp4 -c copy -movflags +faststart+frag_keyframe+empty_moov out.mp4`
  command we want.
- **Bundle:** ~30 MB compressed for the full build, ~12 MB for
  the "core" build. Way too big.
- **Memory:** Same growing-buffer issue as mp4box.js but worse
  because the FFmpeg architecture wasn't designed for streaming
  in/out of WASM memory. Multi-gigabyte transmuxes regularly OOM.
- **Verdict:** great for one-off conversions, unfit for "every
  watch party host pays a 12 MB bundle cost." Reject.

### WebCodecs + custom muxer

The DIY path. `VideoDecoder` / `VideoEncoder` are stable in Chrome
117+ and Firefox 130+; Safari 17.4 ships them. We'd:

1. Demux the source mp4 with a small parser (~30 KB; could write or
   take from mp4box).
2. Repackage samples into fmp4 ourselves with a hand-rolled
   muxer (~50 KB).

- **Pros:** full control, smallest bundle, no WASM at all.
- **Cons:** writing a correct fmp4 muxer is months of work. Edge
  cases: encrypted samples (cenc), edit-list `elst` boxes that
  have to round-trip, multiple-track sync, various CFF/CMAF
  flavors. mp4box.js encodes 15+ years of these in 1.4 MB. Not
  realistic to reinvent.

### Server-side transmuxing

Have the signaling server transmux mp4 -> fmp4 on demand.

- **Pros:** offloaded from host. One-time CPU per unique file.
- **Cons:** breaks Sendie's promise. Bytes flow through our
  server, we hold the whole file in memory or on disk while
  transmuxing, we become a streaming service with bandwidth
  costs and a copyright-infringement target. **Hard reject.**

## Recommended: mp4box.js, opt-in, dynamic-imported

**Architecture sketch:**

```
Host: clicks "Watch together" -> picks file
  |
  v
[preflight on host]
  read first 64 KB
  isStreamableContainer(head) ?
   yes (webm or fmp4) -> wire to file forwarder as-is
   no                  -> transmuxRequired = true
  |
  v
if transmuxRequired:
  show "Preparing for streaming..." progress bar
  dynamic-import mp4box.js (~340 KB gzipped, one-time)
  feed full file through MP4Box
  collect onSegment outputs into a new Blob
  swap that Blob into the forward source
  |
  v
[normal forward + receiver MSE path, unchanged]
```

The receiver path stays exactly as it is now. The change is purely
on the host.

**Failure modes and how we handle them:**

- **Out of memory on host.** mp4box.js holds ~2x the file size in
  RAM. We add a soft cap: files > 1.5 GB skip transmux and fall
  back to C1 with an explanatory toast on the host: "This file is
  too large for browser-side preparation. Viewers will start
  watching once the full transfer finishes."

- **mp4box errors (corrupt input, exotic container).** We catch
  and fall back to C1 with the same toast.

- **User cancels during transmux.** A "Skip preparation" button
  next to the progress bar. Drops to C1.

- **Transmux is slower than the network.** If the host's CPU is
  weak and their uplink is fast, they might finish transmuxing
  AFTER the receiver could have finished receiving the original
  bytes. We'd spend host CPU for nothing. Heuristic: skip
  transmux if the file is small (< 200 MB) since C1 finishes in
  seconds anyway.

**Caching:** transmuxed output cached in memory for the
session under the same fingerprint we use for F-resume
(`SHA-256(name + size)`). Re-watching the same file in the same
session doesn't re-transmux. We could also persist to OPFS but
that's more work and bytes are sensitive.

## A creative alternative: fragmented sender, byte-range receiver

The simplest progressive scheme isn't actually fmp4 + MSE. It's
"give the receiver a Blob URL with a `Range` server behind it."

This is impossible for us as written (no server, just data channels)
but there's a clever twist: the host can act as a byte-range *peer*
over the data channel. The receiver creates a `MediaSource` (or even
just a `Blob` proxy via a Service Worker) that satisfies range
requests by asking the host for the needed bytes.

- Receiver's `<video>` does standard byte-range seeking against the
  Blob URL.
- Each range request is forwarded as a `wp-range-request` message
  to the host.
- Host slices the file (with `File.slice(start, end).arrayBuffer()`)
  and sends back via `wp-range-response`.

This works on any mp4 the browser would normally play directly,
including non-fragmented ones, because the browser's own demuxer
handles the byte-range fetching it would otherwise do over HTTP.

**Trade-offs:**

- **Pros:** zero transmuxing, zero bundle bloat, supports
  arbitrary mp4 / mov / mkv / anything the browser plays
  directly. Receivers seek on their own without bothering the
  host's timeline (in pause-and-think situations). Massively
  simpler code.

- **Cons:** Service Worker required to back the URL with
  range responses. We already use a Service Worker for
  StreamSaver fallback so the infrastructure exists. Receiver
  fetches are interactive (browser asks for ranges as it
  decodes) so latency matters: a CPU-pegged host translates to
  receiver buffering. And every receiver re-fetches the same
  bytes, so a 5-peer mesh quintuples host bandwidth vs C1.
  Mitigation: receivers cache aggressively (browser does this
  for free via the Service Worker cache) and the cache survives
  scrubbing.

This is genuinely interesting and might be the right long-term
direction. Build complexity is mid (the Service Worker glue is the
gnarly bit) but the API surface to the receiver `<video>` is
trivial: a single object URL.

We do not recommend building this for v2. It's a v3 candidate if
fmp4 transmux turns out to have OOM issues we can't mitigate.

## Decision

**Build mp4box.js-based transmux as an opt-in host-side preflight.**

- Dynamic-import gates the cost to "users who actually watch-party."
- Soft-cap at 1.5 GB to dodge OOM on weak hardware.
- Skip transmux for files under 200 MB (C1 is fast enough).
- Cache transmuxed output by `SHA-256(name+size)` for the session.
- Falls back cleanly to C1 on any error; no regression risk.

If users complain about the 1.5 GB ceiling, evaluate the byte-range
peer alternative as a v3 project.

Estimated effort: 2-3 days for the integration including UI for
the prep progress bar and end-to-end testing on a typical phone
mp4, an OBS recording, and an old-encoder mp4 with `moov`-at-end.
