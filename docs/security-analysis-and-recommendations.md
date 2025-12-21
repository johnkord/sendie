# Sendie Security Analysis & Recommendations

This document provides a detailed security review of the Sendie P2P file transfer implementation, identifies gaps between the design and actual code, and proposes fixes based on industry best practices.

**Last Updated:** December 2025

---

## Executive Summary

Sendie relies on WebRTC's built-in DTLS encryption for data-channel confidentiality, which is solid. Several security improvements have been made, though some gaps remain. The table below summarizes findings:

| Issue | Severity | Status | Fix Complexity |
|-------|----------|--------|----------------|
| Weak session ID generation | High | ✅ Fixed (128-bit CSPRNG) | Low |
| Untrusted filename handling | High | ✅ Fixed (sanitization) | Low |
| Rate limiting | High | ✅ Fixed (sliding window) | Low |
| Identity verification incomplete | High | Partial | Medium |
| File consent not enforced | Medium | Not implemented | Medium |
| No file integrity verification | Medium | Not implemented | Low |
| In-memory session storage | Low | By design (MVP) | High |

**Privacy Note:** File metadata (names, sizes, types) is sent **only over the WebRTC data channel** (peer-to-peer). The signaling server never sees any file information.

---

## 1. Weak Session ID Generation ✅ FIXED

### Previous Implementation (Vulnerable)

```csharp
// OLD CODE - DO NOT USE
private static string GenerateSessionId()
{
    const string chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var random = new Random();  // ⚠️ NOT cryptographically secure
    return new string(Enumerable.Repeat(chars, 8)
        .Select(s => s[random.Next(s.Length)]).ToArray());
}
```

### Problems (Now Fixed)

1. **`System.Random` is predictable**: It's seeded from the system clock; an attacker who knows roughly when a session was created can narrow guesses.
2. **8 characters from 36 symbols ≈ 41 bits of entropy**: With no rate limiting, brute-force enumeration is feasible (~2.8 trillion combinations, but attackers can try thousands per second).
3. **No authentication on `JoinSession`**: Anyone who guesses or intercepts a session ID can join and become the peer.

### Current Implementation ✅

```csharp
using System.Security.Cryptography;

private static string GenerateSessionId()
{
    // 16 bytes = 128 bits of entropy - computationally infeasible to brute-force
    var bytes = RandomNumberGenerator.GetBytes(16);
    // URL-safe base64 (22 chars, no padding)
    return Convert.ToBase64String(bytes)
        .Replace("+", "-")
        .Replace("/", "_")
        .TrimEnd('=');
}
```

**Status:** Session IDs now use 128 bits of cryptographically secure randomness. The session URL effectively acts as a capability token - anyone with the URL can join, which is by design for easy sharing.

**Remaining recommendations**:
- Add per-IP rate limiting on session creation and join attempts.

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

The original design showed a flow where:
1. Sender sends file metadata via signaling
2. Receiver accepts or rejects
3. Only then do file bytes flow

### Current Implementation

**Update (December 2025):** The signaling-based file metadata methods have been **removed** as dead code. File metadata is now sent **only over the WebRTC data channel** (peer-to-peer). This is more privacy-preserving since the server never sees file information.

| Component | Status |
|-----------|--------|
| `SignalingHub.SendFileMetadata()` | ❌ Removed (was unused) |
| `SignalingHub.AcceptFile()` / `RejectFile()` | ❌ Removed (was unused) |
| `SignalingService.onFileAccepted` / `onFileRejected` | ❌ Removed |
| File metadata via data channel | ✅ Implemented (`file-start` message) |
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

Since file metadata now goes through the data channel, implement a consent flow over the same channel:

```typescript
async sendFile(file: File): Promise<void> {
  const fileId = cryptoService.generateFileId();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  
  // Send metadata and wait for accept/reject over data channel
  const metadata: DataChannelMessage = {
    type: 'file-offer',  // New message type for consent flow
    fileId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream',
    totalChunks,
  };
  webrtcService.send(JSON.stringify(metadata));
  
  // Wait for accept/reject
  return new Promise((resolve, reject) => {
    const handleResponse = (data: string) => {
      const msg = JSON.parse(data);
      if (msg.fileId !== fileId) return;
      
      if (msg.type === 'file-accept') {
        this.startTransfer(file, fileId).then(resolve).catch(reject);
      } else if (msg.type === 'file-reject') {
        reject(new Error('Peer rejected the file'));
      }
    };
    // ... register handler ...
  });
}
```

**B. Add receiver consent UI:**

```tsx
// Handle incoming file offers
const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

fileTransferService.on('onFileOffer', (fileId, fileName, fileSize, fileType) => {
  setPendingFiles(prev => [...prev, { fileId, fileName, fileSize, fileType }]);
});

const handleAcceptFile = (fileId: string) => {
  webrtcService.send(JSON.stringify({ type: 'file-accept', fileId }));
  setPendingFiles(prev => prev.filter(f => f.fileId !== fileId));
};

const handleRejectFile = (fileId: string) => {
  webrtcService.send(JSON.stringify({ type: 'file-reject', fileId }));
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

## 5. Rate Limiting ✅ IMPLEMENTED

### Previous Implementation

- The design doc mentioned `RateLimitService.cs`—**this file did not exist**.
- No limits on session creation, join attempts, or signaling messages.

### Current Implementation

In-memory sliding window rate limiter implemented in `Services/RateLimiterService.cs`:

| Policy | Limit | Window | Target |
|--------|-------|--------|--------|
| `SessionCreate` | 10 | 1 hour | Session creation per IP |
| `SessionJoin` | 30 | 1 minute | Join attempts per IP |
| `SignalingMessage` | 100 | 1 second | Signaling per connection |
| `IceCandidate` | 200 | 1 second | ICE candidates per connection |

**Features:**
- Thread-safe sliding window counters
- Automatic cleanup of expired entries (every 5 minutes)
- In-memory storage (resets on restart, acceptable for this use case)
- Returns `Retry-After` information for clients

**Applied to:**
- `POST /api/sessions` → HTTP 429 when exceeded
- `SignalingHub.JoinSession()` → HubException when exceeded
- All signaling methods (SendOffer, SendAnswer, SendIceCandidate, etc.)

---

## 6. Filename Sanitization ✅ IMPLEMENTED

### Problem

File metadata (including filenames) is received from peers over the WebRTC data channel. While this is peer-to-peer and doesn't go through the server, malicious peers could send crafted filenames designed to:

1. **Path traversal attacks**: `../../../etc/passwd` or `..\Windows\System32\config`
2. **XSS attacks**: `<script>alert('xss')</script>.html`
3. **Filesystem issues**: Null bytes, control characters, or reserved characters
4. **Resource exhaustion**: Extremely long filenames

### Solution

A `sanitizeFilename()` function is applied to all incoming filenames before they are used for:
- File save dialogs (File System Access API)
- StreamSaver.js downloads
- Browser download attribute fallback

**Location:** `client/src/utils/formatters.ts`

```typescript
export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') {
    return 'unnamed_file';
  }

  let result = filename
    // Remove null bytes
    .replace(/\0/g, '')
    // Remove control characters (0x00-0x1f, 0x7f)
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Trim leading/trailing whitespace
    .trim()
    // Remove path traversal sequences
    .replace(/\.\./g, '_')
    // Remove directory separators (Unix and Windows)
    .replace(/[\/\\]/g, '_')
    // Remove dangerous characters (Windows reserved + common XSS vectors)
    .replace(/[<>:"|\?\*]/g, '_')
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Remove leading/trailing underscores and dots
    .replace(/^[_\.]+|[_\.]+$/g, '')
    // Limit length (255 is common filesystem limit)
    .substring(0, 255);

  // Fallback if empty after sanitization
  return result || 'unnamed_file';
}
```

### Sanitization Steps

| Step | Purpose | Example |
|------|---------|--------|
| Remove null bytes | Prevent null byte injection | `file\0.txt` → `file.txt` |
| Remove control chars | Prevent terminal escape sequences | `file\x1b[31m.txt` → `file.txt` |
| Remove `..` | Prevent path traversal | `../secret.txt` → `_secret.txt` |
| Remove `/` and `\` | Prevent directory escape | `dir/file.txt` → `dir_file.txt` |
| Remove `<>:"|?*` | Prevent XSS and Windows reserved chars | `<script>.html` → `_script_.html` |
| Collapse underscores | Clean up after replacements | `a___b.txt` → `a_b.txt` |
| Trim leading `_` and `.` | Prevent hidden files, clean names | `_.hidden` → `hidden` |
| Limit to 255 chars | Filesystem compatibility | (truncated) |

### Usage

Applied in `FileTransferService.ts` and `MultiPeerFileTransferService.ts`:

```typescript
import { sanitizeFilename } from '../utils/formatters';

// When receiving file metadata from peer
const sanitizedName = sanitizeFilename(incoming.fileName);
a.download = sanitizedName;
```

### Test Coverage

12 test cases in `formatters.test.ts` covering:
- Path traversal attempts (`../`, `..\`, multiple levels)
- Dangerous characters removal
- Control character removal
- Null byte injection
- Empty/invalid input handling
- Length limiting

---

## 7. Additional Recommendations

### 7.1 Session Join Authentication

Consider a two-part credential: public session ID + secret join token.

```
URL: https://sendie.io/s/{sessionId}?token={joinToken}
```

The token is generated alongside the session and required to join. This prevents join-by-guessing even if session IDs leak.

### 7.2 Connection State Validation

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

### 7.3 Secure Defaults for TURN

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

### 7.4 Content Security Policy

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
| 1 | Strong session ID generation | ✅ Done | High |
| 2 | Filename sanitization | ✅ Done | High |
| 3 | Rate limiting | ✅ Done | Medium |
| 4 | Complete identity verification flow | 4 hours | High |
| 5 | Enforce file consent | 4 hours | Medium |
| 6 | Add file integrity checks | 2 hours | Medium |
| 7 | Session join tokens | 2 hours | Medium |

---

## References

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [WebRTC Security Architecture (RFC 8827)](https://datatracker.ietf.org/doc/html/rfc8827)
- [Signal Protocol Documentation](https://signal.org/docs/)
- [ZRTP Media Path Key Agreement (RFC 6189)](https://datatracker.ietf.org/doc/html/rfc6189)
- [ASP.NET Core Rate Limiting](https://learn.microsoft.com/en-us/aspnet/core/performance/rate-limit)
- [.NET Cryptographic Services](https://learn.microsoft.com/en-us/dotnet/standard/security/cryptographic-services)
