using System.Collections.Concurrent;

namespace Sendie.Server.Services;

/// <summary>
/// In-memory rate limiter using sliding window counters.
/// Thread-safe and automatically cleans up expired entries.
/// </summary>
public class RateLimiterService : IRateLimiterService, IDisposable
{
    private readonly ConcurrentDictionary<string, RateLimitBucket> _buckets = new();
    private readonly ILogger<RateLimiterService> _logger;
    private readonly Timer _cleanupTimer;

    // Policy configurations: (maxRequests, windowSize)
    private static readonly Dictionary<RateLimitPolicy, (int MaxRequests, TimeSpan Window)> PolicyConfig = new()
    {
        [RateLimitPolicy.SessionCreate] = (10, TimeSpan.FromHours(1)),
        [RateLimitPolicy.SessionJoin] = (30, TimeSpan.FromMinutes(1)),
        [RateLimitPolicy.SignalingMessage] = (100, TimeSpan.FromSeconds(1)),
        [RateLimitPolicy.IceCandidate] = (200, TimeSpan.FromSeconds(1))
    };

    public RateLimiterService(ILogger<RateLimiterService> logger)
    {
        _logger = logger;
        // Clean up expired entries every 5 minutes
        _cleanupTimer = new Timer(CleanupExpiredEntries, null, TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(5));
    }

    public RateLimitResult IsAllowed(string key, RateLimitPolicy policy)
    {
        var (maxRequests, window) = PolicyConfig[policy];
        var bucketKey = $"{policy}:{key}";

        var bucket = _buckets.GetOrAdd(bucketKey, _ => new RateLimitBucket(maxRequests, window));
        var result = bucket.TryConsume();

        if (!result.IsAllowed)
        {
            _logger.LogWarning(
                "Rate limit exceeded for {Policy} by {Key}. Retry after {RetryAfter:F1}s",
                policy, key, result.RetryAfter.TotalSeconds);
        }

        return result;
    }

    public void ClearKey(string key)
    {
        // Remove all policy buckets for this key
        foreach (var policy in PolicyConfig.Keys)
        {
            var bucketKey = $"{policy}:{key}";
            _buckets.TryRemove(bucketKey, out _);
        }
    }

    private void CleanupExpiredEntries(object? state)
    {
        var now = DateTime.UtcNow;
        var expiredKeys = new List<string>();

        foreach (var (key, bucket) in _buckets)
        {
            if (bucket.IsExpired(now))
            {
                expiredKeys.Add(key);
            }
        }

        foreach (var key in expiredKeys)
        {
            _buckets.TryRemove(key, out _);
        }

        if (expiredKeys.Count > 0)
        {
            _logger.LogDebug("Cleaned up {Count} expired rate limit entries", expiredKeys.Count);
        }
    }

    public void Dispose()
    {
        _cleanupTimer.Dispose();
    }

    /// <summary>
    /// Thread-safe sliding window rate limit bucket.
    /// </summary>
    private class RateLimitBucket
    {
        private readonly int _maxRequests;
        private readonly TimeSpan _window;
        private readonly object _lock = new();
        private readonly Queue<DateTime> _timestamps = new();
        private DateTime _lastAccess;

        public RateLimitBucket(int maxRequests, TimeSpan window)
        {
            _maxRequests = maxRequests;
            _window = window;
            _lastAccess = DateTime.UtcNow;
        }

        public RateLimitResult TryConsume()
        {
            lock (_lock)
            {
                var now = DateTime.UtcNow;
                _lastAccess = now;
                var windowStart = now - _window;

                // Remove expired timestamps
                while (_timestamps.Count > 0 && _timestamps.Peek() < windowStart)
                {
                    _timestamps.Dequeue();
                }

                if (_timestamps.Count >= _maxRequests)
                {
                    // Calculate retry-after based on oldest timestamp in window
                    var oldestInWindow = _timestamps.Peek();
                    var retryAfter = oldestInWindow.Add(_window) - now;
                    return RateLimitResult.Denied(retryAfter > TimeSpan.Zero ? retryAfter : TimeSpan.FromMilliseconds(100));
                }

                _timestamps.Enqueue(now);
                return RateLimitResult.Allowed(_maxRequests - _timestamps.Count);
            }
        }

        public bool IsExpired(DateTime now)
        {
            // Consider expired if no activity for 2x the window period
            return now - _lastAccess > _window * 2;
        }
    }
}
