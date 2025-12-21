using System.Collections.Concurrent;
using System.Security.Cryptography;
using Sendie.Server.Models;

namespace Sendie.Server.Services;

public class SessionService : ISessionService
{
    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    private readonly ConcurrentDictionary<string, List<Peer>> _sessionPeers = new();
    private readonly Timer _cleanupTimer;

    // Session TTL configuration
    private readonly TimeSpan _baseTtl = TimeSpan.FromMinutes(30);
    private readonly TimeSpan _absoluteMaxTtl = TimeSpan.FromHours(4);
    private readonly TimeSpan _emptyTimeout = TimeSpan.FromMinutes(5);

    public SessionService()
    {
        // Cleanup expired sessions every minute (more frequent for empty session cleanup)
        _cleanupTimer = new Timer(CleanupExpiredSessions, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    public const int DefaultMaxPeers = 10;
    public const int AbsoluteMaxPeers = 10;

    public Session CreateSession(int maxPeers = DefaultMaxPeers)
    {
        // Clamp maxPeers to valid range
        maxPeers = Math.Clamp(maxPeers, 2, AbsoluteMaxPeers);

        var id = GenerateSessionId();
        var now = DateTime.UtcNow;
        var session = new Session(
            Id: id,
            CreatedAt: now,
            ExpiresAt: now.Add(_baseTtl),
            AbsoluteExpiresAt: now.Add(_absoluteMaxTtl),
            MaxPeers: maxPeers
        );

        _sessions[id] = session;
        _sessionPeers[id] = new List<Peer>();

        return session;
    }

    public Session? GetSession(string id)
    {
        if (_sessions.TryGetValue(id, out var session))
        {
            var now = DateTime.UtcNow;

            // Never expire while peers are actively connected P2P
            if (session.ConnectedPeerPairs > 0)
            {
                // Session is "alive" - extend TTL automatically
                var newExpiry = now.Add(_baseTtl);
                // But don't exceed absolute max
                if (newExpiry > session.AbsoluteExpiresAt)
                {
                    newExpiry = session.AbsoluteExpiresAt;
                }

                var extended = session with
                {
                    ExpiresAt = newExpiry,
                    EmptySince = null
                };
                _sessions[id] = extended;

                var peerCount = _sessionPeers.TryGetValue(id, out var peers) ? peers.Count : 0;
                return extended with { PeerCount = peerCount };
            }

            // Check if session has exceeded absolute max (hard limit)
            if (now > session.AbsoluteExpiresAt)
            {
                RemoveSession(id);
                return null;
            }

            // Check normal expiration
            if (session.ExpiresAt < now)
            {
                RemoveSession(id);
                return null;
            }

            var count = _sessionPeers.TryGetValue(id, out var p) ? p.Count : 0;
            return session with { PeerCount = count };
        }
        return null;
    }

    public bool SessionExists(string id)
    {
        return GetSession(id) != null;
    }

    public Peer? AddPeerToSession(string sessionId, string connectionId)
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
        var peer = new Peer(connectionId, sessionId, isInitiator);

        lock (peers)
        {
            peers.Add(peer);
        }

        // Extend session and clear empty flag when peer joins
        ExtendSession(sessionId);
        ClearSessionEmpty(sessionId);

        return peer;
    }

    public void RemovePeerFromSession(string sessionId, string connectionId)
    {
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
            var newExpiry = DateTime.UtcNow.Add(_baseTtl);
            // Don't exceed absolute maximum
            if (newExpiry > session.AbsoluteExpiresAt)
            {
                newExpiry = session.AbsoluteExpiresAt;
            }

            _sessions[sessionId] = session with
            {
                ExpiresAt = newExpiry,
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
                // Don't expire sessions with active P2P connections (unless past absolute max)
                (kvp.Value.ConnectedPeerPairs == 0 && kvp.Value.ExpiresAt < now) ||
                // Always expire past absolute max
                kvp.Value.AbsoluteExpiresAt < now)
            .Select(kvp => kvp.Key)
            .ToList();

        foreach (var id in expiredIds)
        {
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
}
