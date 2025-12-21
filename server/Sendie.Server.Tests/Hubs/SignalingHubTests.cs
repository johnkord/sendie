using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Sendie.Server.Hubs;
using Sendie.Server.Services;
using Sendie.Server.Models;

namespace Sendie.Server.Tests.Hubs;

public class SignalingHubTests
{
    private readonly Mock<ISessionService> _sessionServiceMock;
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
        _loggerMock = new Mock<ILogger<SignalingHub>>();
        _clientsMock = new Mock<IHubCallerClients>();
        _groupsMock = new Mock<IGroupManager>();
        _contextMock = new Mock<HubCallerContext>();
        _clientProxyMock = new Mock<IClientProxy>();
        _othersProxyMock = new Mock<IClientProxy>();

        _contextMock.Setup(c => c.ConnectionId).Returns("test-connection-id");
        _clientsMock.Setup(c => c.Group(It.IsAny<string>())).Returns(_clientProxyMock.Object);
        _clientsMock.Setup(c => c.OthersInGroup(It.IsAny<string>())).Returns(_othersProxyMock.Object);

        _hub = new SignalingHub(_sessionServiceMock.Object, _loggerMock.Object)
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
        var sessionId = "test-session";
        var peer = new Peer("test-connection-id", sessionId, true);

        _sessionServiceMock
            .Setup(s => s.AddPeerToSession(sessionId, "test-connection-id"))
            .Returns(peer);

        _sessionServiceMock
            .Setup(s => s.GetPeersInSession(sessionId))
            .Returns(new List<Peer> { peer });

        // Act
        var result = await _hub.JoinSession(sessionId);

        // Assert
        var successProp = result.GetType().GetProperty("success");
        var isInitiatorProp = result.GetType().GetProperty("isInitiator");

        successProp.Should().NotBeNull();
        ((bool)successProp!.GetValue(result)!).Should().BeTrue();
        isInitiatorProp.Should().NotBeNull();
        ((bool)isInitiatorProp!.GetValue(result)!).Should().BeTrue();
    }

    [Fact]
    public async Task JoinSession_WithInvalidSession_ShouldReturnError()
    {
        // Arrange
        var sessionId = "invalid-session";

        _sessionServiceMock
            .Setup(s => s.AddPeerToSession(sessionId, It.IsAny<string>()))
            .Returns((Peer?)null);

        // Act
        var result = await _hub.JoinSession(sessionId);

        // Assert
        var successProp = result.GetType().GetProperty("success");
        successProp.Should().NotBeNull();
        ((bool)successProp!.GetValue(result)!).Should().BeFalse();
    }

    [Fact]
    public async Task JoinSession_ShouldAddToGroup()
    {
        // Arrange
        var sessionId = "test-session";
        var peer = new Peer("test-connection-id", sessionId, true);

        _sessionServiceMock
            .Setup(s => s.AddPeerToSession(sessionId, It.IsAny<string>()))
            .Returns(peer);

        _sessionServiceMock
            .Setup(s => s.GetPeersInSession(sessionId))
            .Returns(new List<Peer> { peer });

        // Act
        await _hub.JoinSession(sessionId);

        // Assert
        _groupsMock.Verify(
            g => g.AddToGroupAsync("test-connection-id", sessionId, default),
            Times.Once);
    }

    [Fact]
    public async Task JoinSession_ShouldNotifyOtherPeers()
    {
        // Arrange
        var sessionId = "test-session";
        var peer = new Peer("test-connection-id", sessionId, false);

        _sessionServiceMock
            .Setup(s => s.AddPeerToSession(sessionId, It.IsAny<string>()))
            .Returns(peer);

        _sessionServiceMock
            .Setup(s => s.GetPeersInSession(sessionId))
            .Returns(new List<Peer> { peer });

        // Act
        await _hub.JoinSession(sessionId);

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnPeerJoined",
                It.Is<object[]>(o => o[0].ToString() == "test-connection-id"),
                default),
            Times.Once);
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

    #region SendOffer Tests

    [Fact]
    public async Task SendOffer_WithValidPeer_ShouldBroadcastToGroup()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", true);
        var sdp = "test-sdp-offer";

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.SendOffer(sdp);

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnOffer",
                It.Is<object[]>(o => o[0].ToString() == "test-connection-id" && o[1].ToString() == sdp),
                default),
            Times.Once);
    }

    [Fact]
    public async Task SendOffer_WithNoPeer_ShouldNotBroadcast()
    {
        // Arrange
        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns((Peer?)null);

        // Act
        await _hub.SendOffer("test-sdp");

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync(It.IsAny<string>(), It.IsAny<object[]>(), default),
            Times.Never);
    }

    #endregion

    #region SendAnswer Tests

    [Fact]
    public async Task SendAnswer_WithValidPeer_ShouldBroadcastToGroup()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", false);
        var sdp = "test-sdp-answer";

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.SendAnswer(sdp);

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnAnswer",
                It.Is<object[]>(o => o[0].ToString() == "test-connection-id" && o[1].ToString() == sdp),
                default),
            Times.Once);
    }

    #endregion

    #region SendIceCandidate Tests

    [Fact]
    public async Task SendIceCandidate_WithValidPeer_ShouldBroadcastToGroup()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", true);
        var candidate = "test-candidate";
        var sdpMid = "0";
        var sdpMLineIndex = 0;

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.SendIceCandidate(candidate, sdpMid, sdpMLineIndex);

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnIceCandidate",
                It.Is<object[]>(o =>
                    o[0].ToString() == "test-connection-id" &&
                    o[1].ToString() == candidate &&
                    o[2].ToString() == sdpMid &&
                    (int)o[3] == sdpMLineIndex),
                default),
            Times.Once);
    }

    #endregion

    #region SendPublicKey Tests

    [Fact]
    public async Task SendPublicKey_WithValidPeer_ShouldBroadcastToGroup()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", true);
        var keyJwk = "{\"kty\":\"EC\",\"crv\":\"P-256\"}";

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.SendPublicKey(keyJwk);

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnPublicKey",
                It.Is<object[]>(o => o[0].ToString() == "test-connection-id" && o[1].ToString() == keyJwk),
                default),
            Times.Once);
    }

    #endregion

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

    #region SendFileMetadata Tests

    [Fact]
    public async Task SendFileMetadata_WithValidPeer_ShouldBroadcastToGroup()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", true);
        var fileId = "file-123";
        var fileName = "test.pdf";
        var fileSize = 1024L;
        var fileType = "application/pdf";

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.SendFileMetadata(fileId, fileName, fileSize, fileType);

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnFileMetadata",
                It.Is<object[]>(o =>
                    o[0].ToString() == "test-connection-id" &&
                    o[1].ToString() == fileId &&
                    o[2].ToString() == fileName &&
                    (long)o[3] == fileSize &&
                    o[4].ToString() == fileType),
                default),
            Times.Once);
    }

    #endregion

    #region AcceptFile Tests

    [Fact]
    public async Task AcceptFile_WithValidPeer_ShouldBroadcastToGroup()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", false);
        var fileId = "file-123";

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.AcceptFile(fileId);

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnFileAccepted",
                It.Is<object[]>(o => o[0].ToString() == "test-connection-id" && o[1].ToString() == fileId),
                default),
            Times.Once);
    }

    #endregion

    #region RejectFile Tests

    [Fact]
    public async Task RejectFile_WithValidPeer_ShouldBroadcastToGroup()
    {
        // Arrange
        var peer = new Peer("test-connection-id", "test-session", false);
        var fileId = "file-123";

        _sessionServiceMock
            .Setup(s => s.GetPeerByConnectionId("test-connection-id"))
            .Returns(peer);

        // Act
        await _hub.RejectFile(fileId);

        // Assert
        _othersProxyMock.Verify(
            p => p.SendCoreAsync("OnFileRejected",
                It.Is<object[]>(o => o[0].ToString() == "test-connection-id" && o[1].ToString() == fileId),
                default),
            Times.Once);
    }

    #endregion
}
