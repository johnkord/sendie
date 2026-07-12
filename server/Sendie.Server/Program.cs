using AspNet.Security.OAuth.Discord;
using System.Net;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Sendie.Server.Authorization;
using Sendie.Server.Hubs;
using Sendie.Server.Services;

var builder = WebApplication.CreateBuilder(args);

// Configure forwarded headers for reverse proxy (nginx ingress)
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    var knownNetworks = builder.Configuration
        .GetSection("ReverseProxy:KnownNetworks")
        .Get<string[]>() ?? [];
    var knownProxies = builder.Configuration
        .GetSection("ReverseProxy:KnownProxies")
        .Get<string[]>() ?? [];

    if (knownNetworks.Length > 0 || knownProxies.Length > 0)
    {
        options.KnownIPNetworks.Clear();
        options.KnownProxies.Clear();
    }
    foreach (var value in knownNetworks)
    {
        if (!System.Net.IPNetwork.TryParse(value, out var network))
            throw new InvalidOperationException($"Invalid ReverseProxy:KnownNetworks value: {value}");
        options.KnownIPNetworks.Add(network);
    }
    foreach (var value in knownProxies)
    {
        if (!IPAddress.TryParse(value, out var proxy))
            throw new InvalidOperationException($"Invalid ReverseProxy:KnownProxies value: {value}");
        options.KnownProxies.Add(proxy);
    }
});

// Add services
builder.Services.AddSignalR(options =>
{
    // Extended keep-alive for long-running sessions (24 hours)
    options.KeepAliveInterval = TimeSpan.FromSeconds(15);
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(60);  // 4x keep-alive for reliability
});
builder.Services.AddSingleton<ISessionService, SessionService>();
builder.Services.AddSingleton<IAllowListService, AllowListService>();
builder.Services.AddSingleton<IRateLimiterService, RateLimiterService>();
builder.Services.AddSingleton<IAuthorizationHandler, AllowListHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, AdminHandler>();

// Configure Data Protection for persistent cookie encryption keys
// This prevents users from being logged out when the server restarts
var dataDirectory = builder.Configuration["DataDirectory"] ?? Path.Combine(Directory.GetCurrentDirectory(), "data");
builder.Services.AddDataProtection()
    .SetApplicationName("Sendie")
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataDirectory, "keys")));

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowFrontend", policy =>
    {
        policy.WithOrigins("http://localhost:5173", "http://127.0.0.1:5173")
              .WithHeaders("Content-Type")
              .WithMethods("GET", "POST", "DELETE")
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
    options.Cookie.SecurePolicy = builder.Environment.IsDevelopment()
        ? CookieSecurePolicy.SameAsRequest
        : CookieSecurePolicy.Always;
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

    // Tokens are not used server-side; do not persist them in the auth cookie.
    options.SaveTokens = false;
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

// Phase 6.3 (audit): admin lockout safety. If no admins are configured, the
// allow-list is unmanageable at runtime. Log a loud warning so operators
// notice in the deploy logs rather than discovering it when they need to
// add a user.
using (var startupScope = app.Services.CreateScope())
{
    var allowList = startupScope.ServiceProvider.GetRequiredService<IAllowListService>();
    var startupLogger = startupScope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    var admins = allowList.GetAdmins();
    if (admins.Count == 0)
    {
        startupLogger.LogWarning(
            "No admins are configured (AccessControl:Admins is empty). The allow-list " +
            "is unmanageable at runtime. Add at least one Discord ID to AccessControl:Admins " +
            "and redeploy.");
    }
    else
    {
        startupLogger.LogInformation(
            "Startup admin self-test: {AdminCount} admin(s) configured.", admins.Count);
    }
}

// Configure middleware
// Must be first to ensure X-Forwarded-* headers are processed for OAuth redirects
app.UseForwardedHeaders();
app.UseCors("AllowFrontend");

// Security headers on all server responses (API + hub upgrade). nginx adds
// the same set on the static client; we duplicate here so direct port-forwards
// or future deployments without an nginx in front are still defended.
app.Use(async (context, next) =>
{
    var headers = context.Response.Headers;
    headers["X-Content-Type-Options"] = "nosniff";
    headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    headers["X-Frame-Options"] = "DENY";
    headers["Permissions-Policy"] = "camera=(self), microphone=(self), geolocation=(), interest-cohort=()";
    // Defense-in-depth CSP for API and hub responses. Anyone hitting the
    // server directly (port-forward, no nginx) still gets a usable policy.
    // The static client served by nginx has a fuller CSP that mirrors this.
    headers["Content-Security-Policy"] =
        "default-src 'self'; " +
        "connect-src 'self'; " +
        "frame-ancestors 'none'; " +
        "base-uri 'none'; " +
        "object-src 'none'";
    await next();
});

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

    // Only accept relative paths starting with '/' that aren't protocol-relative
    // (//evil.example or /\\evil.example are absolute when interpreted by the browser).
    var redirect = IsSafeReturnUrl(returnUrl) ? returnUrl! : defaultRedirect;

    var properties = new AuthenticationProperties
    {
        RedirectUri = redirect
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
app.MapPost("/api/sessions", (ISessionService sessionService, IRateLimiterService rateLimiter, HttpContext context, int? maxPeers) =>
{
    var clientIp = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    var ipResult = rateLimiter.IsAllowed(clientIp, RateLimitPolicy.SessionCreate);

    if (!ipResult.IsAllowed)
    {
        context.Response.Headers["Retry-After"] = ((int)Math.Ceiling(ipResult.RetryAfter.TotalSeconds)).ToString();
        return Results.StatusCode(429);
    }

    // Get Discord user ID from authenticated user
    var discordId = context.User.FindFirst("urn:discord:id")?.Value;
    if (string.IsNullOrEmpty(discordId))
    {
        return Results.Unauthorized();
    }

    // Per-user rate limit (separate bucket from per-IP) so CGNAT doesn't make
    // one user lock out another, and a multi-IP attacker can't slip past.
    var userResult = rateLimiter.IsAllowed($"user:{discordId}", RateLimitPolicy.SessionCreate);
    if (!userResult.IsAllowed)
    {
        context.Response.Headers["Retry-After"] = ((int)Math.Ceiling(userResult.RetryAfter.TotalSeconds)).ToString();
        return Results.StatusCode(429);
    }

    var session = sessionService.CreateSession(discordId, maxPeers ?? SessionService.DefaultMaxPeers);
    return Results.Ok(session);
}).RequireAuthorization("AllowedUser");

app.MapGet("/api/sessions/{id}", (string id, HttpContext ctx, ISessionService sessionService, IRateLimiterService rateLimiter) =>
{
    if (!IsValidSessionId(id))
    {
        return Results.BadRequest(new { error = "Invalid session ID" });
    }

    var clientIp = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    var r = rateLimiter.IsAllowed(clientIp, RateLimitPolicy.SessionLookup);
    if (!r.IsAllowed)
    {
        ctx.Response.Headers["Retry-After"] = ((int)Math.Ceiling(r.RetryAfter.TotalSeconds)).ToString();
        return Results.StatusCode(429);
    }

    var session = sessionService.GetSession(id);
    if (session == null)
        return Results.NotFound(new { error = "Session not found" });

    // Phase 6.1: never leak the SecretHash. Return a stripped-down view of
    // the session so this public probe cannot be used to attack the secret.
    return Results.Ok(new
    {
        session.Id,
        session.CreatedAt,
        session.ExpiresAt,
        session.AbsoluteExpiresAt,
        session.PeerCount,
        session.MaxPeers,
        session.IsLocked,
        session.IsHostOnlySending
    });
}); // Public - anyone with a valid session ID can probe (rate-limited).

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

// SignalR hub with stateful reconnect for better connection resilience
app.MapHub<SignalingHub>("/hubs/signaling", options =>
{
    // Enable stateful reconnect for seamless recovery from temporary disconnections
    options.AllowStatefulReconnects = true;
});

app.Run();

// Helper function to validate Discord user ID format
static bool IsValidDiscordId(string id)
{
    return id.Length >= 17 && id.Length <= 19 && id.All(char.IsDigit);
}

// Helper function to validate post-OAuth return URLs.
// Only accepts paths relative to the application root and rejects protocol-relative inputs.
static bool IsSafeReturnUrl(string? value)
{
    if (string.IsNullOrEmpty(value)) return false;
    if (value.Length > 512) return false;
    if (!value.StartsWith('/')) return false;
    if (value.StartsWith("//") || value.StartsWith("/\\")) return false;
    return Uri.TryCreate(value, UriKind.Relative, out _);
}

// Helper function to validate session ID format (16 random bytes -> 22-char base64url, no padding).
static bool IsValidSessionId(string id)
{
    if (id.Length != 22) return false;
    foreach (var c in id)
    {
        if (!(char.IsLetterOrDigit(c) || c == '-' || c == '_')) return false;
    }
    return true;
}

// Make the implicit Program class public for integration tests
public partial class Program { }
