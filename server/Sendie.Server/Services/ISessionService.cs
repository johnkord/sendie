using Sendie.Server.Models;

namespace Sendie.Server.Services;

public interface ISessionService
{
    Session CreateSession(string creatorUserId, int maxPeers = 10);
    Session? GetSession(string id);
    bool SessionExists(string id);
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
    void IncrementConnectedPairs(string sessionId);
    void DecrementConnectedPairs(string sessionId);

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
