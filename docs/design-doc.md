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
│   └── transferStore.ts        # Global transfer state
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
```

### C# Models

```csharp
// Session Models
public record Session(
    string Id,
    DateTime CreatedAt,
    DateTime ExpiresAt
);

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
        │                                         │
        │  2. Send File Metadata                  │
        │────────────────────────────────────────►│
        │                                         │
        │                                         │  3. Receiver Accepts
        │◄────────────────────────────────────────│
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

### Threat Mitigations

| Threat | Mitigation |
|--------|------------|
| **MITM Attack** | SAS verification, signature exchange |
| **Eavesdropping** | DTLS encryption (automatic in WebRTC) |
| **Session Hijacking** | Short-lived sessions, single-use tokens |
| **Replay Attack** | Random challenges, session binding |
| **DoS** | Rate limiting, session limits per IP |

---

## API Design

### SignalR Hub (C#)

```csharp
public class SignalingHub : Hub
{
    // Session Management
    public async Task<string> CreateSession();
    public async Task JoinSession(string sessionId);
    public async Task LeaveSession();
    
    // WebRTC Signaling
    public async Task SendOffer(string sdp);
    public async Task SendAnswer(string sdp);
    public async Task SendIceCandidate(IceCandidateMessage candidate);
    
    // Identity Verification
    public async Task SendPublicKey(string keyJwk);
    public async Task SendSignature(string signature, string challenge);
    
    // Client Events (invoked by server)
    // - OnPeerJoined(peerId)
    // - OnPeerLeft(peerId)
    // - OnOffer(sdp)
    // - OnAnswer(sdp)
    // - OnIceCandidate(candidate)
    // - OnPublicKey(keyJwk)
    // - OnSignature(signature, challenge)
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

### Phase 1: MVP (Core Transfer)
- [ ] Basic React UI with file selection
- [ ] SignalR signaling server
- [ ] WebRTC peer connection setup
- [ ] Simple file transfer (small files)
- [ ] Session link sharing

### Phase 2: Robustness
- [ ] Large file streaming (chunked transfer)
- [ ] Progress tracking with speed/ETA
- [ ] Connection recovery on temporary drops
- [ ] TURN server fallback

### Phase 3: Security
- [ ] Key pair generation and exchange
- [ ] Signature-based verification
- [ ] SAS code display and comparison
- [ ] File integrity verification (SHA-256)

### Phase 4: Polish
- [ ] Mobile-responsive UI
- [ ] Multiple file transfer
- [ ] Drag-and-drop improvements
- [ ] Transfer history (session-only)
- [ ] Dark mode

### Phase 5: Scale
- [ ] Multi-region deployment
- [ ] Analytics and monitoring
- [ ] Rate limiting and abuse prevention
- [ ] Load testing and optimization

---

## References

- [WebRTC API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [Web Crypto API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [SignalR Documentation](https://docs.microsoft.com/en-us/aspnet/core/signalr)
- [FilePizza (Reference Implementation)](https://github.com/nickolasburr/filepizza)
- [ShareDrop (Reference Implementation)](https://github.com/nickolasburr/sharedrop)
- [Coturn TURN Server](https://github.com/coturn/coturn)
