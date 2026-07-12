# Sendie product and architecture review

**Date:** 2026-07-11
**Scope:** Product purpose, user experience, browser client, signaling server,
security and privacy model, deployment, tests, maintenance, and feature direction.
**Method:** Read the live code and current docs, ran the repository preflight,
checked dependency advisories, and compared browser assumptions with current
WebRTC and browser-platform documentation.

## Decisions used in this review

The following product decisions came from the maintainer during this review:

| Question | Decision |
|---|---|
| Product north star | Ephemeral collaboration rooms |
| Distribution model | Self-hosted distribution |
| SAS policy | Low-friction default plus an optional strict mode |

Those decisions matter. A personal, file-transfer-only deployment could accept
several of the current constraints. A self-hosted private-room product needs a
clear room model, portable setup, predictable cross-network connectivity, and
one trust policy shared by every feature.

## Implementation follow-up

**Updated:** 2026-07-11, after the first remediation pass.

Resolved in this pass:

- Production camera and microphone permissions now allow the Sendie origin,
  with a preflight regression check.
- Incoming files require consent by default.
- Watch-party forwarding now requires a verified sender, validates host and
  room policy, prompts before bytes are sent, validates bounded ordered chunks,
  streams large media into OPFS, caps the memory fallback, and reports receiver
  readiness. It remains a separate byte engine; unifying it with normal file
  transfer is still the cleaner long-term architecture.
- Room event subscriptions use owned disposer functions, so leaving one room
  no longer removes singleton service listeners.
- SignalR reconnect now rejoins idempotently, reconciles the roster, refreshes
  host/capacity/policy state, and broadcasts host connection changes.
- Mixed one-time and retained-file queues have explicit clear operations and
  regression tests.
- The server and client now use the same default room capacity of 10 and the
  server returns the authoritative value on join.
- Forwarded headers trust only configured proxy networks or addresses.
- Node 24 and .NET 10 LTS now drive local docs, package metadata, Docker images,
  server packages, and the VS Code launch path.
- npm production advisories were cleared, coverage tooling and thresholds were
  restored, ESLint 9 was configured, CI was added, and Dependabot was enabled.

Still open from this review: TURN and portable self-host packaging, generic
OIDC, channel-bound versus human-confirmed SAS states, control/bulk channel
separation, a versioned capability handshake, resumable transfers, explicit
recipients, invite rotation, and real multi-browser end-to-end tests.

## Executive assessment

Sendie has a better technical core than its surface roughness suggests. The
join secret is handled carefully, the bound-SAS exchange is tied to DTLS
fingerprints, normal file transfer has per-peer flow control and multiple
disk-backed receive paths, and prior security reviews led to real fixes rather
than cosmetic changes. The repository also has unusually candid design notes
about failed watch-party approaches.

The main weakness is architectural consistency. Sendie began as a file-transfer
application, then voice, camera, screen sharing, chat, session controls, and
watch parties were attached to the same mesh. The original file path gained
verification, consent, host-role checks, limits, and cleanup. Newer payload
paths did not always inherit those controls. The same pattern appears in the UI,
protocol, lifecycle, docs, and deployment: each works locally, but the combined
product does not yet have one room-level contract.

My overall recommendation is:

> Treat Sendie as a private ephemeral room with file transfer as its strongest
> tool. Stop adding panels for now. Build a shared room protocol, shared inbound
> policy, reliable reconnect story, and a portable self-host package. Then add
> recipient control, resumable delivery, and capability-aware UX.

### Highest-priority findings

| Priority | Finding | Why it matters |
|---|---|---|
| P0 | Production headers disable camera and microphone | Advertised media features can work in Vite development and fail in the shipped nginx image. |
| P0 | Watch-party forwarding bypasses file receive policy | An unverified peer can claim to be host, force a watch-party receive, and consume unbounded memory. |
| P0 | `autoReceive` says default off but is set to true | The running app violates the threat model's explicit-consent promise. |
| P0 | Automated SAS success is called `verified` before users compare codes | Queued files can leave before the human step that detects a hostile signaling server. |
| P0 | Docs promise TURN fallback, but production returns STUN only | A meaningful share of cross-network connections will fail on restrictive NATs and firewalls. |
| P1 | Leaving one room removes singleton service listeners | A second room in the same SPA lifetime loses camera, screen, watch-party, voice, or chat lifecycle behavior. |
| P1 | Host identity and SignalR reconnect state go stale | Host-only enforcement and room membership can break after host or signaling reconnects. |
| P1 | Queue actions can erase the wrong class of files | Clearing or dispatching one-time files can also delete broadcast files. |
| P1 | Server caps new rooms at 5 while the UI reports 10 | The room appears to have space after the server starts rejecting joins. |
| P1 | The self-host story is Azure- and Discord-specific | There is no Compose package, bundled TURN, generic auth, or portable configuration despite self-hosting claims. |

## What Sendie is today

The live product is an authenticated host creating a capability-link room. A
guest with the path and fragment secret joins anonymously. SignalR exchanges
room membership, SDP, and ICE candidates. Every pair of guests then gets a
WebRTC connection. Files and application messages use data channels; voice,
camera, and screen sharing use WebRTC media tracks.

This gives Sendie a useful product shape:

- The signaling server does not receive file contents, chat bodies, media, or
  watch-party bytes.
- Guests do not need accounts.
- The room link is a capability, with a secret in the fragment so link-preview
  fetchers and HTTP logs do not receive it.
- A full mesh keeps content paths peer-to-peer and avoids an SFU trust and
  operations burden for small rooms.
- The host has room-level controls while guests can communicate directly.

The home screen still says "Secure P2P File Transfer" in
[HomePage.tsx](../client/src/pages/HomePage.tsx), while the room exposes live
audio, camera, screen sharing, chat, watch parties, queues, and host controls in
[MultiPeerSessionPage.tsx](../client/src/pages/MultiPeerSessionPage.tsx). The
implementation has already become a room product. The information architecture
and language have not caught up.

## P0 findings

### P0.1 Production nginx forbids camera and microphone [resolved]

[client/nginx.conf](../client/nginx.conf) sends this policy on the SPA and its
static assets:

```text
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
```

`camera=()` and `microphone=()` mean no origin is allowed to use those features.
In browsers that implement these directives, `getUserMedia()` rejects with
`NotAllowedError`. The same policy is mirrored on server responses in
[Program.cs](../server/Sendie.Server/Program.cs), although the client nginx
header is the one applied to the top-level document.

This is easy to miss because Vite development does not serve that production
header. It explains the exact class of bug where voice and camera work locally
but not after deployment.

**Recommendation:** Remove the camera and microphone directives and accept the
default `self` policy, or explicitly use `camera=(self), microphone=(self)`.
Keep geolocation disabled. Add a browser test against the built nginx image that
asserts the policy and exercises a mocked or permission-granted `getUserMedia()`
call.

### P0.2 Watch-party forward mode is a second, weaker file protocol [mitigated]

The normal receive path in
[MultiPeerFileTransferService.ts](../client/src/services/MultiPeerFileTransferService.ts)
checks all of the following before accepting bytes:

1. The peer completed the channel-binding handshake.
2. Host-only sending permits this sender.
3. The recipient accepted this file or pre-approved the peer.
4. The selected receive method and file size are supportable.

The `wp-file-start`, `wp-file-chunk-meta`, and `wp-file-end` path in
[WatchPartyService.ts](../client/src/services/WatchPartyService.ts) does not use
those checks. `handleFileStart` trusts `hostPeerId` from the message, changes an
idle recipient into a follower, and starts collecting chunks. `mediaSize`,
`totalChunks`, chunk index, decoded chunk size, and total accumulated bytes are
not bounded. Chunks are retained in a `Map` until the entire media file is
assembled as a Blob. A malicious room member can send arbitrary indices or
oversized base64 fields and exhaust the tab.

The sender does have SCTP and ACK backpressure. That is good, but it controls an
honest sender's queue. It does not protect the receiver from an intentionally
malformed sender.

This finding is also recorded in
[security-review-2026-06.md](security-review-2026-06.md). It remains present in
the code reviewed here.

**Recommendation:** Delete the separate watch-party byte receiver. Make the
normal transfer engine accept a receive intent and a sink:

```text
intent: download | watch-party
sink: user-selected file | OPFS temp file | bounded memory
```

The watch-party service should request a transfer and receive a completed
`File` or `FileSystemFileHandle`; it should not own transport security, consent,
chunking, or storage. This keeps wait-then-play behavior without reopening the
progressive MSE/transmuxing work that the repository already rejected.

### P0.3 Explicit receive consent is not the default [resolved]

[appStore.ts](../client/src/stores/appStore.ts) contains a comment saying
"Default OFF" immediately above:

```ts
autoReceive: true,
```

[MultiPeerSessionPage.tsx](../client/src/pages/MultiPeerSessionPage.tsx) then
silently accepts from any peer whose store status is `connected` when this flag
is true. That contradicts the hard promise in
[threat-model.md](threat-model.md) that `autoReceive` defaults to false and that
the prompt is mandatory.

**Recommendation:** Set the initial value to false. Rename the opt-in to
"Automatically accept files from room members" and make its scope clear. Do
not use "auto-receive" to describe sender-side broadcast retention.

### P0.4 The app conflates channel binding with identity confirmation

[VerificationService.ts](../client/src/services/VerificationService.ts) is a
thoughtful proof-of-possession protocol. It signs both JWKs, both nonces, both
DTLS fingerprints, and the room ID; checks the asserted fingerprint against
SDP; pins it; and tears down on mismatch. That proves that the current data
channel endpoint controls the advertised ephemeral key and keeps the binding
stable across renegotiation.

It does not, by itself, prove that the endpoint is the intended human. A hostile
signaling service can terminate two separate connections and prove possession
of its own key on each side. The out-of-band SAS comparison is the step that
exposes this: the two humans see different codes.

Today the service publishes `status: 'verified'` before the humans compare the
SAS. The page immediately dispatches queued and broadcast files on that event.
[PeerList.tsx](../client/src/components/PeerList.tsx) has a good tooltip telling
users to compare the code, but there is no "codes match" action or state.

**Recommendation:** Model three states instead of one:

```text
connected -> channel-bound -> identity-confirmed
```

Use "Channel secured" for the automatic result. Add the selected optional
strict mode at room creation. In strict mode, each local user must confirm the
matching SAS before that peer can receive files, watch-party bytes, chat, or
media. In normal mode, link possession remains the practical trust mechanism,
but the UI must say "Code not compared" rather than "Verified."

### P0.5 TURN fallback is documented but not implemented

[Program.cs](../server/Sendie.Server/Program.cs) returns three public Google
STUN entries and no TURN entries. The client fallback in
[MultiPeerWebRTCService.ts](../client/src/services/MultiPeerWebRTCService.ts) is
also STUN-only. At the same time, [README.md](../README.md),
[design-doc.md](design-doc.md), and [what-is-sendie.md](what-is-sendie.md) state
that TURN is used when direct connectivity fails.

Production WebRTC needs TURN for peers behind symmetric NAT, restrictive
enterprise firewalls, and some carrier networks. Without it, the user sees a
room and peer but never gets a working content path. "No relay" and "TURN
fallback" also cannot both describe the same deployment.

**Recommendation:** Include coturn in the default self-host Compose package and
return short-lived credentials from `/api/ice-servers`. Report whether each
connection is direct or relayed. Give operators an egress warning because large
relayed files can be expensive. Document the privacy boundary accurately:
TURN can observe network metadata and encrypted packet volume, but WebRTC
content remains encrypted end-to-end.

An optional "Hide my IP from room members" mode could set `iceTransportPolicy`
to `relay`. That fits Sendie's privacy positioning, with the explicit tradeoff
that the TURN operator sees connection metadata and pays the bandwidth bill.

## P1 correctness and lifecycle findings

### P1.1 Leaving one room disables singleton listeners for later rooms [resolved]

`MultiPeerWebRTCService.on()` correctly supports multiple listeners and returns
an unsubscribe function. Its `off(event)` compatibility form clears every
listener for that event.

The cleanup in
[MultiPeerSessionPage.tsx](../client/src/pages/MultiPeerSessionPage.tsx) calls
`off('onPeerDisconnected')`, `off('onDataChannelOpen')`, and similar forms
without the page's handler. This clears listeners installed once in the module
singleton constructors of:

- [VoiceService.ts](../client/src/services/VoiceService.ts)
- [CameraService.ts](../client/src/services/CameraService.ts)
- [ScreenShareService.ts](../client/src/services/ScreenShareService.ts)
- [WatchPartyService.ts](../client/src/services/WatchPartyService.ts)
- [ChatService.ts](../client/src/services/ChatService.ts)

After navigating home and entering another room without a full reload, those
constructors do not run again. Late-join announcements and disconnect cleanup
can stop working.

**Recommendation:** Capture every unsubscribe returned by `on()` in the page
effect and invoke only those functions during cleanup. Remove the no-handler
`off()` overload once all call sites migrate. Add an integration test that
enters, leaves, and enters a second room in one module lifetime.

### P1.2 Signaling reconnect does not rejoin or reconcile the room [resolved]

[SignalingService.ts](../client/src/services/SignalingService.ts) enables
automatic and stateful reconnect, but does not register `onreconnecting`,
`onreconnected`, or `onclose`. If stateful reconnect cannot preserve the old
connection and SignalR assigns a new connection ID, the server no longer sees
that client as a room member. The UI and existing P2P channels may still look
alive, but future signaling, host controls, ICE restart, and new-peer joins are
broken.

**Recommendation:** On reconnect, rejoin with the room secret, fetch a complete
room snapshot, update the local connection ID, reconcile peers, and rebuild
connections when identity changed. Show `Reconnecting` and `Room restored`
states. Treat a server restart as a first-class test case.

### P1.3 Existing peers do not learn a new host connection ID [resolved]

The server returns `hostConnectionId` only to the caller of `JoinSession`.
`OnPeerJoined` contains only the new connection ID. If the host arrives after a
guest, reconnects with a new SignalR ID, or is restored after a transient
failure, existing peers keep a null or stale host ID.

The receiver-side host-only check in
[MultiPeerFileTransferService.ts](../client/src/services/MultiPeerFileTransferService.ts)
uses that client value. It can therefore reject the real host after reconnect
or fail to label the host correctly.

**Recommendation:** Broadcast a versioned room snapshot or an explicit
`OnHostConnectionChanged` event. A snapshot should include host connection ID,
member list, lock state, send policy, max peers, protocol version, and expiry.
This event also gives reconnect reconciliation one authoritative source.

### P1.4 Mixed queue operations can delete broadcast files [resolved]

[appStore.ts](../client/src/stores/appStore.ts) exposes
`clearQueuedFiles(broadcastOnly?)`. Passing `false` clears the entire queue.
[FileQueue.tsx](../client/src/components/FileQueue.tsx) passes `false` from a
handler named `handleClearOneTime`, so the one-time Clear button also erases
broadcast entries.

The same call occurs after sending one-time files to the first verified peer.
If the queue contains both one-time and broadcast entries, it clears the
broadcast entries before the same function reads them for the new peer.

The copy "New joiners auto-receive" is also wrong. Broadcast mode offers or
sends metadata to future joiners; receive consent is a separate recipient
policy.

**Recommendation:** Replace the boolean API with unambiguous actions:

```text
clearAllQueuedFiles()
clearOneTimeFiles()
clearRetainedFiles()
```

Rename Broadcast mode to "Keep files for future joiners" and use copy such as
"Offer these files to people who join later."

### P1.5 The server and client disagree about room capacity [resolved]

The session service default and public claims say 10 peers. The session create
endpoint in [Program.cs](../server/Sendie.Server/Program.cs) passes 5 when no
query value is supplied. The home page supplies no value. `JoinSession` does not
return `maxPeers`, and the client store defaults to 10.

The practical result is a five-person room whose UI can report capacity for ten.

**Recommendation:** Pick a product default based on tested media and transfer
loads. Return it in every room snapshot and render the server value. My bias is
a default of 5 and an operator-configurable ceiling of 10. Phrase 10 as the
maximum, not the normal target.

### P1.6 Control traffic shares the ordered bulk channel

Chat has its own data channel, specifically to avoid head-of-line blocking.
Verification, voice/camera/screen state, watch-party timeline, watch-party
forwarding, and normal file metadata all use the ordered `fileTransfer`
channel. During a large transfer, control messages wait behind earlier chunks
on the same ordered stream. Watch-party forwarding further inflates every 16 KiB
chunk by base64-encoding it into JSON.

**Recommendation:** Use three application channels:

| Channel | Content |
|---|---|
| `control` | Verification, capabilities, room state, media state, timeline, transfer metadata and ACKs |
| `bulk` | Binary file chunks only |
| `chat` | Human chat, as today |

Keep WebRTC media on RTP tracks. Put a maximum message size on control and chat
before JSON parsing. Moving watch-party bytes into the normal binary bulk path
removes base64 overhead as a side effect.

### P1.7 There is no wire-version or capability handshake

Incoming JSON is generally parsed and cast to `DataChannelMessage` without
runtime schema validation. A stale tab, mixed deployment version, or malicious
peer can send missing fields, extreme numbers, giant strings, or an unsupported
message type. Browser support is inferred locally rather than negotiated.

**Recommendation:** Begin every peer connection with a small validated hello:

```json
{
  "v": 1,
  "features": ["files", "chat", "voice", "watch-local"],
  "storage": { "mode": "opfs", "availableBytes": 123456789 },
  "media": { "camera": true, "screenShare": false, "h264": true },
  "limits": { "maxIncomingFileBytes": 123456789 }
}
```

Use a runtime schema validator or small explicit validators at the dispatcher.
Reject incompatible protocol majors cleanly. Use capabilities to disable or
explain controls before a user starts an impossible operation.

### P1.8 Direct-to-disk selection is not tied to a user gesture

The code puts serious work into File System Access, OPFS, and StreamSaver.
However, `showSaveFilePicker()` is called after an inbound data-channel event
and an awaited `window.confirm` callback. The API requires transient user
activation. Depending on browser behavior, this call can reject with
`SecurityError` and silently fall through to OPFS or StreamSaver.

**Recommendation:** Replace `window.confirm` with an application modal. Its
Accept button should choose the receive target in the click handler and return a
decision object containing the selected file handle. This makes consent,
destination, quota, and strict verification one coherent receive step.

Also change "No size limits" to "No server-imposed file-size limit." Actual
limits depend on browser support, free disk or origin quota, private-browsing
mode, receiver memory, relay policy, and uninterrupted connectivity.

### P1.9 Metadata logging contradicts user-facing privacy language

[what-is-sendie.md](what-is-sendie.md) says "No metadata logging," then says the
server knows that a session existed. The live server logs session IDs,
connection IDs, Discord IDs, join and leave events, host-control actions,
pair-established events, and rate-limit keys at Information or Warning level in
[SignalingHub.cs](../server/Sendie.Server/Hubs/SignalingHub.cs),
[SessionService.cs](../server/Sendie.Server/Services/SessionService.cs), and
[RateLimiterService.cs](../server/Sendie.Server/Services/RateLimiterService.cs).
Standard ingress logs may add IP addresses and request paths.

The content claim is still strong: filenames, file sizes, chat, voice, camera,
screen, and watch-party bytes stay off the signaling server. The metadata claim
is not.

**Recommendation:** Say "No content logging" instead of "No metadata logging."
Document default fields and retention. Move routine peer and pair IDs to Debug,
redact or rotate-hash identifiers where correlation is needed, and provide a
privacy-minimal logging profile for self-hosters.

### P1.10 Forwarded headers trust any source [resolved]

[Program.cs](../server/Sendie.Server/Program.cs) clears `KnownNetworks` and
`KnownProxies`. This accepts forwarded IP/protocol headers from any direct
source. If a self-hoster exposes Kestrel or configures a proxy that preserves
client-supplied forwarding headers, clients can spoof the IP used by join and
lookup rate limits and poison logs.

**Recommendation:** Make trusted proxy CIDRs explicit configuration. If no
trusted proxy is configured, do not process forwarded headers. Include correct
settings in Compose and Kubernetes examples.

## Self-hosting gaps

Self-hosting is described as supported, but the repository currently packages
one maintainer's Azure deployment rather than a portable product.

### Current constraints

- [what-is-sendie.md](what-is-sendie.md) calls Docker Compose the simplest
  deployment, but the repository has no Compose file.
- [deploy.sh](../deploy.sh) requires Azure CLI, ACR, and Kubernetes.
- [k8s/ingress.yaml](../k8s/ingress.yaml) hardcodes
  `sendie.curlyquote.com` and a `letsencrypt-prod` cluster issuer.
- [k8s/server-pvc.yaml](../k8s/server-pvc.yaml) hardcodes the Azure Files
  storage class.
- Host authentication is Discord-only. Every operator must create a Discord
  application and manage numeric Discord IDs.
- Discord client ID and secret can be empty at startup; the service starts and
  authentication fails later.
- The `Session` values in
  [appsettings.json](../server/Sendie.Server/appsettings.json) look configurable,
  but [SessionService.cs](../server/Sendie.Server/Services/SessionService.cs)
  hardcodes all five durations and never reads that section.
- A Firefox storage error in
  [MultiPeerFileTransferService.ts](../client/src/services/MultiPeerFileTransferService.ts)
  tells users to bookmark `sendie.curlyquote.com` on every self-hosted instance.
- ICE servers are not configurable and TURN is absent.
- The health endpoint always returns healthy; it does not validate auth config,
  writable data storage, Data Protection key persistence, or TURN config.
- The server deployment deliberately uses one replica and `Recreate` because
  room state is process-local. This is coherent, but every update interrupts
  signaling and invalidates all server-side room records.

### Recommended self-host v1

1. Add a vendor-neutral Compose stack with client, server, coturn, persistent
   data volume, and a documented TLS proxy option.
2. Support generic OIDC and keep Discord as a preset. Also consider an explicit
   private-instance mode with a bootstrap owner token or passkey.
3. Bind public URL, instance name, auth provider, admins, room limits, TTLs,
   logging profile, CORS, trusted proxies, and ICE/TURN through validated options.
4. Fail startup or readiness with actionable diagnostics when required config
   is missing. Keep `/health/live` process-only and make `/health/ready` check
   configuration and persistence.
5. Move Azure manifests under an example deployment directory. Add a Helm chart
   only after Compose and configuration are stable.
6. State the single-instance consequence plainly: active rooms do not survive a
   server restart. Add recovery only if operators say this is unacceptable.

## Product gaps and opportunities

### 1. Make recipients explicit

Dropping a file in normal mode calls `broadcastFile()` and sends it to every
current peer. There is no recipient selector, and the primary drop zone does not
make "everyone" prominent. In a private room, accidental audience expansion is
a security and usability problem.

Add a stable recipient control above the drop zone:

```text
To: [Everyone] [Alice] [Blue-Larch] [3 selected]
```

Show the intended recipients, aggregate upload cost, and any capability problem
before sending. Keep "Everyone" available, but never implicit in a room with
more than one remote peer.

### 2. Use room presets, not separate products

The room is the product, but not every room needs every tool at once. Let the
host choose a preset at creation:

| Preset | Initial focus | Default policy |
|---|---|---|
| Send files | Drop zone and recipients | Per-file consent, no retained files |
| Collaborate | Voice, screen, chat, files | Media controls visible |
| Watch together | Media selection and readiness | Watch-party transfer intent |

These should be layout and policy presets over one protocol, not new room
types. Users can reveal other tools later. This reduces the current long panel
stack without removing capability.

### 3. Add a connection and capability preflight

Before a multi-gigabyte transfer or media session, show:

- Direct or TURN-relayed path.
- Browser receive mode: direct-to-disk, OPFS, StreamSaver, or bounded memory.
- Estimated available browser storage.
- RTT and a rough throughput probe.
- Camera, microphone, and screen-share availability.
- Watch-party codec support.
- Whether the tab may be suspended in the background.

This turns vague failures into decisions. It is especially useful to
self-hosters diagnosing their TURN and proxy setup.

### 4. Add resumable transfer and content integrity together

The current transfer restarts from byte zero after interruption and has no
content checksum. DTLS already protects in-flight packet integrity, so a hash is
not an authentication fix. It is useful for detecting implementation or disk
errors and is the stable identity needed for resume.

A practical sequence is:

1. Resume within the same tab using committed chunk ranges.
2. Retain OPFS partials with an expiry and resume token.
3. On reload, ask the sender to reselect the source and verify its file identity.
4. Use an incremental content root or chunk tree so hashing does not require the
   whole file in memory.

Do not advertise unlimited large-file transfer until interruption recovery has
been tested across browsers and TURN.

### 5. Make room capabilities revocable

Kicking a guest removes the current connection but does not revoke the room link
they already possess. They can immediately rejoin an unlocked room. Anonymous
guests have no stable account identity to ban reliably.

Add "Rotate invite link" and optionally issue per-invite capabilities. Rotation
is a better fit than pretending a connection-ID ban is durable. The host should
be able to kick, rotate, and share a fresh link without recreating the room or
interrupting established P2P connections.

### 6. Add mobile continuity before more media features

Mobile browsers suspend background tabs and can kill service workers or origin
storage work. A PWA shell, Wake Lock during active user-approved work, clear
background warnings, and tested resume behavior would improve the core product
more than reactions, rich previews, or additional watch-party controls.

PairDrop is a useful product benchmark here: its PWA, wake-lock handling,
cross-device focus, TURN examples, and BrowserStack testing solve mundane
reliability problems that users notice immediately.

### 7. Consider a lightweight shared pointer later

A colored peer pointer over a shared screen could make remote walkthroughs and
code reviews distinct without requiring document editing or server state. It
fits the ephemeral-room model and uses tiny control messages. It should wait
until control traffic has its own channel and peer identity state is clear.

## Design choices I would keep

### Keep the full mesh for now

A mesh is a reasonable choice for private rooms with a practical default near
five peers. It keeps the operator out of the content path and makes self-hosting
simple. The wrong move would be to promise ten simultaneous cameras or to add an
SFU before measurements show a need.

Add an SFU only if real usage requires larger media rooms. If that day comes,
make insertable-stream end-to-end encryption and the changed metadata boundary
an explicit product decision.

### Keep wait-then-play watch parties

The repository's
[transmuxing-research.md](transmuxing-research.md) documents why progressive MSE,
range proxies, and browser transmuxing were repeatedly expensive and fragile.
Do not reopen that work as the next watch-party improvement. Unifying the
transfer engine, showing readiness, and supporting local-file mode are better
investments.

### Keep ephemeral content as the default

Do not add server-side file storage, chat history, transcripts, or recordings
just because collaboration products usually have them. Local export can be an
explicit user action. Server persistence would change the clearest privacy
property and create a different product.

### Keep the bound-SAS primitive

The implementation is substantially better than a decorative fingerprint. Keep
the protocol and improve its state names and confirmation UX. Do not replace it
with a weaker server-forwarded key exchange.

## Architecture direction

### One room snapshot

Make the server publish one authoritative, versioned snapshot on join,
reconnect, host change, lock change, and policy change:

```text
RoomSnapshot {
  protocolVersion,
  roomId,
  hostConnectionId,
  members,
  maxPeers,
  locked,
  sendingPolicy,
  strictVerification,
  expiresAt
}
```

This replaces scattered flags and fixes host/reconnect drift.

### One inbound policy

Every application payload should pass through a room-level policy before a
feature service sees it:

```text
peer is in current snapshot
-> message matches a known schema and size limit
-> channel is bound
-> identity is confirmed when strict mode requires it
-> sender role permits this operation
-> recipient consent exists when content is offered
-> resource budget permits it
```

Media tracks need the equivalent gate before rendering. A track can be buffered
briefly while channel binding completes, then attached or discarded.

### One bulk transfer engine

Normal downloads, retained files for future joiners, and watch-party media are
different intents over the same byte-transfer engine. They should share chunking,
ACKs, cancellation, storage sinks, limits, cleanup, and later resume/integrity.

### Session-scoped ownership

Global service singletons are workable, but page cleanup and constructor-time
subscriptions currently disagree about ownership. Either make a `RoomSession`
object that owns services and disposes them together, or keep singletons and
require every registration to return a stored disposer. Do not mix both models.

## Testing and delivery assessment

### Baseline run on 2026-07-11

`./scripts/preflight.sh` passed with no warnings:

- 55 server tests passed on .NET 10.
- 181 client tests passed across 14 files on Node 24.
- The production client build succeeded.
- StreamSaver origin pinning, media Permissions-Policy, and configuration
  hygiene checks passed.

`dotnet list package --vulnerable --include-transitive` found no known NuGet
advisories from the configured source.

`npm audit --omit=dev` and the complete npm audit both report zero known
advisories. `npm run test:coverage` now runs reproducibly with enforced floors
of 40% statements/functions/lines and 35% branches. The measured baseline is
42.87% statements, 37.07% branches, 42.66% functions, and 45.10% lines.

`npm run lint` is clean. Both production Docker images build successfully. The
server image runs as the built-in `app` identity (UID/GID 1654). The deployed
Azure Files volume uses mode 0770 for directories and 0660 for files, with no
world access. GitHub Actions now runs lint, coverage, build,
audit, .NET tests, and container builds on pushes and pull requests.

### What the test count does not cover

There are no direct tests for the complete
`MultiPeerFileTransferService`, `VoiceService`,
`CameraService`, `ScreenShareService`, `ChatService`, `SignalingService`, or
`MultiPeerSessionPage` workflows. Watch-party receive policy and forward
protocol now have focused unit tests, but not real browser storage/network
coverage. Existing WebRTC tests mock browser transport. There
is no multi-browser end-to-end suite, no nginx-header browser test, no TURN
test, no reconnect test, and no two-room lifecycle test.

For a browser networking product, Playwright tests with two or three browser
contexts are more valuable than raising a global line-coverage number. Minimum
scenarios:

1. Create, join, compare/confirm in strict mode, and transfer a checksum fixture.
2. Decline a file and verify no chunks arrive.
3. Leave and enter a second room without reload.
4. Disconnect and restore SignalR, including a changed connection ID.
5. Host disconnect/reconnect while host-only sending is enabled.
6. Mixed one-time and retained queues.
7. Watch-party receive rejection from a non-host and an oversized payload.
8. Camera and microphone under the production nginx headers.
9. Direct ICE failure followed by successful TURN relay.
10. Chromium, Firefox, and WebKit storage fallbacks with bounded fixtures.

Add CI before expanding distribution: clean install, tests, production builds,
coverage command, container build, dependency audit, and a small Playwright
matrix. Pin container images or digests and use an update bot.

## Runtime maintenance

The repository now uses Node 24 and .NET 10 LTS throughout its active build,
test, Docker, and setup surfaces. Dependabot watches npm, NuGet, Docker, and
GitHub Actions weekly. The remaining supply-chain hardening opportunity is to
pin production base images or digests rather than relying on floating
`node:24-alpine`, `nginx:alpine`, and .NET `10.0` tags.

## Documentation corrections

The docs are rich but mix live behavior, old proposals, abandoned work, and
stronger promises than the deployment supports. A smaller source of truth would
help operators and contributors.

Correct these claims first:

| Current claim | More accurate wording |
|---|---|
| "No metadata logging" | "No content logging by default; the signaling service and infrastructure can log room and connection metadata." |
| "Files never touch our servers" | "File contents never reach the signaling server. TURN may relay encrypted packets when direct connectivity fails." |
| "No size limits" | "No server-imposed size limit; browser storage, disk, network, relay, and continuity limits apply." |
| "Up to 10 peers" | "Server-authoritative and currently capped at 10; lower the default only after measured room-load testing." |
| "Verified" after handshake | "Channel secured; compare the code to confirm the person." |
| "TURN fallback" | Only claim this after a TURN server is configured and tested. |
| "Docker Compose (simplest)" | Add and test the Compose package before claiming it. |
| "New joiners auto-receive" | "Offer retained files to future joiners." |

Create one current-capabilities page with a browser matrix and links to design
history. Keep proposal documents as decision records, but put `Status`,
`Shipped`, `Deferred`, and `Abandoned` at the top of each.

## Suggested roadmap

### Completed in the first remediation pass

- Fix the production Permissions-Policy.
- Set auto-receive off.
- Fix mixed queue clearing and wording.
- Make server and UI room capacity agree.
- Update advised npm dependencies and add the missing coverage provider.
- Correct privacy, TURN, size, and verification wording.

### Next: unify trust and lifecycle

- Route watch-party media through the normal transfer engine.
- Add channel-bound versus identity-confirmed states and optional strict rooms.
- Separate control and bulk channels with validated, versioned messages.
- Add the high-value multi-context browser tests listed above.

### Then: ship a real self-host package

- Vendor-neutral Compose with coturn and persistent data.
- Generic OIDC plus Discord preset.
- Validated runtime options and readiness diagnostics.
- Privacy-minimal logs and documented retention.

### After that: improve the room product

- Room presets and room-first home language.
- Explicit recipients and retained-file semantics.
- Connection and capability preflight.
- Resume plus content integrity.
- Invite rotation and per-invite capabilities.
- PWA and mobile continuity work.

### Do not prioritize yet

- An SFU or rooms larger than the measured mesh ceiling.
- Another progressive watch-party streaming or transmuxing attempt.
- Server-side content history or recording.
- Rich chat, reactions, previews, or more panels.
- MLS or SFrame before a relay/SFU architecture actually requires them.

## Strengths worth preserving

- The session ID and fragment-secret split is well designed. The server stores
  a peppered HMAC and compares it in constant time.
- The bound-SAS payload covers the right connection material and pins the
  fingerprint across renegotiation.
- Normal file transfer uses per-peer ACK flow control so a slow recipient does
  not automatically block every other recipient.
- Large-file receive has thoughtful FSA, OPFS, and StreamSaver fallbacks,
  watchdogs, and cleanup. The product language needs qualification, but the
  engineering investment is real.
- Signaling is targeted to room peers, room capabilities are high entropy, and
  session creation and signaling methods are rate-limited.
- The security audits and watch-party autopsies record failed assumptions
  honestly. That history should guide the architecture rather than be erased.
- The full mesh is a defensible privacy and operations choice for the selected
  small-room, self-hosted direction.

## Open product and operator questions

These do not block the immediate fixes, but they should be answered before the
self-host release is designed:

1. Should generic OIDC be the default host-auth path, or should a private
   instance work without any third-party identity provider?
2. Must active rooms survive a signaling-server restart, or is an explicit
   "rooms end on restart" contract acceptable?
3. What is the target real-world room shape: number of peers, simultaneous
   cameras, typical file size, and expected watch-party frequency?
4. What metadata retention should the default distribution use for application,
   ingress, and TURN logs?
5. Have voice and camera been tested through the current production nginx
   deployment? The policy analysis predicts failure in Chromium-family browsers.
6. Should guests remain fully anonymous, or may an instance optionally require
   OIDC for guests as well as hosts?

## External references consulted

- MDN, Permissions-Policy camera:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/camera
- MDN, Permissions-Policy microphone:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/microphone
- MDN, `showSaveFilePicker()` availability and user activation:
  https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker
- MDN, Origin Private File System behavior and quotas:
  https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system
- MDN, persistent browser storage:
  https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist
- WebRTC project, TURN server guidance:
  https://webrtc.org/getting-started/turn-server
- IETF RFC 8827, WebRTC Security Architecture, especially sections 6.5 and 9.1:
  https://www.rfc-editor.org/rfc/rfc8827.html
- IETF RFC 8844, identity and session binding caveats:
  https://www.rfc-editor.org/rfc/rfc8844.html
- PairDrop, product and self-hosting comparison:
  https://github.com/schlagmichdoch/PairDrop
- Node.js release status:
  https://nodejs.org/en/about/previous-releases
- Microsoft .NET support policy:
  https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core
