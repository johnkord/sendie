using Sendie.Server.Models;

namespace Sendie.Server.Services;

public interface ISessionService
{
    Session CreateSession(int maxPeers = 10);
    Session? GetSession(string id);
    bool SessionExists(string id);
    Peer? AddPeerToSession(string sessionId, string connectionId);
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
    bool IsSessionCreator(string sessionId, string connectionId);
    bool LockSession(string sessionId, string connectionId);
    bool UnlockSession(string sessionId, string connectionId);
    bool IsSessionLocked(string sessionId);
    string? GetSessionCreator(string sessionId);
}
