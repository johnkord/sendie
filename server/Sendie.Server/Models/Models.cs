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
    string? CreatorUserId = null,  // Discord user ID of the session creator (host)
    bool IsHostConnected = false,  // Whether the host is currently connected to the session
    DateTime? HostLastSeen = null,  // When the host was last connected (for grace period)
                                    // Phase 6.1 (audit C4): peppered HMAC of the join secret. The plaintext
                                    // secret travels only in the URL fragment and is never sent to the server
                                    // until JoinSession validates it. Compared with constant-time equality.
                                    // Null only on legacy sessions created before the cutover (purged after 24h).
    string? SecretHash = null
);

// Returned to the session creator on POST /api/sessions. Distinct from the
// stored Session record because the plaintext secret is delivered exactly once
// and never persisted on the server.
public record SessionCreationResponse(
    string Id,
    string Secret,
    DateTime CreatedAt,
    DateTime ExpiresAt,
    DateTime AbsoluteExpiresAt,
    int MaxPeers,
    int PeerCount,
    bool IsLocked,
    bool IsHostOnlySending
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
