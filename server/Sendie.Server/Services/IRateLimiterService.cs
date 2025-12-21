namespace Sendie.Server.Services;

/// <summary>
/// Service for rate limiting requests to prevent abuse.
/// Uses in-memory storage with automatic cleanup of expired entries.
/// </summary>
public interface IRateLimiterService
{
    /// <summary>
    /// Check if a request is allowed under the specified rate limit policy.
    /// </summary>
    /// <param name="key">Unique identifier for the rate limit bucket (e.g., IP address, connection ID)</param>
    /// <param name="policy">The rate limit policy to apply</param>
    /// <returns>Result indicating whether the request is allowed</returns>
    RateLimitResult IsAllowed(string key, RateLimitPolicy policy);

    /// <summary>
    /// Remove all rate limit entries for a specific key.
    /// Useful when a connection is closed.
    /// </summary>
    void ClearKey(string key);
}

/// <summary>
/// Predefined rate limit policies for different operations.
/// </summary>
public enum RateLimitPolicy
{
    /// <summary>
    /// Session creation: 10 per hour per IP
    /// </summary>
    SessionCreate,

    /// <summary>
    /// Session join attempts: 30 per minute per IP
    /// </summary>
    SessionJoin,

    /// <summary>
    /// SignalR signaling messages: 100 per second per connection
    /// </summary>
    SignalingMessage,

    /// <summary>
    /// ICE candidate messages: 200 per second per connection (WebRTC can generate many)
    /// </summary>
    IceCandidate
}

/// <summary>
/// Result of a rate limit check.
/// </summary>
public record RateLimitResult(
    bool IsAllowed,
    int Remaining,
    TimeSpan RetryAfter
)
{
    public static RateLimitResult Allowed(int remaining) => new(true, remaining, TimeSpan.Zero);
    public static RateLimitResult Denied(TimeSpan retryAfter) => new(false, 0, retryAfter);
}
