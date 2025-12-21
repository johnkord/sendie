using System.Collections.Concurrent;
using System.Text.Json;

namespace Sendie.Server.Services;

/// <summary>
/// Implementation of the allow-list service with file-based persistence.
/// Admins are loaded from configuration and cannot be modified at runtime.
/// Users can be added/removed by admins at runtime and are persisted to disk.
/// </summary>
public class AllowListService : IAllowListService
{
    private readonly HashSet<string> _admins;
    private readonly ConcurrentDictionary<string, AllowedUser> _allowedUsers = new();
    private readonly ILogger<AllowListService> _logger;
    private readonly string _persistencePath;
    private readonly object _fileLock = new();
    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public AllowListService(IConfiguration config, ILogger<AllowListService> logger, IWebHostEnvironment env)
    {
        _logger = logger;

        // Set up persistence file path in the data directory
        var dataDir = config["DataDirectory"] ?? Path.Combine(env.ContentRootPath, "data");
        Directory.CreateDirectory(dataDir);
        _persistencePath = Path.Combine(dataDir, "allowlist.json");

        // Load admins from configuration (immutable at runtime)
        var adminIds = config.GetSection("AccessControl:Admins").Get<string[]>() ?? [];
        _admins = new HashSet<string>(adminIds);

        // Load persisted users first (runtime additions from previous runs)
        LoadPersistedUsers();

        // Load initial allow-list from configuration (config takes precedence for source tracking)
        var initialUsers = config.GetSection("AccessControl:InitialAllowList").Get<string[]>() ?? [];
        foreach (var userId in initialUsers)
        {
            _allowedUsers[userId] = new AllowedUser(userId, DateTime.UtcNow, "config");
        }

        // Admins are implicitly allowed
        foreach (var adminId in _admins)
        {
            _allowedUsers[adminId] = new AllowedUser(adminId, DateTime.UtcNow, "config");
        }

        _logger.LogInformation(
            "AllowListService initialized with {AdminCount} admins and {UserCount} allowed users",
            _admins.Count,
            _allowedUsers.Count);
    }

    private void LoadPersistedUsers()
    {
        if (!File.Exists(_persistencePath))
        {
            _logger.LogDebug("No persisted allow-list found at {Path}", _persistencePath);
            return;
        }

        try
        {
            var json = File.ReadAllText(_persistencePath);
            var persistedUsers = JsonSerializer.Deserialize<List<PersistedUser>>(json, _jsonOptions);

            if (persistedUsers != null)
            {
                foreach (var user in persistedUsers)
                {
                    _allowedUsers[user.DiscordUserId] = new AllowedUser(
                        user.DiscordUserId,
                        user.AddedAt,
                        user.AddedByAdminId);
                }

                _logger.LogInformation(
                    "Loaded {Count} persisted users from {Path}",
                    persistedUsers.Count,
                    _persistencePath);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load persisted allow-list from {Path}", _persistencePath);
        }
    }

    private void PersistAllowList()
    {
        try
        {
            // Only persist non-config users (runtime additions)
            var usersToPersist = _allowedUsers.Values
                .Where(u => u.AddedByAdminId != "config")
                .Select(u => new PersistedUser(u.DiscordUserId, u.AddedAt, u.AddedByAdminId))
                .ToList();

            lock (_fileLock)
            {
                var json = JsonSerializer.Serialize(usersToPersist, _jsonOptions);
                File.WriteAllText(_persistencePath, json);
            }

            _logger.LogDebug("Persisted {Count} users to {Path}", usersToPersist.Count, _persistencePath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to persist allow-list to {Path}", _persistencePath);
        }
    }

    // Internal record for JSON serialization
    private record PersistedUser(string DiscordUserId, DateTime AddedAt, string AddedByAdminId);

    public bool IsAllowed(string discordUserId)
    {
        return _allowedUsers.ContainsKey(discordUserId);
    }

    public bool IsAdmin(string discordUserId)
    {
        return _admins.Contains(discordUserId);
    }

    public bool AddUser(string discordUserId, string addedByAdminId)
    {
        if (!IsAdmin(addedByAdminId))
        {
            _logger.LogWarning(
                "Non-admin {UserId} attempted to add user {TargetUserId}",
                addedByAdminId,
                discordUserId);
            return false;
        }

        var user = new AllowedUser(discordUserId, DateTime.UtcNow, addedByAdminId);
        var added = _allowedUsers.TryAdd(discordUserId, user);

        if (added)
        {
            PersistAllowList();
            _logger.LogInformation(
                "Admin {AdminId} added user {UserId} to allow-list",
                addedByAdminId,
                discordUserId);
        }

        return added;
    }

    public bool RemoveUser(string discordUserId, string removedByAdminId)
    {
        if (!IsAdmin(removedByAdminId))
        {
            _logger.LogWarning(
                "Non-admin {UserId} attempted to remove user {TargetUserId}",
                removedByAdminId,
                discordUserId);
            return false;
        }

        // Prevent removing admins
        if (IsAdmin(discordUserId))
        {
            _logger.LogWarning(
                "Attempted to remove admin {AdminId} from allow-list",
                discordUserId);
            return false;
        }

        var removed = _allowedUsers.TryRemove(discordUserId, out _);

        if (removed)
        {
            PersistAllowList();
            _logger.LogInformation(
                "Admin {AdminId} removed user {UserId} from allow-list",
                removedByAdminId,
                discordUserId);
        }

        return removed;
    }

    public IReadOnlyList<AllowedUser> GetAllowedUsers()
    {
        return _allowedUsers.Values.ToList();
    }

    public IReadOnlyList<string> GetAdmins()
    {
        return _admins.ToList();
    }
}
