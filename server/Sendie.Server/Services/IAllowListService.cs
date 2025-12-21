namespace Sendie.Server.Services;

/// <summary>
/// Service for managing the allow-list of Discord users who can access the application.
/// Admins are defined at configuration time and can add/remove users at runtime.
/// </summary>
public interface IAllowListService
{
    /// <summary>
    /// Check if a Discord user is allowed to access the application.
    /// </summary>
    bool IsAllowed(string discordUserId);

    /// <summary>
    /// Check if a Discord user is an administrator.
    /// </summary>
    bool IsAdmin(string discordUserId);

    /// <summary>
    /// Add a user to the allow-list. Only admins can perform this action.
    /// </summary>
    /// <returns>True if user was added, false if already exists or operation failed.</returns>
    bool AddUser(string discordUserId, string addedByAdminId);

    /// <summary>
    /// Remove a user from the allow-list. Only admins can perform this action.
    /// Admins cannot be removed.
    /// </summary>
    /// <returns>True if user was removed, false if not found or cannot be removed.</returns>
    bool RemoveUser(string discordUserId, string removedByAdminId);

    /// <summary>
    /// Get all users on the allow-list.
    /// </summary>
    IReadOnlyList<AllowedUser> GetAllowedUsers();

    /// <summary>
    /// Get all admin Discord user IDs.
    /// </summary>
    IReadOnlyList<string> GetAdmins();
}

/// <summary>
/// Represents a user on the allow-list.
/// </summary>
public record AllowedUser(
    string DiscordUserId,
    DateTime AddedAt,
    string AddedByAdminId
);
