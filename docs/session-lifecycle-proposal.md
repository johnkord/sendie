# Session Lifecycle & Security Proposal

**Author:** AI Assistant  
**Date:** December 24, 2025  
**Status:** ✅ Implemented (with enhancements)

> **Implementation Note (December 2025):** Option E (Hybrid Approach) has been implemented with an additional enhancement: **24-hour session persistence while the host is connected**. When the session creator (host) is connected, sessions can persist for up to 24 hours. When the host disconnects, there's a 30-minute grace period before the session reverts to the standard 4-hour maximum. See the "Current Implementation" section below for details.

---

## Executive Summary

This document proposes improvements to Sendie's session management system based on identified security concerns and industry best practices. The core issues are:

1. Sessions have a fixed 1-hour TTL that is never extended, regardless of activity
2. Sessions persist after the authenticated creator leaves
3. Unauthenticated users can effectively "inherit" sessions and share them with other unauthenticated users

---

## Current Behavior

### Session Creation & Expiration
- Sessions are created with a fixed `ExpiresAt` of 1 hour from creation time
- TTL is never extended based on activity
- Expired sessions are cleaned up every 5 minutes by a background timer

### Authentication Model
- **Session creation**: Requires `AllowedUser` authorization (authenticated + allow-listed)
- **Session joining**: No authorization required—anyone with the session ID can join
- **Session persistence**: Sessions exist independently of connected peers

### The Problem Scenario
1. User A (authenticated) creates session at 10:00 AM
2. User A shares link with User B (unauthenticated)
3. User A closes browser at 10:05 AM
4. User B shares link with User C (unauthenticated) at 10:10 AM
5. Users B and C can transfer files until 11:00 AM without any authenticated user present

---

## Industry Best Practices (OWASP & WebRTC Standards)

### OWASP Session Management Guidelines

1. **Idle Timeout**: Sessions should have an inactivity timeout (2-5 minutes for high-value apps, 15-30 minutes for low-risk)
2. **Absolute Timeout**: Maximum session lifetime regardless of activity (4-8 hours for typical apps)
3. **Activity-Based Extension**: Sliding expiration that resets on legitimate activity
4. **Session Binding**: Associate sessions with user properties (IP, User-Agent) for anomaly detection

### WebRTC-Specific Considerations

- Signaling servers are typically stateless message routers
- Room/session lifetime is an application-level concern
- Common patterns include:
  - **Owner-controlled rooms**: Room dies when owner leaves
  - **Time-limited rooms**: Fixed expiration regardless of participants
  - **Occupancy-based**: Room persists while occupied, expires when empty

---

## Proposal Options

### Option A: Sliding Expiration (Recommended)

**Concept**: Extend session TTL on activity, but maintain absolute maximum lifetime.

**Implementation**:
```csharp
public record Session(
    string Id,
    DateTime CreatedAt,
    DateTime ExpiresAt,
    DateTime LastActivityAt,    // NEW
    DateTime AbsoluteExpiresAt, // NEW: Hard limit
    int PeerCount = 0,
    int MaxPeers = 10
);
```

**Rules**:
- Initial TTL: 30 minutes
- Extension on activity: Reset to 30 minutes from now
- Absolute maximum: 4 hours from creation
- Activity triggers: Peer join, signaling message (offer/answer/ICE)

**Pros**:
- Prevents mid-transfer expiration
- Natural cleanup of abandoned sessions
- Balances usability and security

**Cons**:
- Slightly more complex state management
- "Activity" definition could be gamed

---

### Option B: Owner-Presence Required

**Concept**: Session remains valid only while the creator is connected.

**Implementation**:
```csharp
public record Session(
    string Id,
    string CreatorConnectionId,  // NEW
    string? CreatorDiscordId,    // NEW: For re-authentication
    DateTime CreatedAt,
    DateTime ExpiresAt,
    int PeerCount = 0,
    int MaxPeers = 10
);
```

**Rules**:
- Session is invalidated when creator disconnects
- OR: Grace period (e.g., 5 minutes) for creator to reconnect
- Other peers are notified and disconnected

**Pros**:
- Strongest security model
- Clear accountability
- No "orphaned" sessions

**Cons**:
- Poor UX: Creator can't close browser while transfer continues
- Doesn't work for "fire and forget" link sharing
- Creator network issues kill the session

---

### Option C: Empty Session Cleanup (Lightweight)

**Concept**: Sessions expire faster when no peers are connected.

**Implementation**:
```csharp
public record Session(
    string Id,
    DateTime CreatedAt,
    DateTime ExpiresAt,
    DateTime? EmptySince,  // NEW: Set when last peer leaves
    int PeerCount = 0,
    int MaxPeers = 10
);
```

**Rules**:
- Normal TTL while peers are connected (1 hour)
- If session becomes empty, expires in 5 minutes
- If a peer rejoins, reset to normal TTL

**Pros**:
- Simple to implement
- Addresses the "orphaned session" problem
- Good UX for active sessions

**Cons**:
- Doesn't extend TTL for long transfers
- Doesn't solve authentication inheritance issue

---

### Option D: Require Authenticated Anchor

**Concept**: At least one authenticated user must be present in the session at all times.

**Implementation**:
- Track which peers are authenticated via Discord claims
- If no authenticated peers remain, start a countdown (5-10 minutes)
- Notify unauthenticated peers that session will expire
- If authenticated user rejoins, cancel countdown

**Pros**:
- Maintains trust chain from authenticated creator
- Prevents fully anonymous file sharing

**Cons**:
- Breaks the "No Account Required" design philosophy for receivers
- Complex to implement and explain to users
- May frustrate legitimate use cases

---

### Option E: Hybrid Approach (Recommended Alternative)

**Concept**: Combine sliding expiration with empty session cleanup, and never expire while peers are actively connected.

**Rules**:
1. **Base TTL**: 30 minutes, sliding on activity
2. **Absolute maximum (host connected)**: 24 hours from creation
3. **Absolute maximum (host disconnected)**: 4 hours from creation, or 30-minute grace period after host leaves
4. **Empty timeout**: 5 minutes after last peer disconnects
5. **Active connection protection**: Session CANNOT expire while 2+ peers have established WebRTC connections
6. **Creator disconnect**: 30-minute grace period before TTL reduction

**Activity that extends TTL**:
- Peer joins session
- WebRTC connection established (indicates active transfer intent)
- P2P connection reported active
- Host (creator) connects to the session

**Activity that does NOT extend TTL**:
- ICE candidates (too frequent)
- Signaling heartbeats

**Key safety feature**: Even if TTL technically expires, if peers are connected P2P, the transfer continues. The session just becomes "closed to new joiners."

---

## Comparison Matrix

| Criterion | Option A | Option B | Option C | Option D | Option E |
|-----------|----------|----------|----------|----------|----------|
| Security | Medium | High | Low | High | Medium |
| UX for Sender | Good | Poor | Good | Medium | Good |
| UX for Receiver | Good | Poor | Good | Poor | Good |
| Implementation Complexity | Medium | Medium | Low | High | Medium |
| Prevents Orphan Reuse | Partial | Yes | Yes | Yes | Yes |
| Supports Long Transfers | Yes | No | No | Yes | Yes |
| Protects Active Transfers | N/A | No | N/A | N/A | Yes |
| Aligns with Design Goals | Yes | No | Yes | No | Yes |

---

## Recommendation

**Primary: Option E (Hybrid Approach)**

This balances security and usability:
- Sessions naturally expire when abandoned
- Active transfers aren't interrupted
- No authentication burden on receivers
- Simple mental model for users

**Secondary consideration**: If the "B shares link with C" scenario is truly unacceptable, implement Option D but make it opt-in (session creator can choose "require authenticated participants").

---

## Current Implementation

> **Status:** Implemented in December 2025

The hybrid approach (Option E) has been implemented with the following enhancements:

### Session TTL Rules

| Scenario | Maximum Session Lifetime |
|----------|-------------------------|
| Host connected | **24 hours** from session creation |
| Host disconnected (was connected) | **30-minute grace period**, then 4-hour max |
| Host never connected | **4 hours** from session creation |
| Empty session (no peers) | **5 minutes** until expiration |
| Active P2P transfers | Session will not expire mid-transfer |

### Session Model

```csharp
public record Session(
    string Id,
    DateTime CreatedAt,
    DateTime ExpiresAt,
    DateTime AbsoluteExpiresAt,
    DateTime? EmptySince = null,
    int PeerCount = 0,
    int ConnectedPeerPairs = 0,
    int MaxPeers = 10,
    bool IsLocked = false,
    bool IsHostOnlySending = false,
    string? CreatorUserId = null,    // Discord user ID of the session creator (host)
    bool IsHostConnected = false,    // Whether the host is currently connected
    DateTime? HostLastSeen = null    // When the host was last connected (for grace period)
);
```

### Configuration (appsettings.json)

```json
{
  "Session": {
    "BaseTtlMinutes": 30,
    "AbsoluteMaxHoursHostConnected": 24,
    "AbsoluteMaxHoursHostDisconnected": 4,
    "HostGraceMinutes": 30,
    "EmptyTimeoutMinutes": 5
  }
}
```

### SignalR Resilience

Stateful Reconnect is enabled for improved connection resilience during long-running sessions:
- Server: `options.AllowStatefulReconnects = true`
- Client: `.withStatefulReconnect()` with progressive retry pattern

---

## Implementation Sketch for Option E

### Key Design Decision: Connection-Aware Expiration

The server needs to track not just peer count, but whether peers have active WebRTC connections. This requires the client to report connection state.

### New Session Model (SessionService.cs)

```csharp
public record Session(
    string Id,
    DateTime CreatedAt,
    DateTime ExpiresAt,
    DateTime AbsoluteExpiresAt,
    DateTime? EmptySince,
    int PeerCount = 0,
    int ConnectedPeerPairs = 0,  // NEW: Number of established P2P connections
    int MaxPeers = 10
);

// Constants
private readonly TimeSpan _baseTtl = TimeSpan.FromMinutes(30);
private readonly TimeSpan _absoluteMaxTtl = TimeSpan.FromHours(4);  // Extended
private readonly TimeSpan _emptyTimeout = TimeSpan.FromMinutes(5);
```

### Connection State Tracking

Add a new SignalR method for clients to report P2P connection status:

```csharp
// In SignalingHub.cs
public async Task ReportConnectionEstablished(string targetPeerId)
{
    var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
    if (peer != null)
    {
        _sessionService.IncrementConnectedPairs(peer.SessionId);
        _logger.LogInformation(
            "P2P connection established in session {SessionId}: {PeerId} <-> {TargetPeerId}",
            peer.SessionId, Context.ConnectionId, targetPeerId);
    }
}

public async Task ReportConnectionClosed(string targetPeerId)
{
    var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
    if (peer != null)
    {
        _sessionService.DecrementConnectedPairs(peer.SessionId);
    }
}
```

### Modified Expiration Logic

```csharp
public Session? GetSession(string id)
{
    if (_sessions.TryGetValue(id, out var session))
    {
        // Never expire while peers are actively connected P2P
        if (session.ConnectedPeerPairs > 0)
        {
            // Session is "alive" - extend TTL automatically
            var extended = session with { 
                ExpiresAt = DateTime.UtcNow.Add(_baseTtl) 
            };
            // But don't exceed absolute max
            if (extended.ExpiresAt > session.AbsoluteExpiresAt)
            {
                extended = extended with { ExpiresAt = session.AbsoluteExpiresAt };
            }
            _sessions[id] = extended;
            return extended with { PeerCount = GetPeerCount(id) };
        }
        
        // No active connections - normal expiration rules apply
        if (session.ExpiresAt < DateTime.UtcNow)
        {
            RemoveSession(id);
            return null;
        }

        return session with { PeerCount = GetPeerCount(id) };
    }
    return null;
}
```

### Client-Side Reporting (MultiPeerWebRTCService.ts)

```typescript
// When DataChannel opens successfully
private handleDataChannelOpen(peerId: string) {
    // Report to server that we have an active P2P connection
    signalingService.reportConnectionEstablished(peerId);
}

// When connection closes
private handlePeerDisconnected(peerId: string) {
    signalingService.reportConnectionClosed(peerId);
}
```

---

## Important: Transfer Continuity

### Why Active Transfers Won't Be Interrupted

A critical architectural point: **WebRTC DataChannels are peer-to-peer connections that operate independently of the signaling server**.

```
┌─────────────┐                              ┌─────────────┐
│   Peer A    │◄════════════════════════════►│   Peer B    │
│  (Browser)  │    Direct P2P DataChannel    │  (Browser)  │
└─────────────┘         (survives)           └─────────────┘
       │                                            │
       │  SignalR connection                        │  SignalR connection
       │  (can expire)                              │  (can expire)
       ▼                                            ▼
┌──────────────────────────────────────────────────────────┐
│                    Signaling Server                       │
│              (only needed for discovery)                  │
└──────────────────────────────────────────────────────────┘
```

**The signaling session is only needed for:**
1. Initial peer discovery (finding each other)
2. WebRTC offer/answer exchange (negotiation)
3. ICE candidate exchange (NAT traversal)
4. New peers joining mid-session

**Once DataChannels are established:**
- File transfers continue directly peer-to-peer
- Signaling server is not involved in data transfer
- Session expiration does NOT interrupt active transfers

### What Session Expiration Actually Affects

| Scenario | Impact of Session Expiration |
|----------|------------------------------|
| Active file transfer in progress | ✅ **No impact** - continues P2P |
| New peer tries to join via link | ❌ **Blocked** - session not found |
| Peer disconnects and tries to rejoin | ❌ **Blocked** - cannot re-negotiate |
| Peers want to start a new transfer | ⚠️ **Depends** - may need re-negotiation |

### Recommendation: Extend During Active Connections

Even though transfers survive session expiration, we should still extend TTL while peers are connected because:

1. **Reconnection safety**: If a peer's network hiccups, they need the session to reconnect
2. **Multi-file transfers**: Users may send multiple files in sequence
3. **New peer additions**: Creator might share link with additional people mid-session
4. **Good UX**: Avoids confusing "session expired" messages while actively using the app

**Proposed rule**: Session TTL should not expire while 2+ peers have established DataChannels.

---

## Open Questions

1. **Should session TTL be user-configurable?** 
   - Allow creator to choose: 15 min / 30 min / 1 hour / 2 hours?
   - Or keep it simple with fixed values?

2. **Should we track creator identity for audit purposes?**
   - Even if we don't enforce owner-presence, should we log who created which session?
   - Useful for abuse investigation

3. **Should we notify users when session is expiring?**
   - Display countdown timer when < 5 minutes remaining?
   - "Session expiring soon - new peers won't be able to join"

4. **Rate limiting session creation?**
   - Should an authenticated user be limited to N active sessions?
   - Prevents abuse of the "create session, share link, leave" pattern

5. **Should there be a "session owner" concept without enforcement?**
   - Track who created the session
   - Show in UI: "Session created by @username"
   - Provides transparency without blocking functionality

6. **Is the 2-hour absolute maximum appropriate?**
   - Consider: Large file transfers over slow connections
   - Alternative: No absolute max, but session creation counts toward rate limit

7. **Should empty timeout vary based on whether a transfer was ever initiated?**
   - Session with no file transfers: 5 min empty timeout
   - Session where files were transferred: 15 min empty timeout (in case of reconnect)

---

## Next Steps

1. Review this proposal and decide on approach
2. If Option E is approved:
   - Update `Session` model
   - Implement TTL extension logic
   - Add empty session detection
   - Update cleanup timer logic
   - Add client-side countdown/warning UI
3. Consider adding session analytics/logging
4. Update documentation and design doc

---

## References

- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [MDN: WebRTC Signaling and video calling](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling)
- Current implementation: [SessionService.cs](../server/Sendie.Server/Services/SessionService.cs)
