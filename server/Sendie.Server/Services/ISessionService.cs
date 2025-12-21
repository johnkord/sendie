using Sendie.Server.Models;

namespace Sendie.Server.Services;

public interface ISessionService
{
    Session CreateSession(int maxPeers = 5);
    Session? GetSession(string id);
    bool SessionExists(string id);
    Peer? AddPeerToSession(string sessionId, string connectionId);
    void RemovePeerFromSession(string sessionId, string connectionId);
    List<Peer> GetPeersInSession(string sessionId);
    Peer? GetPeerByConnectionId(string connectionId);
    int GetMaxPeersForSession(string sessionId);
}
