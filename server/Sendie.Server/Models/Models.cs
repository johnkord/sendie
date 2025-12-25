namespace Sendie.Server.Models;

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
    string? CreatorUserId = null  // Discord user ID of the session creator (host)
);

public record Peer(
    string ConnectionId,
    string SessionId,
    bool IsInitiator
);

// Signaling Messages
public abstract record SignalingMessage(string Type);

public record OfferMessage(string Sdp) : SignalingMessage("offer");

public record AnswerMessage(string Sdp) : SignalingMessage("answer");

public record IceCandidateMessage(
    string Candidate,
    string? SdpMid,
    int? SdpMLineIndex
) : SignalingMessage("ice-candidate");

public record PublicKeyMessage(string KeyJwk) : SignalingMessage("public-key");

public record SignatureMessage(
    string Signature,
    string Challenge
) : SignalingMessage("signature");

// Configuration
public record IceServerConfig(
    string[] Urls,
    string? Username = null,
    string? Credential = null
);
