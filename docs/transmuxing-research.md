# Browser-side transmuxing for progressive playback

Status: **DEFERRED**. mp4box.js implementation built and shipped 2026-05-09; disabled the same day after dogfooding revealed an unfixable MSE interaction. Last updated 2026-05.

> **Current state in production:** `runHostPrep` is gated on
> `localStorage.sendie_wp_transmux=1`; off by default. Receivers
> get original (non-fragmented) mp4 bytes, wait for the full
> transfer, then play via direct `<video>` Blob URL. Reliable but
> not progressive. The autopsy below explains why we got here, and
> the alternatives section sketches paths that might actually work.

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

---

## Autopsy: what went wrong with the mp4box.js attempt (2026-05)

The implementation worked exactly as designed: host transmuxes plain
mp4 to fmp4 in memory, sends fmp4 bytes to receiver, receiver feeds
them through a `MediaSource`. Every visible piece of the pipeline
landed correctly. The receiver still couldn't play.

We shipped, dogfooded, and rolled back across roughly a dozen iterations.
This section catalogs every theory, every fix, and the actual outcome,
so a future engineer can avoid re-running the same experiments.

### The fundamental incompatibility we hit

**Fragmented mp4 (fmp4) is not playable via a direct `<video src=blob:...>` URL.**
It is only ingestible via the Media Source Extensions API (`MediaSource`
+ `SourceBuffer.appendBuffer`). This is by design: fmp4's container
structure (init segment + sequence of `moof`/`mdat` fragments) is what
MSE consumes, and `<video>` directly expects monolithic mp4.

Browsers correctly reject a direct fmp4 Blob URL with
`NotSupportedError: no supported source`. We confirmed this in Chrome
129 and Firefox 142.

**Why this matters:** Sendie's pipeline has two paths:

1. **Happy path (MSE):** receiver pipes fmp4 chunks into MSE.
2. **Fallback (Blob assembly):** if MSE fails, receiver concatenates all
   chunks into a Blob and binds it as `<video src=blob:...>`.

We always need both. With **plain mp4** input, both work: MSE rejects
plain mp4 (no `mvex`), but the Blob fallback plays it natively.

With **fmp4** input (after our transmux), the Blob fallback can't
play it, so we _must_ get MSE working. And MSE wasn't.

### What MSE was doing wrong

The receiver consistently saw:

```
[watch-party] receiver MSE check: streamable= true codec= ... MSE supported= true
[watch-party] SourceBuffer error; falling back to Blob. video.error: none
```

The `SourceBuffer.error` event fires with no detail, and `video.error`
is `null` at that moment because the error originated in the source
buffer's parser, not the media element. Chrome and Firefox both emit
this event with no diagnostic info exposed to JavaScript.

We tried, in order:

| # | Theory | Fix | Outcome |
|---|---|---|---|
| 1 | Codec mime had vendor `profiles="..."` param confusing addSourceBuffer | Strip to type+codecs only | Cleaner mime; SourceBuffer error still fired |
| 2 | `info.mime` codec doesn't match real moov | Synthesize from `info.tracks[i].codec` | Matches better, still fails |
| 3 | nbSamples=1000 produces 33s fragments; first fragment too big | Lower to nbSamples=60 | Still fails |
| 4 | Multiple init segments in output | Use only initSegs[0] | Still fails |
| 5 | `sb.mode = 'sequence'` conflicts with mp4box's tfdt | Remove, default to 'segments' | Still fails |
| 6 | Browser autoplay policy, NOT decoder | Add muted-fallback play() | Wasn't the bug |
| 7 | Listener attached after canplay fired | Synchronous readyState check | Wasn't the bug |
| 8 | Per-timeline play-kick belt-and-suspenders | Idempotent kick | Wasn't the bug |

### What we never tried that might have worked

We didn't reproduce the failure outside Sendie. The right next debug
step is a minimal HTML page that:

1. `fetch()`s the actual fmp4 bytes mp4box produced.
2. Feeds them to a fresh `MediaSource` with the sanitized codec mime.
3. Watches `SourceBuffer.error` and the parsed-but-rejected box logs
   in `chrome://media-internals/`.

`chrome://media-internals/` is the only way to get the real error from
the demuxer. The MSE spec deliberately doesn't surface decoder errors
to JS for security reasons (info leak about codec implementation).

We also never tried a different transmuxer. mp4box.js is the canonical
choice but not the only one (see alternatives below).

### Why we backed it out

The failure mode was strictly worse than not-transmuxing:

- **No transmux:** MSE rejects plain mp4 quickly, fall back to Blob,
  Blob plays. Latency to first frame = full transfer time. Reliable.
- **With transmux:** MSE accepts fmp4 init segment, fails partway in,
  falls back to Blob, Blob is fmp4 and won't play. Latency to first
  frame = infinite. **Broken.**

So we shipped a `localStorage.sendie_wp_transmux=1` flag (off by default)
that re-enables transmux for testing without further code changes, and
left the rest of the pipeline intact.

---

## Alternatives for future progressive-playback attempts

Now that we've proven the "transmux on host, MSE on receiver" path is
brittle, here are the realistic alternatives ranked by likelihood-of-
working-out:

### 1. Fix the existing MSE pipeline outside Sendie first

**Effort:** 1-2 days of focused debugging.
**Risk:** medium. We may discover mp4box's output is inherently
incompatible with Chromium's MSE in some way and pivot to a
different transmuxer.

Build a minimal repro page (no Sendie code, just `mp4box.js` ->
`MediaSource` in HTML) that reads any chosen mp4 and tries to play
it via MSE. Use `chrome://media-internals/` to capture the real
error. Likely culprits to investigate:

- mp4box defaults to `rapAlignement: true` but with `nbSamples: 60`,
  the alignment may not actually find a RAP for non-keyframe-frequent
  inputs. Try `rapAlignement: false` to confirm.
- mp4box's tfdt timestamps may not be monotonic across track
  fragmentation boundaries when audio and video have different sample
  durations.
- Some files have edit lists (`elst` in tkhd) that mp4box copies into
  the moov but MSE doesn't honor consistently.

Decision tree from minimal repro:
- Plays fine standalone -> Sendie integration is wrong (race? buffer
  size? wrong appendBuffer order?).
- Same SourceBuffer error standalone -> mp4box's output is wrong; pivot
  to alternative transmuxer.

### 2. Switch to mp4-muxer (or similar)

**Effort:** 2-3 days.
**Bundle:** ~40 KB gzipped (vs mp4box's 35 KB; comparable).

`mp4-muxer` is a newer pure-JS muxer, much smaller and simpler than
mp4box.js. It's primarily a muxer (write-only) so we'd combine it with
a small parser for the input. Or use `gpu-mp4` which is a complete
parse-and-mux library aimed at fmp4 specifically.

Other candidates worth surveying: `webm-muxer` (WebM only, but always
streamable), `fmp4-muxer`, the demux/mux pair from `shaka-player`.

### 3. WebCodecs + custom muxer

**Effort:** 1-2 weeks.
**Risk:** high. Edge cases (encrypted samples, edit lists, multi-track
sync) are real work to get right.

`VideoDecoder` + `VideoEncoder` are now stable in Chrome 117+ and
Firefox 130+. We could:

1. Demux the input mp4 ourselves with a small parser (mp4box's
   `ISOFile` is ~150 KB minified but pure-parse mode is much smaller).
2. Decode each sample to `VideoFrame` / `AudioData`.
3. Re-encode? Or pass-through with a hand-rolled fmp4 muxer?

The pass-through path is interesting because it avoids re-encode CPU
cost. Hand-rolling an fmp4 muxer is the part that's months of work.

Probably not worth doing; option 1 (debug the existing pipeline) or
option 4 (skip transmux entirely) are more pragmatic.

### 4. Skip transmux; use byte-range "P2P streaming" via Service Worker

**Effort:** 4-6 days.
**Risk:** medium-high. Service Worker glue is gnarly but well-trodden.

This is the approach we sketched in the original v2 doc and never
built. Recap:

- Host has the original mp4 file on disk.
- Receiver creates a `<video>` with `src` pointing to a synthetic
  URL handled by a Service Worker.
- When `<video>` issues range fetches against that URL (which it
  always does for native mp4 playback on Chromium), the Service
  Worker sends a `wp-range-request { start, end }` over the data
  channel to the host.
- Host slices the file (`File.slice(start, end).arrayBuffer()`) and
  sends the bytes back as `wp-range-response`.
- Service Worker fulfills the original fetch with those bytes.

Why this could work where mp4box failed: **the browser's own demuxer
parses the file**. If the browser would play the file from a normal
HTTP server, it will play it from us. We never touch the bytes
semantically. mp4 / mov / mkv / webm all just work.

Pros over transmux:
- No transmux step at all; works for any container the browser plays.
- Receivers can scrub independently (the browser fetches new ranges
  on seek; we forward those range requests).
- Caches naturally: the Service Worker `Cache` API stores chunks the
  receiver has already fetched, so re-watching scenes doesn't
  re-spend host bandwidth.

Cons:
- 5-receiver mesh = 5x the host bandwidth vs the current "send once"
  forward. Cache helps but doesn't eliminate.
- Latency on every seek: receiver issues a range request, waits for
  the round-trip. Could add 200-500 ms to scrubbing. Mitigation:
  receiver-side prefetch (request the next 10 MB ahead of playhead).
- Service Worker registration UX: requires the SW be registered
  before the first range request, which means a one-time cold-start
  cost.

The Service Worker side has precedent: StreamSaver does exactly this
(SW-as-fake-server) and we already vendor it.

### 5. Send the file twice: original + fmp4

**Effort:** ~2 days on top of #1 working.
**Risk:** low (pure plumbing).

Combination strategy: host sends the original mp4 (for the Blob
fallback) AND, in parallel, an fmp4 stream (for MSE progressive).
Receiver tries MSE; if it fails, the parallel original mp4 is already
landing and Blob fallback can play it.

Cost: doubles host upload bandwidth. Probably a non-starter for
bandwidth-conscious users but acceptable for short clips.

### 6. Pure server-side transmux (rejected, repeat for emphasis)

We documented this in the original research and rejected it. Now that
we've burned cycles on the client-side path, the temptation to
"just do it server-side" returns. Restate the rejections:

- Bytes flow through our server -> we stop being mesh-only.
- We hold the file on disk while transmuxing -> storage cost.
- Copyright targets us instead of the user.
- Bandwidth cost shifts from peers' uplink to our egress.

If we wanted streaming-service economics, we'd build a streaming
service. We don't. **Stays rejected.**

### 7. Don't ship progressive at all

**Effort:** zero (this is the current state).

The real question is: how often does a watch-party host pick a 1+ GB
file? The C1 wait-for-receipt path is honestly fine for files <200 MB
on a typical home uplink (8-30 seconds). If most usage is short clips,
progressive playback is a polish feature, not a core one.

We could just leave it disabled, document the file-size sweet spot
in the UI, and move on.

---

## Recommendation

The immediate-future path that's most likely to pay off:

1. Spend a day on a minimal-repro HTML page reproducing the
   SourceBuffer error outside Sendie. Use `chrome://media-internals/`
   to get the real error. (Option 1 above.)
2. If mp4box's output is the problem, evaluate `mp4-muxer` or a thin
   custom shim. (Option 2.)
3. If MSE itself is the problem (e.g. some Chromium quirk), seriously
   consider Option 4 (Service Worker byte-range proxy) as a more
   robust path that avoids the entire MSE pipeline.

The user-perceived improvement from "wait 30 s for full transfer"
to "play in 2 s" is real, but not worth shipping a broken receiver
to chase. Stay disabled until one of the above paths produces
something that actually plays in dogfooding.

---

## Autopsy 2: the Service Worker byte-range proxy attempt (2026-05-10)

After the mp4box.js MSE attempt was rolled back, we tried option 4
from the alternatives section: instead of MSE, use a Service Worker
to back a synthetic `/wp-stream/<sessionId>` URL that the receiver's
`<video>` would fetch via byte-range requests. The SW would proxy
those range requests over the data channel to the host, host slices
the file, returns bytes, SW fulfills the original fetch.

Architecturally this should have worked: the browser's native
demuxer parses the file (any container `<video>` plays directly),
no MSE involvement, no transmux needed.

It didn't work either. Catalog of what we hit:

### Issue 1: Service Worker scope mismatch

Our first attempt registered the SW at `/wp-stream/sw.js` with
scope `/wp-stream/`. The page lives at `/multipeer/<id>`. The SW
only intercepts fetches initiated by clients **within its scope**;
since the page is out of scope, the SW's `fetch` handler never
ran. The `/wp-stream/<id>` request went straight to nginx, hit
`try_files $uri $uri/ /index.html`, and the SPA's index.html came
back as the response. `<video>` got HTML, threw "no supported
sources".

**Fix attempted:** moved SW to `/wp-stream-sw.js` with scope `/`.
That part worked: SW would now be in scope to intercept any
`/wp-stream/*` fetch from any page on the origin.

### Issue 2: clients API can't reach a page that isn't controlled

Even with the wider scope, the SW's `clients.get(clientId)` could
return null if the page registered the SW and immediately tried to
register a session before the SW had actually claimed control of
the page. `controllerchange` would fire eventually, but on the
first session-register we sometimes lost the round-trip.

**Fix attempted:** switched from `clients` API to private
`MessageChannel`. Page sends one `MessagePort` to the SW with the
`register-session` message. SW posts range-requests on the port;
page replies on the port. Independent of scope and controlling
state.

### Issue 3 (still unsolved): the receiver still doesn't play

Even after both scope and channel fixes, dogfooding showed:

- `<video>` fires `play()` "no supported sources" repeatedly.
- Receiver shows "0% of the file delivered" indefinitely.
- Host doesn't get any indication the receiver is connected.
- Console doesn't surface a SW fetch interception, suggesting
  the SW isn't actually running or its fetch handler isn't
  installed for this scope.

We didn't fully root-cause this before deciding to roll back. Likely
suspects:

1. **`controllerchange` race vs initial session registration.** The
   SW takes time to activate after first install (`waiting` →
   `installing` → `activated`). Our code waits for `activated` but
   not for the page itself to be controlled, and posts to the SW
   before `clients.matchAll()` would find the page. With the
   MessageChannel approach this should still work because we transfer
   the port directly... unless the SW garbage-collected the port
   when no one is referencing it from the SW side (it's stored in
   the `sessions` Map but if the SW shuts down between activation
   and the next fetch, the Map is gone).
2. **SW lifetime.** Service workers are aggressively unloaded by
   browsers when idle. If the SW gets shut down between
   register-session and the first fetch, our session Map is lost
   and the fetch returns 404 "no such session". The fix is some
   keepalive (post a heartbeat from the page periodically while a
   session is live), but we didn't try it.
3. **SW hard-refresh quirks.** Chrome sometimes serves a stale SW
   on hard-refresh; the user may have been hitting an old version
   that didn't have our latest fix. We didn't make the user
   manually unregister the old SW between attempts.

Each of these is fixable. None was fixed in this round.

### What worked

Mode C1 (chunked-forward, plain mp4 Blob URL) is rock-solid. We've
been running on it the whole time. The user pays a "wait for full
transfer" penalty (1-3 minutes for typical 30-100 MB clips on a
home uplink) but then gets reliable playback that scrubs cleanly,
mutes/unmutes correctly, and plays in any browser that handles
the file natively.

### Recommendation revised

The progressive-playback feature is harder to build correctly than
to enumerate the architectural options would suggest. We've now
spent multiple days across two distinct approaches (mp4box+MSE,
and SW byte-range proxy) and shipped neither. Each had a different
class of subtle browser quirk we didn't fully chart.

**Backout decision (2026-05-10):** revert both the mp4box and the
SW proxy code. Keep the working chunked-forward path. Document
both failed attempts here so the next attempt has a complete map
of the terrain.

When we come back to this:

1. **Build a minimal repro outside Sendie first.** Both attempts
   were debugged inside the full app where the failure mode
   ("video doesn't play") had too many possible causes.
2. **Test with `chrome://media-internals/`** for MSE attempts;
   `chrome://serviceworker-internals/` for SW attempts. These give
   actual error info that JavaScript can't see.
3. **Be willing to spend a full day instrumenting the Service
   Worker lifecycle** before declaring it works. Logs in `install`,
   `activate`, every `fetch`, every `message`, every port message.
   Verify the SW is actually receiving and responding to the
   `<video>` fetch.
4. **Test without the rest of Sendie.** A standalone HTML page
   that creates a File from a hardcoded path and binds a SW URL is
   the right test bench. If that doesn't work, nothing will.
5. **Consider just shipping "wait then play."** The C1 path is
   honestly fine for files under ~200 MB. We could add an ETA
   indicator and a "skip to file save" button for big files and
   call it done.

The Service Worker approach is still architecturally cleaner than
MSE and has my (the agent's) recommendation **after** a proper
minimal-repro. But "I haven't verified the SW is firing at all"
is the wrong place to start a feature.

### Code that was reverted

- `client/public/wp-stream-sw.js` (deleted)
- `client/src/services/watchPartyStreamProxy.ts` (deleted)
- `WatchPartyService.ts` reverted to the b2bc81d state
  (sendie_wp_transmux=0 default, no byte-stream code path,
  classic chunked forward as the only forward mode).
- `types/index.ts` reverted (no wp-bytes-* messages).

The mp4box.js dependency stays in package.json since the dynamic
import path remains in the file (gated behind localStorage flag);
removing it is a separate cleanup that can wait.
