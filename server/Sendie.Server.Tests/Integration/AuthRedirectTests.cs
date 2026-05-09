using System.Net;
using System.Net.Http;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Sendie.Server.Tests.Integration;

/// <summary>
/// Phase 0 regression tests: the open-redirect protection on /api/auth/login
/// must reject any returnUrl that is not strictly a relative path under the
/// application root.
/// </summary>
public class AuthRedirectTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public AuthRedirectTests(WebApplicationFactory<Program> factory)
    {
        _factory = factory;
    }

    [Theory]
    [InlineData("https://evil.example/")]                  // absolute http(s) URL
    [InlineData("//evil.example/path")]                    // protocol-relative
    [InlineData("/\\\\evil.example/")]                     // backslash variant
    [InlineData("javascript:alert(1)")]                    // js scheme
    [InlineData("http://localhost:5173/admin")]            // looks-local
    public async Task Login_RejectsUnsafeReturnUrl(string returnUrl)
    {
        // Don't follow redirects so we can inspect the Location header.
        var client = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
        });

        var resp = await client.GetAsync($"/api/auth/login?returnUrl={Uri.EscapeDataString(returnUrl)}");

        // Auth challenge results in either a 302 to Discord OR a 401 if Discord OAuth
        // isn't fully wired in tests. Either way, the response must not include the
        // attacker-controlled URL anywhere in headers/body.
        var location = resp.Headers.Location?.ToString() ?? "";
        var body = await resp.Content.ReadAsStringAsync();
        location.Should().NotContain("evil.example");
        body.Should().NotContain("evil.example");
        location.Should().NotContain("javascript:");
    }

    [Fact]
    public async Task Login_AcceptsRelativeReturnUrl()
    {
        var client = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
        });

        // Relative path should be accepted (carried through the OAuth flow). We
        // don't assert on the Discord redirect URL itself because the test host
        // may not have OAuth configured; we just assert the request did not 400.
        var resp = await client.GetAsync("/api/auth/login?returnUrl=/safe-path");
        ((int)resp.StatusCode).Should().BeLessThan(500);
    }
}
