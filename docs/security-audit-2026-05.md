# Sendie Implementation & Security Audit

**Date:** May 2026 (revised after second pass)
**Scope:** Full pass over server (`Sendie.Server`), client (`client/src`), deployment (`k8s/`, Dockerfiles, nginx), and the security promises made in `README.md` and `docs/security-audit-2025-12.md`.
**Style:** Adversarial. Where prior audits already cover an item, I either confirm, expand, or push back. New findings are marked NEW.

> Revision note (pass 2): added C3 (open redirect), C4 (session-page is unprotected by design with consequences), H4 (paste-a-URL bug that drops sessions on the floor), M7..M10 and L9..L11. Tightened M5 wording. The headline conclusion from pass 1 stands: SAS does not authenticate the DTLS channel.

---

## TL;DR

Sendie is well-structured for what it is: a small, opinionated, allow-listed signaling server plus a WebRTC mesh client. The 2025-12 audit captures the obvious surface stuff (rate limiting, filename sanitization, headers, cookies). What it misses, and what I think is the most important takeaway, is that **the cryptographic identity-verification system shipped in the client is partially wired up, partially decorative, and does not actually authenticate the DTLS channel that carries the file bytes**. The README's headline "End-to-End Encrypted" promise holds against a passive network attacker but **does not hold against a malicious or compromised signaling server**, which is the threat the SAS code is supposed to defend against. Everything else in this document is smaller.

Severity legend: **Critical** (breaks a stated security promise), **High** (real exploit), **Medium** (degraded posture), **Low** (hygiene).

---

## Critical findings

### C1. SAS / ECDSA identity verification is not bound to the DTLS connection (NEW)

**Where:** [client/src/services/CryptoService.ts](client/src/services/CryptoService.ts), [client/src/services/SignalingService.ts](client/src/services/SignalingService.ts), [client/src/pages/MultiPeerSessionPage.tsx](client/src/pages/MultiPeerSessionPage.tsx), [server/Sendie.Server/Hubs/SignalingHub.cs](server/Sendie.Server/Hubs/SignalingHub.cs)

**What's wired up:**
- Each peer generates a P-256 ECDSA keypair on join.
- Each peer sends their public JWK to every other peer via the server (`SendPublicKeyTo`).
- Each peer hashes the sorted pair of JWKs into a 4-word SAS code and shows it in the UI.

**What is missing:**
1. Nobody ever calls `sendSignature` and nobody registers `onSignature` in the page. The `sign` / `verify` methods exist but are dead code. There is no proof-of-possession step. A peer (or the server) can claim any public key.
2. More importantly, **the SAS is computed over JWKs only**. It is never tied to the WebRTC DTLS fingerprint that appears in the SDP. The SDP travels through the same untrusted signaling server.

**The actual MITM the server can pull off:**
- Peer A and Peer B both generate JWKs `pkA`, `pkB`. The server forwards them honestly. Both peers compute the same SAS. They compare it on Discord/voice/etc. and it matches.
- In parallel, when A's offer SDP arrives at the server, the server rewrites the `a=fingerprint:` line to its own DTLS cert. It does the same for B's answer. The server now terminates DTLS on both sides and sees plaintext file chunks. It re-encrypts and forwards to maintain the illusion of a working data channel.
- Neither peer ever signed their DTLS fingerprint with their ECDSA key, so there is no cross-check. The "identity verified" UI lights up green.

**Why this matters:** The README's first feature bullet is "🔒 End-to-End Encrypted - All transfers use DTLS encryption (built into WebRTC)". DTLS is end-to-end against external network attackers, but in a 1:1 mesh with a server that sees the SDP, the only thing standing between the server and the plaintext is the SAS. If the SAS does not authenticate the DTLS endpoints, the server can MITM and the SAS is theatre.

**Fix (pick one):**
- **Best:** finish the signature flow. Have each peer sign a payload that includes both peers' DTLS fingerprints (extract from SDP after `setLocalDescription`/`setRemoteDescription`) plus a session-binding nonce, send the signature over the same data channel (so it inherits whatever DTLS is actually in use), and refuse to send file data until the signature verifies against the JWK whose hash produced the displayed SAS.
- **Cheaper:** include the local DTLS fingerprint in the JWK exchange and SAS hash, so SAS = `H(pkA || fingerprintA || pkB || fingerprintB)`. A server that rewrites SDP fingerprints will cause SAS mismatch out-of-band.
- **At minimum:** stop advertising SAS as "identity verification" if it does not authenticate the channel, and tell users explicitly that SAS only catches a MITM on the JWK exchange.

Until one of these lands, calling Sendie E2EE in a threat model that includes a hostile server is overclaiming.

---

### C2. "Host-only sending" is a UI flag with no enforcement (NEW)

**Where:** [client/src/pages/MultiPeerSessionPage.tsx](client/src/pages/MultiPeerSessionPage.tsx), [client/src/services/MultiPeerFileTransferService.ts](client/src/services/MultiPeerFileTransferService.ts), [server/Sendie.Server/Services/SessionService.cs](server/Sendie.Server/Services/SessionService.cs)

The host can toggle `IsHostOnlySending`. The flag is broadcast to peers via `OnHostOnlySendingEnabled`. The non-host client respects it by hiding the send UI (`canSendFiles` becomes false).

But: the actual file transfer goes peer-to-peer over the data channel, and the receiver only gates incoming files on `autoReceive`. A non-host peer who modifies their client (or just calls `multiPeerFileTransferService.broadcastFile` from the dev console) can still send to anyone whose `autoReceive` is on. The server cannot enforce this because it never sees data-channel traffic. That is fine, but the receiving client should also enforce it: when `connection.isHostOnlySending` is true, the receive path should drop `file-start` messages from any peer whose `connectionId !== hostConnectionId`.

The README and host-controls UI imply this is a security control. Right now it isn't, it is a hint.

**Fix:** in `MultiPeerFileTransferService.initializeIncomingTransfer`, reject if host-only-sending is on and `peerId !== hostConnectionId`. (Also requires plumbing the flag into the service.)

---

### C3. Open redirect on `/api/auth/login` via `returnUrl` (NEW, pass 2)

**Where:** [server/Sendie.Server/Program.cs](server/Sendie.Server/Program.cs#L136-L147)

```csharp
app.MapGet("/api/auth/login", (string? returnUrl, IConfiguration config) =>
{
    var defaultRedirect = app.Environment.IsDevelopment() ? "http://localhost:5173" : "/";
    var properties = new AuthenticationProperties { RedirectUri = returnUrl ?? defaultRedirect };
    return Results.Challenge(properties, [DiscordAuthenticationDefaults.AuthenticationScheme]);
});
```

`returnUrl` is taken straight from the query string, stuffed into `AuthenticationProperties.RedirectUri`, and passed to the Discord OAuth challenge. After the OAuth round-trip succeeds, the remote-auth handler issues `Response.Redirect(properties.RedirectUri)` with **no `IsLocalUrl` check**. Crafting `https://sendie.curlyquote.com/api/auth/login?returnUrl=https://evil.example/phish` produces a fully legitimate Discord OAuth screen on the real Sendie origin, then drops the victim on `evil.example` after a successful login. Classic OAuth-laundered open redirect, useful for phishing because the user just authorized a thing on the real domain.

`ProtectedRoute` worsens it: it calls `authService.login(window.location.href)`, so any unauthenticated visit to `/?returnUrl=…` fed via a wrapped link will inherit the attacker's `returnUrl`.

**Fix:** validate `returnUrl` server-side. Either restrict to relative paths only (`Url.IsLocalUrl(returnUrl)` via `LinkGenerator`/`HttpContext.Request.PathBase`) or restrict to a hardcoded host allow-list. Reject everything else and fall through to the default redirect.

```csharp
app.MapGet("/api/auth/login", (string? returnUrl, HttpContext ctx) =>
{
    var safe = !string.IsNullOrEmpty(returnUrl)
               && Uri.TryCreate(returnUrl, UriKind.Relative, out _);
    var redirect = safe ? returnUrl! : (ctx.RequestServices.GetRequiredService<IWebHostEnvironment>().IsDevelopment() ? "http://localhost:5173" : "/");
    return Results.Challenge(new AuthenticationProperties { RedirectUri = redirect },
                             [DiscordAuthenticationDefaults.AuthenticationScheme]);
});
```

(Dev-mode `http://localhost:5173` is technically also non-local; gate it on `IsDevelopment()`.)

---

### C4. Session URL is the only authentication for joiners, and the join page is not behind `ProtectedRoute` (clarification of design risk)

**Where:** [client/src/App.tsx](client/src/App.tsx#L17-L20), [server/Sendie.Server/Hubs/SignalingHub.cs](server/Sendie.Server/Hubs/SignalingHub.cs#L86-L100)

This is mostly a documentation-of-intent issue, but it deserves Critical treatment because the README, prior audit, and code all *assume* it without spelling out what it costs you:

- `MultiPeerSessionPage` is rendered without `ProtectedRoute`. Anyone with a session URL can connect to `/hubs/signaling`, call `JoinSession`, see every peer's connection ID, and exchange JWKs/SDP/ICE.
- The hub itself has no `[Authorize]`. The session ID is the only capability token.
- That session ID is **routinely exposed** in browser history, in any chat client where the link is pasted (Discord embed previews, Slack link unfurling, employer URL scanners, antivirus URL fetchers), and in the URL bar where shoulder-surfers can read it.
- 128 bits of entropy stops *guessing*. It does not stop *leaking*.

Combined with H1 (auto-receive on by default, sub-100MB silent download), a session URL exposed to a chat-bot URL preview service can put files in the previewer's Downloads folder before the human ever clicks the link, depending on whether they auto-load preview iframes (most don't, but some self-hosted ones do).

**Fix options, in order of how invasive they are:**
1. Cheapest: stop putting the session ID in the URL path. Use a fragment (`/s/#token=…`) so it never goes over HTTP and is never sent to the server. Servers, proxies, and access logs no longer see it.
2. Better: split the session ID into a public part (in the URL) and a secret part (also in the URL fragment). The hub only reveals peer state if the joiner can prove they have the secret, e.g. by HMAC-ing a server-issued nonce.
3. Best: optional host-issued one-time join tokens that are independent from the session ID, with a max use count. Lets the host revoke a leaked link without tearing down the session.

---

## High findings

### H1. Auto-receive default-on causes silent drive-by file delivery for files under 100 MB (NEW)

**Where:** [client/src/stores/appStore.ts](client/src/stores/appStore.ts), [client/src/services/MultiPeerFileTransferService.ts](client/src/services/MultiPeerFileTransferService.ts) (`completeIncomingTransfer`)

For files under the 100 MB streaming threshold, `completeIncomingTransfer` builds a Blob, creates an `<a download>`, and calls `a.click()` with no user interaction. Combined with `autoReceive` defaulting to true, anyone who has the session URL and a data channel can push arbitrary files to every peer's Downloads folder. Filename is sanitized (good), but extension is not constrained: `.html`, `.svg`, `.iso`, `.lnk`, `.pdf` with embedded JS, etc. all go through. Some browsers will warn on `.exe`, many won't.

Combine this with C2: a malicious joiner can spam files to every peer, even when "host only sending" is on.

**Fix options:**
- Default `autoReceive` to false. Show a one-tap accept prompt for the first file from each peer.
- For files below the streaming threshold, still go through `showSaveFilePicker` when supported, falling back to a confirm dialog otherwise.
- Cap the per-peer per-minute incoming file count and total bytes when auto-receive is on.

### H2. No ceiling on session-extension games via `ReportConnectionEstablished` (NEW)

**Where:** [server/Sendie.Server/Hubs/SignalingHub.cs](server/Sendie.Server/Hubs/SignalingHub.cs), [server/Sendie.Server/Services/SessionService.cs](server/Sendie.Server/Services/SessionService.cs)

`ReportConnectionEstablished` increments `ConnectedPeerPairs` with no rate limit, no idempotency, and no validation that an actual peer connection exists. While `ConnectedPeerPairs > 0` the session is rolled forward `_baseTtl` (30 min) on every `GetSession` call, capped only by the 24-hour absolute max when host is connected.

A single connected peer can:
- Repeatedly call `ReportConnectionEstablished` to drive `ConnectedPeerPairs` arbitrarily high.
- That value is decremented by `ReportConnectionClosed` and clamped at zero, so a peer that closes will leave a permanent positive count if they over-reported.
- Net result: session sits at the 24h hard cap consuming memory, and the "never expire while peers are actively connected" branch in `GetSession` keeps extending.

It's not a giant DoS (capped at 24h, capped at 10 peers per session, allow-list gates session creation). But the design is sloppy.

**Fix:** track connected pairs as a per-(peerA, peerB) set, not a counter. Reject duplicate `ReportConnectionEstablished` for the same target. Rate-limit these calls. On `OnDisconnectedAsync`, remove all pairs involving that connection.

### H3. Race conditions in `AddPeerToSession` (NEW)

**Where:** [server/Sendie.Server/Services/SessionService.cs](server/Sendie.Server/Services/SessionService.cs)

```csharp
if (peers.Count >= session.MaxPeers) return null;
...
if (!isInitiator && session.IsLocked) return null;
...
lock (peers) { peers.Add(peer); }
```

Both checks happen outside the lock. With concurrent joins or a join racing against `LockSession`, you can:
- Exceed `MaxPeers` by 1 to N depending on how many threads observe the pre-lock count.
- Slip a peer into a session at the exact moment it's being locked.

Real-world impact is small (capped at 10, allow-list, narrow timing window) but the fix is one move:

**Fix:** acquire `lock(peers)` before reading `peers.Count` and re-read `_sessions[sessionId]` for `IsLocked` inside the lock; or use an atomic add helper.

The same general pattern appears in `IsSessionCreator`/`LockSession` etc. — they read `_sessions`, check, and write back via `with`. Concurrent writers will lose updates because `ConcurrentDictionary` indexer assignment is last-write-wins. For `IsLocked`, `IsHostOnlySending`, and `ConnectedPeerPairs`, use `AddOrUpdate` with the update factory.

---

### H4. The "paste a URL to join" flow silently corrupts session IDs (NEW, pass 2 — functional bug with security flavor)

**Where:** [client/src/pages/HomePage.tsx](client/src/pages/HomePage.tsx#L91-L96)

```ts
if (sessionId.includes('/s/')) {
  const match = sessionId.match(/\/s\/([a-z0-9]+)/i);
  if (match) sessionId = match[1];
}
```

Session IDs are generated as URL-safe base64 (`SessionService.GenerateSessionId` → `RandomNumberGenerator.GetBytes(16)` → `Convert.ToBase64String` with `+→-` and `/→_`). Roughly 50% of generated IDs contain `-` or `_`. The regex `[a-z0-9]+` (case-insensitive) **excludes both characters**. Pasting a URL like `https://sendie.curlyquote.com/s/Ab-cD_EFghi` truncates to `Ab` and either 404s or, worse, hands you a silently-truncated prefix that happens to match a different session.

Why this matters for security and not just UX: if a user expects the join probe to fail and instead lands in *some other* session because the truncated prefix collided with another live session, they'll start exchanging keys and SDP with strangers. Probability is microscopic given 128-bit IDs but the failure mode is "you joined the wrong room", which is an integrity failure even when rare.

**Fix:** `match(/\/s\/([A-Za-z0-9_-]+)/)` and drop the case-insensitive flag. Server-side also validate the ID against the same alphabet (currently `GetSession` just does a dictionary lookup, which is fine, but reject early to avoid dictionary churn from junk).

---

## Medium findings

### M1. StreamSaver.js loads a third-party service worker by default (NEW)

**Where:** [client/src/services/MultiPeerFileTransferService.ts](client/src/services/MultiPeerFileTransferService.ts), [client/src/services/FileTransferService.ts](client/src/services/FileTransferService.ts)

`streamSaver.createWriteStream(...)` is called without setting `streamSaver.mitm`. The library's default `mitm` URL points at a page hosted on the maintainer's GitHub Pages site. When that fallback path is used (Firefox, Safari, large files where the FSA picker is dismissed), file bytes pass through an iframe + service worker hosted on a third-party origin. The bytes don't leave the browser, but the maintainer of that origin can ship JS that touches them.

This contradicts "files never touch a server" in spirit. For a project whose pitch is privacy, hosting the StreamSaver `mitm.html` yourself is the right call.

**Fix:** Vendor `mitm.html` and `sw.js` from the streamsaver package, serve them from the Sendie origin, and set `streamSaver.mitm = '/streamsaver/mitm.html'` at startup. Add a CSP that forbids the default origin so a regression fails closed.

### M2. No CSP, no security headers (confirmed from prior audit, still open)

**Where:** [client/nginx.conf](client/nginx.conf), [server/Sendie.Server/Program.cs](server/Sendie.Server/Program.cs)

The nginx config that serves the SPA has no `Content-Security-Policy`, no `X-Content-Type-Options`, no `X-Frame-Options`, no `Referrer-Policy`, no `Permissions-Policy`. Combined with M1, a strict CSP would have caught the third-party SW issue automatically.

A reasonable starter:
```
Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' wss://sendie.curlyquote.com https://stun.l.google.com:* ; img-src 'self' https://cdn.discordapp.com data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'
```
(Tune `connect-src` for your STUN/TURN list. Tailwind in production is precompiled, so `style-src 'self'` should work; if not, narrow to a hash.)

### M3. Cookie `SecurePolicy = SameAsRequest` in production code path (already in 2025-12 audit)

Still open. In the deployed `k8s/` setup the ingress terminates TLS so cookies will be marked Secure in practice, but this depends entirely on the proxy never being reconfigured. Make it `Always` and rely on dev being HTTPS-optional through configuration, not through a footgun default.

### M4. ICE configuration is hardcoded in `Program.cs`, no TURN, no auth (NEW-ish)

**Where:** [server/Sendie.Server/Program.cs](server/Sendie.Server/Program.cs) `/api/ice-servers`

Three Google STUN servers, no TURN. Two consequences:
1. Reliability: peers behind symmetric NAT can never connect. For a "share files with anyone" tool that's a big functional gap, but not security.
2. Privacy: the README acknowledges that peers see each other's IPs. With STUN-only, no relay, there is no way for users who want to hide their IP to opt in (the README correctly tells them to use a VPN). A future operator might add a TURN server with static credentials and ship them through this public endpoint, exactly as the 2025-12 audit warns. Add a code comment to `/api/ice-servers` saying "if you add TURN, switch to ephemeral REST credentials per RFC 7635" so future-you doesn't paste a static secret here.

### M5. Discord OAuth `SaveTokens = true` keeps an unused access token in the cookie (NEW)

**Where:** [server/Sendie.Server/Program.cs](server/Sendie.Server/Program.cs)

`options.SaveTokens = true` stuffs the Discord access + refresh tokens into the auth ticket, which is then encrypted with the Data Protection key and serialized into the `Sendie.Auth` cookie. The cookie is encrypted at rest on the server keyring (good, prior audit's PVC for `data/keys` is doing real work here) but the encrypted blob lives on the user's disk in their cookie jar, and is sent on every request to Sendie. The server never reads these tokens; the only Discord claim it consults is `urn:discord:id`.

Risks of leaving it on:
- Pointlessly larger cookie. Cookies > 4KB get dropped silently by some proxies; `SaveTokens` plus a few claims pushes Discord-auth cookies into the 2-3KB range routinely.
- If the Data Protection keys are ever exfiltrated (the PVC is on a shared cluster, somebody snapshots it, etc.), an attacker with stolen cookies can also extract a live Discord token. Without `SaveTokens`, the worst-case stolen-cookie scenario is "session in Sendie until logout".

**Fix:** `options.SaveTokens = false`. Trivial.

### M6. `GET /api/sessions/{id}` is unauthenticated and unrate-limited (NEW)

**Where:** [server/Sendie.Server/Program.cs](server/Sendie.Server/Program.cs)

Anyone with a session ID can probe metadata. The 128-bit ID makes blind enumeration infeasible, but this endpoint is also useful for "is this session still alive" oracles by anyone who *did* legitimately receive a link, including after they were kicked. Apply `SessionJoin` rate limiting to GET sessions too, or invent a `SessionLookup` policy.

---

### M7. `secrets.yaml.template` advertises a `CookieEncryptionKey` that the app never reads (NEW, pass 2)

**Where:** [k8s/secrets.yaml.template](k8s/secrets.yaml.template)

```yaml
CookieEncryptionKey: "REPLACE_WITH_GENERATED_KEY"
```

There is no configuration binding for `CookieEncryptionKey` anywhere in `Program.cs`. The actual cookie encryption is handled by `AddDataProtection().PersistKeysToFileSystem(...)`, which derives keys on first run and persists them to the PVC at `data/keys/`. Operators who follow the template will generate a 256-bit secret, save it carefully, and gain nothing from it.

Worse, the placeholder pattern invites someone to *replace* the actual mechanism with this string, breaking the existing key persistence. Documentation drift like this is how production gets a fresh key on every restart and logs everyone out (the very issue Data Protection persistence was added to fix, per the in-code comment).

**Fix:** delete the line. If you want a single configurable secret for some future feature, name it for that feature and wire it up.

---

### M8. `AllowListService.PersistAllowList` is non-atomic and runs synchronously inside admin requests (NEW, pass 2)

**Where:** [server/Sendie.Server/Services/AllowListService.cs](server/Sendie.Server/Services/AllowListService.cs)

Two issues, one file:

1. `File.WriteAllText(_persistencePath, json)` is not atomic. A crash, kill, or full disk between truncate and write loses the entire allow-list. Restart on the next deploy comes up with whatever was in config plus admin entries only. For the deploy size this targets it's not catastrophic, but it is preventable.
2. `AddUser` and `RemoveUser` perform `_allowedUsers.TryAdd / TryRemove`, then call `PersistAllowList()` without holding any cross-operation lock. Two concurrent admin requests (`AdminA` adds X, `AdminB` adds Y) interleave: both observe the snapshot before each other's mutation, and whichever one lands the second `PersistAllowList` writes a snapshot that includes its own change but may or may not include the other's, depending on dictionary timing. The in-memory state is correct (ConcurrentDictionary), the on-disk state can lose one entry until the next persist.

**Fix:** write to a temp path and `File.Move(tempPath, _persistencePath, overwrite: true)`. Either snapshot under `_fileLock` (`var snap = _allowedUsers.Values.Where(...).ToList(); File.WriteAllText(...)`) or, simpler, take the lock around the read+write rather than just the write.

---

### M9. `deploy.sh` uses `export $(grep -v '^#' .env | xargs)` (NEW, pass 2 — operational)

**Where:** [deploy.sh](deploy.sh)

This is a well-known footgun:
- Quoted values with spaces silently mangle.
- Values containing `$`, `*`, backticks, or globs are word-split and expanded.
- Anyone who accidentally puts a Discord client secret with a special character in `.env` will get a deploy that pushes the wrong secret to ACR and Kubernetes, or worse, expands a glob to file content.

It also implicitly trusts `.env` to be free of malicious content; for a script that subsequently runs `kubectl apply`, that trust matters.

**Fix:** `set -a; . ./.env; set +a` reads `.env` correctly under bash's `source` rules (still imperfect, but does not word-split values). Better: write a tiny YAML or `.envrc` and use a real loader.

---

### M10. Stateful SignalR reconnect after server restart can resurrect zombie peers (NEW, pass 2)

**Where:** [server/Sendie.Server/Program.cs](server/Sendie.Server/Program.cs) (`AllowStatefulReconnects = true`), [client/src/services/SignalingService.ts](client/src/services/SignalingService.ts) (`.withStatefulReconnect()`)

Stateful reconnect is great for transient network blips. But sessions live in a `ConcurrentDictionary` in process memory — they do not survive a restart. After a server-side restart, the client's stateful-reconnect logic will rebind `connectionId` on the server (at the SignalR transport layer) but `_sessions` will be empty, so:

- The peer believes it's still in session `S` with peers `[A, B]`.
- The hub has no record of `S`. Any inbound `SendOfferTo` from this client returns silently (no session match).
- The peer sees no errors, sees no events, but transfers all silently fail.

The data channels themselves may keep working (DTLS is between browsers), but new joiners and any signaling-mediated state changes (lock, kick, host-only) are lost forever.

**Fix:** either persist sessions across restarts (Redis backplane or similar — overkill for the project's scope), or have the hub send an explicit `OnSessionExpired` to any reconnected client whose `connectionId` is not present in any session, prompting the client to re-join cleanly.

---

## Low findings

### L1. Allow-list state divergence on admin demotion (NEW)

**Where:** [server/Sendie.Server/Services/AllowListService.cs](server/Sendie.Server/Services/AllowListService.cs)

Admins are loaded from config into `_admins`, then also written into `_allowedUsers` with source `"config"` and persisted. If you remove an admin from config and restart, the persisted file does not contain config-sourced users (good), so the in-memory state is rebuilt cleanly. So far OK. But:

- `RemoveUser` rejects removing anyone who is currently an admin. If a user was an admin in a previous run and had been added to the persisted JSON via something other than config, they remain allow-listed even after demotion. Low risk because admins are config-only.
- `AddUser` will overwrite a config-sourced entry's `AddedByAdminId` to the live admin's ID, losing the "added from config" provenance. The next persist cycle will then write that entry to disk. Restarts now have a duplicate: the user is in config and on disk. Not a security issue, but tidy this up by keying provenance separately or by skipping `AddUser` when the entry exists with source `"config"`.

### L2. `IsValidDiscordId` only checks length and digit-ness (NEW)

Discord snowflakes have a defined epoch and structure; a 17-19 digit string of zeros passes. Not exploitable beyond getting weird entries into your allow-list, but if you're going to validate, validate against the Discord epoch (Discord epoch starts 2015-01-01) by extracting the timestamp from the snowflake.

### L3. Dockerfile runs as root (already in 2025-12 audit)

Still open in [server/Sendie.Server/Dockerfile](server/Sendie.Server/Dockerfile). One-line fix.

### L4. `existingPeers` returned to a joiner exposes connection IDs of current participants

These IDs are needed for mesh setup. Just noting that anyone who can join can enumerate who else is in the session, including the host (`hostConnectionId` is also returned). Behaves correctly for the tool's threat model; document it.

### L5. `SendOffer` / `SendAnswer` / `SendIceCandidate` (broadcast variants) are dead code (NEW)

The mesh client only uses the targeted `*To` variants. The broadcast variants in `SignalingHub` (`SendOffer`, `SendAnswer`, `SendIceCandidate`, `SendPublicKey`, `SendSignature`) are still callable by any peer in any session and will fan out to every other peer. None of the flows expect this anymore. Delete them; less attack surface, less confusion.

### L6. `friendlyName` collisions trivially occur (NEW)

`generateFriendlyName` uses `H(jwk)[0] mod 64` and `H(jwk)[1] mod 64`. That's 4096 distinct names over the entire universe of users. Even within a 10-peer session there's a roughly 1.1% birthday collision per session. The SAS is what actually distinguishes peers, but the friendly name is what users will gravitate to in the UI. Consider three words instead of two, or include a 4-character hex tag.

### L7. ETag/Cache headers on `index.html` (NEW)

`nginx.conf` caches static assets `1y` immutable (good for hashed Vite output) but does not explicitly set `Cache-Control: no-cache` for `index.html`. SPA bootstrap files should be `no-cache` so users always pick up the latest hashed bundle pointers. Otherwise a stale `index.html` can reference deleted JS chunks.

### L8. `setBroadcastMode` and queued files persist across leave/rejoin via Zustand (NEW, behavior bug)

Skim [client/src/stores/appStore.ts](client/src/stores/appStore.ts) — if `queuedFiles` and `broadcastMode` are not reset on `handleLeaveSession`, the next session inherits them. The leave handler does call `clearQueuedFiles` and `setBroadcastMode(false)`, so this is currently safe. Worth a regression test, since the security implication is real: an unintended file gets sent to a stranger in a future session.

### L9. `addQueuedFile` accepts files even when `broadcastMode` is later disabled (NEW, pass 2)

**Where:** [client/src/stores/appStore.ts](client/src/stores/appStore.ts)

`isBroadcast` is captured at queue time from the current `broadcastMode`. If a user enables broadcast mode, drags in a sensitive file ("send to everyone who joins"), then disables broadcast mode without clearing, the file silently switches behavior: it stays in the queue with `isBroadcast: true` and gets force-sent to the next joiner via `getBroadcastFiles()` + `peersReceivedBroadcastRef`, even though the user's mental model is "broadcast is off, this file is just sitting there".

**Fix:** when toggling broadcast off, either prompt to clear broadcast files, or re-tag everything in the queue as `isBroadcast: false` so the next joiner only gets the one-time queue.

### L10. Console log noise leaks peer connection IDs to anyone with devtools open (NEW, pass 2)

`MultiPeerSessionPage` and the WebRTC services log `peerId` (which is a SignalR connection ID) on essentially every event. SignalR connection IDs are predictable-ish (Microsoft has changed the format over versions, but they have not been treated as secrets). Browser-extension supply-chain attacks that read console output (a real and growing class — see "extensions that exfiltrate logs") get a free map of who's in every session this user has ever joined. Production builds should down-shift these to `debug` and disabled by default.

### L11. `data/allowlist.json` and `data/keys/` ride on the same PVC, with no separation (NEW, pass 2)

**Where:** [k8s/server-pvc.yaml](k8s/server-pvc.yaml), [server/Sendie.Server/Services/AllowListService.cs](server/Sendie.Server/Services/AllowListService.cs)

A single PVC holds both the Data Protection master keys and the allow-list. An operator who hands a backup to a contractor for "audit the allow-list" is also handing them the keys that decrypt every active auth cookie. Trivial to fix by writing keys to a separate sub-path with stricter permissions, or splitting into two PVCs.

---

## What the existing 2025-12 audit got right and what it missed

Got right and still open: cookie `SecurePolicy`, CORS scope, security headers, file size limits (related to H1), Dockerfile root, ICE-server endpoint future risk.

Missed entirely:
- **C1** (the SAS-vs-DTLS gap) — this is the big one and it's framed in 2025-12 only as "make verification mandatory", which doesn't address the underlying flaw. Mandatory or not, the verification doesn't authenticate what users think it authenticates.
- **C2** (host-only sending unenforced).
- **C3** (open redirect via `returnUrl`).
- **C4** (session-page unprotected, leak-not-guess threat model).
- **H1** (silent file delivery).
- **H2** (`ReportConnectionEstablished` abuse).
- **H3** (peer-add race).
- **H4** (URL paste regex truncates valid IDs).
- **M1** (third-party StreamSaver service worker).
- **M5** (`SaveTokens = true`).
- **M7** (dead `CookieEncryptionKey` in template).
- **M8** (allow-list write is non-atomic).
- **M9** (`deploy.sh` env loading).
- **M10** (stateful reconnect leaves zombie peers after restart).
- **L5** (dead broadcast hub methods).
- **L9..L11** (broadcast queue stickiness, log leakage, key/allow-list co-location).

---

## Suggested order of operations

1. **C3** (open redirect): one-line fix, prevents real-world phishing today.
2. **C1**: bind SAS to DTLS fingerprint **or** stop calling SAS "identity verification" in copy. Smallest defensible fix is a one-screen change in `CryptoService.generateSAS` plus extracting fingerprints from the local SDP.
3. **C2**: receiver-side enforcement of host-only sending.
4. **H4**: fix the URL paste regex; one character of effort.
5. **H1**: default `autoReceive = false`, prompt on first incoming file from each peer.
6. **M1**: vendor StreamSaver `mitm.html` and pin `streamSaver.mitm`.
7. **M2**: ship a CSP and the standard header set.
8. **H2/H3**: fix the session-state races with `AddOrUpdate` and a per-pair connection set.
9. **M7/M8/M9**: clean up secrets template, atomic allow-list writes, fix `.env` loader.
10. Sweep: M3 (cookie Secure=Always), M5 (SaveTokens=false), M10 (zombie reconnect detection), L3 (Docker non-root), L5 (delete broadcast hub methods), L9 (broadcast queue sanity).

---

## One last creative thought

The sharpest improvement that costs little: make every file transfer **opt-in, per-file, by name and size**, and surface the sender's SAS-verified state in that prompt. That single UX change collapses H1, mitigates C2, and gives users a reason to actually compare the SAS code. Right now the SAS is a colored pill nobody clicks. If you have to click "Accept this file from cosmic-tiger" and you see that cosmic-tiger isn't verified, you'll think for half a second. That half-second is the entire point of the SAS.
