# Sendie threat model

**Date:** May 2026 (post Phase 0-6 hardening)
**Audience:** Future contributors, future auditors, future me

## Why this exists

Every audit of Sendie so far has had to re-derive the threat model from scratch. That is a waste of time and a source of subtle disagreements. This doc is the canonical answer to "what does Sendie protect against, and what doesn't it." Copy-paste from the audits would be lossy; the audits are findings against a model. This is the model.

## Adversaries

I name them so we can talk about them concretely.

### Mallory — malicious signaling server

The SignalR server, or someone who has compromised it, or anyone who can MITM TLS to it (e.g. a corporate proxy injecting certificates).

What Mallory can do:
- Read all SDP, ICE candidates, and SignalR messages.
- Drop, delay, reorder, replay any signaling message.
- Forge messages from any connection she controls.
- Rewrite `a=fingerprint:` lines in SDP to attempt a DTLS MITM.
- See session IDs and the connection IDs of every peer.
- Refuse to deliver messages, partitioning the group.

What Mallory **cannot** do (and the reasons):
- **Read file contents.** Files travel over the WebRTC data channel, which is DTLS-encrypted between browsers. Mallory has the SDP but not the DTLS handshake material; she can attempt a MITM but is detected by the bound SAS (Phase 2).
- **Read chat messages or A/V media.** Same channel, same protection. (Speculative for A/V; today only files exist.)
- **Forge a peer's identity in the verification protocol.** ECDSA signatures are exchanged over the data channel itself, not via her, and the signed payload includes the DTLS fingerprints of both endpoints. To forge, Mallory needs the peer's private key, which never leaves the browser.
- **Recover the join secret from a session URL she observed in the path.** The 128-bit secret travels in the URL fragment (`#k=...`) per Phase 6.1. Browsers do not send fragments to servers. Mallory only sees fragments if she compromises the user's browser, in which case the threat model has bigger problems.
- **Call any peer-to-peer hub method.** Hub methods rate-limit, validate session ID format, and require the join secret for `JoinSession`.

### Eve — passive network observer

Wi-fi sniffer, ISP, anyone on the path. Can read but not modify.

What Eve learns: TLS-protected, so very little. Connection metadata (which IPs talk when), session IDs in URL paths if the link is leaked, but not in the fragment. Cannot read files or media.

### Trent — malicious or compromised peer

Joined the session legitimately (had the link with secret), or someone who got their session token via social engineering.

What Trent can do:
- Read all files sent to the group (he's a participant; this is by design).
- Send files to other peers (subject to host-only-sending if enabled, which is now enforced server-side and on the receiver, per Phase 1).
- See every other peer's connection ID, friendly name, and SAS code.
- See peer IPs (WebRTC mesh exposes them; the README is honest about this).
- Disrupt the call: spam chunks, refuse to acknowledge, etc.

What Trent **cannot** do:
- **Forge another peer's identity** to send files claiming to be them. Each peer's outgoing files are tied to their connection ID, and the receiver has verified that connection ID against an ECDSA signature.
- **Decrypt files sent only between two other peers** in the mesh. Each pairwise data channel has its own DTLS session.
- **Cause a peer to receive a file without an explicit accept.** Per Phase 1, the receiver-side accept prompt is mandatory; auto-receive is opt-in.
- **Re-join a locked session after being kicked.** Lock + kick combined with `IsLocked` enforcement on join is sufficient. He can re-join an unlocked session because the secret is still in his URL — that is a known limitation, see "Open issues" below.

### Marvin — bot or automated URL fetcher

Discord embed unfurler, Slack link preview, antivirus URL scanner, malware sandbox URL crawler.

What Marvin does: HTTP-GETs the session URL when it's pasted somewhere it can see.

What Marvin gets: only the path. Fragments are never sent on the initial GET. He cannot join the session (no secret). He cannot probe much through `GET /api/sessions/{id}` because that endpoint is rate-limited and returns only public metadata.

Pre-Phase-6.1, Marvin could in theory have triggered the auto-receive flow on whoever the bot was authenticated as, except Marvin is rarely authenticated and the rate limits prevent enumeration. Post-Phase-6.1, Marvin is not even a real risk class anymore.

### Carol — compromised admin

Admin's Discord account is taken over.

What Carol can do:
- Add / remove users from the allow-list.
- Create unlimited sessions (rate-limited per Discord ID per hour).
- Cannot read existing sessions she did not create (no special key access).
- Cannot remove other admins from the allow-list (config-only).
- Cannot read past file content (no server-side storage).

The damage is bounded by "Discord IDs that were allow-listed during Carol's compromise window." Recovery is "log in as another admin, remove Carol's additions." The audit log Phase 3.10 (deferred) would help with this; right now we rely on application logs.

## Promises Sendie makes

In order from "we'll defend against any audit" to "yeah this part is best-effort":

### Hard promises (will reject anything that breaks them as a security bug)

1. **Files never touch the server.** Verifiable by inspecting [server/Sendie.Server](../server/Sendie.Server). The hub forwards SDP and ICE candidates and nothing else of payload-relevant content.
2. **Session creation requires an allow-listed Discord ID.** Enforced by `AllowedUser` policy on `POST /api/sessions`.
3. **Sessions auto-expire.** Hard cap at 24 hours when host is connected, 4 hours otherwise. No way to extend past that.
4. **The bound SAS authenticates the DTLS endpoints.** Phase 2 binds the SAS to fingerprints from SDP plus signed challenges over the data channel. A server that rewrites `a=fingerprint:` causes mismatch and the channel is torn down.
5. **The join secret is required.** Phase 6.1. URL fragment. Path-only links cannot join.
6. **Receivers explicitly accept incoming files.** Phase 1. `autoReceive` defaults to false; the consent prompt is mandatory; small files go through `showSaveFilePicker` when supported.
7. **Host-only-sending is enforced on the receiver.** Phase 1. Not a UI hint.
8. **Cookies are HttpOnly and Secure in production.** Phase 0. Discord access tokens are not stored in the cookie (`SaveTokens=false`).
9. **CORS is restricted to localhost in development.** Phase 3. Production reverse-proxy provides additional origin protection.

### Soft promises (best-effort, may not survive future deployment changes)

1. **Mesh CPU caps at 10 peers.** Currently enforced by `AbsoluteMaxPeers`; there is no cryptographic protection if a future change raises it. Adding voice/video would tighten this further (4-peer cap with video).
2. **No third-party content fetching from the SPA.** CSP `connect-src 'self'` blocks it, but extensions, dev consoles, and people who serve their own build can bypass.
3. **`robots.txt` blocks indexing of session URLs.** Best-effort; well-behaved bots only. Marvin's polite cousins.
4. **Container runs as non-root.** Phase 5. UID 1001. PVC permissions are 0700 on the keys subpath.

### Things we explicitly do NOT promise

1. **IP privacy.** WebRTC mesh exposes peer IPs. The README says so. This is by design; switching to a TURN relay model would change the trust story (relay has to be trusted not to read media even if SFrame protects the bytes, since metadata still leaks).
2. **Anonymity.** Discord OAuth tells the server who the host is. Recipients are anonymous to the server (no auth required to join), but the host knows them by SAS code and friendly name.
3. **Metadata privacy from the signaling server.** Mallory sees session existence, peer count, SDP, ICE candidates. She does not see file names, sizes, types — those move only over the data channel.
4. **Forward secrecy across page reloads.** A reload regenerates ECDSA keys and re-runs verification. Files sent in the previous session are still on the user's local disk. This is intentional ("you keep your files"); it is not forward secrecy in the cryptographic sense.
5. **Resistance to a malicious peer's screen recorder.** If you accept a video call with someone, they can record it with OS tools. We can show "they're recording" prompts (Phase A/V proposal) but not enforce them.
6. **Resistance to social engineering.** "Compare your SAS code over Discord" assumes the comparing channel is trusted. If both peers have been compromised by the same attacker, the SAS comparison is meaningless.

## What changed under each phase

For each phase we shipped, here's what the threat model gained:

| Phase | What it gave us in this model |
|-------|------|
| 0 | Mallory can no longer phish through `?returnUrl=`. URL-paste accepts all valid IDs. Mallory does not get a Discord access token from a stolen cookie. |
| 1 | Drive-by file delivery is closed. Trent cannot bypass host-only-sending. |
| 2 | The bound SAS gives us a real, cryptographically meaningful answer to "is Mallory MITMing this DTLS connection?" |
| 3 | Trent cannot pin a session at the 24h cap with `ReportConnectionEstablished` spam. Race conditions in peer-add and host-only-sending toggles are gone. |
| 4 | Marvin sees no third-party scripts. StreamSaver bytes do not pass through `jimmywarting.github.io`. |
| 5 | A container compromise cannot escalate via root and cannot trivially read Data Protection keys. |
| 6.1 | Marvin no longer matters. Mallory and Eve see fewer secrets. |
| 6.3 | Operators get a loud warning if they will be locked out of admin functions. |

## Open issues that this model does NOT address

These are flagged for future work, not silently ignored:

1. **Kicking a peer does not revoke their copy of the URL.** The session lock prevents re-join, but un-locking lets them back. A revocable per-recipient join token (Phase 6.1 Option B) would fix this. Not done.
2. **Mallory can fragment the group by selectively delivering messages.** RFC 9605 §7.4 names this for SFrame; the same applies to our SignalR. The session won't fork (everyone has different state), it just degrades. Detection: peers don't agree on the participant list. Mitigation: out-of-band comparison via SAS plus friendly names.
3. **Server restart loses sessions.** Stateful SignalR reconnect tries; session state does not persist. Phase 3 added a hint but not real recovery. RFC 9420's MLS resumption-PSK pattern would help if we ever adopted MLS.
4. **No audit log for admin actions.** Phase 3.10 deferred. Application logs survive at the operator's discretion only.
5. **CSP violation reports are not collected.** Phase 7 (post-merge monitoring), deferred. We rely on people in the dev console to notice.

## What I want you to do with this doc

Three things:

1. **If you change the threat model, change this doc in the same PR.** Threat models are alive. If you add a feature that breaks one of the hard promises, the audit will find it eventually; better that we say so up front.
2. **If you find a vulnerability, locate it on the table above.** Is it a violation of a hard promise? That's a security bug. Soft promise? Worth fixing but not a CVE. Explicitly-not-promised? Then the question is whether to upgrade the promise.
3. **Don't add adversaries this list doesn't have without a reason.** "What if a quantum computer breaks ECDSA in 2030?" is fine in a roadmap doc, not here. This doc is about today's product.
