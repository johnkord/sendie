# Sendie - P2P File Transfer Application Design Document

## Overview

Sendie is a browser-based peer-to-peer file transfer application that enables direct, encrypted file sharing between users without files ever touching a server. The application leverages WebRTC for establishing secure peer connections and data transfer.

### Goals

- **Direct Transfer**: Files transfer directly between browsers—no server storage
- **End-to-End Encryption**: All transfers encrypted via DTLS (built into WebRTC)
- **Multi-Peer Sessions**: Share files with multiple people simultaneously (up to 10 peers)
- **No Account Required**: Anonymous, session-based file sharing (auth only for creation)
- **Large File Support**: Handle files of any size (limited only by browser/device capability)
- **NAT Traversal**: Seamlessly connect peers behind firewalls and NATs
- **Identity Verification**: Optional cryptographic verification to prevent MITM attacks
- **File Queuing**: Queue files before peers join, auto-send on connect
- **Broadcast Mode**: Send files to all new joiners automatically
- **Receiver Control**: Recipients can disable auto-receive for incoming files

---

## Architecture

### Multi-Peer Mesh Topology

Sendie uses a **full mesh topology** where each peer connects directly to all other peers in the session. When a file is sent, it's broadcast to all connected peers simultaneously.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         MULTI-PEER MESH ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐          │
│   │  Browser A  │◄───────►│  Browser B  │◄───────►│  Browser C  │          │
│   │   (Peer)    │         │   (Peer)    │         │   (Peer)    │          │
│   └──────┬──────┘         └─────────────┘         └──────┬──────┘          │
│          │                       ▲                       │                 │
│          │    WebRTC DataChannel │ (Full Mesh)           │                 │
│          └───────────────────────┼───────────────────────┘                 │
│                                  │                                         │
│                    ┌─────────────┴─────────────┐                           │
│                    │      Signaling Server      │                          │
│                    │      (Session + ICE)       │                          │
│                    └─────────────┬─────────────┘                           │
│                                  │                                         │
│                           ┌──────┴──────┐                                  │
│                           │ STUN/TURN   │                                  │
│                           │  Servers    │                                  │
│                           └─────────────┘                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

Connections in mesh: N peers = N*(N-1)/2 total connections
  2 peers: 1 connection
  3 peers: 3 connections
  5 peers: 10 connections
 10 peers: 45 connections (practical maximum)
```

### Legacy 2-Peer Architecture

For reference, the original 2-peer architecture:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SENDIE ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────────┐                           ┌─────────────────┐        │
│   │   Browser A     │                           │   Browser B     │        │
│   │   (Sender)      │                           │   (Receiver)    │        │
│   │                 │                           │                 │        │
│   │  ┌───────────┐  │      WebRTC DataChannel   │  ┌───────────┐  │        │
│   │  │ TypeScript│  │◄─────────────────────────►│  │ TypeScript│  │        │
│   │  │ Frontend  │  │    (Direct P2P + DTLS)    │  │ Frontend  │  │        │
│   │  └───────────┘  │                           │  └───────────┘  │        │
│   │        │        │                           │        │        │        │
│   └────────┼────────┘                           └────────┼────────┘        │
│            │                                             │                 │
│            │  WebSocket (Signaling Only)                 │                 │
│            │         ┌─────────────┐                     │                 │
│            └────────►│  Signaling  │◄────────────────────┘                 │
│                      │   Server    │                                       │
│                      │   (C#)      │                                       │
│                      └──────┬──────┘                                       │
│                             │                                              │
│                      ┌──────┴──────┐                                       │
│                      │ STUN/TURN   │                                       │
│                      │  Servers    │                                       │
│                      └─────────────┘                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

### Frontend (TypeScript)

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Framework** | React 18+ with TypeScript | UI components and state management |
| **Build Tool** | Vite | Fast development and optimized builds |
| **WebRTC** | Native Browser API | P2P connection and data transfer |
| **Crypto** | Web Crypto API (SubtleCrypto) | Key generation, signing, verification |
| **Styling** | Tailwind CSS | Rapid UI development |
| **State** | Zustand | Lightweight state management |

### Backend (C#)

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Runtime** | .NET 8 | Modern, performant runtime |
| **Framework** | ASP.NET Core Minimal API | Lightweight HTTP server |
| **WebSocket** | SignalR | Real-time signaling communication |
| **Hosting** | Kestrel | High-performance web server |

### Infrastructure

| Component | Technology | Purpose |
|-----------|------------|---------|
| **STUN** | Coturn or public STUN servers | NAT traversal discovery |
| **TURN** | Coturn (self-hosted) | Relay fallback for restrictive NATs |
| **Deployment** | Docker + Docker Compose | Containerized deployment |

---

## Component Design

### 1. Frontend Architecture

```
src/
├── components/
│   ├── FileDropZone.tsx        # Drag-and-drop file selection
│   ├── FileQueue.tsx           # Queued/broadcast files display
│   ├── TransferProgress.tsx    # Progress indicator with speed/ETA
│   ├── PeerConnection.tsx      # Connection status display
│   ├── VerificationCode.tsx    # SAS code display/comparison
│   └── SessionLink.tsx         # Shareable session link generator
├── hooks/
│   ├── useWebRTC.ts            # WebRTC connection management
│   ├── useFileTransfer.ts      # File chunking and transfer logic
│   ├── useSignaling.ts         # SignalR client wrapper
│   └── useCrypto.ts            # Key generation and verification
├── services/
│   ├── WebRTCService.ts        # Core WebRTC operations
│   ├── SignalingService.ts     # SignalR signaling client
│   ├── CryptoService.ts        # Cryptographic operations
│   └── FileChunker.ts          # File streaming and chunking
├── types/
│   ├── signaling.ts            # Signaling message types
│   ├── transfer.ts             # Transfer state types
│   └── crypto.ts               # Crypto-related types
├── stores/
│   └── transferStore.ts        # Global transfer state (incl. queue, broadcast mode)
└── utils/
    ├── sasGenerator.ts         # Short Authentication String generation
    └── formatters.ts           # File size, speed formatters
```

### 2. Backend Architecture

```
Sendie.Server/
├── Program.cs                  # Application entry point
├── Hubs/
│   └── SignalingHub.cs         # SignalR hub for signaling
├── Models/
│   ├── SignalingMessage.cs     # ICE candidates, SDP offers/answers
│   ├── Session.cs              # Session metadata
│   └── Peer.cs                 # Peer connection info
├── Services/
│   ├── SessionService.cs       # Session management
│   └── RateLimitService.cs     # Abuse prevention
└── Configuration/
    └── IceServerConfig.cs      # STUN/TURN configuration
```

---

## Data Models

### TypeScript Types

```typescript
// Session and Connection Types
interface Session {
  id: string;
  createdAt: Date;
  expiresAt: Date;
}

interface PeerInfo {
  peerId: string;
  publicKey: CryptoKey | null;
  verified: boolean;
}

// Signaling Message Types
type SignalingMessage = 
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit }
  | { type: 'public-key'; key: JsonWebKey }
  | { type: 'signature'; signature: string; challenge: string };

// Transfer Types
interface FileMetadata {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

interface TransferState {
  fileId: string;
  status: 'pending' | 'transferring' | 'completed' | 'failed';
  bytesTransferred: number;
  totalBytes: number;
  startTime: Date | null;
  speed: number; // bytes per second
}

interface ChunkMessage {
  fileId: string;
  chunkIndex: number;
  totalChunks: number;
  data: ArrayBuffer;
}

// Crypto Types
interface KeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

interface VerificationResult {
  verified: boolean;
  sasCode: string; // e.g., "apple-banana-cherry-delta"
}

// Peer Connection State (Multi-peer)
interface PeerConnectionState {
  peerId: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'failed';
  dataChannelOpen: boolean;
  publicKeyJwk: string | null;
  sasCode: string | null;       // Security verification code (shared between both peers)
  friendlyName: string | null;  // Human-readable name derived from public key
}
```

### C# Models

```csharp
// Session Models
public record Session(
    string Id,
    DateTime CreatedAt,
    DateTime ExpiresAt,
    DateTime AbsoluteExpiresAt,
    DateTime? EmptySince = null,
    int PeerCount = 0,
    int ConnectedPeerPairs = 0,
    int MaxPeers = 10,
    bool IsLocked = false,              // Host can lock to prevent new joins
    bool IsHostOnlySending = false,     // Host can restrict file sending to self only
    string? CreatorUserId = null,       // Discord user ID of the session creator (host)
    bool IsHostConnected = false,       // Whether the host is currently connected
    DateTime? HostLastSeen = null       // When the host was last connected (for grace period)
);

// Session TTL Rules:
// - Host connected: 24 hours from creation
// - Host disconnected: 30-minute grace period, then 4-hour max
// - Empty session: 5 minutes until expiration
// - Active P2P transfers: Session will not expire mid-transfer

public record Peer(
    string ConnectionId,
    string SessionId,
    bool IsInitiator
);

// Signaling Messages
public abstract record SignalingMessage(string Type);

public record OfferMessage(string Sdp) : SignalingMessage("offer");

public record AnswerMessage(string Sdp) : SignalingMessage("answer");

public record IceCandidateMessage(
    string Candidate,
    string? SdpMid,
    int? SdpMLineIndex
) : SignalingMessage("ice-candidate");

public record PublicKeyMessage(string KeyJwk) : SignalingMessage("public-key");

public record SignatureMessage(
    string Signature,
    string Challenge
) : SignalingMessage("signature");

// Configuration
public record IceServerConfig(
    string[] Urls,
    string? Username = null,
    string? Credential = null
);
```

---

## Core Workflows

### 1. Session Creation Flow

```
┌──────────┐          ┌──────────────┐          ┌──────────┐
│ Sender   │          │   Signaling  │          │ Receiver │
│ Browser  │          │    Server    │          │ Browser  │
└────┬─────┘          └──────┬───────┘          └────┬─────┘
     │                       │                       │
     │  1. Create Session    │                       │
     │──────────────────────►│                       │
     │                       │                       │
     │  2. Session ID        │                       │
     │◄──────────────────────│                       │
     │                       │                       │
     │  3. Generate Link     │                       │
     │  (sendie.io/s/{id})   │                       │
     │                       │                       │
     │                       │   4. Join Session     │
     │                       │◄──────────────────────│
     │                       │                       │
     │  5. Peer Connected    │   5. Peer Connected   │
     │◄──────────────────────│──────────────────────►│
     │                       │                       │
```

### 2. WebRTC Connection Flow

```
┌──────────┐          ┌──────────────┐          ┌──────────┐
│ Sender   │          │   Signaling  │          │ Receiver │
│ (Offer)  │          │    Server    │          │ (Answer) │
└────┬─────┘          └──────┬───────┘          └────┬─────┘
     │                       │                       │
     │  1. Create Offer      │                       │
     │  (RTCPeerConnection)  │                       │
     │                       │                       │
     │  2. Send SDP Offer    │                       │
     │──────────────────────►│──────────────────────►│
     │                       │                       │
     │                       │   3. Create Answer    │
     │                       │                       │
     │   4. SDP Answer       │◄──────────────────────│
     │◄──────────────────────│                       │
     │                       │                       │
     │  5. ICE Candidates    │   5. ICE Candidates   │
     │◄─────────────────────►│◄─────────────────────►│
     │       (bidirectional exchange)                │
     │                       │                       │
     │═══════════════════════════════════════════════│
     │        6. Direct P2P DataChannel              │
     │═══════════════════════════════════════════════│
```

### 3. Identity Verification Flow

```
┌────────────────┐                        ┌────────────────┐
│    Peer A      │                        │    Peer B      │
└───────┬────────┘                        └───────┬────────┘
        │                                         │
        │  1. Generate ECDSA Key Pair             │  1. Generate ECDSA Key Pair
        │                                         │
        │  2. Exchange Public Keys (over DataChannel)
        │◄───────────────────────────────────────►│
        │                                         │
        │  3. Generate Random Challenge           │  3. Generate Random Challenge
        │                                         │
        │  4. Sign Challenge with Private Key     │  4. Sign Challenge with Private Key
        │                                         │
        │  5. Exchange Signatures                 │
        │◄───────────────────────────────────────►│
        │                                         │
        │  6. Verify Signature with              │  6. Verify Signature with
        │     Peer's Public Key                  │     Peer's Public Key
        │                                         │
        │  7. Derive SAS Code from               │  7. Derive SAS Code from
        │     Combined Public Keys               │     Combined Public Keys
        │                                         │
        │  ════════════════════════════════════  │
        │      8. Users Compare SAS Codes        │
        │         (Out-of-band verification)     │
        │  ════════════════════════════════════  │
```

### 4. File Transfer Flow

```
┌────────────────┐                        ┌────────────────┐
│    Sender      │                        │    Receiver    │
└───────┬────────┘                        └───────┬────────┘
        │                                         │
        │  1. User Selects File                   │
        │     (or queues files before connect)    │
        │                                         │
        │  2. Send File Metadata                  │
        │────────────────────────────────────────►│
        │                                         │
        │                                         │  3. Auto-accept (if enabled)
        │                                         │     or silently ignore
        │                                         │
        │  4. Read File in Chunks (64KB each)     │
        │     using File.stream() API             │
        │                                         │
        │  5. Send Chunk via DataChannel          │
        │────────────────────────────────────────►│
        │                                         │  6. Append to Blob/
        │                                         │     Write to FileSystem
        │  7. Repeat until complete               │
        │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►│
        │                                         │
        │                                         │  8. Verify Integrity
        │                                         │     (Optional SHA-256)
        │                                         │
        │  9. Transfer Complete ACK               │
        │◄────────────────────────────────────────│
```

### 5. File Queue and Broadcast Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          FILE QUEUE / BROADCAST FLOW                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  QUEUE MODE (when alone in session):                                        │
│  ┌─────────────────┐                                                        │
│  │ 1. User drops   │──► Files queued locally                                │
│  │    files        │    (not sent yet)                                      │
│  └─────────────────┘                                                        │
│           │                                                                 │
│           ▼                                                                 │
│  ┌─────────────────┐     ┌─────────────────┐                               │
│  │ 2. Peer joins & │────►│ 3. Queued files │──► Queue cleared               │
│  │    connects     │     │    auto-send    │    (one-time send)             │
│  └─────────────────┘     └─────────────────┘                               │
│                                                                             │
│  BROADCAST MODE (toggle enabled):                                           │
│  ┌─────────────────┐                                                        │
│  │ 1. User enables │──► Files marked as "broadcast"                         │
│  │    broadcast    │                                                        │
│  └─────────────────┘                                                        │
│           │                                                                 │
│           ▼                                                                 │
│  ┌─────────────────┐     ┌─────────────────┐                               │
│  │ 2. Peer A joins │────►│ 3. Broadcast    │                               │
│  └─────────────────┘     │    files sent   │                               │
│           │              └─────────────────┘                               │
│           ▼                                                                 │
│  ┌─────────────────┐     ┌─────────────────┐                               │
│  │ 4. Peer B joins │────►│ 5. Same files   │──► Continues for all          │
│  │    (later)      │     │    sent to B    │    new joiners                 │
│  └─────────────────┘     └─────────────────┘                               │
│                                                                             │
│  AUTO-RECEIVE (receiver-side toggle):                                       │
│  • Enabled (default): Files automatically accepted and downloaded           │
│  • Disabled: Incoming file transfers are silently ignored                   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Security Design

### Encryption Layers

| Layer | Protocol | Purpose |
|-------|----------|---------|
| **Transport** | DTLS 1.2/1.3 | WebRTC DataChannel encryption (automatic) |
| **Signaling** | TLS 1.3 (WSS) | Secure signaling message exchange |
| **Identity** | ECDSA P-256 | Key ownership verification |

### Cryptographic Operations

```typescript
// Key Generation (ECDSA P-256)
const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true, // extractable for sharing public key
  ['sign', 'verify']
);

// Signing
const signature = await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' },
  keyPair.privateKey,
  challengeData
);

// Verification
const isValid = await crypto.subtle.verify(
  { name: 'ECDSA', hash: 'SHA-256' },
  peerPublicKey,
  signature,
  challengeData
);
```

### Short Authentication String (SAS) Generation

The SAS code is a 4-word phrase derived from **both** peers' public keys combined. Since both peers use the same input (sorted keys), they will see the **same** SAS code. This allows out-of-band verification that no man-in-the-middle is intercepting the connection.

```typescript
// Derive SAS from combined public keys
async function generateSAS(
  localKey: CryptoKey, 
  remoteKey: CryptoKey
): Promise<string> {
  // Export keys and combine
  const localJwk = await crypto.subtle.exportKey('jwk', localKey);
  const remoteJwk = await crypto.subtle.exportKey('jwk', remoteKey);
  
  const combined = JSON.stringify([localJwk, remoteJwk].sort());
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(combined)
  );
  
  // Convert to memorable words (first 4 bytes → 4 words)
  const words = ['apple', 'banana', 'cherry', ...]; // 256 word list
  const view = new Uint8Array(hash);
  
  return [
    words[view[0]],
    words[view[1]],
    words[view[2]],
    words[view[3]]
  ].join('-');
}
```

### Friendly Names (Peer Identification)

Each peer is assigned a human-readable **friendly name** derived from their individual public key. This helps users identify themselves and coordinate in multi-peer sessions.

**Key differences from SAS codes:**
- **Friendly Name**: Derived from a single public key → unique to each peer (e.g., "cosmic-tiger")
- **SAS Code**: Derived from two combined public keys → shared between two connected peers

```typescript
// Generate friendly name from a single public key
async function generateFriendlyName(publicKeyJwk: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(publicKeyJwk)
  );
  const view = new Uint8Array(hash);
  
  // 64 adjectives × 64 nouns = 4,096 unique combinations
  const ADJECTIVES = ['cosmic', 'swift', 'calm', 'bright', ...]; // 64 words
  const NOUNS = ['tiger', 'falcon', 'phoenix', 'dragon', ...];   // 64 words
  
  const adjective = ADJECTIVES[view[0] % 64];
  const noun = NOUNS[view[1] % 64];
  
  return `${adjective}-${noun}`;
}
```

**UX Benefits:**
- Users can see their own identity ("You are: cosmic-tiger") immediately upon joining
- Users can tell others which peer they are for coordination
- More memorable than truncated connection IDs
- Deterministic: same key always produces the same name

### Threat Mitigations

| Threat | Mitigation |
|--------|------------|
| **MITM Attack** | SAS verification, signature exchange |
| **Eavesdropping** | DTLS encryption (automatic in WebRTC) |
| **Session Hijacking** | Short-lived sessions, single-use tokens |
| **Replay Attack** | Random challenges, session binding |
| **DoS** | Rate limiting, session limits per IP |
| **Malicious Filenames** | `sanitizeFilename()` removes path traversal, XSS, and dangerous chars |

---

## API Design

### SignalR Hub (C#)

```csharp
public class SignalingHub : Hub
{
    // Session Management
    public async Task<string> CreateSession();
    public async Task<object> JoinSession(string sessionId);
    // Returns: { success, isInitiator, existingPeers, isHost, hostConnectionId, isLocked, isHostOnlySending }
    public async Task LeaveSession();
    
    // WebRTC Signaling
    public async Task SendOffer(string sdp);
    public async Task SendAnswer(string sdp);
    public async Task SendIceCandidate(IceCandidateMessage candidate);
    
    // Targeted Signaling (for mesh topology)
    public async Task SendOfferTo(string targetPeerId, string sdp);
    public async Task SendAnswerTo(string targetPeerId, string sdp);
    public async Task SendIceCandidateTo(string targetPeerId, ...);
    public async Task SendPublicKeyTo(string targetPeerId, string keyJwk);
    
    // Identity Verification
    public async Task SendPublicKey(string keyJwk);
    public async Task SendSignature(string signature, string challenge);
    
    // Session Control (Host Powers)
    public async Task<object> LockSession();    // Prevent new peers from joining
    public async Task<object> UnlockSession();  // Allow new peers to join
    public async Task<object> KickPeer(string targetPeerId);  // Remove peer from session
    public async Task<object> EnableHostOnlySending();   // Only host can send files
    public async Task<object> DisableHostOnlySending();  // Everyone can send files
    
    // Connection State Tracking
    public async Task ReportConnectionEstablished(string targetPeerId);
    public async Task ReportConnectionClosed(string targetPeerId);
    
    // Client Events (invoked by server)
    // - OnPeerJoined(peerId)
    // - OnPeerLeft(peerId)
    // - OnOffer(peerId, sdp)
    // - OnAnswer(peerId, sdp)
    // - OnIceCandidate(peerId, candidate, sdpMid, sdpMLineIndex)
    // - OnPublicKey(peerId, keyJwk)
    // - OnSignature(peerId, signature, challenge)
    // - OnSessionLocked()       // Session was locked by host
    // - OnSessionUnlocked()     // Session was unlocked by host
    // - OnKicked()              // You were kicked from the session
    // - OnHostOnlySendingEnabled()   // Host-only sending was enabled
    // - OnHostOnlySendingDisabled()  // Host-only sending was disabled
}
```

### REST Endpoints (C#)

```
GET  /api/health              # Health check
GET  /api/ice-servers         # Get STUN/TURN configuration
POST /api/sessions            # Create new session (returns session ID)
GET  /api/sessions/{id}       # Get session info (exists, peer count)
```

---

## Configuration

### ICE Server Configuration

```json
{
  "IceServers": [
    {
      "urls": ["stun:stun.l.google.com:19302"]
    },
    {
      "urls": ["stun:stun1.l.google.com:19302"]
    },
    {
      "urls": ["turn:turn.sendie.io:3478"],
      "username": "sendie",
      "credential": "${TURN_SECRET}"
    }
  ]
}
```

### Application Settings

```json
{
  "Session": {
    "MaxDurationMinutes": 60,
    "MaxPeersPerSession": 2,
    "CleanupIntervalSeconds": 300
  },
  "RateLimiting": {
    "SessionsPerIpPerHour": 20,
    "SignalingMessagesPerMinute": 100
  },
  "Transfer": {
    "ChunkSizeBytes": 65536,
    "MaxConcurrentChunks": 4
  }
}
```

---

## Performance Considerations

### File Chunking Strategy

| File Size | Chunk Size | Rationale |
|-----------|------------|-----------|
| < 10 MB | 16 KB | Lower latency for small files |
| 10 MB - 1 GB | 64 KB | Balanced throughput/overhead |
| > 1 GB | 256 KB | Maximize throughput for large files |

### Memory Management

```typescript
// Stream-based file reading (avoids loading entire file)
async function* streamFile(file: File, chunkSize: number) {
  const stream = file.stream();
  const reader = stream.getReader();
  
  let buffer = new Uint8Array(0);
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer = concat(buffer, value);
    
    while (buffer.length >= chunkSize) {
      yield buffer.slice(0, chunkSize);
      buffer = buffer.slice(chunkSize);
    }
  }
  
  if (buffer.length > 0) {
    yield buffer;
  }
}
```

### DataChannel Configuration

```typescript
const dataChannel = peerConnection.createDataChannel('fileTransfer', {
  ordered: true,           // Guaranteed order (like TCP)
  maxRetransmits: undefined // Reliable delivery
});

// Buffer management
dataChannel.bufferedAmountLowThreshold = 64 * 1024; // 64KB
dataChannel.onbufferedamountlow = () => {
  // Resume sending when buffer drains
};
```

---

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Docker Compose                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │    Frontend     │    │    Backend      │                │
│  │    (nginx)      │    │    (C#/.NET)    │                │
│  │                 │    │                 │                │
│  │  - Static files │    │  - SignalR Hub  │                │
│  │  - SPA routing  │    │  - REST API     │                │
│  │                 │    │                 │                │
│  │    Port: 80     │    │   Port: 5000    │                │
│  └────────┬────────┘    └────────┬────────┘                │
│           │                      │                         │
│           └──────────┬───────────┘                         │
│                      │                                     │
│              ┌───────┴───────┐                             │
│              │   Traefik     │                             │
│              │   (Reverse    │                             │
│              │    Proxy)     │                             │
│              │               │                             │
│              │  - TLS        │                             │
│              │  - Routing    │                             │
│              └───────────────┘                             │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                    Coturn                           │   │
│  │              (STUN/TURN Server)                     │   │
│  │                                                     │   │
│  │  - UDP 3478 (STUN/TURN)                            │   │
│  │  - UDP 49152-65535 (Relay)                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Development Phases

### Phase 1: MVP (Core Transfer) ✅ COMPLETE
- [x] Basic React UI with file selection
- [x] SignalR signaling server
- [x] WebRTC peer connection setup
- [x] Simple file transfer (small files)
- [x] Session link sharing

### Phase 2: Robustness ✅ MOSTLY COMPLETE
- [x] Large file streaming (chunked transfer with StreamSaver.js)
- [x] Progress tracking with speed/ETA
- [ ] Connection recovery on temporary drops
- [ ] TURN server fallback

### Phase 3: Security ✅ PARTIALLY COMPLETE
- [x] Key pair generation and exchange (ECDSA P-256)
- [x] SAS code display and comparison
- [x] Filename sanitization for received files
- [ ] Full signature-based verification flow
- [ ] File integrity verification (SHA-256)

### Phase 4: Polish ✅ MOSTLY COMPLETE
- [x] Mobile-responsive UI
- [x] Multiple file transfer
- [x] Drag-and-drop improvements
- [x] Multi-peer support (up to 10 peers)
- [ ] Transfer history (session-only)
- [x] Dark mode
- [x] Host controls (lock/unlock session, kick peers)
- [x] Host badge indicator
- [x] File queue (queue before peers join, auto-send on connect)
- [x] Broadcast mode (send to all new joiners)
- [x] Auto-receive toggle (receiver can disable)

### Phase 5: Scale ✅ IN PROGRESS
- [x] Kubernetes deployment (AKS)
- [ ] Multi-region deployment
- [ ] Analytics and monitoring
- [x] Rate limiting and abuse prevention
- [ ] Load testing and optimization

---

## References

- [WebRTC API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [Web Crypto API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [SignalR Documentation](https://docs.microsoft.com/en-us/aspnet/core/signalr)
- [FilePizza (Reference Implementation)](https://github.com/nickolasburr/filepizza)
- [ShareDrop (Reference Implementation)](https://github.com/nickolasburr/sharedrop)
- [Coturn TURN Server](https://github.com/coturn/coturn)
