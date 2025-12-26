using System.Collections.Concurrent;
using System.Security.Cryptography;
using Sendie.Server.Models;

namespace Sendie.Server.Services;

public class SessionService : ISessionService
{
    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    private readonly ConcurrentDictionary<string, List<Peer>> _sessionPeers = new();
    private readonly ConcurrentDictionary<string, string> _connectionToUserId = new();  // ConnectionId -> UserId mapping
    private readonly Timer _cleanupTimer;
    private readonly ILogger<SessionService>? _logger;

    // Session TTL configuration
    private readonly TimeSpan _baseTtl = TimeSpan.FromMinutes(30);
    private readonly TimeSpan _absoluteMaxTtlHostConnected = TimeSpan.FromHours(24);    // 24 hours when host is connected
    private readonly TimeSpan _absoluteMaxTtlHostDisconnected = TimeSpan.FromHours(4);  // 4 hours when host is disconnected
    private readonly TimeSpan _hostGracePeriod = TimeSpan.FromMinutes(30);              // Grace period after host disconnects
    private readonly TimeSpan _emptyTimeout = TimeSpan.FromMinutes(5);

    public SessionService(ILogger<SessionService>? logger = null)
    {
        _logger = logger;
        // Cleanup expired sessions every minute (more frequent for empty session cleanup)
        _cleanupTimer = new Timer(CleanupExpiredSessions, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    public const int DefaultMaxPeers = 10;
    public const int AbsoluteMaxPeers = 10;

    public Session CreateSession(string creatorUserId, int maxPeers = DefaultMaxPeers)
    {
        // Clamp maxPeers to valid range
        maxPeers = Math.Clamp(maxPeers, 2, AbsoluteMaxPeers);

        var id = GenerateSessionId();
        var now = DateTime.UtcNow;

        // Session starts with host-disconnected TTL; will extend to 24h when host joins
        var session = new Session(
            Id: id,
            CreatedAt: now,
            ExpiresAt: now.Add(_baseTtl),
            AbsoluteExpiresAt: now.Add(_absoluteMaxTtlHostDisconnected),  // Will be extended when host connects
            MaxPeers: maxPeers,
            IsLocked: false,
            CreatorUserId: creatorUserId,  // Set at creation time from authenticated user
            IsHostConnected: false,
            HostLastSeen: null
        );

        _sessions[id] = session;
        _sessionPeers[id] = new List<Peer>();

        _logger?.LogInformation("Session {SessionId} created by user {UserId}, initial absolute max: {MaxTtl}h",
            id, creatorUserId, _absoluteMaxTtlHostDisconnected.TotalHours);

        return session;
    }

    public Session? GetSession(string id)
    {
        if (_sessions.TryGetValue(id, out var session))
        {
            var now = DateTime.UtcNow;

            // Calculate the effective absolute max based on host connection state
            var effectiveAbsoluteMax = GetEffectiveAbsoluteMax(session);

            // Never expire while peers are actively connected P2P
            if (session.ConnectedPeerPairs > 0)
            {
                // Session is "alive" - extend TTL automatically
                var newExpiry = now.Add(_baseTtl);
                // But don't exceed effective absolute max
                if (newExpiry > effectiveAbsoluteMax)
                {
                    newExpiry = effectiveAbsoluteMax;
                }

                var extended = session with
                {
                    ExpiresAt = newExpiry,
                    AbsoluteExpiresAt = effectiveAbsoluteMax,
                    EmptySince = null
                };
                _sessions[id] = extended;

                var peerCount = _sessionPeers.TryGetValue(id, out var peers) ? peers.Count : 0;
                return extended with { PeerCount = peerCount };
            }

            // Check if session has exceeded effective absolute max (hard limit)
            if (now > effectiveAbsoluteMax)
            {
                _logger?.LogInformation("Session {SessionId} expired (absolute max exceeded, host connected: {HostConnected})",
                    id, session.IsHostConnected);
                RemoveSession(id);
                return null;
            }

            // Check normal expiration
            if (session.ExpiresAt < now)
            {
                RemoveSession(id);
                return null;
            }

            // Update the stored absolute max if it changed
            if (session.AbsoluteExpiresAt != effectiveAbsoluteMax)
            {
                _sessions[id] = session with { AbsoluteExpiresAt = effectiveAbsoluteMax };
            }

            var count = _sessionPeers.TryGetValue(id, out var p) ? p.Count : 0;
            return session with { PeerCount = count, AbsoluteExpiresAt = effectiveAbsoluteMax };
        }
        return null;
    }

    /// <summary>
    /// Calculates the effective absolute maximum expiration based on host connection state.
    /// - Host connected: 24 hours from session creation
    /// - Host disconnected: grace period from HostLastSeen, or 4 hours from creation
    /// </summary>
    private DateTime GetEffectiveAbsoluteMax(Session session)
    {
        if (session.IsHostConnected)
        {
            // Host is connected - use 24-hour max from creation time
            return session.CreatedAt.Add(_absoluteMaxTtlHostConnected);
        }
        else if (session.HostLastSeen.HasValue)
        {
            // Host was connected but left - use grace period from when they left
            var graceExpiry = session.HostLastSeen.Value.Add(_hostGracePeriod);
            var originalMax = session.CreatedAt.Add(_absoluteMaxTtlHostDisconnected);

            // Use the later of: grace period expiry or original 4-hour max
            // This prevents the session from expiring sooner than expected if host leaves early
            return graceExpiry > originalMax ? graceExpiry : originalMax;
        }
        else
        {
            // Host never connected - use standard 4-hour max
            return session.CreatedAt.Add(_absoluteMaxTtlHostDisconnected);
        }
    }

    public bool SessionExists(string id)
    {
        return GetSession(id) != null;
    }

    public Peer? AddPeerToSession(string sessionId, string connectionId)
    {
        return AddPeerToSessionInternal(sessionId, connectionId, null);
    }

    /// <summary>
    /// Adds a peer to a session with an optional user ID for tracking authenticated users.
    /// </summary>
    public Peer? AddPeerToSession(string sessionId, string connectionId, string? userId)
    {
        return AddPeerToSessionInternal(sessionId, connectionId, userId);
    }

    private Peer? AddPeerToSessionInternal(string sessionId, string connectionId, string? userId)
    {
        if (!_sessions.TryGetValue(sessionId, out var session))
            return null;

        var now = DateTime.UtcNow;

        // Check absolute expiration
        if (now > session.AbsoluteExpiresAt)
        {
            RemoveSession(sessionId);
            return null;
        }

        // Check normal expiration (but allow if there are active connections)
        if (session.ExpiresAt < now && session.ConnectedPeerPairs == 0)
        {
            RemoveSession(sessionId);
            return null;
        }

        if (!_sessionPeers.TryGetValue(sessionId, out var peers))
        {
            peers = new List<Peer>();
            _sessionPeers[sessionId] = peers;
        }

        // Check against session's max peers limit
        if (peers.Count >= session.MaxPeers)
            return null;

        var isInitiator = peers.Count == 0;

        // Check if session is locked (only applies to non-initiators)
        if (!isInitiator && session.IsLocked)
            return null;

        var peer = new Peer(connectionId, sessionId, isInitiator);

        lock (peers)
        {
            peers.Add(peer);
        }

        // Track user ID for this connection (for host identification)
        if (!string.IsNullOrEmpty(userId))
        {
            _connectionToUserId[connectionId] = userId;
        }

        // Extend session and clear empty flag when peer joins
        ExtendSession(sessionId);
        ClearSessionEmpty(sessionId);

        return peer;
    }

    public void RemovePeerFromSession(string sessionId, string connectionId)
    {
        // Clean up user ID mapping
        _connectionToUserId.TryRemove(connectionId, out _);

        if (_sessionPeers.TryGetValue(sessionId, out var peers))
        {
            lock (peers)
            {
                peers.RemoveAll(p => p.ConnectionId == connectionId);

                // Check if session is now empty
                if (peers.Count == 0)
                {
                    MarkSessionEmpty(sessionId);
                }
            }
        }
    }

    public List<Peer> GetPeersInSession(string sessionId)
    {
        if (_sessionPeers.TryGetValue(sessionId, out var peers))
        {
            lock (peers)
            {
                return peers.ToList();
            }
        }
        return new List<Peer>();
    }

    public Peer? GetPeerByConnectionId(string connectionId)
    {
        foreach (var peers in _sessionPeers.Values)
        {
            lock (peers)
            {
                var peer = peers.FirstOrDefault(p => p.ConnectionId == connectionId);
                if (peer != null)
                    return peer;
            }
        }
        return null;
    }

    public int GetMaxPeersForSession(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            return session.MaxPeers;
        }
        return DefaultMaxPeers;
    }

    public void ExtendSession(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            var effectiveAbsoluteMax = GetEffectiveAbsoluteMax(session);
            var newExpiry = DateTime.UtcNow.Add(_baseTtl);
            // Don't exceed effective absolute maximum
            if (newExpiry > effectiveAbsoluteMax)
            {
                newExpiry = effectiveAbsoluteMax;
            }

            _sessions[sessionId] = session with
            {
                ExpiresAt = newExpiry,
                AbsoluteExpiresAt = effectiveAbsoluteMax,
                EmptySince = null // Clear empty timer when extending
            };
        }
    }

    public void MarkSessionEmpty(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            // Only mark empty if not already marked and no active P2P connections
            if (session.EmptySince == null && session.ConnectedPeerPairs == 0)
            {
                var now = DateTime.UtcNow;
                var emptyExpiry = now.Add(_emptyTimeout);
                // Use the earlier of empty expiry or current expiry
                var newExpiry = emptyExpiry < session.ExpiresAt ? emptyExpiry : session.ExpiresAt;

                _sessions[sessionId] = session with
                {
                    ExpiresAt = newExpiry,
                    EmptySince = now
                };
            }
        }
    }

    public void ClearSessionEmpty(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            if (session.EmptySince != null)
            {
                // Restore TTL when session becomes non-empty
                var newExpiry = DateTime.UtcNow.Add(_baseTtl);
                if (newExpiry > session.AbsoluteExpiresAt)
                {
                    newExpiry = session.AbsoluteExpiresAt;
                }

                _sessions[sessionId] = session with
                {
                    ExpiresAt = newExpiry,
                    EmptySince = null
                };
            }
        }
    }

    public void IncrementConnectedPairs(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            _sessions[sessionId] = session with
            {
                ConnectedPeerPairs = session.ConnectedPeerPairs + 1,
                EmptySince = null // Clear empty flag when connections are active
            };

            // Also extend TTL when P2P connection is established
            ExtendSession(sessionId);
        }
    }

    public void DecrementConnectedPairs(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            var newCount = Math.Max(0, session.ConnectedPeerPairs - 1);
            _sessions[sessionId] = session with
            {
                ConnectedPeerPairs = newCount
            };
        }
    }

    private void RemoveSession(string id)
    {
        _sessions.TryRemove(id, out _);
        _sessionPeers.TryRemove(id, out _);
    }

    private void CleanupExpiredSessions(object? state)
    {
        var now = DateTime.UtcNow;
        var expiredIds = _sessions
            .Where(kvp =>
            {
                var session = kvp.Value;
                var effectiveAbsoluteMax = GetEffectiveAbsoluteMax(session);

                // Don't expire sessions with active P2P connections (unless past absolute max)
                if (session.ConnectedPeerPairs == 0 && session.ExpiresAt < now)
                    return true;

                // Always expire past effective absolute max (considers host connection state)
                if (effectiveAbsoluteMax < now)
                    return true;

                return false;
            })
            .Select(kvp => kvp.Key)
            .ToList();

        foreach (var id in expiredIds)
        {
            _logger?.LogInformation("Cleaning up expired session {SessionId}", id);
            RemoveSession(id);
        }
    }

    private static string GenerateSessionId()
    {
        // Generate a cryptographically secure, URL-safe session ID
        // 16 bytes = 128 bits of entropy, sufficient to prevent brute-force attacks
        // Per OWASP guidelines: use CSPRNG with at least 128 bits of entropy
        var bytes = RandomNumberGenerator.GetBytes(16);

        // Convert to URL-safe base64 (no padding, replace +/ with -_)
        return Convert.ToBase64String(bytes)
            .Replace("+", "-")
            .Replace("/", "_")
            .TrimEnd('=');
    }

    // ============================================
    // Session Control (Host Powers)
    // ============================================

    public bool IsSessionCreator(string sessionId, string? userId)
    {
        if (string.IsNullOrEmpty(userId))
            return false;

        if (_sessions.TryGetValue(sessionId, out var session))
        {
            return session.CreatorUserId == userId;
        }
        return false;
    }

    public bool LockSession(string sessionId, string? userId)
    {
        if (string.IsNullOrEmpty(userId))
            return false;

        if (!_sessions.TryGetValue(sessionId, out var session))
            return false;

        // Only the creator can lock the session
        if (session.CreatorUserId != userId)
            return false;

        _sessions[sessionId] = session with { IsLocked = true };
        return true;
    }

    public bool UnlockSession(string sessionId, string? userId)
    {
        if (string.IsNullOrEmpty(userId))
            return false;

        if (!_sessions.TryGetValue(sessionId, out var session))
            return false;

        // Only the creator can unlock the session
        if (session.CreatorUserId != userId)
            return false;

        _sessions[sessionId] = session with { IsLocked = false };
        return true;
    }

    public bool IsSessionLocked(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            return session.IsLocked;
        }
        return false;
    }

    public string? GetSessionCreatorUserId(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            return session.CreatorUserId;
        }
        return null;
    }

    /// <summary>
    /// Gets the current ConnectionId of the session host (if they're connected).
    /// Returns null if the host is not currently in the session.
    /// </summary>
    public string? GetHostConnectionId(string sessionId)
    {
        if (!_sessions.TryGetValue(sessionId, out var session))
            return null;

        var creatorUserId = session.CreatorUserId;
        if (string.IsNullOrEmpty(creatorUserId))
            return null;

        // Find the connection ID that belongs to the creator
        if (_sessionPeers.TryGetValue(sessionId, out var peers))
        {
            lock (peers)
            {
                foreach (var peer in peers)
                {
                    if (_connectionToUserId.TryGetValue(peer.ConnectionId, out var userId) && userId == creatorUserId)
                    {
                        return peer.ConnectionId;
                    }
                }
            }
        }

        return null;
    }

    public bool EnableHostOnlySending(string sessionId, string? userId)
    {
        if (string.IsNullOrEmpty(userId))
            return false;

        if (!_sessions.TryGetValue(sessionId, out var session))
            return false;

        // Only the creator can enable host-only sending
        if (session.CreatorUserId != userId)
            return false;

        _sessions[sessionId] = session with { IsHostOnlySending = true };
        return true;
    }

    public bool DisableHostOnlySending(string sessionId, string? userId)
    {
        if (string.IsNullOrEmpty(userId))
            return false;

        if (!_sessions.TryGetValue(sessionId, out var session))
            return false;

        // Only the creator can disable host-only sending
        if (session.CreatorUserId != userId)
            return false;

        _sessions[sessionId] = session with { IsHostOnlySending = false };
        return true;
    }

    public bool IsHostOnlySending(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            return session.IsHostOnlySending;
        }
        return false;
    }

    // ============================================
    // Host Presence Tracking (for 24-hour session persistence)
    // ============================================

    /// <summary>
    /// Checks if the host (session creator) is currently connected to the session.
    /// </summary>
    public bool IsHostCurrentlyConnected(string sessionId)
    {
        if (_sessions.TryGetValue(sessionId, out var session))
        {
            return session.IsHostConnected;
        }
        return false;
    }

    /// <summary>
    /// Updates the host connection state when a peer joins or leaves.
    /// This affects the session's TTL - 24 hours when host is connected, shorter when disconnected.
    /// </summary>
    public void UpdateHostConnectionState(string sessionId, string connectionId, string? userId, bool isConnecting)
    {
        if (string.IsNullOrEmpty(userId))
            return;

        if (!_sessions.TryGetValue(sessionId, out var session))
            return;

        // Only the creator's connection affects host presence
        if (session.CreatorUserId != userId)
            return;

        var now = DateTime.UtcNow;

        if (isConnecting)
        {
            // Host is connecting - extend to 24-hour TTL
            var newAbsoluteMax = session.CreatedAt.Add(_absoluteMaxTtlHostConnected);
            var newExpiry = now.Add(_baseTtl);
            if (newExpiry > newAbsoluteMax)
            {
                newExpiry = newAbsoluteMax;
            }

            _sessions[sessionId] = session with
            {
                IsHostConnected = true,
                HostLastSeen = now,
                AbsoluteExpiresAt = newAbsoluteMax,
                ExpiresAt = newExpiry
            };

            _logger?.LogInformation(
                "Host connected to session {SessionId}. TTL extended to 24 hours (absolute max: {AbsoluteMax})",
                sessionId, newAbsoluteMax);
        }
        else
        {
            // Host is disconnecting - record last seen time and recalculate TTL
            var newHostLastSeen = now;
            var graceExpiry = newHostLastSeen.Add(_hostGracePeriod);
            var originalMax = session.CreatedAt.Add(_absoluteMaxTtlHostDisconnected);
            var newAbsoluteMax = graceExpiry > originalMax ? graceExpiry : originalMax;

            _sessions[sessionId] = session with
            {
                IsHostConnected = false,
                HostLastSeen = newHostLastSeen,
                AbsoluteExpiresAt = newAbsoluteMax
            };

            _logger?.LogInformation(
                "Host disconnected from session {SessionId}. Grace period until {GraceExpiry}, absolute max: {AbsoluteMax}",
                sessionId, graceExpiry, newAbsoluteMax);
        }
    }
}
