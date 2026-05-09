using Sendie.Server.Models;

namespace Sendie.Server.Services;

public interface ISessionService
{
    /// <summary>
    /// Create a new session. Returns the session metadata together with a
    /// freshly generated 128-bit join secret that is delivered to the caller
    /// exactly once. The server only retains a peppered HMAC of the secret;
    /// joiners must present it via the URL fragment.
    /// </summary>
    SessionCreationResponse CreateSession(string creatorUserId, int maxPeers = 10);
    Session? GetSession(string id);
    bool SessionExists(string id);
    /// <summary>
    /// Validate a candidate join secret against the session's stored hash.
    /// Constant-time comparison. Returns false for unknown sessions, missing
    /// secrets, or hash mismatch.
    /// </summary>
    bool ValidateSecret(string sessionId, string? candidateSecret);
    Peer? AddPeerToSession(string sessionId, string connectionId);
    Peer? AddPeerToSession(string sessionId, string connectionId, string? userId);  // Overload with user tracking
    void RemovePeerFromSession(string sessionId, string connectionId);
    List<Peer> GetPeersInSession(string sessionId);
    Peer? GetPeerByConnectionId(string connectionId);
    int GetMaxPeersForSession(string sessionId);

    // Session lifecycle management
    void ExtendSession(string sessionId);
    void MarkSessionEmpty(string sessionId);
    void ClearSessionEmpty(string sessionId);

    // Per-pair connection tracking. Replaces the old counter-based
    // IncrementConnectedPairs/DecrementConnectedPairs which could be abused
    // by clients calling Increment in a loop to pin sessions alive.
    void RecordPair(string sessionId, string connectionA, string connectionB);
    void ForgetPair(string sessionId, string connectionA, string connectionB);
    void ForgetConnection(string sessionId, string connectionId);

    // Session control (host powers)
    bool IsSessionCreator(string sessionId, string? userId);
    bool LockSession(string sessionId, string? userId);
    bool UnlockSession(string sessionId, string? userId);
    bool IsSessionLocked(string sessionId);
    string? GetSessionCreatorUserId(string sessionId);
    string? GetHostConnectionId(string sessionId);  // Get current connection ID of host (if connected)
    bool EnableHostOnlySending(string sessionId, string? userId);
    bool DisableHostOnlySending(string sessionId, string? userId);
    bool IsHostOnlySending(string sessionId);

    // Host presence tracking (for 24-hour session persistence)
    bool IsHostCurrentlyConnected(string sessionId);
    void UpdateHostConnectionState(string sessionId, string connectionId, string? userId, bool isConnecting);
}
