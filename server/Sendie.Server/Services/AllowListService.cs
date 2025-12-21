using System.Collections.Concurrent;

namespace Sendie.Server.Services;

/// <summary>
/// In-memory implementation of the allow-list service.
/// Admins are loaded from configuration and cannot be modified at runtime.
/// Users can be added/removed by admins at runtime.
/// </summary>
public class AllowListService : IAllowListService
{
    private readonly HashSet<string> _admins;
    private readonly ConcurrentDictionary<string, AllowedUser> _allowedUsers = new();
    private readonly ILogger<AllowListService> _logger;

    public AllowListService(IConfiguration config, ILogger<AllowListService> logger)
    {
        _logger = logger;

        // Load admins from configuration (immutable at runtime)
        var adminIds = config.GetSection("AccessControl:Admins").Get<string[]>() ?? [];
        _admins = new HashSet<string>(adminIds);

        // Load initial allow-list from configuration
        var initialUsers = config.GetSection("AccessControl:InitialAllowList").Get<string[]>() ?? [];
        foreach (var userId in initialUsers)
        {
            _allowedUsers[userId] = new AllowedUser(userId, DateTime.UtcNow, "config");
        }

        // Admins are implicitly allowed
        foreach (var adminId in _admins)
        {
            _allowedUsers.TryAdd(adminId, new AllowedUser(adminId, DateTime.UtcNow, "config"));
        }

        _logger.LogInformation(
            "AllowListService initialized with {AdminCount} admins and {UserCount} allowed users",
            _admins.Count,
            _allowedUsers.Count);
    }

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
