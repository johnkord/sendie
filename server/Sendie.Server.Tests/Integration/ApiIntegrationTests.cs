using Microsoft.AspNetCore.Mvc.Testing;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Sendie.Server.Tests.Integration;

public class ApiIntegrationTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    private readonly HttpClient _client;

    public ApiIntegrationTests(WebApplicationFactory<Program> factory)
    {
        _factory = factory;
        _client = _factory.CreateClient();
    }

    #region Health Endpoint Tests

    [Fact]
    public async Task GetHealth_ShouldReturnOk()
    {
        // Act
        var response = await _client.GetAsync("/api/health");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GetHealth_ShouldReturnHealthyStatus()
    {
        // Act
        var response = await _client.GetAsync("/api/health");
        var content = await response.Content.ReadFromJsonAsync<JsonElement>();

        // Assert
        content.GetProperty("status").GetString().Should().Be("healthy");
        content.TryGetProperty("timestamp", out _).Should().BeTrue();
    }

    #endregion

    #region ICE Servers Endpoint Tests

    [Fact]
    public async Task GetIceServers_ShouldReturnOk()
    {
        // Act
        var response = await _client.GetAsync("/api/ice-servers");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GetIceServers_ShouldReturnArray()
    {
        // Act
        var response = await _client.GetAsync("/api/ice-servers");
        var content = await response.Content.ReadFromJsonAsync<JsonElement[]>();

        // Assert
        content.Should().NotBeNull();
        content!.Length.Should().BeGreaterThan(0);
    }

    [Fact]
    public async Task GetIceServers_ShouldContainStunServers()
    {
        // Act
        var response = await _client.GetAsync("/api/ice-servers");
        var content = await response.Content.ReadAsStringAsync();

        // Assert
        content.Should().Contain("stun:");
    }

    #endregion

    #region Sessions Endpoint Tests

    [Fact]
    public async Task CreateSession_ShouldReturnOk()
    {
        // Act
        var response = await _client.PostAsync("/api/sessions", null);

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task CreateSession_ShouldReturnSessionWithId()
    {
        // Act
        var response = await _client.PostAsync("/api/sessions", null);
        var content = await response.Content.ReadFromJsonAsync<JsonElement>();

        // Assert
        content.TryGetProperty("id", out var id).Should().BeTrue();
        id.GetString().Should().NotBeNullOrEmpty();
        id.GetString()!.Length.Should().Be(8);
    }

    [Fact]
    public async Task CreateSession_ShouldReturnSessionWithTimestamps()
    {
        // Act
        var response = await _client.PostAsync("/api/sessions", null);
        var content = await response.Content.ReadFromJsonAsync<JsonElement>();

        // Assert
        content.TryGetProperty("createdAt", out _).Should().BeTrue();
        content.TryGetProperty("expiresAt", out _).Should().BeTrue();
    }

    [Fact]
    public async Task GetSession_WithValidId_ShouldReturnOk()
    {
        // Arrange
        var createResponse = await _client.PostAsync("/api/sessions", null);
        var session = await createResponse.Content.ReadFromJsonAsync<JsonElement>();
        var sessionId = session.GetProperty("id").GetString();

        // Act
        var response = await _client.GetAsync($"/api/sessions/{sessionId}");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GetSession_WithValidId_ShouldReturnSessionDetails()
    {
        // Arrange
        var createResponse = await _client.PostAsync("/api/sessions", null);
        var createdSession = await createResponse.Content.ReadFromJsonAsync<JsonElement>();
        var sessionId = createdSession.GetProperty("id").GetString();

        // Act
        var response = await _client.GetAsync($"/api/sessions/{sessionId}");
        var session = await response.Content.ReadFromJsonAsync<JsonElement>();

        // Assert
        session.GetProperty("id").GetString().Should().Be(sessionId);
        session.GetProperty("peerCount").GetInt32().Should().Be(0);
    }

    [Fact]
    public async Task GetSession_WithInvalidId_ShouldReturnNotFound()
    {
        // Act
        var response = await _client.GetAsync("/api/sessions/nonexistent");

        // Assert
        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task CreateMultipleSessions_ShouldReturnUniqueIds()
    {
        // Arrange
        var sessionIds = new List<string>();

        // Act
        for (int i = 0; i < 10; i++)
        {
            var response = await _client.PostAsync("/api/sessions", null);
            var session = await response.Content.ReadFromJsonAsync<JsonElement>();
            sessionIds.Add(session.GetProperty("id").GetString()!);
        }

        // Assert
        sessionIds.Distinct().Should().HaveCount(10);
    }

    #endregion
}
