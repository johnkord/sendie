# Sendie Security Audit Report

**Date:** December 24, 2025  
**Auditor:** Security Review  
**Scope:** Full application security analysis  
**Last Updated:** December 24, 2025

---

## Executive Summary

Sendie is a peer-to-peer file transfer application using WebRTC for direct transfers and SignalR for signaling. This audit identified several security considerations ranging from high to low severity.

**Design Notes:**
- The application intentionally allows unauthenticated access to sessions via session URLs. Session IDs serve as capability tokens with 128 bits of entropy (cryptographically secure), making brute-force attacks computationally infeasible. This is a deliberate design choice for ease of sharing.
- **Privacy Enhancement:** File metadata (names, sizes, types) is transmitted **only over the WebRTC data channel** (peer-to-peer). The signaling server never receives or logs any file information.

---

## Findings

### 🟠 High Severity

#### 1. Rate Limiting on Critical Endpoints ✅ FIXED

**Status:** Fixed (December 2025)  
**Location:** 
- Server: `Services/RateLimiterService.cs`
- Applied to: `Program.cs` (REST endpoints), `SignalingHub.cs` (SignalR methods)

**Implementation Details:**

In-memory sliding window rate limiter with automatic cleanup. Limits reset on server restart (acceptable for this use case).

| Policy | Limit | Window | Applied To |
|--------|-------|--------|------------|
| `SessionCreate` | 10 requests | 1 hour | `POST /api/sessions` per IP |
| `SessionJoin` | 30 requests | 1 minute | `JoinSession()` per IP |
| `SignalingMessage` | 100 requests | 1 second | Offer/Answer/PublicKey per connection |
| `IceCandidate` | 200 requests | 1 second | ICE candidates per connection |

**Response when rate limited:**
- REST endpoints: HTTP 429 with `Retry-After` header
- SignalR: `HubException` with retry time

---

#### 2. No Input Validation/Sanitization for File Metadata ✅ FIXED

**Status:** Fixed (December 2025)  
**Location:** 
- Client: `FileTransferService.ts`, `MultiPeerFileTransferService.ts`

**Note:** File metadata is sent **only over the WebRTC data channel** (peer-to-peer), not through the signaling server. The server never sees file names, sizes, or types.

**Fix Implemented:** Added `sanitizeFilename()` function in `utils/formatters.ts` that:
- Removes path traversal sequences (`..`)
- Removes directory separators (`/`, `\`)
- Removes dangerous characters (`<`, `>`, `:`, `"`, `|`, `?`, `*`)
- Removes null bytes and control characters
- Limits filename length to 255 characters
- Falls back to `unnamed_file` for empty/invalid input

All incoming filenames from peers are now sanitized before being used for:
- File save dialogs (File System Access API)
- StreamSaver.js downloads
- Browser download attribute

---

### 🟡 Medium Severity

#### 3. Cookie Security Policy Set to `SameAsRequest`

**Status:** Open  
**Location:** `Program.cs` line ~55

```csharp
options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest; // Use Always in production
```

**Impact:** In misconfigured production environments, cookies could be transmitted over HTTP, exposing session tokens to network attackers.

**Recommendation:** Change to `CookieSecurePolicy.Always` and ensure HTTPS is enforced:
```csharp
options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
```

---

#### 4. Overly Permissive CORS Policy

**Status:** Open  
**Location:** `Program.cs` lines ~35-42

```csharp
policy.WithOrigins("http://localhost:5173", "http://127.0.0.1:5173")
      .AllowAnyHeader()
      .AllowAnyMethod()
      .AllowCredentials();
```

**Impact:** `.AllowAnyHeader()` and `.AllowAnyMethod()` are more permissive than necessary.

**Recommendation:** Explicitly list allowed headers and methods:
```csharp
policy.WithOrigins("http://localhost:5173")
      .WithHeaders("Content-Type", "Authorization")
      .WithMethods("GET", "POST", "DELETE")
      .AllowCredentials();
```

---

#### 5. No WebRTC Fingerprint Verification Enforcement

**Status:** Open  
**Location:** `WebRTCService.ts`, `CryptoService.ts`

**Analysis:** The SAS (Short Authentication String) provides out-of-band verification capability, but verification is optional. Users can skip it, making MITM attacks possible if a malicious party obtains a session URL.

**Recommendation:** 
- Consider making SAS verification mandatory before file transfers begin
- At minimum, prominently warn users who skip verification
- Display peer connection status and verification state in UI

---

#### 6. Data Channel Lacks Application-Level Encryption

**Status:** Open  
**Location:** `FileTransferService.ts`

**Analysis:** WebRTC DTLS provides transport encryption between peers. However, if a malicious peer joins the session (by obtaining the session URL), they can receive files in plaintext.

**Recommendation:** Consider adding end-to-end encryption for file data:
- Derive a symmetric key from the ECDSA key exchange
- Encrypt file chunks before sending over the data channel
- This provides defense-in-depth even if session URL leaks

---

#### 7. No File Size Limits Enforced

**Status:** Open  
**Location:** Session creation and file transfer logic

**Impact:** 
- Attackers could announce extremely large files
- Files under 100MB are held entirely in memory on the receiver
- Could cause memory exhaustion on receivers

**Recommendation:**
- Implement configurable file size limits
- Warn users about large incoming files before accepting
- Consider lowering the streaming threshold (currently 100MB)

---

### 🟢 Low Severity

#### 8. AllowedHosts Wildcard

**Status:** Open  
**Location:** `appsettings.json` line 8

```json
"AllowedHosts": "*"
```

**Impact:** Minor host header injection risk in production.

**Recommendation:** Set explicit allowed hosts in production:
```json
"AllowedHosts": "sendie.curlyquote.com"
```

---

#### 9. ICE Servers Endpoint Exposes Configuration

**Status:** Open  
**Location:** `Program.cs` lines ~117-123

```csharp
app.MapGet("/api/ice-servers", () => Results.Ok(new[]
{
    new { urls = new[] { "stun:stun.l.google.com:19302" } },
}));
```

**Impact:** Currently low risk (uses public STUN servers), but if TURN servers with credentials are added in the future, they would be publicly exposed.

**Recommendation:** If TURN servers are added, authenticate this endpoint or implement short-lived TURN credentials.

---

#### 10. No CSRF Protection on Logout

**Status:** Open  
**Location:** `Program.cs` line ~139

```csharp
app.MapPost("/api/auth/logout", async (HttpContext context) =>
```

**Impact:** CSRF logout attacks have minimal security impact but could be used for annoyance.

**Recommendation:** Consider adding anti-forgery token validation for state-changing operations.

---

#### 11. Missing Security Headers

**Status:** Open  
**Location:** Server middleware configuration

**Analysis:** No security headers are configured.

**Recommendation:** Add security headers via middleware:
```csharp
app.Use(async (context, next) => {
    context.Response.Headers.Add("X-Frame-Options", "DENY");
    context.Response.Headers.Add("X-Content-Type-Options", "nosniff");
    context.Response.Headers.Add("Referrer-Policy", "strict-origin-when-cross-origin");
    context.Response.Headers.Add("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    await next();
});
```

Or use a library like `NWebsec`.

---

#### 12. Docker Container Runs as Root

**Status:** Open  
**Location:** `server/Sendie.Server/Dockerfile`

**Analysis:** No `USER` directive specified, container runs as root by default.

**Recommendation:** Add non-root user:
```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app

# Create non-root user
RUN adduser --disabled-password --gecos '' --uid 1001 appuser
USER appuser

COPY --from=build /app/publish .
```

---

#### 13. Verbose Error Messages in Development

**Status:** Open  
**Location:** Various client services

**Analysis:** Error messages are logged to console and may expose internal details.

**Recommendation:** Ensure production builds suppress detailed error messages:
```typescript
if (import.meta.env.DEV) {
  console.error('Detailed error:', error);
}
```

---

## Security Strengths ✅

The following security measures are already well-implemented:

1. **Strong Session ID Generation** - Uses `RandomNumberGenerator.GetBytes(16)` providing 128 bits of entropy
2. **Data Protection Keys Persisted** - Prevents cookie invalidation on server restart
3. **SAS Code Implementation** - Allows out-of-band peer identity verification
4. **Allow-List Based Access** - Good for private deployments requiring controlled access
5. **Admin Protection** - Admins cannot be removed from the allow-list, preventing lockout
6. **Discord OAuth** - Delegates authentication to a trusted identity provider
7. **TLS in Production** - Ingress configured with cert-manager and Let's Encrypt
8. **Session TTL with Absolute Maximum** - Sessions expire after 4 hours maximum
9. **Discord ID Validation** - Input validation on Discord user ID format (17-19 digits)
10. **Targeted Signaling Verification** - `SendOfferTo`/`SendAnswerTo` verify peers are in same session
11. **HttpOnly Cookies** - Authentication cookies are not accessible to JavaScript
12. **SameSite Cookie Policy** - Cookies use `Lax` SameSite policy
13. **Host Controls** - Session creator can lock sessions (prevent new joins) and kick peers; only the original creator can use these controls

---

## Prioritized Remediation Plan

| Priority | Issue | Effort | Impact | Status |
|----------|-------|--------|--------|--------|
| 1 | Implement rate limiting | Medium | High | ✅ Done |
| 2 | Sanitize file metadata | Low | High | ✅ Done |
| 3 | Set cookie SecurePolicy to Always | Low | Medium | Open |
| 4 | Add security headers | Low | Low | Open |
| 5 | Tighten CORS policy | Low | Medium | Open |
| 6 | Run container as non-root | Low | Low | Open |
| 7 | Consider mandatory SAS verification | Medium | Medium | Open |
| 8 | Add file size limits | Low | Medium | Open |
| 9 | Set explicit AllowedHosts | Low | Low | Open |

---

## Notes

- Session URLs functioning as capability tokens is an intentional design decision
- The 128-bit session ID entropy makes brute-force attacks infeasible (2^128 possibilities)
- WebRTC's DTLS provides transport-level encryption for peer-to-peer data
- The allow-list system provides access control for session creation, not session joining

---

*End of Report*
