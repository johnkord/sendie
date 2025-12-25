using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Sendie.Server.Services;

namespace Sendie.Server.Tests.Integration;

public class TestWebApplicationFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureServices(services =>
        {
            // Remove the existing authentication configuration
            services.AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = TestAuthHandler.AuthenticationScheme;
                options.DefaultChallengeScheme = TestAuthHandler.AuthenticationScheme;
                options.DefaultScheme = TestAuthHandler.AuthenticationScheme;
            })
            .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(
                TestAuthHandler.AuthenticationScheme, options => { });

            // Replace AllowListService with a test version that allows our test user
            services.AddSingleton<IAllowListService, TestAllowListService>();
            
            // Replace RateLimiterService with a test version that never limits
            services.AddSingleton<IRateLimiterService, TestRateLimiterService>();
        });
    }
}

/// <summary>
/// Test allow-list service that allows the test user
/// </summary>
public class TestAllowListService : IAllowListService
{
    public bool IsAllowed(string discordUserId) => 
        discordUserId == TestAuthHandler.TestUserId;

    public bool IsAdmin(string discordUserId) => 
        discordUserId == TestAuthHandler.TestUserId;

    public bool AddUser(string discordUserId, string addedByAdminId) => true;
    
    public bool RemoveUser(string discordUserId, string removedByAdminId) => true;
    
    public IReadOnlyList<AllowedUser> GetAllowedUsers() => 
        new[] { new AllowedUser(TestAuthHandler.TestUserId, DateTime.UtcNow, TestAuthHandler.TestUserId) };
    
    public IReadOnlyList<string> GetAdmins() => new[] { TestAuthHandler.TestUserId };
}

/// <summary>
/// Test rate limiter service that allows all requests
/// </summary>
public class TestRateLimiterService : IRateLimiterService
{
    public RateLimitResult IsAllowed(string key, RateLimitPolicy policy) => 
        RateLimitResult.Allowed(100);
    
    public void ClearKey(string key) { }
}
