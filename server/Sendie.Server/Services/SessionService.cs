using System.Collections.Concurrent;
using System.Security.Cryptography;
using Sendie.Server.Models;

namespace Sendie.Server.Services;

public class SessionService : ISessionService
{
    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    private readonly ConcurrentDictionary<string, List<Peer>> _sessionPeers = new();
    private readonly TimeSpan _sessionDuration = TimeSpan.FromHours(1);
    private readonly Timer _cleanupTimer;

    public SessionService()
    {
        // Cleanup expired sessions every 5 minutes
        _cleanupTimer = new Timer(CleanupExpiredSessions, null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));
    }

    public const int DefaultMaxPeers = 5;
    public const int AbsoluteMaxPeers = 10;

    public Session CreateSession(int maxPeers = DefaultMaxPeers)
    {
        // Clamp maxPeers to valid range
        maxPeers = Math.Clamp(maxPeers, 2, AbsoluteMaxPeers);

        var id = GenerateSessionId();
        var session = new Session(
            Id: id,
            CreatedAt: DateTime.UtcNow,
            ExpiresAt: DateTime.UtcNow.Add(_sessionDuration),
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
            if (session.ExpiresAt < DateTime.UtcNow)
            {
                RemoveSession(id);
                return null;
            }

            var peerCount = _sessionPeers.TryGetValue(id, out var peers) ? peers.Count : 0;
            return session with { PeerCount = peerCount };
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

        if (session.ExpiresAt < DateTime.UtcNow)
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

        return peer;
    }

    public void RemovePeerFromSession(string sessionId, string connectionId)
    {
        if (_sessionPeers.TryGetValue(sessionId, out var peers))
        {
            lock (peers)
            {
                peers.RemoveAll(p => p.ConnectionId == connectionId);
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

    private void RemoveSession(string id)
    {
        _sessions.TryRemove(id, out _);
        _sessionPeers.TryRemove(id, out _);
    }

    private void CleanupExpiredSessions(object? state)
    {
        var expiredIds = _sessions
            .Where(kvp => kvp.Value.ExpiresAt < DateTime.UtcNow)
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
