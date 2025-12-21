# Discord-Based Identity & Access Control Proposal

This document proposes replacing the SAS-based identity verification with a Discord OAuth2 authentication system featuring an allow-list with runtime administration.

---

## Goals

1. **Discord-based identity**: Users authenticate via Discord OAuth2 flow
2. **Allow-list access control**: Only pre-approved Discord user IDs can use the app
3. **Admin management**: Config-defined admins can add/remove users at runtime
4. **Session binding**: File transfer sessions are tied to authenticated Discord identities

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AUTHENTICATION FLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                  │
│   │   Browser   │────►│   Sendie    │────►│   Discord   │                  │
│   │             │◄────│   Server    │◄────│   OAuth2    │                  │
│   └─────────────┘     └──────┬──────┘     └─────────────┘                  │
│                              │                                              │
│                       ┌──────▼──────┐                                       │
│                       │  Allow-List │                                       │
│                       │   Service   │                                       │
│                       │             │                                       │
│                       │ • Admins    │                                       │
│                       │ • Users     │                                       │
│                       └─────────────┘                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Discord OAuth2 Integration

### 1.1 Discord Application Setup

Create a Discord application at https://discord.com/developers/applications:

1. Create new application → copy **Client ID** and **Client Secret**
2. Add redirect URI: `https://yourdomain.com/signin-discord`
3. Required OAuth2 scopes: `identify` (gets user ID, username, avatar)

### 1.2 ASP.NET Core Implementation

**Add NuGet package:**

```bash
dotnet add package AspNet.Security.OAuth.Discord
```

**Configuration (`appsettings.json`):**

```json
{
  "Discord": {
    "ClientId": "YOUR_DISCORD_CLIENT_ID",
    "ClientSecret": "YOUR_DISCORD_CLIENT_SECRET"
  },
  "AccessControl": {
    "Admins": [
      "123456789012345678",
      "234567890123456789"
    ],
    "InitialAllowList": [
      "345678901234567890"
    ]
  }
}
```

**Program.cs changes:**

```csharp
using AspNet.Security.OAuth.Discord;
using Microsoft.AspNetCore.Authentication.Cookies;

var builder = WebApplication.CreateBuilder(args);

// Add authentication services
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
    options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
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
    options.ClientId = builder.Configuration["Discord:ClientId"]!;
    options.ClientSecret = builder.Configuration["Discord:ClientSecret"]!;
    options.Scope.Add("identify");
    
    // Map Discord claims
    options.ClaimActions.MapJsonKey("urn:discord:id", "id");
    options.ClaimActions.MapJsonKey("urn:discord:username", "username");
    options.ClaimActions.MapJsonKey("urn:discord:global_name", "global_name");
    options.ClaimActions.MapJsonKey("urn:discord:avatar", "avatar");
    
    options.SaveTokens = true; // Store tokens for potential API calls
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

// Register access control services
builder.Services.AddSingleton<IAllowListService, AllowListService>();
builder.Services.AddSingleton<IAuthorizationHandler, AllowListHandler>();
builder.Services.AddSingleton<IAuthorizationHandler, AdminHandler>();

var app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();
```

---

## 2. Allow-List Service

### 2.1 Interface

```csharp
// Services/IAllowListService.cs
namespace Sendie.Server.Services;

public interface IAllowListService
{
    // Check access
    bool IsAllowed(string discordUserId);
    bool IsAdmin(string discordUserId);
    
    // Admin operations
    bool AddUser(string discordUserId, string addedByAdminId);
    bool RemoveUser(string discordUserId, string removedByAdminId);
    
    // List management
    IReadOnlyList<AllowedUser> GetAllowedUsers();
    IReadOnlyList<string> GetAdmins();
}

public record AllowedUser(
    string DiscordUserId,
    DateTime AddedAt,
    string AddedByAdminId
);
```

### 2.2 Implementation

```csharp
// Services/AllowListService.cs
using System.Collections.Concurrent;

namespace Sendie.Server.Services;

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
```

### 2.3 Authorization Handlers

```csharp
// Authorization/AllowListRequirement.cs
using Microsoft.AspNetCore.Authorization;

namespace Sendie.Server.Authorization;

public class AllowListRequirement : IAuthorizationRequirement { }

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

public class AdminRequirement : IAuthorizationRequirement { }

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
```

---

## 3. API Endpoints

### 3.1 Authentication Endpoints

```csharp
// Program.cs - Add these endpoints

// Login - redirects to Discord OAuth
app.MapGet("/api/auth/login", (string? returnUrl) =>
{
    var properties = new AuthenticationProperties
    {
        RedirectUri = returnUrl ?? "/"
    };
    return Results.Challenge(properties, [DiscordAuthenticationDefaults.AuthenticationScheme]);
});

// Logout
app.MapPost("/api/auth/logout", async (HttpContext context) =>
{
    await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.Ok(new { message = "Logged out" });
}).RequireAuthorization();

// Get current user info
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
```

### 3.2 Admin Endpoints

```csharp
// Program.cs - Admin endpoints

var adminGroup = app.MapGroup("/api/admin")
    .RequireAuthorization("Admin");

// Get all allowed users
adminGroup.MapGet("/users", (IAllowListService allowList) =>
{
    return Results.Ok(new
    {
        admins = allowList.GetAdmins(),
        users = allowList.GetAllowedUsers()
    });
});

// Add user to allow-list
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

// Remove user from allow-list
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

static bool IsValidDiscordId(string id)
{
    return id.Length >= 17 && id.Length <= 19 && id.All(char.IsDigit);
}
```

---

## 4. Securing Existing Endpoints

### 4.1 Update SignalingHub

```csharp
// Hubs/SignalingHub.cs
using Microsoft.AspNetCore.Authorization;

namespace Sendie.Server.Hubs;

[Authorize(Policy = "AllowedUser")]
public class SignalingHub : Hub
{
    // ... existing code ...
    
    // Add helper to get Discord ID
    private string? GetDiscordId()
    {
        return Context.User?.FindFirst("urn:discord:id")?.Value;
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
}
```

### 4.2 Update Session Endpoints

```csharp
// Program.cs - Update existing endpoints

app.MapPost("/api/sessions", (ISessionService sessionService, HttpContext context) =>
{
    var discordId = context.User.FindFirst("urn:discord:id")?.Value;
    var session = sessionService.CreateSession(discordId); // Pass creator ID
    return Results.Ok(session);
}).RequireAuthorization("AllowedUser");

app.MapGet("/api/sessions/{id}", (string id, ISessionService sessionService) =>
{
    var session = sessionService.GetSession(id);
    if (session == null)
        return Results.NotFound(new { error = "Session not found" });
    return Results.Ok(session);
}).RequireAuthorization("AllowedUser");
```

---

## 5. Frontend Changes

### 5.1 Auth Service

```typescript
// services/AuthService.ts

export interface User {
  discordId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  isAllowed: boolean;
}

export class AuthService {
  async getCurrentUser(): Promise<User | null> {
    try {
      const response = await fetch('/api/auth/me');
      if (response.status === 401) return null;
      if (!response.ok) throw new Error('Failed to get user');
      return await response.json();
    } catch {
      return null;
    }
  }

  login(returnUrl?: string): void {
    const url = returnUrl 
      ? `/api/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`
      : '/api/auth/login';
    window.location.href = url;
  }

  async logout(): Promise<void> {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }
}

export const authService = new AuthService();
```

### 5.2 Auth Store

```typescript
// stores/authStore.ts
import { create } from 'zustand';
import type { User } from '../services/AuthService';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  error: null,
  setUser: (user) => set({ user, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error, isLoading: false }),
}));
```

### 5.3 Protected Route Component

```tsx
// components/ProtectedRoute.tsx
import { useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { authService } from '../services/AuthService';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
}

export function ProtectedRoute({ children, requireAdmin = false }: ProtectedRouteProps) {
  const { user, isLoading, setUser } = useAuthStore();

  useEffect(() => {
    authService.getCurrentUser().then(setUser);
  }, [setUser]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white mb-4">Authentication Required</h1>
          <p className="text-gray-400 mb-6">Please sign in with Discord to continue.</p>
          <button
            onClick={() => authService.login(window.location.pathname)}
            className="px-6 py-3 bg-[#5865F2] hover:bg-[#4752C4] text-white rounded-lg font-medium transition-colors"
          >
            Sign in with Discord
          </button>
        </div>
      </div>
    );
  }

  if (!user.isAllowed) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white mb-4">Access Denied</h1>
          <p className="text-gray-400 mb-2">Your Discord account is not on the allow-list.</p>
          <p className="text-gray-500 text-sm">Contact an administrator for access.</p>
        </div>
      </div>
    );
  }

  if (requireAdmin && !user.isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white mb-4">Admin Access Required</h1>
          <p className="text-gray-400">You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
```

### 5.4 Admin Panel Component

```tsx
// pages/AdminPage.tsx
import { useState, useEffect } from 'react';
import { ProtectedRoute } from '../components/ProtectedRoute';

interface AllowedUser {
  discordUserId: string;
  addedAt: string;
  addedByAdminId: string;
}

export default function AdminPage() {
  const [users, setUsers] = useState<AllowedUser[]>([]);
  const [admins, setAdmins] = useState<string[]>([]);
  const [newUserId, setNewUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUsers = async () => {
    try {
      const response = await fetch('/api/admin/users');
      if (!response.ok) throw new Error('Failed to fetch users');
      const data = await response.json();
      setUsers(data.users);
      setAdmins(data.admins);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const addUser = async () => {
    if (!newUserId.trim()) return;
    
    try {
      const response = await fetch(`/api/admin/users/${newUserId}`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to add user');
      }
      
      setNewUserId('');
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const removeUser = async (discordUserId: string) => {
    try {
      const response = await fetch(`/api/admin/users/${discordUserId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to remove user');
      }
      
      fetchUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  return (
    <ProtectedRoute requireAdmin>
      <div className="min-h-screen p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl font-bold text-white mb-8">Admin Panel</h1>
          
          {error && (
            <div className="bg-red-900/50 text-red-200 p-4 rounded-lg mb-6">
              {error}
              <button onClick={() => setError(null)} className="ml-4 underline">Dismiss</button>
            </div>
          )}
          
          {/* Add User Form */}
          <div className="bg-gray-800 rounded-lg p-6 mb-8">
            <h2 className="text-xl font-semibold text-white mb-4">Add User</h2>
            <div className="flex gap-4">
              <input
                type="text"
                value={newUserId}
                onChange={(e) => setNewUserId(e.target.value)}
                placeholder="Discord User ID (e.g., 123456789012345678)"
                className="flex-1 px-4 py-2 bg-gray-700 text-white rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
              />
              <button
                onClick={addUser}
                className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
              >
                Add User
              </button>
            </div>
          </div>
          
          {/* Admins List */}
          <div className="bg-gray-800 rounded-lg p-6 mb-8">
            <h2 className="text-xl font-semibold text-white mb-4">Admins (Config-defined)</h2>
            <ul className="space-y-2">
              {admins.map((adminId) => (
                <li key={adminId} className="text-gray-300 font-mono bg-gray-700 px-4 py-2 rounded">
                  {adminId}
                </li>
              ))}
            </ul>
          </div>
          
          {/* Users List */}
          <div className="bg-gray-800 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-white mb-4">Allowed Users</h2>
            {loading ? (
              <p className="text-gray-400">Loading...</p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700">
                    <th className="pb-2">Discord ID</th>
                    <th className="pb-2">Added At</th>
                    <th className="pb-2">Added By</th>
                    <th className="pb-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.discordUserId} className="border-b border-gray-700">
                      <td className="py-3 font-mono text-gray-300">{user.discordUserId}</td>
                      <td className="py-3 text-gray-400">
                        {new Date(user.addedAt).toLocaleDateString()}
                      </td>
                      <td className="py-3 text-gray-400">{user.addedByAdminId}</td>
                      <td className="py-3">
                        {!admins.includes(user.discordUserId) && (
                          <button
                            onClick={() => removeUser(user.discordUserId)}
                            className="text-red-400 hover:text-red-300"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </ProtectedRoute>
  );
}
```

---

## 6. Security Considerations

### 6.1 Best Practices Implemented

| Practice | Implementation |
|----------|----------------|
| **Secure cookie settings** | HttpOnly, Secure, SameSite=Lax |
| **State parameter** | Built into ASP.NET OAuth handler |
| **Token storage** | Server-side only (cookies), not exposed to JS |
| **Admin immutability** | Admins defined at config-time, cannot be removed |
| **Audit logging** | All admin actions logged |
| **Input validation** | Discord ID format validation |
| **CSRF protection** | Built into ASP.NET Core |

### 6.2 Additional Recommendations

1. **Use environment variables for secrets**:
   ```bash
   export Discord__ClientId="your-client-id"
   export Discord__ClientSecret="your-client-secret"
   ```

2. **Rotate client secret periodically** via Discord Developer Portal

3. **Consider persistent storage** for allow-list if server restarts should preserve changes:
   - SQLite for simple deployments
   - Redis for distributed deployments

4. **Add webhook notifications** for admin actions (post to a Discord channel)

---

## 7. Migration Steps

### 7.1 Server-side

1. Add NuGet package: `AspNet.Security.OAuth.Discord`
2. Create `Services/IAllowListService.cs` and `Services/AllowListService.cs`
3. Create `Authorization/` handlers
4. Update `Program.cs` with auth configuration
5. Update `SignalingHub.cs` with `[Authorize]` attribute
6. Update `appsettings.json` with Discord credentials and admin IDs
7. Remove SAS-related SignalR methods (optional, can keep for legacy)

### 7.2 Client-side

1. Create `services/AuthService.ts`
2. Create `stores/authStore.ts`
3. Create `components/ProtectedRoute.tsx`
4. Create `pages/AdminPage.tsx`
5. Update `App.tsx` routing to use `ProtectedRoute`
6. Remove SAS-related UI components
7. Add login/logout buttons to header

### 7.3 Configuration

1. Create Discord application at https://discord.com/developers/applications
2. Set redirect URI to `https://yourdomain.com/signin-discord`
3. Copy Client ID and Client Secret to `appsettings.json` or environment variables
4. Add initial admin Discord user IDs to configuration

---

## 8. Testing Checklist

- [ ] Unauthenticated users are redirected to Discord login
- [ ] Users not on allow-list see "Access Denied" after login
- [ ] Allowed users can access session pages
- [ ] Admins can access admin panel
- [ ] Admins can add users to allow-list
- [ ] Admins can remove non-admin users from allow-list
- [ ] Admins cannot remove other admins
- [ ] SignalR connections require authentication
- [ ] Session creation requires authentication
- [ ] Logout properly clears session

---

## References

- [Discord OAuth2 Documentation](https://discord.com/developers/docs/topics/oauth2)
- [AspNet.Security.OAuth.Discord](https://github.com/aspnet-contrib/AspNet.Security.OAuth.Providers)
- [ASP.NET Core Authentication](https://learn.microsoft.com/en-us/aspnet/core/security/authentication)
- [ASP.NET Core Authorization](https://learn.microsoft.com/en-us/aspnet/core/security/authorization)
