# What is Sendie?

Sendie is a browser-based peer-to-peer collaboration tool: file transfer, voice chat, camera, screen sharing, and synced video watch-parties, all directly between browsers with no server-side data. This document explains what it is and what it promises, tailored to different audiences.

---

## For Casual Users

**What it is:** A website where you can send files to other people, talk over voice, share your screen, or watch a movie together synced.

**How to use it (session creator):**
1. Sign in with Discord (your account must be on the allow-list)
2. Click "Create Session"
3. Drop files now to queue them, or use the voice / camera / screen / watch-party panels
4. Share the link with whoever you want to join
5. Use host controls to lock the session or remove unwanted peers

**Pro tip:** Enable **Broadcast Mode** to automatically send queued files to everyone who joins.

**How to use it (joining a session):**
1. Click the session link someone shared with you
2. That's it. No login or account required
3. Receive files, join voice, watch the host's video

**What we promise:**
- ✅ Your files, voice, video, and screen go directly to the other person's browser
- ✅ We never see or store any of it
- ✅ Files of any size
- ✅ Up to 10 people can join a single session
- ✅ Hosts can lock sessions and kick peers
- ✅ Queue files before anyone joins; auto-send on connect
- ✅ Broadcast mode for one-to-many file sharing
- ✅ Watch a video file together with synced play, pause, seek, and skip-10s controls

**What you need:** A modern browser (Chrome, Firefox, Edge, Safari). That's it.

---

## For Privacy-Conscious Users

**What it is:** A zero-knowledge peer-to-peer collaboration tool. Files, voice, video, screen contents, and watch-party media never touch our servers.

**How it works:**
- Everything transfers directly between browsers using WebRTC
- Our server only helps browsers find each other (signaling) and handles Discord OAuth
- All transports are end-to-end encrypted via DTLS / SRTP

**What we promise:**
- ✅ **Zero server storage** — files / voice / video / screen / watch-party bytes are never uploaded to us
- ✅ **End-to-end encryption** — built into WebRTC, not our code to break
- ✅ **No metadata logging** — we don't know what you're sending, saying, or watching
- ✅ **Verify recipients** — bound SAS codes let you confirm who you're connected to

**What we know about you:**
- Your Discord username (only if you create a session; joining requires no login)
- That a session existed (not what was transferred)
- IP addresses in server logs (standard web traffic)

**What we don't know:**
- File names, sizes, contents
- What was said over voice, what was on camera or screen
- What movie was watched, who watched, or when
- Anything about the actual transfer

**Anonymity considerations:**
- ⚠️ **Peers see each other's IP addresses** — this is inherent to P2P connections
- ❌ **Tor Browser won't work** — Tor disables WebRTC to prevent IP leaks
- ✅ **VPN works** — use one with WebRTC leak protection enabled
- Sendie's privacy promise is about *us* not seeing your data, not hiding your identity from peers in the same session

---

## For Power Users

**What it is:** WebRTC-based P2P collaboration with mesh topology. File transfer, voice, camera, screen share, and synced media playback all flow through the same DataChannel + RTP transport between peers.

**Capabilities:**
| Feature | Limit / notes |
|---------|---------------|
| Max peers per session | 10 (configurable) |
| Max file size | Unlimited (browser/device constrained) |
| Concurrent transfers | Multiple files, multiple peers |
| Voice chat | Mesh full-duplex; mute toggles per peer |
| Camera | Mesh, one encoder per receiver on the host |
| Screen share | Tab/window/screen; tab/system audio on Chromium; cap of 4 receivers |
| Watch party | Synced play/pause/seek/rate; host sends file via data channel; cap of 4 receivers |
| Skip 10s | Host buttons propagate to followers |
| Resume position | localStorage-backed; 30-day TTL |
| Late-joiner rewind | Host gets a toast when a late peer finishes receiving |
| Session duration | Until all peers disconnect |
| Host controls | Lock/unlock session, kick peers, restrict sending |
| File queue | Queue files before peers join |
| Broadcast mode | Auto-send to all new joiners |
| Auto-receive | Default on; can be disabled per user |
| Host-only sending | Restrict file sending to host only |

**Performance notes:**
- Transfer speed depends on the slowest peer's connection
- Sender uploads once per recipient (mesh, not relay)
- Voice / camera / screen share / watch-party stream all run one encoder per peer connection. Large groups (5+) may strain bandwidth and CPU on the sender side
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
- For watch parties, H.264/AAC mp4 plays everywhere; Firefox on Linux can't decode H.264 without system codecs (the panel surfaces a banner explaining the workaround)

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
| Where do my files / voice / video go? | Directly to other peers, never our servers |
| Is it encrypted? | Yes, DTLS / SRTP (WebRTC standard) |
| Do I need an account? | Only to create sessions, not to join |
| File size limit? | None (browser/device limited) |
| How many people? | Up to 10 per session |
| Voice chat? | Yes, mesh full-duplex |
| Screen share? | Yes, with optional tab/system audio (Chromium) |
| Watch a movie together? | Yes; host picks a file, Sendie sends it to peers, then synced play/pause/seek/skip-10s |
| Can you see anything I send? | No, technically impossible |
| Can peers see my IP? | Yes, unless you use a VPN |
| Does it work on Tor? | No, Tor disables WebRTC |
| Can I queue files? | Yes, auto-send when someone joins |
| What is broadcast mode? | Auto-sends queued files to every new joiner |
| Can I refuse files? | Yes, disable auto-receive |
| Is it open source? | Yes |
