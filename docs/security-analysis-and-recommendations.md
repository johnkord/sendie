# Sendie Security Analysis & Recommendations

This document provides a detailed security review of the Sendie P2P file transfer implementation, identifies gaps between the design and actual code, and proposes fixes based on industry best practices.

---

## Executive Summary

Sendie relies on WebRTC's built-in DTLS encryption for data-channel confidentiality, which is solid. However, several **design-to-implementation gaps** leave the app vulnerable to session hijacking, MITM attacks, and abuse. The table below summarizes findings:

| Issue | Severity | Status | Fix Complexity |
|-------|----------|--------|----------------|
| Weak session ID generation | High | Not implemented | Low |
| Identity verification incomplete | High | Partial | Medium |
| File consent not enforced | Medium | Not implemented | Medium |
| No file integrity verification | Medium | Not implemented | Low |
| No rate limiting or abuse controls | Medium | Not implemented | Medium |
| In-memory session storage | Low | By design (MVP) | High |

---

## 1. Weak Session ID Generation

### Current Implementation

```csharp
// server/Sendie.Server/Services/SessionService.cs (lines 143-150)
private static string GenerateSessionId()
{
    const string chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var random = new Random();  // ⚠️ NOT cryptographically secure
    return new string(Enumerable.Repeat(chars, 8)
        .Select(s => s[random.Next(s.Length)]).ToArray());
}
```

### Problems

1. **`System.Random` is predictable**: It's seeded from the system clock; an attacker who knows roughly when a session was created can narrow guesses.
2. **8 characters from 36 symbols ≈ 41 bits of entropy**: With no rate limiting, brute-force enumeration is feasible (~2.8 trillion combinations, but attackers can try thousands per second).
3. **No authentication on `JoinSession`**: Anyone who guesses or intercepts a session ID can join and become the peer.

### Best Practice

Use a cryptographically secure random number generator (CSPRNG) and increase ID length to at least 128 bits (22+ URL-safe base64 characters).

### Recommended Fix

```csharp
using System.Security.Cryptography;

private static string GenerateSessionId()
{
    // 16 bytes = 128 bits of entropy
    var bytes = RandomNumberGenerator.GetBytes(16);
    // URL-safe base64 (22 chars, no padding)
    return Convert.ToBase64String(bytes)
        .Replace("+", "-")
        .Replace("/", "_")
        .TrimEnd('=');
}
```

**Additional hardening**:
- Add per-IP rate limiting on session creation and join attempts.
- Consider a short-lived join token separate from the session ID.

---

## 2. Identity Verification Is Incomplete

### Design Intent (from design-doc.md)

The design specifies a full challenge-response flow:
1. Exchange ECDSA public keys
2. Each peer signs a random challenge
3. Verify signatures
4. Display SAS (Short Authentication String) for out-of-band comparison

### Current Implementation

| Step | Implemented? | Location |
|------|--------------|----------|
| Generate ECDSA keypair | ✅ | `CryptoService.ts` |
| Export/exchange public keys | ✅ | `SessionPage.tsx` → `SignalingService` |
| Generate challenge | ✅ | `CryptoService.generateChallenge()` |
| Sign challenge | ✅ | `CryptoService.sign()` |
| **Send signature via signaling** | ❌ | Hub method exists but never called |
| **Verify peer's signature** | ❌ | `CryptoService.verify()` exists but unused |
| Generate SAS | ✅ | `CryptoService.generateSAS()` |
| Display SAS | ✅ | `ConnectionStatus.tsx` |
| **Prompt user to confirm SAS match** | ❌ | SAS displayed but no confirmation flow |

### Problems

1. **Signatures are never exchanged**: `signalingService.sendSignature()` is implemented but never invoked. Without challenge-response, an attacker can substitute their own public key during signaling (classic MITM).
2. **SAS is shown but not actionable**: Users see the 4-word code but have no UI to confirm or reject a mismatch. The connection proceeds regardless.
3. **Status jumps to "connected" without verification**: The `handlePublicKey` callback sets `status: 'connected'` immediately after receiving a key, skipping verification.

### Best Practice (Signal Protocol / ZRTP style)

1. Exchange public keys.
2. Each side generates a random challenge, sends it, and signs the peer's challenge.
3. Verify signatures before marking "verified."
4. Display SAS and **require explicit user confirmation** before enabling file transfer.

### Recommended Fix

**A. Add signature exchange in `SessionPage.tsx`:**

```typescript
const handlePublicKey = useCallback(async (_peerId: string, keyJwk: string) => {
  remoteKeyJwkRef.current = keyJwk;
  const remoteKey = await cryptoService.importPublicKey(keyJwk);
  
  // Generate challenge for the peer to sign
  const challenge = cryptoService.generateChallenge();
  challengeRef.current = challenge;
  
  // Sign peer's challenge (they'll send one too)
  // For now, we sign our own challenge to prove key ownership
  const signature = await cryptoService.sign(keyPairRef.current!.privateKey, challenge);
  await signalingService.sendSignature(signature, challenge);
  
  setConnection({ status: 'verifying' });
}, [setConnection]);

const handleSignature = useCallback(async (_peerId: string, signature: string, challenge: string) => {
  if (!remoteKeyJwkRef.current) return;
  
  const remoteKey = await cryptoService.importPublicKey(remoteKeyJwkRef.current);
  const valid = await cryptoService.verify(remoteKey, signature, challenge);
  
  if (!valid) {
    setConnection({ status: 'error', error: 'Signature verification failed' });
    return;
  }
  
  // Generate SAS
  const sasCode = await cryptoService.generateSAS(localKeyJwkRef.current!, remoteKeyJwkRef.current);
  setConnection({ status: 'awaiting-sas-confirmation', sasCode });
}, [setConnection]);
```

**B. Add SAS confirmation UI in `ConnectionStatus.tsx`:**

```tsx
{sasCode && status === 'awaiting-sas-confirmation' && (
  <div className="mt-3 p-3 bg-yellow-900/30 rounded-lg border border-yellow-500/30">
    <p className="text-sm text-yellow-300 mb-2">
      Compare this code with your peer (via phone/message). Do they match?
    </p>
    <p className="text-xl font-mono font-bold text-white tracking-wider mb-3">
      {sasCode}
    </p>
    <div className="flex gap-2">
      <button onClick={onConfirmSAS} className="btn-primary">Yes, they match</button>
      <button onClick={onRejectSAS} className="btn-danger">No, abort</button>
    </div>
  </div>
)}
```

**C. Block file transfer until verified:**

```typescript
const canSendFiles = connection.status === 'verified' && webrtcService.isDataChannelOpen;
```

---

## 3. File Consent Not Enforced

### Design Intent

The design doc shows a flow where:
1. Sender sends file metadata via signaling
2. Receiver accepts or rejects
3. Only then do file bytes flow

### Current Implementation

| Component | Status |
|-----------|--------|
| `SignalingHub.SendFileMetadata()` | ✅ Exists |
| `SignalingHub.AcceptFile()` / `RejectFile()` | ✅ Exists |
| `SignalingService.onFileAccepted` / `onFileRejected` | ✅ Events defined |
| **Sender waits for acceptance** | ❌ Not implemented |
| **Receiver UI to accept/reject** | ❌ Not implemented |

### Problems

1. **Sender pushes immediately**: `FileTransferService.sendFile()` starts chunking right away without waiting for consent.
2. **Receiver has no choice**: Incoming transfers auto-start; for large files, streaming to disk may prompt a file picker, but that's not consent—it's just "where to save."
3. **Potential for abuse**: A malicious peer can flood the receiver with unwanted data.

### Best Practice

Require explicit opt-in before any file bytes are transferred. This is standard in AirDrop, ShareDrop, and similar tools.

### Recommended Fix

**A. Modify `FileTransferService.sendFile()` to wait for acceptance:**

```typescript
async sendFile(file: File): Promise<void> {
  const fileId = cryptoService.generateFileId();
  
  // Send metadata via signaling (not data channel)
  await signalingService.sendFileMetadata(
    fileId,
    file.name,
    file.size,
    file.type || 'application/octet-stream'
  );
  
  // Wait for accept/reject
  return new Promise((resolve, reject) => {
    const onAccepted = (peerId: string, acceptedFileId: string) => {
      if (acceptedFileId !== fileId) return;
      cleanup();
      this.startTransfer(file, fileId).then(resolve).catch(reject);
    };
    
    const onRejected = (peerId: string, rejectedFileId: string) => {
      if (rejectedFileId !== fileId) return;
      cleanup();
      reject(new Error('Peer rejected the file'));
    };
    
    const cleanup = () => {
      signalingService.off('onFileAccepted');
      signalingService.off('onFileRejected');
    };
    
    signalingService.on('onFileAccepted', onAccepted);
    signalingService.on('onFileRejected', onRejected);
    
    // Timeout after 60 seconds
    setTimeout(() => {
      cleanup();
      reject(new Error('File acceptance timed out'));
    }, 60000);
  });
}
```

**B. Add receiver consent UI:**

```tsx
// In SessionPage.tsx
const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

signalingService.on('onFileMetadata', (peerId, fileId, fileName, fileSize, fileType) => {
  setPendingFiles(prev => [...prev, { fileId, fileName, fileSize, fileType }]);
});

const handleAcceptFile = async (fileId: string) => {
  await signalingService.acceptFile(fileId);
  setPendingFiles(prev => prev.filter(f => f.fileId !== fileId));
};

const handleRejectFile = async (fileId: string) => {
  await signalingService.rejectFile(fileId);
  setPendingFiles(prev => prev.filter(f => f.fileId !== fileId));
};
```

---

## 4. No File Integrity Verification

### Current Implementation

- `CryptoService.hashData()` exists and computes SHA-256.
- **It is never called** during file transfer.

### Problems

1. **Silent corruption**: If chunks are corrupted (rare with DTLS, but possible at app layer), the receiver won't know.
2. **No tamper detection at app layer**: While DTLS provides transport integrity, having an end-to-end hash confirms the complete file matches what the sender intended.

### Best Practice

Send a file hash with metadata; verify after reassembly.

### Recommended Fix

**A. Sender computes and sends hash:**

```typescript
// In sendFile(), before sending metadata:
const fileBuffer = await file.arrayBuffer();
const fileHash = await cryptoService.hashData(fileBuffer);

const metadata: DataChannelMessage = {
  type: 'file-start',
  fileId,
  fileName: file.name,
  fileSize: file.size,
  fileType: file.type,
  totalChunks,
  sha256: fileHash,  // Add this field
};
```

**B. Receiver verifies after completion:**

```typescript
private async completeIncomingTransfer(incoming: IncomingTransfer): Promise<void> {
  // ... existing reassembly code ...
  
  if (!incoming.useStreaming && incoming.expectedHash) {
    const blob = new Blob(incoming.receivedChunks, { type: incoming.fileType });
    const buffer = await blob.arrayBuffer();
    const actualHash = await cryptoService.hashData(buffer);
    
    if (actualHash !== incoming.expectedHash) {
      incoming.state.status = 'error';
      this.events.onTransferError?.(incoming.fileId, new Error('Integrity check failed'));
      return;
    }
  }
  
  // ... continue with download ...
}
```

**Note**: For streamed large files, consider chunked hashing or a Merkle tree approach.

---

## 5. No Rate Limiting or Abuse Controls

### Current Implementation

- The design doc mentions `RateLimitService.cs`—**this file does not exist**.
- No limits on:
  - Session creation per IP
  - Join attempts per session
  - Signaling messages per connection
  - Concurrent connections per IP

### Problems

1. **Session enumeration**: Attacker can probe millions of session IDs.
2. **Signaling flood**: Malicious client can spam ICE candidates or other messages.
3. **Resource exhaustion**: Unlimited session creation fills server memory.

### Best Practice

Apply defense-in-depth rate limiting at multiple layers.

### Recommended Fix

**A. Add ASP.NET Core rate limiting (built-in .NET 7+):**

```csharp
// Program.cs
using System.Threading.RateLimiting;

builder.Services.AddRateLimiter(options =>
{
    // Global limiter
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 100,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0
            }));
    
    // Specific policy for session creation
    options.AddFixedWindowLimiter("session-create", opt =>
    {
        opt.PermitLimit = 10;
        opt.Window = TimeSpan.FromHours(1);
        opt.QueueLimit = 0;
    });
});

// Apply to session endpoint
app.MapPost("/api/sessions", (ISessionService sessionService) => { ... })
   .RequireRateLimiting("session-create");
```

**B. Add SignalR-specific throttling:**

```csharp
// In SignalingHub.cs
private static readonly ConcurrentDictionary<string, RateLimiter> _connectionLimiters = new();

public override async Task OnConnectedAsync()
{
    var limiter = new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
    {
        TokenLimit = 50,
        TokensPerPeriod = 10,
        ReplenishmentPeriod = TimeSpan.FromSeconds(1)
    });
    _connectionLimiters[Context.ConnectionId] = limiter;
    await base.OnConnectedAsync();
}

private async Task<bool> TryAcquire()
{
    if (_connectionLimiters.TryGetValue(Context.ConnectionId, out var limiter))
    {
        using var lease = await limiter.AcquireAsync();
        return lease.IsAcquired;
    }
    return false;
}

public async Task SendOffer(string sdp)
{
    if (!await TryAcquire())
    {
        _logger.LogWarning("Rate limit exceeded for {ConnectionId}", Context.ConnectionId);
        return;
    }
    // ... existing code ...
}
```

---

## 6. Additional Recommendations

### 6.1 Session Join Authentication

Consider a two-part credential: public session ID + secret join token.

```
URL: https://sendie.io/s/{sessionId}?token={joinToken}
```

The token is generated alongside the session and required to join. This prevents join-by-guessing even if session IDs leak.

### 6.2 Connection State Validation

The SignalR hub should validate state transitions:

```csharp
public async Task SendOffer(string sdp)
{
    var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
    if (peer == null || !peer.IsInitiator)
    {
        _logger.LogWarning("Invalid SendOffer from {ConnectionId}", Context.ConnectionId);
        return; // Only initiator should send offer
    }
    // ...
}
```

### 6.3 Secure Defaults for TURN

If deploying TURN, use time-limited credentials:

```csharp
app.MapGet("/api/ice-servers", () =>
{
    var expiry = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds();
    var username = $"{expiry}:sendie";
    var credential = ComputeTurnCredential(username, turnSecret);
    
    return Results.Ok(new[]
    {
        new { urls = new[] { "stun:stun.l.google.com:19302" } },
        new { urls = new[] { "turn:turn.sendie.io:3478" }, username, credential }
    });
});
```

### 6.4 Content Security Policy

Add CSP headers to prevent XSS:

```csharp
app.Use(async (context, next) =>
{
    context.Response.Headers.Append(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self' wss: https:; script-src 'self'");
    await next();
});
```

---

## Implementation Priority

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| 1 | Strong session ID generation | 1 hour | High |
| 2 | Complete identity verification flow | 4 hours | High |
| 3 | Add basic rate limiting | 2 hours | Medium |
| 4 | Enforce file consent | 4 hours | Medium |
| 5 | Add file integrity checks | 2 hours | Medium |
| 6 | Session join tokens | 2 hours | Medium |

---

## References

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [WebRTC Security Architecture (RFC 8827)](https://datatracker.ietf.org/doc/html/rfc8827)
- [Signal Protocol Documentation](https://signal.org/docs/)
- [ZRTP Media Path Key Agreement (RFC 6189)](https://datatracker.ietf.org/doc/html/rfc6189)
- [ASP.NET Core Rate Limiting](https://learn.microsoft.com/en-us/aspnet/core/performance/rate-limit)
- [.NET Cryptographic Services](https://learn.microsoft.com/en-us/dotnet/standard/security/cryptographic-services)
