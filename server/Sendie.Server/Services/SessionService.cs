using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Sendie.Server.Models;

namespace Sendie.Server.Services;

public class SessionService : ISessionService
{
    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    private readonly ConcurrentDictionary<string, List<Peer>> _sessionPeers = new();
    private readonly ConcurrentDictionary<string, string> _connectionToUserId = new();  // ConnectionId -> UserId mapping
    // Per-session set of canonicalized connection-pair tuples. Using
    // ConcurrentDictionary as a set so concurrent writers cannot corrupt
    // internal state (HashSet is not thread-safe).
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<(string A, string B), byte>> _pairs = new();
    private readonly Timer _cleanupTimer;
    private readonly ILogger<SessionService>? _logger;
    // Phase 6.1 (audit C4): pepper used to HMAC join secrets before storing
    // them. Derived once at startup from a Data Protection secret so it
    // survives restart but is never written to user-managed config.
    private readonly byte[] _secretPepper;

    // Session TTL configuration
    private readonly TimeSpan _baseTtl = TimeSpan.FromMinutes(30);
    private readonly TimeSpan _absoluteMaxTtlHostConnected = TimeSpan.FromHours(24);    // 24 hours when host is connected
    private readonly TimeSpan _absoluteMaxTtlHostDisconnected = TimeSpan.FromHours(4);  // 4 hours when host is disconnected
    private readonly TimeSpan _hostGracePeriod = TimeSpan.FromMinutes(30);              // Grace period after host disconnects
    private readonly TimeSpan _emptyTimeout = TimeSpan.FromMinutes(5);

    public SessionService(IDataProtectionProvider dataProtection, ILogger<SessionService>? logger = null)
    {
        _logger = logger;
        // Derive a pepper from Data Protection. Protect/Unprotect is keyed
        // off the persisted Data Protection keyring, so the same pepper
        // is recovered across restarts without us managing a separate secret.
        var protector = dataProtection.CreateProtector("Sendie.SessionSecretPepper.v1");
        var seed = Encoding.UTF8.GetBytes("sendie/session-secret-pepper/v1");
        _secretPepper = protector.Protect(seed);
        // Cleanup expired sessions every minute (more frequent for empty session cleanup)
        _cleanupTimer = new Timer(CleanupExpiredSessions, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    // Test-friendly constructor: deterministic pepper provided by the test
    // so we don't have to wire Data Protection into unit tests. Public so
    // the test project (no InternalsVisibleTo on this assembly) can reach it.
    // Do not call from production code; the DI-friendly ctor above does.
    public SessionService(ILogger<SessionService>? logger, byte[] testPepper)
    {
        _logger = logger;
        _secretPepper = testPepper;
        _cleanupTimer = new Timer(CleanupExpiredSessions, null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));
    }

    public const int DefaultMaxPeers = 10;
    public const int AbsoluteMaxPeers = 10;

    public SessionCreationResponse CreateSession(string creatorUserId, int maxPeers = DefaultMaxPeers)
    {
        // Clamp maxPeers to valid range
        maxPeers = Math.Clamp(maxPeers, 2, AbsoluteMaxPeers);

        var id = GenerateSessionId();
        // 16 random bytes (128 bits) of secret material. URL-safe base64,
        // exactly 22 chars after stripping padding — same shape as the ID.
        var secret = GenerateUrlSafeRandom(16);
        var secretHash = ComputeSecretHash(id, secret);
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
            HostLastSeen: null,
            SecretHash: secretHash
        );

        _sessions[id] = session;
        _sessionPeers[id] = new List<Peer>();

        _logger?.LogInformation("Session {SessionId} created by user {UserId}, initial absolute max: {MaxTtl}h",
            id, creatorUserId, _absoluteMaxTtlHostDisconnected.TotalHours);

        return new SessionCreationResponse(
            Id: id,
            Secret: secret,
            CreatedAt: session.CreatedAt,
            ExpiresAt: session.ExpiresAt,
            AbsoluteExpiresAt: session.AbsoluteExpiresAt,
            MaxPeers: session.MaxPeers,
            PeerCount: 0,
            IsLocked: session.IsLocked,
            IsHostOnlySending: session.IsHostOnlySending);
    }

    public bool ValidateSecret(string sessionId, string? candidateSecret)
    {
        if (string.IsNullOrEmpty(candidateSecret)) return false;
        if (!_sessions.TryGetValue(sessionId, out var session)) return false;
        if (string.IsNullOrEmpty(session.SecretHash)) return false;

        var expected = Convert.FromBase64String(session.SecretHash);
        var actual = ComputeSecretHashBytes(sessionId, candidateSecret);
        return CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    private string ComputeSecretHash(string sessionId, string secret)
    {
        return Convert.ToBase64String(ComputeSecretHashBytes(sessionId, secret));
    }

    private byte[] ComputeSecretHashBytes(string sessionId, string secret)
    {
        // HMAC-SHA256 keyed on the pepper, message = sessionId || "|" || secret.
        // Including the session ID prevents a hash collision across sessions
        // from being exploitable as a cross-session secret.
        using var hmac = new HMACSHA256(_secretPepper);
        var data = Encoding.UTF8.GetBytes(sessionId + "|" + secret);
        return hmac.ComputeHash(data);
    }

    private static string GenerateUrlSafeRandom(int byteCount)
    {
        var bytes = RandomNumberGenerator.GetBytes(byteCount);
        return Convert.ToBase64String(bytes)
            .Replace("+", "-")
            .Replace("/", "_")
            .TrimEnd('=');
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

        Peer peer;
        // Take the lock for the entire check+insert. Pre-lock checks would
        // race with concurrent joins (allowing MaxPeers+N) and concurrent
        // LockSession calls (slipping a peer through during a lock).
        lock (peers)
        {
            if (peers.Count >= session.MaxPeers)
                return null;

            // Re-read session to get freshest IsLocked under the lock; the
            // ConcurrentDictionary read is atomic but we still want it after
            // we hold the per-session insert lock to avoid TOCTOU.
            if (!_sessions.TryGetValue(sessionId, out var fresh)) return null;
            var isInitiator = peers.Count == 0;
            if (!isInitiator && fresh.IsLocked) return null;

            peer = new Peer(connectionId, sessionId, isInitiator);
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

        // Forget any pair entries that involved this connection.
        ForgetConnection(sessionId, connectionId);

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

    public void RecordPair(string sessionId, string connectionA, string connectionB)
    {
        if (string.IsNullOrEmpty(connectionA) || string.IsNullOrEmpty(connectionB)) return;
        if (connectionA == connectionB) return;
        if (!_sessions.ContainsKey(sessionId)) return;

        var canonical = string.CompareOrdinal(connectionA, connectionB) <= 0
            ? (connectionA, connectionB)
            : (connectionB, connectionA);
        var bucket = _pairs.GetOrAdd(sessionId, _ => new ConcurrentDictionary<(string A, string B), byte>());
        var added = bucket.TryAdd(canonical, 0);

        // Refresh the count exposed on the Session record.
        SyncPairCount(sessionId);

        if (added)
        {
            ExtendSession(sessionId);
        }
    }

    public void ForgetPair(string sessionId, string connectionA, string connectionB)
    {
        if (!_pairs.TryGetValue(sessionId, out var bucket)) return;
        var canonical = string.CompareOrdinal(connectionA, connectionB) <= 0
            ? (connectionA, connectionB)
            : (connectionB, connectionA);
        bucket.TryRemove(canonical, out _);
        SyncPairCount(sessionId);
    }

    public void ForgetConnection(string sessionId, string connectionId)
    {
        if (!_pairs.TryGetValue(sessionId, out var bucket)) return;
        foreach (var key in bucket.Keys)
        {
            if (key.A == connectionId || key.B == connectionId)
            {
                bucket.TryRemove(key, out _);
            }
        }
        SyncPairCount(sessionId);
    }

    private void SyncPairCount(string sessionId)
    {
        var count = _pairs.TryGetValue(sessionId, out var bucket) ? bucket.Count : 0;
        // Only update if the session still exists. AddOrUpdate would resurrect
        // a deleted session record with a null value, which then surfaces as
        // a NullReferenceException in callers reading session fields.
        if (!_sessions.TryGetValue(sessionId, out var existing)) return;
        var updated = existing with { ConnectedPeerPairs = count };
        _sessions.TryUpdate(sessionId, updated, existing);
        // If TryUpdate fails because the value changed, the next read of
        // _sessions will pick up the latest version which will be re-synced
        // by the next Record/Forget call. Acceptable convergence for a count.
    }

    private void RemoveSession(string id)
    {
        _sessions.TryRemove(id, out _);
        _sessionPeers.TryRemove(id, out _);
        _pairs.TryRemove(id, out _);
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

        // Atomic compare-and-set so concurrent admin actions cannot lose updates.
        while (_sessions.TryGetValue(sessionId, out var session))
        {
            if (session.CreatorUserId != userId) return false;
            if (session.IsLocked) return true;
            var updated = session with { IsLocked = true };
            if (_sessions.TryUpdate(sessionId, updated, session)) return true;
        }
        return false;
    }

    public bool UnlockSession(string sessionId, string? userId)
    {
        if (string.IsNullOrEmpty(userId))
            return false;

        while (_sessions.TryGetValue(sessionId, out var session))
        {
            if (session.CreatorUserId != userId) return false;
            if (!session.IsLocked) return true;
            var updated = session with { IsLocked = false };
            if (_sessions.TryUpdate(sessionId, updated, session)) return true;
        }
        return false;
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

        while (_sessions.TryGetValue(sessionId, out var session))
        {
            if (session.CreatorUserId != userId) return false;
            if (session.IsHostOnlySending) return true;
            var updated = session with { IsHostOnlySending = true };
            if (_sessions.TryUpdate(sessionId, updated, session)) return true;
        }
        return false;
    }

    public bool DisableHostOnlySending(string sessionId, string? userId)
    {
        if (string.IsNullOrEmpty(userId))
            return false;

        while (_sessions.TryGetValue(sessionId, out var session))
        {
            if (session.CreatorUserId != userId) return false;
            if (!session.IsHostOnlySending) return true;
            var updated = session with { IsHostOnlySending = false };
            if (_sessions.TryUpdate(sessionId, updated, session)) return true;
        }
        return false;
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
