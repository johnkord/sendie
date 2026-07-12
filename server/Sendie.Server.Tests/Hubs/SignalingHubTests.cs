using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Sendie.Server.Hubs;
using Sendie.Server.Services;
using Sendie.Server.Models;

namespace Sendie.Server.Tests.Hubs;

public class SignalingHubTests
{
    private readonly Mock<ISessionService> _sessionServiceMock;
    private readonly Mock<IRateLimiterService> _rateLimiterMock;
    private readonly Mock<ILogger<SignalingHub>> _loggerMock;
    private readonly Mock<IHubCallerClients> _clientsMock;
    private readonly Mock<IGroupManager> _groupsMock;
    private readonly Mock<HubCallerContext> _contextMock;
    private readonly Mock<IClientProxy> _clientProxyMock;
    private readonly Mock<IClientProxy> _othersProxyMock;
    private readonly SignalingHub _hub;

    public SignalingHubTests()
    {
        _sessionServiceMock = new Mock<ISessionService>();
        _rateLimiterMock = new Mock<IRateLimiterService>();
        _loggerMock = new Mock<ILogger<SignalingHub>>();
        _clientsMock = new Mock<IHubCallerClients>();
        _groupsMock = new Mock<IGroupManager>();
        _contextMock = new Mock<HubCallerContext>();
        _clientProxyMock = new Mock<IClientProxy>();
        _othersProxyMock = new Mock<IClientProxy>();

        _contextMock.Setup(c => c.ConnectionId).Returns("test-connection-id");
        _clientsMock.Setup(c => c.Group(It.IsAny<string>())).Returns(_clientProxyMock.Object);
        _clientsMock.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(_othersProxyMock.Object);

        // Default: allow all rate limit checks
        _rateLimiterMock
            .Setup(r => r.IsAllowed(It.IsAny<string>(), It.IsAny<RateLimitPolicy>()))
            .Returns(RateLimitResult.Allowed(10));

        _hub = new SignalingHub(_sessionServiceMock.Object, _rateLimiterMock.Object, _loggerMock.Object)
        {
            Clients = _clientsMock.Object,
            Groups = _groupsMock.Object,
            Context = _contextMock.Object
        };
    }

    #region JoinSession Tests

    [Fact]
    public async Task JoinSession_WithValidSession_ShouldReturnSuccess()
    {
        // Arrange
        var sessionId = "abcdefghijklmnopqrstuv"; // 22 chars, base64url-shaped
        var peer = new Peer("test-connection-id", sessionId, true);

        _sessionServiceMock
            .Setup(s => s.ValidateSecret(sessionId, It.IsAny<string?>()))
            .Returns(true);
        _sessionServiceMock
            .Setup(s => s.AddPeerToSession(sessionId, "test-connection-id", It.IsAny<string?>()))
            .Returns(peer);

        _sessionServiceMock
            .Setup(s => s.GetPeersInSession(sessionId))
            .Returns(new List<Peer> { peer });
        _sessionServiceMock
            .Setup(s => s.GetMaxPeersForSession(sessionId))
            .Returns(7);

        // Act
        var result = await _hub.JoinSession(sessionId, "correct-secret");

        // Assert
        var successProp = result.GetType().GetProperty("success");
        var isInitiatorProp = result.GetType().GetProperty("isInitiator");
        var maxPeersProp = result.GetType().GetProperty("maxPeers");

        successProp.Should().NotBeNull();
        ((bool)successProp!.GetValue(result)!).Should().BeTrue();
        isInitiatorProp.Should().NotBeNull();
        ((bool)isInitiatorProp!.GetValue(result)!).Should().BeTrue();
        maxPeersProp.Should().NotBeNull();
        ((int)maxPeersProp!.GetValue(result)!).Should().Be(7);
    }

    [Fact]
    public async Task JoinSession_WithInvalidSession_ShouldReturnError()
    {
        // Arrange
        var sessionId = "abcdefghijklmnopqrstuv"; // valid format, just not in the service

        _sessionServiceMock
            .Setup(s => s.ValidateSecret(sessionId, It.IsAny<string?>()))
            .Returns(true);
        _sessionServiceMock
            .Setup(s => s.AddPeerToSession(sessionId, It.IsAny<string>(), It.IsAny<string?>()))
            .Returns((Peer?)null);

        // Act
        var result = await _hub.JoinSession(sessionId, "any-secret");

        // Assert
        var successProp = result.GetType().GetProperty("success");
        successProp.Should().NotBeNull();
        ((bool)successProp!.GetValue(result)!).Should().BeFalse();
    }

    [Fact]
    public async Task JoinSession_WithInvalidSecret_ShouldReturnError()
    {
        // Phase 6.1 (audit C4): the URL-fragment join secret is required.
        // A valid session ID without the matching secret must be rejected.
        var sessionId = "abcdefghijklmnopqrstuv";

        _sessionServiceMock
            .Setup(s => s.ValidateSecret(sessionId, It.IsAny<string?>()))
            .Returns(false);

        var result = await _hub.JoinSession(sessionId, "wrong-secret");
        var successProp = result.GetType().GetProperty("success");
        ((bool)successProp!.GetValue(result)!).Should().BeFalse();
        // Should not even attempt to add the peer when the secret is wrong.
        _sessionServiceMock.Verify(
            s => s.AddPeerToSession(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>()),
            Times.Never);
    }

    [Fact]
    public async Task JoinSession_ShouldAddToGroup()
    {
        // Arrange
        var sessionId = "abcdefghijklmnopqrstuv";
        var peer = new Peer("test-connection-id", sessionId, true);

        _sessionServiceMock
            .Setup(s => s.ValidateSecret(sessionId, It.IsAny<string?>()))
            .Returns(true);
        _sessionServiceMock
            .Setup(s => s.AddPeerToSession(sessionId, It.IsAny<string>(), It.IsAny<string?>()))
            .Returns(peer);

        _sessionServiceMock
            .Setup(s => s.GetPeersInSession(sessionId))
            .Returns(new List<Peer> { peer });

        // Act
        await _hub.JoinSession(sessionId, "secret");

        // Assert
        _groupsMock.Verify(
            g => g.AddToGroupAsync("test-connection-id", sessionId, default),
            Times.Once);
    }

    [Fact]
    public async Task JoinSession_ShouldNotifyOtherPeers()
    {
        // Arrange
        var sessionId = "abcdefghijklmnopqrstuv";
        var peer = new Peer("test-connection-id", sessionId, false);

        _sessionServiceMock
            .Setup(s => s.ValidateSecret(sessionId, It.IsAny<string?>()))
            .Returns(true);
        _sessionServiceMock
            .Setup(s => s.AddPeerToSession(sessionId, It.IsAny<string>(), It.IsAny<string?>()))
            .Returns(peer);

        _sessionServiceMock
            .Setup(s => s.GetPeersInSession(sessionId))
            .Returns(new List<Peer> { peer });

        // Act
        await _hub.JoinSession(sessionId, "secret");

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnPeerJoined",
                It.Is<object[]>(o => o[0].ToString() == "test-connection-id"),
                default),
            Times.Once);
    }

    [Fact]
    public async Task JoinSession_ShouldBroadcastAuthoritativeHostConnection()
    {
        var sessionId = "abcdefghijklmnopqrstuv";
        var peer = new Peer("test-connection-id", sessionId, false);
        _sessionServiceMock.Setup(s => s.ValidateSecret(sessionId, It.IsAny<string?>())).Returns(true);
        _sessionServiceMock
            .Setup(s => s.AddPeerToSession(sessionId, It.IsAny<string>(), It.IsAny<string?>()))
            .Returns(peer);
        _sessionServiceMock.Setup(s => s.GetPeersInSession(sessionId)).Returns([peer]);
        _sessionServiceMock.Setup(s => s.GetHostConnectionId(sessionId)).Returns("host-connection");

        await _hub.JoinSession(sessionId, "secret");

        _clientProxyMock.Verify(
            proxy => proxy.SendCoreAsync(
                "OnHostConnectionChanged",
                It.Is<object?[]>(args => (string?)args[0] == "host-connection"),
                default),
            Times.Once);
    }

    [Fact]
    public async Task JoinSession_WhenAlreadyMember_ShouldReconcileWithoutDuplicateJoin()
    {
        var sessionId = "abcdefghijklmnopqrstuv";
        var peer = new Peer("test-connection-id", sessionId, true);
        _sessionServiceMock.Setup(s => s.ValidateSecret(sessionId, It.IsAny<string?>())).Returns(true);
        _sessionServiceMock.Setup(s => s.GetPeerByConnectionId("test-connection-id")).Returns(peer);
        _sessionServiceMock.Setup(s => s.GetPeersInSession(sessionId)).Returns([peer]);

        var result = await _hub.JoinSession(sessionId, "secret");

        ((bool)result.GetType().GetProperty("success")!.GetValue(result)!).Should().BeTrue();
        _sessionServiceMock.Verify(
            s => s.AddPeerToSession(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>()),
            Times.Never);
        _othersProxyMock.Verify(
            proxy => proxy.SendCoreAsync("OnPeerJoined", It.IsAny<object?[]>(), default),
            Times.Never);
        _groupsMock.Verify(
            groups => groups.AddToGroupAsync("test-connection-id", sessionId, default),
            Times.Once);
    }

    [Fact]
    public async Task JoinSession_WhenAlreadyInAnotherSession_ShouldRejectWithoutAddingPeer()
    {
        var targetSessionId = "abcdefghijklmnopqrstuv";
        var currentPeer = new Peer("test-connection-id", "different-session", true);
        _sessionServiceMock
            .Setup(s => s.ValidateSecret(targetSessionId, It.IsAny<string?>()))
            .Returns(true);
        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(currentPeer);

        var result = await _hub.JoinSession(targetSessionId, "secret");

        ((bool)result.GetType().GetProperty("success")!.GetValue(result)!).Should().BeFalse();
        _sessionServiceMock.Verify(
            s => s.AddPeerToSession(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>()),
            Times.Never);
    }

    #endregion

    #region LeaveSession Tests

    [Fact]
    public async Task LeaveSession_WithValidPeer_ShouldRemoveFromSession()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", true);

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.LeaveSession();

        // Assert
        _sessionServiceMock.Verify(
            s => s.RemovePeerFromSession("test-session", "test-connection-id"),
            Times.Once);
    }

    [Fact]
    public async Task LeaveSession_ShouldRemoveFromGroup()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", true);

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.LeaveSession();

        // Assert
        _groupsMock.Verify(
            g => g.RemoveFromGroupAsync("test-connection-id", "test-session", default),
            Times.Once);
    }

    [Fact]
    public async Task LeaveSession_ShouldNotifyOtherPeers()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", true);

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.LeaveSession();

        // Assert
        _clientProxyMock.Verify(
            p => p.SendCoreAsync("OnPeerLeft",
                It.Is<object[]>(o => o[0].ToString() == "test-connection-id"),
                default),
            Times.Once);
    }

    #endregion

    // Note: tests for the broadcast variants SendOffer/SendAnswer/SendIceCandidate/SendPublicKey
    // were removed in the security audit Phase 0 cleanup. Those hub methods were never used by
    // the mesh client; only the targeted *To variants are kept and exercised by integration tests.

    #region SendSignature Tests

    [Fact]
    public async Task SendSignature_WithValidPeer_ShouldBroadcastToGroup()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", true);
        var signature = "test-signature";
        var challenge = "test-challenge";

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.SendSignature(signature, challenge);

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnSignature",
                It.Is<object[]>(o =>
                    o[0].ToString() == "test-connection-id" &&
                    o[1].ToString() == signature &&
                    o[2].ToString() == challenge),
                default),
            Times.Once);
    }

    #endregion
}
