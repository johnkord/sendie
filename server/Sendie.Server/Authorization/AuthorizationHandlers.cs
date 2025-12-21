using Microsoft.AspNetCore.Authorization;
using Sendie.Server.Services;

namespace Sendie.Server.Authorization;

/// <summary>
/// Authorization requirement that checks if the user is on the allow-list.
/// </summary>
public class AllowListRequirement : IAuthorizationRequirement { }

/// <summary>
/// Handler that validates users against the allow-list.
/// </summary>
public class AllowListHandler : AuthorizationHandler<AllowListRequirement>
{
    private readonly IAllowListService _allowListService;

    public AllowListHandler(IAllowListService allowListService)
    {
        _allowListService = allowListService;
    }

    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        AllowListRequirement requirement)
    {
        var discordId = context.User.FindFirst("urn:discord:id")?.Value;

        if (discordId != null && _allowListService.IsAllowed(discordId))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

/// <summary>
/// Authorization requirement that checks if the user is an administrator.
/// </summary>
public class AdminRequirement : IAuthorizationRequirement { }

/// <summary>
/// Handler that validates users as administrators.
/// </summary>
public class AdminHandler : AuthorizationHandler<AdminRequirement>
{
    private readonly IAllowListService _allowListService;

    public AdminHandler(IAllowListService allowListService)
    {
        _allowListService = allowListService;
    }

    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        AdminRequirement requirement)
    {
        var discordId = context.User.FindFirst("urn:discord:id")?.Value;

        if (discordId != null && _allowListService.IsAdmin(discordId))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}
