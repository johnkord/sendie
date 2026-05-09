# Sendie Security Remediation Plan

**Companion to:** [docs/security-audit-2026-05.md](security-audit-2026-05.md)
**Date:** May 2026 (revised after self-review)

This is the "what to actually do" doc. It groups the audit findings into shippable batches, ordered so each batch leaves the system in a working, defensible state. Each batch lists files touched, concrete code moves, tests, and rollback notes.

The ordering principle: **fix the things that break security promises before fixing the things that improve security posture.** A user reading the README today is being misled by C1 and C3 in particular. Everything else is hardening.

> **Self-review revisions:** the original draft of this plan contained subtle bugs in three of its own proposed fixes. They are corrected below and called out in `> NOTE` blocks so future reviewers can see what was wrong. The fixes that changed: 0.1 (relative-URL check accepted protocol-relative URLs), 2.2 (JWK serialization is non-canonical across browsers), 3.1 (`HashSet` is not thread-safe), 3.6 (session-ID length is exactly 22, not a range), 4.2 (`connect-src wss:` was way too broad).

---

## Phase 0 — Stop the bleeding (1 PR, ~1 hour)

These are one-line fixes that close real exploits with no design work.

### 0.1 Open-redirect: validate `returnUrl` (C3)

**File:** [server/Sendie.Server/Program.cs](../server/Sendie.Server/Program.cs)

> NOTE: the first draft of this fix used `Uri.TryCreate(returnUrl, UriKind.Relative, out _)` alone. That accepts `//evil.example/path` (a protocol-relative URL) which the browser then treats as absolute. The check below adds explicit rejection of leading `//` and `\\`.

```csharp
static bool IsSafeReturnUrl(string? value)
{
    if (string.IsNullOrEmpty(value)) return false;
    if (value.Length > 512) return false;                  // sanity
    if (!value.StartsWith('/')) return false;              // must be relative path
    if (value.StartsWith("//") || value.StartsWith("/\\")) return false; // protocol-relative
    return Uri.TryCreate(value, UriKind.Relative, out _);
}

app.MapGet("/api/auth/login", (string? returnUrl, IWebHostEnvironment env) =>
{
    var redirect = IsSafeReturnUrl(returnUrl)
        ? returnUrl!
        : (env.IsDevelopment() ? "http://localhost:5173" : "/");
    return Results.Challenge(
        new AuthenticationProperties { RedirectUri = redirect },
        [DiscordAuthenticationDefaults.AuthenticationScheme]);
});
```

Tests: parametrized integration test for `https://evil.example/`, `//evil.example/`, `/\\evil.example/`, `javascript:alert(1)`, oversized inputs. All must end on `/` (or the dev redirect).

Note that `ProtectedRoute` calls `authService.login(window.location.href)`, so post-fix any `?returnUrl=…` an attacker pre-loads onto the homepage URL is now harmless: the homepage URL itself is on Sendie's origin and is therefore relative-safe.

### 0.2 Fix the join-URL regex (H4)

**File:** [client/src/pages/HomePage.tsx](../client/src/pages/HomePage.tsx)

```ts
if (sessionId.includes('/s/')) {
  const match = sessionId.match(/\/s\/([A-Za-z0-9_-]+)/);
  if (match) sessionId = match[1];
}
```

Drop the `i` flag. Add a unit test with three known generated IDs that include `-` and `_`.

### 0.3 Cookie `SecurePolicy = Always` in production (M3)

Switch the default and gate the dev-relaxation on `IsDevelopment()`:

```csharp
options.Cookie.SecurePolicy = builder.Environment.IsDevelopment()
    ? CookieSecurePolicy.SameAsRequest
    : CookieSecurePolicy.Always;
```

### 0.4 `SaveTokens = false` (M5)

Single line in `.AddDiscord(...)`. No callers.

### 0.5 Delete dead broadcast hub methods (L5)

In [server/Sendie.Server/Hubs/SignalingHub.cs](../server/Sendie.Server/Hubs/SignalingHub.cs), remove the broadcast variants `SendOffer`, `SendAnswer`, `SendIceCandidate`, `SendPublicKey`. Keep only the `*To` targeted versions.

In [client/src/services/SignalingService.ts](../client/src/services/SignalingService.ts), remove the matching `sendOffer`, `sendAnswer`, `sendIceCandidate`, `sendPublicKey` client methods.

**Keep `SendSignature` / `OnSignature` for now.** They are dead code today, but Phase 2 will use them. Deleting and re-adding is two more diffs for no benefit. Add a `// TODO(phase-2): used by signature verification flow` comment so the next reader doesn't think it's still dead.

Rationale: less attack surface, less confusion.

### 0.6 Remove `CookieEncryptionKey` placeholder (M7)

Delete the line from [k8s/secrets.yaml.template](../k8s/secrets.yaml.template). Add a one-line comment noting that cookie keys are managed automatically via Data Protection on the server PVC.

**Phase 0 deliverable:** one PR titled "security: phase 0 — close trivially-exploitable issues". After merge, C3, H4, M3, M5, M7, L5 are done.

---

## Phase 1 — Stop default drive-by file delivery (1 PR, ~half a day of UX work)

### 1.1 Default `autoReceive = false` (H1)

**File:** [client/src/stores/appStore.ts](../client/src/stores/appStore.ts)

```ts
autoReceive: false,
```

### 1.2 Per-file accept prompt with sender identity

**File:** [client/src/services/MultiPeerFileTransferService.ts](../client/src/services/MultiPeerFileTransferService.ts)

Replace the current `autoReceiveChecker` model with an async `acceptIncomingFile(peerId, fileName, fileSize)` callback that returns a `Promise<boolean>`. The page wires this to a modal that shows:

- Peer's friendly name + SAS code (with a clear "verified out-of-band? Y/N" toggle)
- File name (post-sanitization), file size, MIME type
- Buttons: Accept once, Accept all from this peer for this session, Reject

The modal stores per-peer "accept all from this peer" state in the page-scoped state, not Zustand (so it doesn't leak across sessions). When `autoReceive` is true the prompt is bypassed; default is false, so the prompt drives the flow.

**Note on the SAS shown here:** until Phase 2 lands, the SAS in this prompt is the legacy unbound one (only authenticates the JWK exchange, not the DTLS endpoints). The prompt UI should still surface it because it raises user awareness for the moment Phase 2 makes it actually load-bearing. After Phase 2, the SAS in this prompt is the bound version with no UI changes needed.

**Sender side:** apply backpressure when the receiver hasn't responded. Currently `sendFileToPeer` blasts the full file as soon as `file-start` is sent. After this change, the sender should wait for a `file-accept` or `file-decline` message from the receiver before transmitting any chunks. Otherwise a rejected file still wastes bandwidth and the sender's UI shows a spurious in-progress transfer.

### 1.3 Force `showSaveFilePicker` for sub-100MB when supported

In `completeIncomingTransfer`, the small-file path currently does `<a download>` with no user interaction. Switch to:

```ts
if ('showSaveFilePicker' in window) {
  const handle = await window.showSaveFilePicker({ suggestedName: incoming.fileName, ... });
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
} else {
  // existing <a download> path, but only after the user already accepted in 1.2
}
```

In Firefox/Safari (no FSA) the prompt-and-then-download flow from 1.2 is sufficient.

### 1.4 Receiver-side enforcement of host-only sending (C2)

Plumb `connection.isHostOnlySending` and `connection.hostConnectionId` into `MultiPeerFileTransferService` (callback or setter). In `initializeIncomingTransfer`:

```ts
if (this.hostOnlySending() && peerId !== this.hostConnectionId()) {
  this.events.onFileDeclined?.(peerId, message.fileId);
  return;
}
```

This is small but it's the difference between a UI hint and an enforced rule.

### 1.5 L9: classify queued files at send-time, not queue-time

In `appStore.ts`, drop `isBroadcast` from `QueuedFile`. In `handleDataChannelOpen`, decide based on the *current* `broadcastMode`:

- One-time files (sent to first peer only) and broadcast files (sent to every joiner) become two stable arrays selected by current mode at the moment of send.

Or: when broadcast toggles off, clear `isBroadcast: true` from existing entries. Pick whichever fits your model better. The current behavior is "I queued this thinking it would broadcast" silently keeping that intent after the user thinks they undid it.

**Phase 1 deliverable:** PR "security: phase 1 — explicit consent for incoming files". H1, C2, L9 closed.

---

## Phase 2 — Real identity verification (1-2 PRs, ~2 days)

This is the headline fix. The goal: SAS that **actually authenticates the DTLS endpoints**. Without this, "End-to-End Encrypted" is a marketing claim.

The cheapest path that closes C1 honestly is:

> **Bind the SAS to the DTLS fingerprints.**

### 2.1 Extract DTLS fingerprints from SDP

**File:** [client/src/services/CryptoService.ts](../client/src/services/CryptoService.ts) (or new `FingerprintService.ts`)

```ts
export function extractFingerprint(sdp: string): string | null {
  const m = sdp.match(/^a=fingerprint:(\S+ \S+)/m);
  return m ? m[1].toLowerCase() : null; // e.g. "sha-256 ab:cd:..."
}
```

Pull the local fingerprint right after `setLocalDescription`. Pull the remote fingerprint right after `setRemoteDescription`.

### 2.2 Update SAS hash domain

> NOTE: the first draft serialized JWKs with `JSON.stringify`. JWK property order from `crypto.subtle.exportKey('jwk', ...)` is **not specified** to be canonical. Two browsers exporting the same key can produce string-different JWK JSON, which would make both sides compute different SAS values and reject every session. Canonicalize before hashing.

```ts
function canonicalJwk(jwkString: string): string {
  const obj = JSON.parse(jwkString) as Record<string, unknown>;
  // For P-256 ECDSA we only care about kty, crv, x, y. Drop key_ops/ext/use which
  // can differ between browsers. Sort keys for stable serialization.
  const trimmed = { kty: obj.kty, crv: obj.crv, x: obj.x, y: obj.y };
  return JSON.stringify(trimmed, Object.keys(trimmed).sort());
}

async generateSAS(
  localKeyJwk: string, remoteKeyJwk: string,
  localFp: string, remoteFp: string,
  sessionId: string
): Promise<string> {
  const a = [canonicalJwk(localKeyJwk), localFp.toLowerCase()];
  const b = [canonicalJwk(remoteKeyJwk), remoteFp.toLowerCase()];
  // Canonical ordering so both peers compute the same value regardless of role.
  const [low, high] = a[0] < b[0] ? [a, b] : [b, a];
  const domainTag = 'sendie/sas/v2';
  const blob = `${domainTag}|${low[0]}|${low[1]}|${high[0]}|${high[1]}|${sessionId}`;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(blob));
  // ... existing 4-word output from first 4 bytes ...
}
```

- The `domainTag` defangs hash collisions with anything else the app ever digests (file hashes, etc.).
- `sessionId` defangs cross-session SAS replay if a session ID ever escapes.
- Pipe-delimitation with field count audit prevents a `|` injection in a JWK ever shifting field boundaries (in practice JWK fields are constrained, but explicit > implicit).

### 2.3 Restore the signature flow

This is no longer dead code. Each peer:

1. After data channel `open`, generate a 32-byte random `nonce_local` and send `{ nonce: nonce_local, fp: fp_local, jwk: pubKeyJwk_local }` over the data channel.
2. Receive the peer's `{ nonce: nonce_remote, fp: fp_remote, jwk: pubKeyJwk_remote }`.
3. Verify `fp_remote` matches the fingerprint observed in the remote SDP (i.e. the peer is asserting the same DTLS identity the SDP claimed). If not, fail.
4. Build the canonical sign-payload (same canonicalization rules as 2.2's SAS):

   `"sendie/auth/v1" | sessionId | min(jwk_a, jwk_b) | max(jwk_a, jwk_b) | nonce_local | nonce_remote | fp_local | fp_remote`

   ECDSA-with-SHA-256 sign it. Send the signature.
5. Verify the peer's signature against `pubKeyJwk_remote`.

If any step fails or **does not complete within 10 seconds of data-channel open**, tear down the data channel and surface "verification failed: possible MITM" (red, not yellow). The 10-second timeout is the missing piece in the original plan: a malicious server can simply stall the verification step forever, leaving the channel in a permanent "unverified" state where the user might be tempted to send anyway.

The signature exchange goes **over the data channel**, not over the signaling server. This is important. By the time the data channel is open, DTLS is up; if the server MITM'd the SDP, the data channel is between victim↔server, so the server would have to forge the signature to keep up the illusion. Forging requires the peer's private key, which never leaves the browser. (Note: this means SignalR's `SendSignature`/`OnSignature` from Phase 0 can be deleted in Phase 2 — the signature does not transit the signaling server at all.)

**File-level data channel message type:** add `{ type: 'verification-init'|'verification-sig'; ... }` to `DataChannelMessage` in `client/src/types/index.ts`. The receiver-side `handleControlMessage` switches on these before any `file-start` is allowed through.

### 2.4 UI: gate file transfers on verification, not on data-channel readiness

**File:** [client/src/pages/MultiPeerSessionPage.tsx](../client/src/pages/MultiPeerSessionPage.tsx)

`canSendFiles` becomes `isConnected && allOpenChannelsAreVerified && !hostOnlyRestricted`. Receivers reject files from unverified peers (or surface a stronger warning if the user opts in to "trust unverified for this session" — see L10's note about the SAS being theatre if nobody compares it).

### 2.5 README correction

Until 2.1-2.4 are merged, change the README's first bullet to:

> **🔒 Encrypted in transit** — All transfers use DTLS encryption between browsers (built into WebRTC). End-to-end against passive network attackers; SAS code comparison protects against active MITM.

After 2.1-2.4 are merged, restore the stronger claim, but pin it to a docs page that explains the SAS step honestly. No marketing language.

**Phase 2 deliverable:** PR "security: phase 2 — bind SAS to DTLS fingerprints". C1 closed.

---

## Phase 3 — Server hardening (1 PR, ~1 day)

### 3.1 Replace counter with set in `ConnectedPeerPairs` (H2)

**File:** [server/Sendie.Server/Services/SessionService.cs](../server/Sendie.Server/Services/SessionService.cs)

> NOTE: the first draft of this plan said `ConcurrentDictionary<string, HashSet<...>>`. `HashSet<T>` is **not** thread-safe; concurrent writers will corrupt internal buckets. Use a `ConcurrentDictionary<(string, string), byte>` as a set, or wrap a `HashSet` in `lock`.

Track active P2P pairs per session. Recommended: 

```csharp
private readonly ConcurrentDictionary<string, ConcurrentDictionary<(string, string), byte>> _connectedPairs = new();

static (string, string) Canon(string a, string b) =>
    string.CompareOrdinal(a, b) <= 0 ? (a, b) : (b, a);
```

`ReportConnectionEstablished(targetPeerId)` adds `Canon(connId, target)` to the inner dict (no-op if already present). `ReportConnectionClosed` removes it. `OnDisconnectedAsync` enumerates the inner dict and removes any tuple containing this connection.

`GetSession` reads `pairs.Count` instead of the integer field. Counter abuse becomes impossible because adding the same pair twice is a no-op in a set.

Add rate limit: `ReportConnectionEstablished` becomes a `SignalingMessage`-policy call.

Also: the existing `ConnectedPeerPairs` field on the `Session` record can be derived (`session.ConnectedPeerPairs => _connectedPairs.GetValueOrDefault(id)?.Count ?? 0`). Keep the field for serialization but compute it on read; never write to it directly.

### 3.2 Atomic, race-free session mutations (H3)

Use `_sessions.AddOrUpdate(sessionId, addFactory, (_, old) => old with { ... })` for everything that currently does read-modify-write. The candidates: `LockSession`, `UnlockSession`, `EnableHostOnlySending`, `DisableHostOnlySending`, `IncrementConnectedPairs` (becomes set-add), `DecrementConnectedPairs`, `UpdateHostConnectionState`, `MarkSessionEmpty`, `ClearSessionEmpty`, `ExtendSession`.

`AddPeerToSessionInternal` needs a single-lock path: take the lock on the session's peer list, re-check `peers.Count < session.MaxPeers` and `!session.IsLocked || isInitiator` *inside* the lock, then insert.

Tests: a hammer test that spawns N concurrent `AddPeerToSession` calls against `MaxPeers = 5` and asserts the post-condition is exactly 5 peers, not 5+ε.

### 3.3 Atomic allow-list persistence (M8)

**File:** [server/Sendie.Server/Services/AllowListService.cs](../server/Sendie.Server/Services/AllowListService.cs)

```csharp
private void PersistAllowList()
{
    var snap = _allowedUsers.Values
        .Where(u => u.AddedByAdminId != "config")
        .Select(u => new PersistedUser(u.DiscordUserId, u.AddedAt, u.AddedByAdminId))
        .ToList();

    lock (_fileLock)
    {
        var tmp = _persistencePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(snap, _jsonOptions));
        File.Move(tmp, _persistencePath, overwrite: true);
    }
}
```

Take the lock around the snapshot+write, not just the write — otherwise concurrent `AddUser`/`RemoveUser` calls each compute their own snapshot and the last writer can lose changes.

### 3.4 Rate-limit `GET /api/sessions/{id}` (M6)

Add a new `RateLimitPolicy.SessionLookup` (60/minute per IP feels right). Apply at the endpoint:

```csharp
app.MapGet("/api/sessions/{id}", (string id, HttpContext ctx, ISessionService s, IRateLimiterService rl) =>
{
    var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    var r = rl.IsAllowed(ip, RateLimitPolicy.SessionLookup);
    if (!r.IsAllowed) { ctx.Response.Headers["Retry-After"] = "60"; return Results.StatusCode(429); }
    var session = s.GetSession(id);
    return session == null ? Results.NotFound() : Results.Ok(session);
});
```

### 3.5 Detect zombie sessions on stateful reconnect (M10)

In `OnConnectedAsync`, if the connection is a reconnect (SignalR exposes this via the connection feature) and the connection is not present in any session, send `Clients.Caller.SendAsync("OnSessionExpired")` and let the client re-join cleanly. Client wires `OnSessionExpired` to a re-join attempt; if the session doesn't exist anymore, navigate to `/` with a friendly error.

### 3.6 Session ID validation at API boundary (defense for H4 even after the regex fix)

> NOTE: the first draft used a 20–24 char range. `Convert.ToBase64String(16-byte)` is exactly 24 chars; trimming `=` padding leaves exactly 22. Validate the exact length, not a range.

```csharp
static bool IsValidSessionId(string id)
    => id.Length == 22
    && id.All(c => char.IsLetterOrDigit(c) || c is '-' or '_');
```

Apply to `GET /api/sessions/{id}` and `JoinSession`. Reject early with 400, before doing any dictionary work, so junk input cannot drive cache pressure.

### 3.7 Tighten Discord ID validation (L2)

Check the snowflake's embedded timestamp is after Discord's epoch (2015-01-01) and before now+1 day. Tiny win, but if you're already validating, validate well.

### 3.8 Tighten CORS (M4 from prior audit, still open)

```csharp
policy.WithOrigins("http://localhost:5173", "http://127.0.0.1:5173")
      .WithHeaders("Content-Type")
      .WithMethods("GET", "POST", "DELETE")
      .AllowCredentials();
```

### 3.9 Per-Discord-ID rate limit on session creation (NEW)

**File:** [server/Sendie.Server/Services/RateLimiterService.cs](../server/Sendie.Server/Services/RateLimiterService.cs), [server/Sendie.Server/Program.cs](../server/Sendie.Server/Program.cs)

The current `SessionCreate` policy is keyed by client IP. That has two failure modes worth noting:

- Allow-listed users behind a NAT (corporate proxy, mobile carrier CGNAT) share the bucket, so one user can lock out others.
- An allow-listed user with multiple IPs (VPN-hopping, dual-stack) bypasses the limit.

Apply both an IP-based and a Discord-ID-based limit on `POST /api/sessions`; reject if either is exceeded. Use a tighter per-user limit (e.g. 30/hour) and the existing per-IP one as a backstop.

### 3.10 Admin audit log (NEW, low priority)

`AddUser`/`RemoveUser` log via the standard logger (good), but to a stream nobody is reading. Append a structured audit line to `data/admin-audit.log` with `{ timestamp, adminId, action, targetId }`. Keep it append-only; do not persist anything else there. Useful when you have to ask "who added that user?" six months later.

**Phase 3 deliverable:** PR "security: phase 3 — server-side correctness and rate limits". H2, H3, M4, M6, M8, M10, L2, plus 3.9/3.10 closed.

---

## Phase 4 — Frontend hardening (1 PR, ~half a day)

### 4.1 Vendor StreamSaver `mitm.html` and pin it (M1)

```bash
mkdir -p client/public/streamsaver
cp client/node_modules/streamsaver/mitm.html client/public/streamsaver/
cp client/node_modules/streamsaver/sw.js client/public/streamsaver/
```

In each file that imports streamsaver, set `streamSaver.mitm = '/streamsaver/mitm.html'` once at module load. Add a CI check that fails if the bundle still references `jimmywarting.github.io`.

### 4.2 CSP and security headers (M2)

**File:** [client/nginx.conf](../client/nginx.conf)

> NOTE: the first draft had `connect-src 'self' wss:` which allows WebSocket connections to *any* host. SignalR connects same-origin, so `wss:` blanket is unnecessary and dangerous. Pinned below.

```nginx
# Roll out as Content-Security-Policy-Report-Only first to catch breakage; flip to enforcing once clean.
add_header Content-Security-Policy "default-src 'self'; connect-src 'self'; img-src 'self' https://cdn.discordapp.com data:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; worker-src 'self' blob:; object-src 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()" always;
add_header X-Frame-Options "DENY" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;  # ingress already sends this; double-add is harmless

# index.html must not be cached so SPA bundle pointers stay fresh
location = /index.html {
    add_header Cache-Control "no-store" always;
}
```

Notes:
- `connect-src 'self'` covers `/hubs/signaling` (SignalR upgrades to WSS on the same origin) and `/api/*`. WebRTC peer connections don't go through `connect-src` — they're outside the fetch/WebSocket model.
- `worker-src 'self' blob:` is needed for StreamSaver's service worker once vendored (4.1).
- `style-src 'unsafe-inline'` is unfortunate but Tailwind v3 can emit inline styles for dynamic class hydration. If/when migrating to Tailwind v4 or precompiled output, drop `'unsafe-inline'` and use a hash.
- The same set goes on the C# response pipeline for `/api/*` and `/hubs/*` (use `app.Use(...)` middleware before `UseAuthentication`). Don't rely solely on nginx — direct pod-to-pod connections during port-forward bypass it.

**Verification step:** run with `Content-Security-Policy-Report-Only` for one full deploy cycle, watch the browser console and Sentry/equivalent for violations, then flip to enforcing. Skipping this step is how teams ship a CSP that breaks login on Safari at 2am Saturday.

### 4.3 Dev-only console logging (L10)

Add a tiny `log.ts`:

```ts
export const log = {
  debug: import.meta.env.DEV ? console.log.bind(console) : () => {},
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
```

Replace every `console.log(...)` in `services/` and `pages/` with `log.debug(...)`. Errors stay visible. Ten-minute sweep.

### 4.4 Friendly-name collision improvement (L6)

> Why this is in the security PR and not a UX PR: today the friendly name is the most prominent identifier in the peer list, and people will pattern-match on it ("oh, that's still cosmic-tiger") even though the SAS is what actually distinguishes peers. A 1.1%-per-session collision rate means social-engineering attacks where an attacker engineers a collision are not implausible. Sketchy, but cheap to fix.


Move from 4096 to ~16M names by either:
- Three words instead of two (`64 * 64 * 64` ≈ 262k), or
- Two words plus a 4-character hex tag derived from the next two bytes of the hash.

Not security-critical, but makes the SAS the obvious differentiator instead of the friendly name being mistaken for one.

### 4.5 `robots.txt` blocks indexing of session URLs (NEW)

**File:** new `client/public/robots.txt`

```
User-agent: *
Disallow: /s/
```

If a session URL ever ends up in a sitemap, an HTTP referer that gets crawled, or a public paste, this prevents Bing/Google from indexing it. Cheap, no downside.

### 4.6 Strip `Referer` for outbound links from session pages (NEW)

Add `<meta name="referrer" content="strict-origin-when-cross-origin">` to `index.html` (the response header in 4.2 already does this; the meta is a belt-and-braces in case the headers are stripped by an upstream cache).

**Phase 4 deliverable:** PR "security: phase 4 — frontend headers and supply chain". M1, M2, L6, L7, L10, plus 4.5/4.6 closed.

---

## Phase 5 — Operations (1 PR, ~2 hours)

### 5.1 Non-root container (L3 from prior audit, still open)

**File:** [server/Sendie.Server/Dockerfile](../server/Sendie.Server/Dockerfile)

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
RUN adduser --disabled-password --gecos '' --uid 1001 appuser \
 && mkdir -p /app/data/keys \
 && chown -R appuser:appuser /app
USER appuser
COPY --from=build --chown=appuser:appuser /app/publish .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Sendie.Server.dll"]
```

Verify the PVC mount path is writable by uid 1001 in `k8s/server-deployment.yaml` (`securityContext.fsGroup: 1001`).

### 5.2 Split keys and allow-list onto separate paths (L11)

Two options:
- Different sub-paths on the same PVC with stricter permissions on `data/keys` (`chmod 700`, owned by `appuser`).
- Two PVCs.

The first costs nothing and addresses the "give the contractor the allow-list" failure mode by making the keys a separate restorable artifact.

### 5.3 `deploy.sh` env handling (M9)

```bash
# old: export $(grep -v '^#' .env | xargs)
set -a
. ./.env
set +a
```

Or migrate to `direnv` / a real config tool. Either way, document that `.env` must be quoted.

### 5.4 `AllowedHosts` for production (L8 from prior audit)

`appsettings.Production.json`:

```json
{ "AllowedHosts": "sendie.curlyquote.com" }
```

**Phase 5 deliverable:** PR "security: phase 5 — operations and packaging". L3, L8, L11, M9 closed.

---

## Phase 6 — Strategic re-architecture (separate proposal doc, schedule later)

This phase exists to acknowledge that two findings cannot be papered over with code-level fixes. They want design changes.

### 6.1 Session ID exposure (C4)

The fundamental problem: anyone with the URL is in. The URL leaks via too many channels.

**What this design defends against and what it does not:** the URL-fragment trick stops the URL from being sent to *anything other than the user's browser* — server access logs, HTTP referer headers, chat-bot URL preview fetches, antivirus URL scanners, browser-history cloud sync. It does **not** protect against the signaling server itself; the server eventually sees the secret over WSS during `JoinSession`. C4 was always a leak threat, not a server-trust threat (that's C1's job).

Three concrete options, in increasing complexity:

**Option A — URL fragment for the secret half (small change)**

Generate sessions with a public ID and a separate 128-bit secret. Format: `https://sendie.curlyquote.com/s/<publicId>#k=<secret>`. The fragment never goes to the server in the initial GET. The server stores `H(publicId || secret)` (with a server-side pepper) and `JoinSession` requires the joiner to send the secret over the SignalR connection (which is TLS).

Migration is a hard cutover, not a soft one — old `/s/<publicId>` links without a `#k=` fragment cannot authenticate against the new format. Plan for it:

1. Deploy step 1: server accepts both formats. Old format issues a deprecation header and a short TTL (sessions created before cutover continue without secret; sessions created after require secret).
2. After max session TTL (24h) elapses, all old-format sessions have expired naturally. Remove old-format support.

Alternative gentle path: generate a secret for new sessions but keep old-format optional for one full release cycle, with the server logging when an old-format session is used so you know when usage drops to zero.

**Option B — Host-issued, revocable join tokens**

Same as A but the host can issue N one-time or count-limited tokens, each tied to the session. Lets a host say "here's a link for Alice" and revoke it without rotating the session. Implementation cost: a small per-session token store (still in-memory, expiring with the session).

**Option C — Mandatory verification before any data flows**

Treat the SAS as load-bearing: no file metadata is even shown to a recipient until the SAS is acknowledged. This is the UX move discussed in pass 1's "creative thought".

Recommendation: ship A first. It costs almost nothing, addresses the most common leak vector, and doesn't change the host's mental model. C should ride alongside Phase 2 because the SAS is now real.

### 6.2 Session persistence across server restarts (M10 deeper fix)

The Phase 3 fix (detect zombies, force re-join) is correct but mediocre UX. The real fix is a SignalR backplane. Redis is overkill for this app's scale, but a tiny SQLite-backed `ISessionService` implementation that mirrors the in-memory state would survive restarts. Worth doing only if the project moves beyond a single replica.

---

### 6.3 Admin lockout safety (NEW)

`AllowListService` refuses to remove anyone listed as an admin in config. Good. But there is no guard against an admin removing the *last allow-listed user that isn't themselves*, then losing access to their Discord account. Recovery means a code+config change.

Low-effort fix: a startup self-test that logs a loud warning if `_admins` is empty after config load ("the system is now unmanageable; add an admin to AccessControl:Admins and redeploy"). One-line.

### 6.4 Threat-model documentation (NEW)

Write `docs/threat-model.md` once the above is shipped. Be honest about:
- What Sendie protects against: passive network attackers, casual session-URL discovery, drive-by file delivery (after Phase 1).
- What Sendie does **not** protect against without Phase 2: a malicious or compromised signaling server.
- What Sendie does not protect against ever: a malicious peer who you give the link to (this is by design, consistent with the README).
- The IP-exposure note from the README, expanded.

Without this doc, every new contributor and every audit (including this one) re-derives the same threat model from scratch and gets the answers slightly different.

---

## What we are explicitly *not* doing

- **End-to-end encryption above DTLS.** The 2025-12 audit suggested deriving a symmetric key from the ECDSA exchange and re-encrypting chunks. Once Phase 2 binds SAS to DTLS, this provides defense-in-depth only against an attacker who breaks DTLS itself, which is a very different threat model. Skip unless someone shows up with that threat model.
- **TURN servers.** Out of scope. The README is honest that peers see each other's IPs. Adding TURN with static credentials would be worse than not having it.
- **Anti-CSRF on logout (item 10 in 2025-12).** The cookie is `SameSite=Lax` and the consequence of a forged logout is a logged-out user. Not worth the complexity.

---

## Phase 7 — Post-merge: monitoring and watchposts

After the phases above land, add ongoing checks. None of these are gates on shipping the phases; they are how you find out a regression happened.

- **CSP violation reports.** Add `report-uri` (or `report-to`) to the CSP and pipe to whatever logging endpoint you use. The first time someone introduces a third-party script tag, you'll see it in minutes, not weeks.
- **Verification-failure metric.** After Phase 2, instrument client-side how often verification fails. A non-zero baseline is normal (browser quirks, races). A spike is either a bug or an attack — investigate either way.
- **Rate-limit denial metric.** Per-policy counters (`SessionCreate denied`, `SessionJoin denied`, etc.) so you can spot enumeration attempts that aren't quite hitting the per-bucket limit but are persistent.
- **`unverified-transfer` metric.** If anyone manages to send/receive a file before verification completes (shouldn't be possible after Phase 2, but a metric of zero is your proof), alert.
- **Dependency scan.** `npm audit` and `dotnet list package --vulnerable` in CI. StreamSaver in particular is a sleepy package; if it ever ships a malicious update, you want CI yelling about it.
- **Periodic SAS-mismatch user reports.** If users start saying "the SAS doesn't match", that's either a bug in our canonicalization or an actual MITM. Add a quick "Report mismatch" button in the peer list that pings a low-volume admin alert.

---

## Test strategy summary

Per-phase, the minimum:

| Phase | Tests added |
|-------|-------------|
| 0 | Open-redirect integration test (parametrized: `https:`, `//`, `/\\`, `javascript:`, oversized); URL paste regex unit tests covering 50 random session IDs |
| 1 | E2E test: default reject, user accepts, accept-all-from-peer carries to next file; sender backpressure: rejected file produces no chunks on the wire |
| 2 | Unit tests on canonical SAS computation including a fingerprint-mismatch case and a JWK-property-order-difference case; integration test that simulates a server replacing fingerprints and asserts verification fails; timeout test for verification stalled mid-flow |
| 3 | Concurrent peer-add hammer test (100 threads vs `MaxPeers=5`); allow-list persistence under concurrent admin requests with kill -9 mid-write; rate-limit unit tests for the new policy and per-Discord-ID limit; `IsValidSessionId` boundary tests |
| 4 | CSP regression check via Playwright + console-error capture; bundle-content check that there is no `jimmywarting.github.io` reference; `robots.txt` served correctly |
| 5 | Container starts as uid 1001 and can write to `/app/data`; `data/keys` permissions are 0700 |

Existing tests should not regress. `Sendie.Server.Tests/` has integration scaffolding; reuse it.

---

## Rollout

Ship the phases in order. After each phase, deploy to a staging slot for at least 24 hours. Phases 0, 1, 5 are low-risk. Phase 2 is the riskiest because it changes the verification UX and rejects unverified transfers — stage it behind a feature flag (`Verification:RequireBoundSas`) defaulting on in dev, off in prod for the first deploy, then flip after a quiet 48h.

**Phase 4's CSP** also wants the soft-rollout: ship as `Content-Security-Policy-Report-Only` first, watch reports for at least one full deploy cycle, then flip to enforcing.

If anything breaks: each phase is a separate PR. Revert is straightforward. Phase 6 is a separate proposal doc, not a PR — do not start on it without a fresh design review of the migration plan.

---

## Self-review checklist (for the next reviewer)

If you're reading this plan and about to start implementing, sanity-check these in order. Each one is a place I either had to revise during self-review or is a place where it's tempting to take a shortcut that bites you.

1. Does 0.1's `IsSafeReturnUrl` reject `//evil.example/`? (It must.) Test it.
2. Does 2.2's SAS computation produce identical output between Chrome and Firefox? Run the canonicalization tests on both.
3. Does 2.3's verification-failure path actually tear down the data channel, or does it just set a UI flag while the channel keeps living? It must close.
4. In 3.1, are you using `ConcurrentDictionary` as a set, or did you reach for `HashSet` again? (If you wrote `lock(_pairs)` anywhere, you reached.)
5. In 3.6, did you write a length range or `length == 22`? It must be exact.
6. In 4.2, did you ship CSP as `Report-Only` first? If you went straight to enforcing, you'll find out about an incompatible header at the worst possible time.
7. In Phase 6 Option A, did you try to keep old links working forever? (You can't; either cut over with a TTL window or spawn two formats during transition.)

---

## Phase 8 — Deployment verification

**Status:** to run after each phase deploys to staging, and once more after the full set lands in production. Smoke tests, not unit tests; we are checking that the moving parts work together against a real ingress, real Discord OAuth, real DTLS.

The goal: catch the failure modes that unit tests cannot — TLS-vs-cookie-policy mismatches, CSP-vs-Discord-CDN conflicts, ingress timeout vs SignalR keep-alive interactions, fragments getting stripped by some unexpected proxy, etc.

### 8.1 Pre-deploy checklist (run locally before pushing)

- [ ] `dotnet test` passes (server)
- [ ] `npm run build` produces no TypeScript or rollup errors (client)
- [ ] `npm test -- --run` passes (client)
- [ ] `grep -r "jimmywarting.github.io" client/dist/` returns nothing (StreamSaver mitm is vendored)
- [ ] `grep -r "console.log" client/src/services client/src/pages` is reviewed (debug logs should go through `log.debug`)
- [ ] `git diff` against `main` for `appsettings.json` and `k8s/secrets.yaml.template` does not introduce unexpected secrets

### 8.2 Smoke test plan (run against staging after each phase)

For each, use two real browser profiles (or one browser plus an incognito window). Mark each step pass/fail in the deploy ticket.

#### S1: Auth and session creation
1. Visit the staging URL in a fresh browser profile.
2. Click "Sign in with Discord", complete OAuth.
3. Land back on the home page. The header shows the Discord username.
4. Click "Create New Session".
5. Verify the URL has the form `/s/<22 chars>#k=<22 chars>` (Phase 6.1).
6. Open DevTools Network tab. Confirm the URL fragment is **not** in any request to the server (search for `#k=` in the request panel; nothing).

#### S2: Cross-device join
1. From browser A (host), copy the session URL.
2. Paste into browser B (joiner). The page should load and join.
3. Verify both peer tiles show "Connected" and a SAS code.
4. Both peers compare the SAS code on a side channel (the test runner reads it aloud). They must match exactly.
5. Verify the friendly names match what each browser shows.

#### S3: File transfer (drive-by gating)
1. From browser A, drop a 10MB file.
2. On browser B, observe a confirm dialog: "Browser A wants to send you: foo (10 MB)". Click Cancel.
3. On browser A, the transfer shows "declined". Bytes-on-wire counter is approximately zero (verify with DevTools Network panel; it should not show 10MB transit).
4. Drop the same file again, click Accept on browser B.
5. The save-file picker opens (Chrome/Edge) or the file downloads to default location (Firefox/Safari).
6. SHA256 of the received file matches the source. (Run `sha256sum` on both ends.)

#### S4: Verification rejection
1. Use a man-in-the-middle proxy (or tooling like `mitmproxy`) on browser B's network path.
2. The proxy is configured to rewrite `a=fingerprint:` lines in SDP traffic to the SignalR server.
3. Browser B attempts to join. The bound-SAS verification fails within ~10 seconds.
4. Both browsers show "verification failed: possible MITM" in red.
5. The data channel is closed; no file can be sent.
6. **If this step does not behave as described, Phase 2 is broken in production.** Revert immediately.

#### S5: Host controls
1. Host locks the session. A third browser profile attempts to join via the URL. Should get "session is locked".
2. Host unlocks. Third browser joins successfully.
3. Host kicks the third browser. Browser shows "you have been removed".
4. Host enables host-only-sending. From browser B, attempt to drop a file. UI hides the drop zone.
5. From browser B, in DevTools console, manually call the broadcastFile() method. The receiver (host) should still reject the file (`file-decline` returned).

#### S6: Rate limiting
1. Burst 30 join requests in 1 minute from a single IP. The 31st should return 429 with a Retry-After header.
2. Burst 11 session creations in 1 hour from a single user. The 11th should return 429.
3. Junk session ID (`/api/sessions/abc`) should return 400 (not 404), confirming format validation runs first.

#### S7: Headers and CSP
1. From DevTools Network, inspect the response to `GET /` (the SPA root).
2. Confirm presence of:
   - `Content-Security-Policy: default-src 'self'; ...`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()`
   - `X-Frame-Options: DENY`
3. Inspect the response to `GET /index.html`. `Cache-Control` should be `no-store`.
4. Inspect any hashed asset (`/assets/*.js`). `Cache-Control` should include `public, immutable`.
5. Open the page and walk through the file-transfer flow. The browser console should be free of CSP violation reports.

#### S8: Reverse-proxy + cookie behavior
1. Watch the response to `POST /api/auth/logout`. The `Set-Cookie` header should clear `Sendie.Auth` with `Secure; HttpOnly; SameSite=Lax`.
2. Confirm the cookie is **not** marked Secure in dev (localhost) but **is** marked Secure in staging/prod (Phase 0.3).
3. From DevTools, confirm the cookie's value does not contain a base64-encoded Discord access token (Phase 0.4 / M5). Decode the cookie payload locally if you've kept the Data Protection key.

#### S9: Container security
1. SSH onto the staging pod. Run `id`. Should return uid=1001, not 0.
2. `ls -la /app/data/keys`. Permissions should be 700, owner appuser:appuser.
3. `cat /proc/1/status | grep CapBnd`. Capabilities should be reduced (Phase 5).

#### S10: Open-redirect regression
1. Navigate to `https://staging/api/auth/login?returnUrl=https://evil.example/`. Should redirect to Discord OAuth, then back to the home page (not to evil.example).
2. Repeat with `returnUrl=//evil.example/`, `returnUrl=javascript:alert(1)`, `returnUrl=/safe-path`. Only the last should pass through.

### 8.3 Post-deploy monitoring (24h watch)

After each production deploy, watch:

- Application logs grep for `verification failed` — a spike is either a real attack or a regression in Phase 2.
- Application logs grep for `Rate limit exceeded` — a spike suggests either abuse or a legitimate user hitting limits we should raise.
- Pod restarts. The startup admin self-test (Phase 6.3) should log either "0 admins" warning or "N admins configured." If you see neither in the deploy logs, the startup hook didn't run.
- 5xx response rate from ingress. Any new 500s should be diagnosed before declaring deploy successful.
- StreamSaver `mitm.html` 404s in nginx access logs. If you see them, the postinstall vendoring didn't run during the build (Phase 4.1).

### 8.4 Failure-mode escalation

If S4 (verification rejection) fails: revert Phase 2. Users are not protected against MITM.

If S3 (drive-by gating) fails: revert Phase 1. Users will receive files without consent.

If S7 (CSP) shows violation reports for legitimate functionality: ship CSP as `Content-Security-Policy-Report-Only` instead of enforcing while you iterate on the policy.

If S8 (cookie Secure) fails in production: the reverse proxy is forwarding HTTP to the pod and the cookie will be sent over plaintext. Fix the ingress config; do not roll forward.

If a smoke test fails on a phase that's already in production, the policy is: roll back to the previous deploy, then fix the regression in a separate PR. Do not roll forward "fixes" without re-running the full smoke battery.

### 8.5 Verification artifacts

Each successful deploy should leave:
- The deploy ticket has S1-S10 checked off with timestamps.
- A post-deploy summary comment in the ticket: "Phase X deployed at HH:MM. Smoke tests S1-S10 passed. Logs clean for first hour of monitoring."
- Any failed steps documented with screenshots, browser version, and reproduction steps.

This is the same checklist for every phase. The audit / remediation work is meaningless if the production deploy bypasses validation.

