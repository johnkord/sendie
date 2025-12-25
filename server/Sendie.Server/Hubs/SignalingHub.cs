using Microsoft.AspNetCore.SignalR;
using Sendie.Server.Services;

namespace Sendie.Server.Hubs;

// No authorization required - anyone with a session ID can join
public class SignalingHub : Hub
{
    private readonly ISessionService _sessionService;
    private readonly IRateLimiterService _rateLimiter;
    private readonly ILogger<SignalingHub> _logger;

    public SignalingHub(
        ISessionService sessionService,
        IRateLimiterService rateLimiter,
        ILogger<SignalingHub> logger)
    {
        _sessionService = sessionService;
        _rateLimiter = rateLimiter;
        _logger = logger;
    }

    /// <summary>
    /// Gets the Discord user ID from the authenticated user's claims.
    /// </summary>
    private string? GetDiscordId()
    {
        return Context.User?.FindFirst("urn:discord:id")?.Value;
    }

    /// <summary>
    /// Gets the client IP address for rate limiting.
    /// Falls back to ConnectionId if HttpContext is unavailable (unit tests).
    /// </summary>
    private string GetClientIp()
    {
        try
        {
            var httpContext = Context.GetHttpContext();
            if (httpContext?.Connection.RemoteIpAddress != null)
            {
                return httpContext.Connection.RemoteIpAddress.ToString();
            }
        }
        catch
        {
            // GetHttpContext can throw in unit tests when Features is not set up
        }
        // Fallback to ConnectionId for unit tests or when IP is unavailable
        return Context.ConnectionId;
    }

    /// <summary>
    /// Check rate limit and throw if exceeded.
    /// </summary>
    private void CheckRateLimit(RateLimitPolicy policy, string? keyOverride = null)
    {
        var key = keyOverride ?? Context.ConnectionId;
        var result = _rateLimiter.IsAllowed(key, policy);

        if (!result.IsAllowed)
        {
            throw new HubException($"Rate limit exceeded. Try again in {result.RetryAfter.TotalSeconds:F0} seconds.");
        }
    }

    public override async Task OnConnectedAsync()
    {
        var discordId = GetDiscordId();
        _logger.LogInformation(
            "Client connected: {ConnectionId} (Discord: {DiscordId})",
            Context.ConnectionId,
            discordId);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            _sessionService.RemovePeerFromSession(peer.SessionId, Context.ConnectionId);

            // Notify other peers in the session
            await Clients.Group(peer.SessionId).SendAsync("OnPeerLeft", Context.ConnectionId);

            _logger.LogInformation("Peer left session {SessionId}: {ConnectionId}", peer.SessionId, Context.ConnectionId);
        }

        // Clean up rate limit entries for this connection
        _rateLimiter.ClearKey(Context.ConnectionId);

        await base.OnDisconnectedAsync(exception);
    }

    public async Task<object> JoinSession(string sessionId)
    {
        // Rate limit by IP for join attempts (prevents session enumeration)
        CheckRateLimit(RateLimitPolicy.SessionJoin, GetClientIp());

        // Check if session is locked before attempting to join
        if (_sessionService.IsSessionLocked(sessionId))
        {
            _logger.LogWarning("Failed to join session {SessionId}: session is locked", sessionId);
            return new { success = false, error = "Session is locked" };
        }

        var peer = _sessionService.AddPeerToSession(sessionId, Context.ConnectionId);

        if (peer == null)
        {
            _logger.LogWarning("Failed to join session {SessionId}: session not found or full", sessionId);
            return new { success = false, error = "Session not found or full" };
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, sessionId);

        // Notify other peers in the session
        await Clients.OthersInGroup(sessionId).SendAsync("OnPeerJoined", Context.ConnectionId);

        _logger.LogInformation("Peer joined session {SessionId}: {ConnectionId} (initiator: {IsInitiator})",
            sessionId, Context.ConnectionId, peer.IsInitiator);

        // Return list of existing peers
        var existingPeers = _sessionService.GetPeersInSession(sessionId)
            .Where(p => p.ConnectionId != Context.ConnectionId)
            .Select(p => p.ConnectionId)
            .ToList();

        // Get session info for the joining peer
        var session = _sessionService.GetSession(sessionId);
        var isHost = _sessionService.IsSessionCreator(sessionId, Context.ConnectionId);
        var hostConnectionId = _sessionService.GetSessionCreator(sessionId);

        return new
        {
            success = true,
            isInitiator = peer.IsInitiator,
            existingPeers,
            isHost,
            hostConnectionId,
            isLocked = session?.IsLocked ?? false
        };
    }

    public async Task LeaveSession()
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            _sessionService.RemovePeerFromSession(peer.SessionId, Context.ConnectionId);
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, peer.SessionId);
            await Clients.Group(peer.SessionId).SendAsync("OnPeerLeft", Context.ConnectionId);

            _logger.LogInformation("Peer left session {SessionId}: {ConnectionId}", peer.SessionId, Context.ConnectionId);
        }
    }

    // WebRTC Signaling Methods
    public async Task SendOffer(string sdp)
    {
        CheckRateLimit(RateLimitPolicy.SignalingMessage);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            _logger.LogDebug("Sending offer from {ConnectionId} to session {SessionId}",
                Context.ConnectionId, peer.SessionId);
            await Clients.OthersInGroup(peer.SessionId).SendAsync("OnOffer", Context.ConnectionId, sdp);
        }
    }

    public async Task SendAnswer(string sdp)
    {
        CheckRateLimit(RateLimitPolicy.SignalingMessage);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            _logger.LogDebug("Sending answer from {ConnectionId} to session {SessionId}",
                Context.ConnectionId, peer.SessionId);
            await Clients.OthersInGroup(peer.SessionId).SendAsync("OnAnswer", Context.ConnectionId, sdp);
        }
    }

    public async Task SendIceCandidate(string candidate, string? sdpMid, int? sdpMLineIndex)
    {
        CheckRateLimit(RateLimitPolicy.IceCandidate);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            await Clients.OthersInGroup(peer.SessionId).SendAsync("OnIceCandidate",
                Context.ConnectionId, candidate, sdpMid, sdpMLineIndex);
        }
    }

    // Identity Verification Methods
    public async Task SendPublicKey(string keyJwk)
    {
        CheckRateLimit(RateLimitPolicy.SignalingMessage);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            _logger.LogDebug("Sending public key from {ConnectionId}", Context.ConnectionId);
            await Clients.OthersInGroup(peer.SessionId).SendAsync("OnPublicKey", Context.ConnectionId, keyJwk);
        }
    }

    public async Task SendSignature(string signature, string challenge)
    {
        CheckRateLimit(RateLimitPolicy.SignalingMessage);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            _logger.LogDebug("Sending signature from {ConnectionId}", Context.ConnectionId);
            await Clients.OthersInGroup(peer.SessionId).SendAsync("OnSignature",
                Context.ConnectionId, signature, challenge);
        }
    }

    // ============================================
    // Targeted Signaling Methods (for mesh setup)
    // ============================================

    /// <summary>
    /// Send WebRTC offer to a specific peer (used for mesh topology setup)
    /// </summary>
    public async Task SendOfferTo(string targetPeerId, string sdp)
    {
        CheckRateLimit(RateLimitPolicy.SignalingMessage);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            // Verify target is in the same session
            var targetPeer = _sessionService.GetPeerByConnectionId(targetPeerId);
            if (targetPeer != null && targetPeer.SessionId == peer.SessionId)
            {
                _logger.LogDebug("Sending targeted offer from {ConnectionId} to {TargetPeerId}",
                    Context.ConnectionId, targetPeerId);
                await Clients.Client(targetPeerId).SendAsync("OnOffer", Context.ConnectionId, sdp);
            }
            else
            {
                _logger.LogWarning("SendOfferTo failed: target {TargetPeerId} not in same session as {ConnectionId}",
                    targetPeerId, Context.ConnectionId);
            }
        }
    }

    /// <summary>
    /// Send WebRTC answer to a specific peer (used for mesh topology setup)
    /// </summary>
    public async Task SendAnswerTo(string targetPeerId, string sdp)
    {
        CheckRateLimit(RateLimitPolicy.SignalingMessage);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            var targetPeer = _sessionService.GetPeerByConnectionId(targetPeerId);
            if (targetPeer != null && targetPeer.SessionId == peer.SessionId)
            {
                _logger.LogDebug("Sending targeted answer from {ConnectionId} to {TargetPeerId}",
                    Context.ConnectionId, targetPeerId);
                await Clients.Client(targetPeerId).SendAsync("OnAnswer", Context.ConnectionId, sdp);
            }
            else
            {
                _logger.LogWarning("SendAnswerTo failed: target {TargetPeerId} not in same session as {ConnectionId}",
                    targetPeerId, Context.ConnectionId);
            }
        }
    }

    /// <summary>
    /// Send ICE candidate to a specific peer (used for mesh topology setup)
    /// </summary>
    public async Task SendIceCandidateTo(string targetPeerId, string candidate, string? sdpMid, int? sdpMLineIndex)
    {
        CheckRateLimit(RateLimitPolicy.IceCandidate);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            var targetPeer = _sessionService.GetPeerByConnectionId(targetPeerId);
            if (targetPeer != null && targetPeer.SessionId == peer.SessionId)
            {
                await Clients.Client(targetPeerId).SendAsync("OnIceCandidate",
                    Context.ConnectionId, candidate, sdpMid, sdpMLineIndex);
            }
        }
    }

    /// <summary>
    /// Send public key to a specific peer (used for per-peer verification in mesh)
    /// </summary>
    public async Task SendPublicKeyTo(string targetPeerId, string keyJwk)
    {
        CheckRateLimit(RateLimitPolicy.SignalingMessage);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            var targetPeer = _sessionService.GetPeerByConnectionId(targetPeerId);
            if (targetPeer != null && targetPeer.SessionId == peer.SessionId)
            {
                _logger.LogDebug("Sending targeted public key from {ConnectionId} to {TargetPeerId}",
                    Context.ConnectionId, targetPeerId);
                await Clients.Client(targetPeerId).SendAsync("OnPublicKey", Context.ConnectionId, keyJwk);
            }
        }
    }

    // ============================================
    // Connection State Tracking (for TTL management)
    // ============================================

    /// <summary>
    /// Report that a P2P WebRTC connection has been established with a peer.
    /// This is used to keep the session alive while transfers may be in progress.
    /// </summary>
    public Task ReportConnectionEstablished(string targetPeerId)
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            // Verify target is in the same session
            var targetPeer = _sessionService.GetPeerByConnectionId(targetPeerId);
            if (targetPeer != null && targetPeer.SessionId == peer.SessionId)
            {
                _sessionService.IncrementConnectedPairs(peer.SessionId);
                _logger.LogInformation(
                    "P2P connection established in session {SessionId}: {PeerId} <-> {TargetPeerId}",
                    peer.SessionId, Context.ConnectionId, targetPeerId);
            }
        }
        return Task.CompletedTask;
    }

    /// <summary>
    /// Report that a P2P WebRTC connection has been closed with a peer.
    /// </summary>
    public Task ReportConnectionClosed(string targetPeerId)
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            _sessionService.DecrementConnectedPairs(peer.SessionId);
            _logger.LogInformation(
                "P2P connection closed in session {SessionId}: {PeerId} <-> {TargetPeerId}",
                peer.SessionId, Context.ConnectionId, targetPeerId);
        }
        return Task.CompletedTask;
    }

    // ============================================
    // Session Control Methods (Host Powers)
    // ============================================

    /// <summary>
    /// Lock the session to prevent new peers from joining.
    /// Only the session creator (host) can lock the session.
    /// </summary>
    public async Task<object> LockSession()
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer == null)
        {
            return new { success = false, error = "Not in a session" };
        }

        var success = _sessionService.LockSession(peer.SessionId, Context.ConnectionId);
        if (!success)
        {
            _logger.LogWarning("Failed to lock session {SessionId}: not the host", peer.SessionId);
            return new { success = false, error = "Only the host can lock the session" };
        }

        _logger.LogInformation("Session {SessionId} locked by {ConnectionId}", peer.SessionId, Context.ConnectionId);

        // Notify all peers in the session
        await Clients.Group(peer.SessionId).SendAsync("OnSessionLocked");

        return new { success = true };
    }

    /// <summary>
    /// Unlock the session to allow new peers to join.
    /// Only the session creator (host) can unlock the session.
    /// </summary>
    public async Task<object> UnlockSession()
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer == null)
        {
            return new { success = false, error = "Not in a session" };
        }

        var success = _sessionService.UnlockSession(peer.SessionId, Context.ConnectionId);
        if (!success)
        {
            _logger.LogWarning("Failed to unlock session {SessionId}: not the host", peer.SessionId);
            return new { success = false, error = "Only the host can unlock the session" };
        }

        _logger.LogInformation("Session {SessionId} unlocked by {ConnectionId}", peer.SessionId, Context.ConnectionId);

        // Notify all peers in the session
        await Clients.Group(peer.SessionId).SendAsync("OnSessionUnlocked");

        return new { success = true };
    }

    /// <summary>
    /// Kick a peer from the session.
    /// Only the session creator (host) can kick peers.
    /// </summary>
    public async Task<object> KickPeer(string targetPeerId)
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer == null)
        {
            return new { success = false, error = "Not in a session" };
        }

        // Verify caller is the host
        if (!_sessionService.IsSessionCreator(peer.SessionId, Context.ConnectionId))
        {
            _logger.LogWarning("Failed to kick peer from session {SessionId}: not the host", peer.SessionId);
            return new { success = false, error = "Only the host can kick peers" };
        }

        // Verify target is in the same session
        var targetPeer = _sessionService.GetPeerByConnectionId(targetPeerId);
        if (targetPeer == null || targetPeer.SessionId != peer.SessionId)
        {
            return new { success = false, error = "Peer not found in session" };
        }

        // Can't kick yourself
        if (targetPeerId == Context.ConnectionId)
        {
            return new { success = false, error = "Cannot kick yourself" };
        }

        // Remove the peer from the session
        _sessionService.RemovePeerFromSession(peer.SessionId, targetPeerId);

        _logger.LogInformation("Peer {TargetPeerId} kicked from session {SessionId} by host {HostId}",
            targetPeerId, peer.SessionId, Context.ConnectionId);

        // Notify the kicked peer
        await Clients.Client(targetPeerId).SendAsync("OnKicked");

        // Notify other peers that this peer left
        await Clients.Group(peer.SessionId).SendAsync("OnPeerLeft", targetPeerId);

        // Remove kicked peer from the SignalR group
        await Groups.RemoveFromGroupAsync(targetPeerId, peer.SessionId);

        return new { success = true };
    }
}
