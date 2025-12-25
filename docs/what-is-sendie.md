# What is Sendie?

Sendie is a browser-based file transfer tool. This document explains what it is and what it promises, tailored to different audiences.

---

## For Casual Users

**What it is:** A website where you can send files directly to other people.

**How to use it (session creator):**
1. Sign in with Discord (your account must be on the allow-list)
2. Click "Create Session"
3. Drop files now—they'll queue up and send automatically when someone joins
4. Share the link with whoever you want to receive your files
5. Use host controls to lock the session or remove unwanted peers

**Pro tip:** Enable **Broadcast Mode** to automatically send files to everyone who joins!

**How to use it (joining a session):**
1. Click the session link someone shared with you
2. That's it! No login or account required
3. Receive files directly in your browser

**What we promise:**
- ✅ Your files go directly to the other person's browser
- ✅ We never see or store your files
- ✅ Works with any file size
- ✅ Up to 10 people can join a single session
- ✅ Session hosts can lock sessions and kick peers
- ✅ Queue files before anyone joins—auto-send on connect
- ✅ Broadcast mode sends files to everyone who joins

**What you need:** A modern browser (Chrome, Firefox, Edge, Safari). That's it.

---

## For Privacy-Conscious Users

**What it is:** A zero-knowledge file transfer tool. Your files never touch our servers.

**How it works:**
- Files transfer directly between browsers using WebRTC
- Our server only helps browsers find each other (signaling)
- All transfers are encrypted end-to-end via DTLS

**What we promise:**
- ✅ **Zero server storage** - Files are never uploaded to us
- ✅ **End-to-end encryption** - Built into WebRTC, not our code to break
- ✅ **No file metadata logging** - We don't know what you're sending
- ✅ **Verify recipients** - SAS codes let you confirm who you're connected to

**What we know about you:**
- Your Discord username (only if you create a session—joining requires no login)
- That a session existed (not what was transferred)
- IP addresses in server logs (standard web traffic)

**What we don't know:**
- File names, sizes, contents
- Who received what
- Anything about the actual transfer

**Anonymity considerations:**
- ⚠️ **Peers see each other's IP addresses** — this is inherent to P2P connections
- ❌ **Tor Browser won't work** — Tor disables WebRTC to prevent IP leaks
- ✅ **VPN works** — use one with WebRTC leak protection enabled
- Sendie's privacy promise is about *us* not seeing your files, not hiding your identity from transfer partners

---

## For Power Users

**What it is:** WebRTC-based P2P file transfer with mesh topology for multi-peer sessions.

**Capabilities:**
| Feature | Limit |
|---------|-------|
| Max peers per session | 10 (configurable) |
| Max file size | Unlimited (browser/device constrained) |
| Concurrent transfers | Multiple files, multiple peers |
| Session duration | Until all peers disconnect |
| Host controls | Lock/unlock session, kick peers, restrict sending |
| File queue | Queue files before peers join |
| Broadcast mode | Auto-send to all new joiners |
| Auto-receive | Can be disabled per-user |
| Host-only sending | Restrict file sending to host only |

**Performance notes:**
- Transfer speed depends on the slowest peer's connection
- Sender uploads once per recipient (mesh, not relay)
- Large groups (5+) may strain bandwidth on sender side
- TURN relay used only when direct connection fails

**Tips:**
- Verify SAS codes for sensitive transfers
- Smaller groups = faster transfers
- Both peers need stable connections for best speed
- Use a VPN with WebRTC leak protection if you want to hide your IP from peers
- Use **Broadcast Mode** to distribute files to a group without manually sending each time
- Queue files before sharing the link for instant transfer when people join
- Disable **Auto-receive** if you don't want to accept incoming files
- Enable **Host-only sending** when distributing files to prevent others from sending

---

## For Developers / Self-Hosters

**What it is:** A .NET 8 + React/TypeScript application using SignalR for WebRTC signaling.

**Architecture:**
```
Client (React/Vite) ←→ SignalR Hub ←→ Client (React/Vite)
                            ↓
                    Session Management
                    (in-memory, no DB)
```

**Key components:**
- **Server:** ASP.NET Core Minimal API + SignalR
- **Client:** React 18, TypeScript, Zustand, Tailwind
- **Auth:** Discord OAuth2 with cookie sessions
- **Signaling:** SignalR WebSocket hub
- **P2P:** Native WebRTC with full mesh topology

**Self-hosting requirements:**
- .NET 8 runtime
- Node.js 18+ (for building client)
- Discord OAuth application
- STUN/TURN servers (or use public STUN)
- TLS termination (nginx, Traefik, etc.)

**Deployment options:**
- Docker Compose (simplest)
- Kubernetes (included manifests for AKS)
- Any container orchestrator

**What's not included:**
- Database (sessions are in-memory)
- File storage (by design)
- User management beyond allow-list

---

## For Security Auditors / IT Professionals

**What it is:** A WebRTC-based file transfer application with Discord OAuth authentication.

**Security model:**

| Layer | Implementation |
|-------|----------------|
| Authentication | Discord OAuth2, cookie-based sessions |
| Authorization | Runtime allow-list + config-defined admins |
| Transport (signaling) | TLS 1.2+ (HTTPS/WSS) |
| Transport (P2P) | DTLS 1.2 (WebRTC mandatory) |
| Session IDs | 128-bit CSPRNG (`RandomNumberGenerator`) |
| Identity verification | ECDSA key exchange → SAS code |

**Data flow:**
1. Server facilitates WebRTC signaling only
2. SDP offers/answers and ICE candidates pass through server
3. Actual file data flows peer-to-peer, never through server
4. Server has no visibility into transferred content

**What the server stores:**
- Active sessions (in-memory, not persisted)
- Allow-list (in-memory, seeded from config)
- Standard HTTP access logs

**What the server doesn't store:**
- Files or file metadata
- Transfer history
- Persistent user data

**Authentication flow:**
- Discord OAuth2 with PKCE
- HttpOnly, SameSite=Lax cookies
- 24-hour sliding expiration (resets on each request)
- Data Protection keys persisted to disk for session survival across restarts
- Session creation requires auth; joining does not

**Known limitations:**
- In-memory state (lost on restart)
- No audit logging of transfers (by design)
- No file integrity verification (hash checking)

**Security features implemented:**
- 128-bit cryptographically secure session IDs
- Filename sanitization for received files
- Rate limiting on session creation and signaling

**Anonymity & network considerations:**

| Method | Compatible? | Notes |
|--------|-------------|-------|
| Regular browser | ✅ | IP visible to peers |
| VPN | ✅ | Enable WebRTC leak protection |
| Corporate/University NAT | ✅ | Shared exit IP provides some anonymity |
| Mobile data (CGNAT) | ✅ | IP shared with other users |
| Tor Browser | ❌ | WebRTC disabled by design |

**Important:** WebRTC establishes direct peer-to-peer connections. Peers exchange IP addresses as part of the ICE (Interactive Connectivity Establishment) process. This is fundamental to P2P — there's no way around it without adding a relay server that sees all traffic.

**Compliance considerations:**
- No PII stored beyond Discord ID in allow-list
- GDPR: Minimal data collection, no persistence
- Files never touch infrastructure (no data residency concerns)

---

## Summary Table

| Concern | Answer |
|---------|--------|
| Where do my files go? | Directly to recipients, never our servers |
| Is it encrypted? | Yes, DTLS (WebRTC standard) |
| Do I need an account? | Only to create sessions, not to join |
| File size limit? | None (browser/device limited) |
| How many people? | Up to 10 per session |
| Can you see my files? | No, technically impossible |
| Can peers see my IP? | Yes, unless you use a VPN |
| Does it work on Tor? | No, Tor disables WebRTC |
| Can I queue files? | Yes, auto-send when someone joins |
| What is broadcast mode? | Auto-sends files to every new joiner |
| Can I refuse files? | Yes, disable auto-receive |
| Is it open source? | Yes |
