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

    /// <summary>
    /// Validates the format of a session ID (16 random bytes -> 22-char base64url).
    /// </summary>
    private static bool IsValidSessionIdFormat(string id)
    {
        if (string.IsNullOrEmpty(id) || id.Length != 22) return false;
        foreach (var c in id)
        {
            if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_')) return false;
        }
        return true;
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
            // Get user ID before removing peer (for host tracking)
            var userId = GetDiscordId();

            // Update host connection state before removing peer (for 24-hour session persistence)
            _sessionService.UpdateHostConnectionState(peer.SessionId, Context.ConnectionId, userId, isConnecting: false);

            _sessionService.RemovePeerFromSession(peer.SessionId, Context.ConnectionId);

            // Notify other peers in the session
            await Clients.Group(peer.SessionId).SendAsync("OnPeerLeft", Context.ConnectionId);

            _logger.LogInformation("Peer left session {SessionId}: {ConnectionId}", peer.SessionId, Context.ConnectionId);
        }

        // Clean up rate limit entries for this connection
        _rateLimiter.ClearKey(Context.ConnectionId);

        await base.OnDisconnectedAsync(exception);
    }

    public async Task<object> JoinSession(string sessionId, string? secret = null)
    {
        // Reject malformed IDs early to prevent dictionary churn from junk input.
        if (!IsValidSessionIdFormat(sessionId))
        {
            return new { success = false, error = "Invalid session ID" };
        }

        // Rate limit by IP for join attempts (prevents session enumeration)
        CheckRateLimit(RateLimitPolicy.SessionJoin, GetClientIp());

        // Phase 6.1 (audit C4): require the URL-fragment join secret. The
        // path-only session URL is no longer sufficient to authenticate;
        // the secret travels in the fragment and is sent here over WSS.
        if (!_sessionService.ValidateSecret(sessionId, secret))
        {
            _logger.LogWarning("Failed to join session {SessionId}: invalid join secret", sessionId);
            return new { success = false, error = "Invalid or missing join secret" };
        }

        // Check if session is locked before attempting to join
        if (_sessionService.IsSessionLocked(sessionId))
        {
            _logger.LogWarning("Failed to join session {SessionId}: session is locked", sessionId);
            return new { success = false, error = "Session is locked" };
        }

        // Get user ID if authenticated (for host tracking)
        var userId = GetDiscordId();

        // Use overload that accepts userId for tracking
        var peer = _sessionService.AddPeerToSession(sessionId, Context.ConnectionId, userId);

        if (peer == null)
        {
            _logger.LogWarning("Failed to join session {SessionId}: session not found or full", sessionId);
            return new { success = false, error = "Session not found or full" };
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, sessionId);

        // Track host connection state for 24-hour session persistence
        _sessionService.UpdateHostConnectionState(sessionId, Context.ConnectionId, userId, isConnecting: true);

        // Notify other peers in the session
        await Clients.OthersInGroup(sessionId).SendAsync("OnPeerJoined", Context.ConnectionId);

        _logger.LogInformation("Peer joined session {SessionId}: {ConnectionId} (initiator: {IsInitiator}, userId: {UserId})",
            sessionId, Context.ConnectionId, peer.IsInitiator, userId ?? "anonymous");

        // Return list of existing peers
        var existingPeers = _sessionService.GetPeersInSession(sessionId)
            .Where(p => p.ConnectionId != Context.ConnectionId)
            .Select(p => p.ConnectionId)
            .ToList();

        // Get session info for the joining peer
        var session = _sessionService.GetSession(sessionId);
        var isHost = _sessionService.IsSessionCreator(sessionId, userId);
        var hostConnectionId = _sessionService.GetHostConnectionId(sessionId);

        return new
        {
            success = true,
            isInitiator = peer.IsInitiator,
            existingPeers,
            isHost,
            hostConnectionId,
            isLocked = session?.IsLocked ?? false,
            isHostOnlySending = session?.IsHostOnlySending ?? false
        };
    }

    public async Task LeaveSession()
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            // Get user ID before removing peer (for host tracking)
            var userId = GetDiscordId();

            // Update host connection state before removing peer (for 24-hour session persistence)
            _sessionService.UpdateHostConnectionState(peer.SessionId, Context.ConnectionId, userId, isConnecting: false);

            _sessionService.RemovePeerFromSession(peer.SessionId, Context.ConnectionId);
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, peer.SessionId);
            await Clients.Group(peer.SessionId).SendAsync("OnPeerLeft", Context.ConnectionId);

            _logger.LogInformation("Peer left session {SessionId}: {ConnectionId}", peer.SessionId, Context.ConnectionId);
        }
    }

    // WebRTC Signaling Methods
    // Note: only targeted *To variants are used by the mesh client.
    // Broadcast variants were removed to reduce attack surface.

    // Identity Verification Methods
    // SendSignature/OnSignature is wired through the signaling server but
    // is unused by Phase 2's bound-SAS verification (which runs over the
    // data channel). It is intentionally retained because the protocol may
    // grow a server-mediated handshake in the future; remove if that need
    // never materializes.
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

    // Note: the legacy SendSignature/OnSignature pathway via the signaling
    // server is intentionally not present. Phase 2 verification runs over the
    // P2P data channel so a malicious server cannot forge signatures — the
    // server never sees the verification payload.

    // ============================================
    // Connection State Tracking (for TTL management)
    // ============================================

    /// <summary>
    /// Report that a P2P WebRTC connection has been established with a peer.
    /// This is used to keep the session alive while transfers may be in progress.
    /// </summary>
    public Task ReportConnectionEstablished(string targetPeerId)
    {
        CheckRateLimit(RateLimitPolicy.PairReport);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            // Verify target is in the same session
            var targetPeer = _sessionService.GetPeerByConnectionId(targetPeerId);
            if (targetPeer != null && targetPeer.SessionId == peer.SessionId)
            {
                _sessionService.RecordPair(peer.SessionId, Context.ConnectionId, targetPeerId);
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
        CheckRateLimit(RateLimitPolicy.PairReport);

        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer != null)
        {
            _sessionService.ForgetPair(peer.SessionId, Context.ConnectionId, targetPeerId);
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

        var userId = GetDiscordId();
        var success = _sessionService.LockSession(peer.SessionId, userId);
        if (!success)
        {
            _logger.LogWarning("Failed to lock session {SessionId}: not the host", peer.SessionId);
            return new { success = false, error = "Only the host can lock the session" };
        }

        _logger.LogInformation("Session {SessionId} locked by {ConnectionId} (userId: {UserId})", peer.SessionId, Context.ConnectionId, userId);

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

        var userId = GetDiscordId();
        var success = _sessionService.UnlockSession(peer.SessionId, userId);
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
        var userId = GetDiscordId();
        if (!_sessionService.IsSessionCreator(peer.SessionId, userId))
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

        _logger.LogInformation("Peer {TargetPeerId} kicked from session {SessionId} by host {HostId} (userId: {UserId})",
            targetPeerId, peer.SessionId, Context.ConnectionId, userId);

        // Notify the kicked peer
        await Clients.Client(targetPeerId).SendAsync("OnKicked");

        // Notify other peers that this peer left
        await Clients.Group(peer.SessionId).SendAsync("OnPeerLeft", targetPeerId);

        // Remove kicked peer from the SignalR group
        await Groups.RemoveFromGroupAsync(targetPeerId, peer.SessionId);

        return new { success = true };
    }

    /// <summary>
    /// Enable host-only sending mode.
    /// When enabled, only the host can send files; other peers can only receive.
    /// </summary>
    public async Task<object> EnableHostOnlySending()
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer == null)
        {
            return new { success = false, error = "Not in a session" };
        }

        var userId = GetDiscordId();
        var success = _sessionService.EnableHostOnlySending(peer.SessionId, userId);
        if (!success)
        {
            _logger.LogWarning("Failed to enable host-only sending for session {SessionId}: not the host", peer.SessionId);
            return new { success = false, error = "Only the host can enable host-only sending" };
        }

        _logger.LogInformation("Host-only sending enabled for session {SessionId} by {ConnectionId} (userId: {UserId})", peer.SessionId, Context.ConnectionId, userId);

        // Notify all peers in the session
        await Clients.Group(peer.SessionId).SendAsync("OnHostOnlySendingEnabled");

        return new { success = true };
    }

    /// <summary>
    /// Disable host-only sending mode.
    /// When disabled, all peers can send files.
    /// </summary>
    public async Task<object> DisableHostOnlySending()
    {
        var peer = _sessionService.GetPeerByConnectionId(Context.ConnectionId);
        if (peer == null)
        {
            return new { success = false, error = "Not in a session" };
        }

        var userId = GetDiscordId();
        var success = _sessionService.DisableHostOnlySending(peer.SessionId, userId);
        if (!success)
        {
            _logger.LogWarning("Failed to disable host-only sending for session {SessionId}: not the host", peer.SessionId);
            return new { success = false, error = "Only the host can disable host-only sending" };
        }

        _logger.LogInformation("Host-only sending disabled for session {SessionId} by {ConnectionId} (userId: {UserId})", peer.SessionId, Context.ConnectionId, userId);

        // Notify all peers in the session
        await Clients.Group(peer.SessionId).SendAsync("OnHostOnlySendingDisabled");

        return new { success = true };
    }
}
