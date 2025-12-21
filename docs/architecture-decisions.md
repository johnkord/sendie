# Sendie - Architecture Decisions & Implementation Notes

This document captures key architecture decisions, implementation details, and operational knowledge for the Sendie application.

---

## Table of Contents

1. [Authentication & Authorization](#authentication--authorization)
2. [Security Improvements](#security-improvements)
3. [Deployment](#deployment)
4. [Local Development](#local-development)
5. [Decision Log](#decision-log)

---

## Authentication & Authorization

### Overview

Sendie uses **Discord OAuth2** for authentication with a **runtime-managed allow-list** for authorization. This provides:

- Familiar login experience (most users have Discord)
- No password management burden
- Admin-controlled access via allow-list
- Audit trail of who was granted access and by whom

### Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────►│   Sendie    │────►│   Discord   │
│             │◄────│   Server    │◄────│   OAuth2    │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │ Allow-List  │
                    │ (In-Memory) │
                    └─────────────┘
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `AllowListService` | `Services/AllowListService.cs` | In-memory allow-list with config-loaded admins |
| `AllowListHandler` | `Authorization/AuthorizationHandlers.cs` | Checks if user is on allow-list |
| `AdminHandler` | `Authorization/AuthorizationHandlers.cs` | Checks if user is an admin |
| `AuthService` | `client/src/services/AuthService.ts` | Frontend auth API calls |
| `authStore` | `client/src/stores/authStore.ts` | Zustand store for auth state |
| `ProtectedRoute` | `client/src/components/ProtectedRoute.tsx` | Route protection wrapper |
| `UserHeader` | `client/src/components/UserHeader.tsx` | User info + logout button |
| `AdminPage` | `client/src/pages/AdminPage.tsx` | Admin panel for user management |

### Authorization Policies

- **`AllowedUser`**: User is authenticated AND on the allow-list
- **`Admin`**: User is authenticated AND in the config-defined admin set

### Cookie-Based Sessions (Not JWT)

**Decision**: Use encrypted cookies instead of JWT tokens.

**Rationale**:
- SignalR WebSocket connections work better with cookies (automatic inclusion)
- Stateless anyway - claims encrypted in cookie, no server-side session store
- Simpler implementation - no token refresh logic needed
- HttpOnly cookies prevent XSS token theft

**Configuration**:
```csharp
options.Cookie.Name = "Sendie.Auth";
options.Cookie.HttpOnly = true;
options.Cookie.SameSite = SameSiteMode.Lax;
options.ExpireTimeSpan = TimeSpan.FromDays(7);
options.SlidingExpiration = true;
```

### Discord OAuth Setup

1. Create application at https://discord.com/developers/applications
2. Add redirect URLs:
   - Development: `http://localhost:5000/signin-discord`
   - Production: `https://sendie.curlyquote.com/signin-discord`
3. Copy Client ID and Client Secret to configuration

---

## Security Improvements

### 1. Cryptographic Session IDs (Implemented)

**Problem**: Original implementation used `System.Random` for session IDs, which is predictable.

**Solution**: Use `RandomNumberGenerator` (CSPRNG) with 128-bit entropy.

```csharp
public string GenerateSessionId()
{
    var bytes = RandomNumberGenerator.GetBytes(16); // 128 bits
    return Convert.ToBase64String(bytes)
        .Replace("+", "-")
        .Replace("/", "_")
        .TrimEnd('=');
}
```

**Location**: `Services/SessionService.cs`

### 2. Discord Identity System (Implemented)

Replaced the incomplete ECDSA identity verification with Discord OAuth2. See [Authentication & Authorization](#authentication--authorization).

### 3. Remaining Security Considerations

From the original security analysis, these items remain for future consideration:

- **File consent enforcement**: Currently client-side only; could add server-side consent tracking
- **File integrity verification**: Add SHA-256 hash verification for transferred files
- **Rate limiting**: Add rate limiting to session creation and signaling endpoints
- **Session expiration**: Sessions should auto-expire after inactivity

### 4. Privacy vs Anonymity (Clarification)

Sendie is **privacy-focused** but **not anonymous**:

| Property | Status | Explanation |
|----------|--------|-------------|
| Server can see files | ❌ No | Files transfer P2P, never through server |
| Server logs transfers | ❌ No | Only session existence is known |
| Transfers are encrypted | ✅ Yes | DTLS (WebRTC standard) |
| Peers see each other's IPs | ✅ Yes | Required for P2P connections |
| Works with Tor | ❌ No | Tor disables WebRTC |
| Works with VPN | ✅ Yes | With WebRTC leak protection |

See `docs/what-is-sendie.md` for user-facing documentation on this topic.

---

## Deployment

### Kubernetes (AKS)

Sendie is deployed to Azure Kubernetes Service with the following resources:

| Resource | File | Description |
|----------|------|-------------|
| Namespace | `k8s/namespace.yaml` | `sendie` namespace |
| ConfigMap | `k8s/configmap.yaml` | Admin IDs, environment settings |
| Secrets | `k8s/secrets.yaml` | Discord credentials (gitignored) |
| Server Deployment | `k8s/server-deployment.yaml` | .NET 8 API + SignalR |
| Client Deployment | `k8s/client-deployment.yaml` | Nginx serving React SPA |
| Ingress | `k8s/ingress.yaml` | TLS termination, routing |

### Container Images

- **Server**: `<your-acr>.azurecr.io/sendie-server:latest`
- **Client**: `<your-acr>.azurecr.io/sendie-client:latest`

### Deployment Commands

```bash
# First time: copy and fill in secrets
cp k8s/secrets.yaml.template k8s/secrets.yaml
# Edit k8s/secrets.yaml with real values

# Set your ACR name
export ACR_NAME="your-acr-name"

# Deploy everything
./deploy.sh

# Or manually:
az acr login --name $ACR_NAME
docker build -t $ACR_NAME.azurecr.io/sendie-server:latest ./server/Sendie.Server
docker build -t $ACR_NAME.azurecr.io/sendie-client:latest ./client
docker push $ACR_NAME.azurecr.io/sendie-server:latest
docker push $ACR_NAME.azurecr.io/sendie-client:latest
kubectl apply -f k8s/
```

### Ingress Routing

| Path | Backend |
|------|---------|
| `/api/*` | sendie-server |
| `/hubs/*` | sendie-server (WebSocket) |
| `/signin-discord` | sendie-server (OAuth callback) |
| `/health` | sendie-server |
| `/*` | sendie-client (SPA) |

### TLS

- Managed by cert-manager with Let's Encrypt (`letsencrypt-prod` ClusterIssuer)
- Certificate stored in `sendie-tls` secret

---

## Local Development

### Prerequisites

- .NET 8 SDK
- Node.js 20+
- Docker (for container builds)

### Setup

```bash
# Install dependencies
dotnet restore server/Sendie.Server
npm install --prefix client

# Or use VS Code task:
# Ctrl+Shift+P → "Run Task" → "setup"
```

### Secrets Configuration

Use .NET User Secrets (stored outside repo in `~/.microsoft/usersecrets/`):

```bash
cd server/Sendie.Server

# Initialize (already done)
dotnet user-secrets init

# Set your Discord credentials
dotnet user-secrets set "Discord:ClientId" "your-client-id"
dotnet user-secrets set "Discord:ClientSecret" "your-client-secret"
dotnet user-secrets set "AccessControl:Admins:0" "your-discord-user-id"

# Verify
dotnet user-secrets list
```

### Running

**Option 1: VS Code (Recommended)**
- Press F5 or use Run and Debug panel
- Select "Launch Full Stack" to run both server and client

**Option 2: Terminal**
```bash
# Terminal 1: Server
cd server/Sendie.Server
dotnet run

# Terminal 2: Client
cd client
npm run dev
```

**URLs**:
- Frontend: http://localhost:5173
- API: http://localhost:5000
- SignalR Hub: http://localhost:5000/hubs/signaling

### Discord OAuth Redirect

For local development, add this redirect URL in Discord Developer Portal:
```
http://localhost:5000/signin-discord
```

---

## Decision Log

### 2024-12-24: Multi-Peer Mesh Topology

**Context**: Users requested ability to share files with more than 2 people in a single session.

**Decision**: Implement full mesh WebRTC topology where each peer connects to all others.

**Rationale**:
- Each peer maintains N-1 connections (where N = total peers)
- Maximum 5-10 peers per session (configurable via `MaxPeers`)
- Files are broadcast to all connected peers simultaneously
- Simpler than SFU (Selective Forwarding Unit) - no relay server needed
- Mesh works well for small groups; SFU would be better for large groups (10+)

**Trade-offs**:
- Sender bandwidth scales with peer count (uploads to each peer)
- Connection overhead increases quadratically with peer count
- Ideal for 2-5 peers, workable up to 10

**Implementation**:
- `MultiPeerWebRTCService.ts` - manages Map of peer connections
- `MultiPeerFileTransferService.ts` - broadcasts files to all peers
- `MultiPeerSessionPage.tsx` - shows peer list with SAS codes
- Server tracks multiple peers per session with `MaxPeers` limit

### 2024-12-24: WebRTC "Glare" Prevention

**Context**: When both peers tried to connect simultaneously, both would create offers, causing connection failures ("glare" condition).

**Decision**: Only joining peers create offers; existing peers wait for incoming offers.

**Rationale**:
- Deterministic offer/answer roles prevent race conditions
- New peer joins → creates offers to all existing peers
- Existing peers receive offers and respond with answers
- Server notifies existing peers of new peer arrival

### 2024-12-24: Public Session Joining

**Context**: Original design required authentication for both session creation and joining.

**Decision**: Make session joining public; only session creation requires Discord auth.

**Rationale**:
- Users want to share files with people who may not have Discord
- Link-based sharing is the core UX (just share a URL)
- Creator authentication provides accountability
- Session IDs are cryptographically random (128-bit), so guessing is infeasible

**Implementation**:
- Removed `[Authorize]` from SignalingHub
- Session GET endpoint is public
- Session POST requires authentication
- ICE servers endpoint is public

### 2024-12-24: Deployment-Specific Secrets

**Context**: Admin user IDs should not be hardcoded in committed config files.

**Decision**: Move admin IDs to `secrets.yaml` (gitignored) instead of `configmap.yaml`.

**Rationale**:
- `secrets.yaml` is already deployment-specific and not committed
- Follows same pattern as Discord credentials
- Template file (`secrets.yaml.template`) documents the required fields
- Each deployment can have different admins

### 2024-12-24: OAuth Callback Ingress Route

**Context**: After Discord OAuth, callback to `/signin-discord` was being served by nginx (client) instead of ASP.NET (server).

**Decision**: Add explicit ingress route for `/signin-discord` to server backend.

**Rationale**:
- OAuth callback must be handled by ASP.NET auth middleware
- Client catch-all route (`/`) was intercepting it
- Explicit route ensures callback goes to server

**Ingress routes to server**:
- `/api/*` - REST API
- `/hubs/*` - SignalR WebSocket
- `/signin-discord` - OAuth callback
- `/health` - Health check

### 2024-12-24: ForwardedHeaders for HTTPS Detection

**Context**: Behind nginx ingress with TLS termination, ASP.NET saw HTTP requests and generated wrong OAuth redirect URIs.

**Decision**: Add ForwardedHeaders middleware to read `X-Forwarded-Proto` header.

**Rationale**:
- Ingress terminates TLS, forwards HTTP to pods
- Without ForwardedHeaders, OAuth callback URL was `http://` instead of `https://`
- Middleware reads `X-Forwarded-Proto: https` and sets correct scheme

### 2024-12-24: K8s Recreate Deployment Strategy

**Context**: RollingUpdate strategy was failing due to resource constraints (new pod couldn't start while old was running).

**Decision**: Use `Recreate` strategy for server deployment.

**Rationale**:
- Small AKS cluster with limited resources
- Recreate stops old pod before starting new one
- Acceptable for this application (brief downtime during deploys)
- Could switch to RollingUpdate with larger cluster

### 2024-12-24: P2P Anonymity Limitations (Documented)

**Context**: Users may expect Sendie to provide anonymity since it's "privacy-focused."

**Decision**: Document clearly that Sendie does NOT provide anonymity—peers see each other's IP addresses.

**Rationale**:
- WebRTC requires exchanging IP addresses during ICE (Interactive Connectivity Establishment)
- This is fundamental to P2P — direct connections require knowing where to connect
- Tor Browser won't work because it disables WebRTC to prevent IP leaks
- VPNs work but require WebRTC leak protection enabled

**Privacy model clarification**:
- ✅ **Server-blind**: We can't see your files
- ✅ **Encrypted**: All transfers use DTLS
- ❌ **Anonymous**: Peers see each other's IPs (or VPN exit IPs)

**Compatibility matrix**:
| Network Environment | Works? | Anonymity |
|---------------------|--------|-----------|
| Regular browser | ✅ | None — real IP visible |
| VPN + leak protection | ✅ | VPN exit IP visible |
| Corporate/University NAT | ✅ | Shared IP |
| Mobile CGNAT | ✅ | Carrier IP (shared) |
| Tor Browser | ❌ | N/A — WebRTC disabled |

**Recommendation for anonymity-seeking users**: Use a VPN with WebRTC leak protection enabled. This is documented in `docs/what-is-sendie.md`.

### 2024-12-24: Discord OAuth over Custom ECDSA

**Context**: Original design had incomplete ECDSA-based identity verification.

**Decision**: Replace with Discord OAuth2 + allow-list.

**Rationale**:
- Most target users already have Discord accounts
- Proven security model vs. home-grown crypto
- Allows runtime management of authorized users
- Admins defined at config-time, users at runtime

### 2024-12-24: Cookies over JWT

**Context**: Needed to choose session mechanism for Discord OAuth.

**Decision**: Use encrypted cookie-based sessions.

**Rationale**:
- SignalR WebSocket connections automatically include cookies
- JWT would require manual token injection for SignalR
- Both are stateless; cookies simpler for this use case
- HttpOnly cookies more secure against XSS

### 2024-12-24: In-Memory Allow-List

**Context**: Need to store authorized users.

**Decision**: In-memory ConcurrentDictionary with config seeding.

**Rationale**:
- Simple, fast, no external dependencies
- Single replica deployment (no shared state needed)
- Config-defined admins and initial users
- Future: Could add Redis/database for persistence

### 2024-12-24: User Secrets for Local Dev

**Context**: Need secure way to store Discord credentials locally.

**Decision**: Use .NET User Secrets.

**Rationale**:
- Built into .NET, no extra tooling
- Stored outside repo (no gitignore issues)
- Automatically loaded in Development environment
- Standard practice for .NET development

---

## File Reference

### Server Structure
```
server/Sendie.Server/
├── Program.cs                 # App entry, auth config, endpoints
├── Hubs/
│   └── SignalingHub.cs       # SignalR hub for WebRTC signaling
├── Services/
│   ├── ISessionService.cs    # Session management interface
│   ├── SessionService.cs     # Cryptographic session IDs
│   ├── IAllowListService.cs  # Allow-list interface
│   └── AllowListService.cs   # In-memory allow-list
├── Authorization/
│   └── AuthorizationHandlers.cs  # AllowList + Admin handlers
└── Models/
    └── Models.cs             # DTOs
```

### Client Structure
```
client/src/
├── App.tsx                   # Routes with ProtectedRoute
├── components/
│   ├── ProtectedRoute.tsx    # Auth gate component
│   ├── UserHeader.tsx        # User info + logout
│   ├── PeerList.tsx          # Multi-peer list with SAS codes
│   └── ...
├── pages/
│   ├── HomePage.tsx          # Landing + session create/join
│   ├── MultiPeerSessionPage.tsx  # Multi-peer file transfer UI
│   └── AdminPage.tsx         # User management
├── services/
│   ├── AuthService.ts        # Auth API calls
│   ├── MultiPeerWebRTCService.ts   # Mesh peer connections
│   ├── MultiPeerFileTransferService.ts  # Broadcast file transfers
│   └── ...
└── stores/
    ├── appStore.ts           # App state (peers, transfers)
    └── authStore.ts          # Auth state (user, loading)
```

### Kubernetes Structure
```
k8s/
├── namespace.yaml
├── configmap.yaml            # Admin IDs, env vars
├── secrets.yaml.template     # Template (committed)
├── secrets.yaml              # Real secrets (gitignored)
├── server-deployment.yaml
├── client-deployment.yaml
└── ingress.yaml              # TLS, routing
```
