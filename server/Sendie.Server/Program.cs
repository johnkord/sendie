using AspNet.Security.OAuth.Discord;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.HttpOverrides;
using Sendie.Server.Authorization;
using Sendie.Server.Hubs;
using Sendie.Server.Services;

var builder = WebApplication.CreateBuilder(args);

// Configure forwarded headers for reverse proxy (nginx ingress)
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownNetworks.Clear();
    options.KnownProxies.Clear();
});

// Add services
builder.Services.AddSignalR();
builder.Services.AddSingleton<ISessionService, SessionService>();
builder.Services.AddSingleton<IAllowListService, AllowListService>();
builder.Services.AddSingleton<IAuthorizationHandler, AllowListHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, AdminHandler>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowFrontend", policy =>
    {
        policy.WithOrigins("http://localhost:5173", "http://127.0.0.1:5173")
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});

// Add authentication
builder.Services.AddAuthentication(options =>
{
    options.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = DiscordAuthenticationDefaults.AuthenticationScheme;
})
.AddCookie(options =>
{
    options.Cookie.Name = "Sendie.Auth";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Lax;
    options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest; // Use Always in production
    options.ExpireTimeSpan = TimeSpan.FromHours(24);
    options.SlidingExpiration = true;

    // API-friendly responses for unauthorized requests
    options.Events.OnRedirectToLogin = context =>
    {
        if (context.Request.Path.StartsWithSegments("/api") ||
            context.Request.Path.StartsWithSegments("/hubs"))
        {
            context.Response.StatusCode = 401;
            return Task.CompletedTask;
        }
        context.Response.Redirect(context.RedirectUri);
        return Task.CompletedTask;
    };

    options.Events.OnRedirectToAccessDenied = context =>
    {
        context.Response.StatusCode = 403;
        return Task.CompletedTask;
    };
})
.AddDiscord(options =>
{
    options.ClientId = builder.Configuration["Discord:ClientId"] ?? "";
    options.ClientSecret = builder.Configuration["Discord:ClientSecret"] ?? "";
    options.Scope.Add("identify");

    // Map Discord claims
    options.ClaimActions.MapJsonKey("urn:discord:id", "id");
    options.ClaimActions.MapJsonKey("urn:discord:username", "username");
    options.ClaimActions.MapJsonKey("urn:discord:global_name", "global_name");
    options.ClaimActions.MapJsonKey("urn:discord:avatar", "avatar");

    options.SaveTokens = true;
});

// Add authorization policies
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("AllowedUser", policy =>
        policy.RequireAuthenticatedUser()
              .RequireClaim("urn:discord:id")
              .AddRequirements(new AllowListRequirement()));

    options.AddPolicy("Admin", policy =>
        policy.RequireAuthenticatedUser()
              .RequireClaim("urn:discord:id")
              .AddRequirements(new AdminRequirement()));
});

var app = builder.Build();

// Configure middleware
// Must be first to ensure X-Forwarded-* headers are processed for OAuth redirects
app.UseForwardedHeaders();
app.UseCors("AllowFrontend");
app.UseAuthentication();
app.UseAuthorization();

// Health check endpoint
app.MapGet("/api/health", () => Results.Ok(new { status = "healthy", timestamp = DateTime.UtcNow }));

// ICE servers configuration endpoint (public - needed for WebRTC)
app.MapGet("/api/ice-servers", () => Results.Ok(new[]
{
    new { urls = new[] { "stun:stun.l.google.com:19302" } },
    new { urls = new[] { "stun:stun1.l.google.com:19302" } },
    new { urls = new[] { "stun:stun2.l.google.com:19302" } }
}));

// Authentication endpoints
app.MapGet("/api/auth/login", (string? returnUrl, IConfiguration config) =>
{
    // In development, redirect to frontend; in production, use relative path
    var defaultRedirect = app.Environment.IsDevelopment()
        ? "http://localhost:5173"
        : "/";

    var properties = new AuthenticationProperties
    {
        RedirectUri = returnUrl ?? defaultRedirect
    };
    return Results.Challenge(properties, [DiscordAuthenticationDefaults.AuthenticationScheme]);
});

app.MapPost("/api/auth/logout", async (HttpContext context) =>
{
    await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.Ok(new { message = "Logged out" });
}).RequireAuthorization();

app.MapGet("/api/auth/me", (HttpContext context, IAllowListService allowList) =>
{
    var discordId = context.User.FindFirst("urn:discord:id")?.Value;
    var username = context.User.FindFirst("urn:discord:username")?.Value;
    var globalName = context.User.FindFirst("urn:discord:global_name")?.Value;
    var avatar = context.User.FindFirst("urn:discord:avatar")?.Value;

    if (discordId == null)
        return Results.Unauthorized();

    var avatarUrl = avatar != null
        ? $"https://cdn.discordapp.com/avatars/{discordId}/{avatar}.png"
        : null;

    return Results.Ok(new
    {
        discordId,
        username,
        displayName = globalName ?? username,
        avatarUrl,
        isAdmin = allowList.IsAdmin(discordId),
        isAllowed = allowList.IsAllowed(discordId)
    });
}).RequireAuthorization();

// Session management endpoints
app.MapPost("/api/sessions", (ISessionService sessionService, HttpContext context, int? maxPeers) =>
{
    var session = sessionService.CreateSession(maxPeers ?? 5);
    return Results.Ok(session);
}).RequireAuthorization("AllowedUser");

app.MapGet("/api/sessions/{id}", (string id, ISessionService sessionService) =>
{
    var session = sessionService.GetSession(id);
    if (session == null)
        return Results.NotFound(new { error = "Session not found" });

    return Results.Ok(session);
}); // Public - anyone with session ID can access

// Admin endpoints
var adminGroup = app.MapGroup("/api/admin")
    .RequireAuthorization("Admin");

adminGroup.MapGet("/users", (IAllowListService allowList) =>
{
    return Results.Ok(new
    {
        admins = allowList.GetAdmins(),
        users = allowList.GetAllowedUsers()
    });
});

adminGroup.MapPost("/users/{discordUserId}", (
    string discordUserId,
    HttpContext context,
    IAllowListService allowList) =>
{
    var adminId = context.User.FindFirst("urn:discord:id")?.Value;
    if (adminId == null)
        return Results.Unauthorized();

    // Validate Discord user ID format (snowflake: 17-19 digit number)
    if (!IsValidDiscordId(discordUserId))
        return Results.BadRequest(new { error = "Invalid Discord user ID format" });

    var success = allowList.AddUser(discordUserId, adminId);

    return success
        ? Results.Created($"/api/admin/users/{discordUserId}", new { discordUserId })
        : Results.Conflict(new { error = "User already exists or operation failed" });
});

adminGroup.MapDelete("/users/{discordUserId}", (
    string discordUserId,
    HttpContext context,
    IAllowListService allowList) =>
{
    var adminId = context.User.FindFirst("urn:discord:id")?.Value;
    if (adminId == null)
        return Results.Unauthorized();

    var success = allowList.RemoveUser(discordUserId, adminId);

    return success
        ? Results.NoContent()
        : Results.NotFound(new { error = "User not found or cannot be removed" });
});

// Health check endpoint
app.MapGet("/health", () => Results.Ok(new { status = "healthy" }));

// SignalR hub
app.MapHub<SignalingHub>("/hubs/signaling");

app.Run();

// Helper function to validate Discord user ID format
static bool IsValidDiscordId(string id)
{
    return id.Length >= 17 && id.Length <= 19 && id.All(char.IsDigit);
}

// Make the implicit Program class public for integration tests
public partial class Program { }
