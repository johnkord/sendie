using Sendie.Server.Services;

namespace Sendie.Server.Tests.Services;

public class SessionServiceTests
{
    private readonly SessionService _sut;
    private const string TestUserId = "test-user-123";  // Test Discord user ID

    public SessionServiceTests()
    {
        _sut = new SessionService();
    }

    #region CreateSession Tests

    [Fact]
    public void CreateSession_ShouldReturnSessionWithValidId()
    {
        // Act
        var session = _sut.CreateSession(TestUserId);

        // Assert
        session.Should().NotBeNull();
        session.Id.Should().NotBeNullOrEmpty();
        // Session IDs are base64url-encoded GUIDs
        session.Id.Should().HaveLength(22);
    }

    [Fact]
    public void CreateSession_ShouldSetCorrectTimestamps()
    {
        // Arrange
        var beforeCreate = DateTime.UtcNow;

        // Act
        var session = _sut.CreateSession(TestUserId);

        // Assert
        var afterCreate = DateTime.UtcNow;

        session.CreatedAt.Should().BeOnOrAfter(beforeCreate);
        session.CreatedAt.Should().BeOnOrBefore(afterCreate);
        // Base TTL is 30 minutes
        session.ExpiresAt.Should().BeCloseTo(session.CreatedAt.AddMinutes(30), TimeSpan.FromSeconds(1));
        // Absolute max is 4 hours
        session.AbsoluteExpiresAt.Should().BeCloseTo(session.CreatedAt.AddHours(4), TimeSpan.FromSeconds(1));
    }

    [Fact]
    public void CreateSession_ShouldCreateUniqueSessions()
    {
        // Act
        var sessions = Enumerable.Range(0, 100)
            .Select(_ => _sut.CreateSession(TestUserId))
            .ToList();

        // Assert
        var uniqueIds = sessions.Select(s => s.Id).Distinct();
        uniqueIds.Should().HaveCount(100);
    }

    #endregion

    #region GetSession Tests

    [Fact]
    public void GetSession_WithValidId_ShouldReturnSession()
    {
        // Arrange
        var created = _sut.CreateSession(TestUserId);

        // Act
        var retrieved = _sut.GetSession(created.Id);

        // Assert
        retrieved.Should().NotBeNull();
        retrieved!.Id.Should().Be(created.Id);
    }

    [Fact]
    public void GetSession_WithInvalidId_ShouldReturnNull()
    {
        // Act
        var result = _sut.GetSession("nonexistent");

        // Assert
        result.Should().BeNull();
    }

    [Fact]
    public void GetSession_ShouldIncludePeerCount()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);
        _sut.AddPeerToSession(session.Id, "connection1");

        // Act
        var retrieved = _sut.GetSession(session.Id);

        // Assert
        retrieved!.PeerCount.Should().Be(1);
    }

    #endregion

    #region SessionExists Tests

    [Fact]
    public void SessionExists_WithValidSession_ShouldReturnTrue()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);

        // Act
        var exists = _sut.SessionExists(session.Id);

        // Assert
        exists.Should().BeTrue();
    }

    [Fact]
    public void SessionExists_WithInvalidSession_ShouldReturnFalse()
    {
        // Act
        var exists = _sut.SessionExists("nonexistent");

        // Assert
        exists.Should().BeFalse();
    }

    #endregion

    #region AddPeerToSession Tests

    [Fact]
    public void AddPeerToSession_WithValidSession_ShouldReturnPeer()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);

        // Act
        var peer = _sut.AddPeerToSession(session.Id, "connection1");

        // Assert
        peer.Should().NotBeNull();
        peer!.ConnectionId.Should().Be("connection1");
        peer.SessionId.Should().Be(session.Id);
    }

    [Fact]
    public void AddPeerToSession_FirstPeer_ShouldBeInitiator()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);

        // Act
        var peer = _sut.AddPeerToSession(session.Id, "connection1");

        // Assert
        peer!.IsInitiator.Should().BeTrue();
    }

    [Fact]
    public void AddPeerToSession_SecondPeer_ShouldNotBeInitiator()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);
        _sut.AddPeerToSession(session.Id, "connection1");

        // Act
        var peer = _sut.AddPeerToSession(session.Id, "connection2");

        // Assert
        peer!.IsInitiator.Should().BeFalse();
    }

    [Fact]
    public void AddPeerToSession_AtMaxPeers_ShouldReturnNull()
    {
        // Arrange - Create session with maxPeers=2 to test the limit
        var session = _sut.CreateSession(TestUserId, 2);
        _sut.AddPeerToSession(session.Id, "connection1");
        _sut.AddPeerToSession(session.Id, "connection2");

        // Act
        var peer = _sut.AddPeerToSession(session.Id, "connection3");

        // Assert
        peer.Should().BeNull();
    }

    [Fact]
    public void AddPeerToSession_WithDefaultMaxPeers_ShouldAllowFivePeers()
    {
        // Arrange - Default maxPeers is 5
        var session = _sut.CreateSession(TestUserId);
        _sut.AddPeerToSession(session.Id, "connection1");
        _sut.AddPeerToSession(session.Id, "connection2");
        _sut.AddPeerToSession(session.Id, "connection3");
        _sut.AddPeerToSession(session.Id, "connection4");

        // Act
        var peer = _sut.AddPeerToSession(session.Id, "connection5");

        // Assert
        peer.Should().NotBeNull();
    }

    [Fact]
    public void AddPeerToSession_BeyondDefaultMaxPeers_ShouldReturnNull()
    {
        // Arrange - Default maxPeers is 10
        var session = _sut.CreateSession(TestUserId);
        for (int i = 1; i <= 10; i++)
        {
            _sut.AddPeerToSession(session.Id, $"connection{i}");
        }

        // Act
        var peer = _sut.AddPeerToSession(session.Id, "connection11");

        // Assert
        peer.Should().BeNull();
    }

    [Fact]
    public void AddPeerToSession_WithInvalidSession_ShouldReturnNull()
    {
        // Act
        var peer = _sut.AddPeerToSession("nonexistent", "connection1");

        // Assert
        peer.Should().BeNull();
    }

    #endregion

    #region RemovePeerFromSession Tests

    [Fact]
    public void RemovePeerFromSession_ShouldRemovePeer()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);
        _sut.AddPeerToSession(session.Id, "connection1");

        // Act
        _sut.RemovePeerFromSession(session.Id, "connection1");

        // Assert
        var peers = _sut.GetPeersInSession(session.Id);
        peers.Should().BeEmpty();
    }

    [Fact]
    public void RemovePeerFromSession_ShouldAllowNewPeerToJoin()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);
        _sut.AddPeerToSession(session.Id, "connection1");
        _sut.AddPeerToSession(session.Id, "connection2");
        _sut.RemovePeerFromSession(session.Id, "connection1");

        // Act
        var peer = _sut.AddPeerToSession(session.Id, "connection3");

        // Assert
        peer.Should().NotBeNull();
    }

    #endregion

    #region GetPeersInSession Tests

    [Fact]
    public void GetPeersInSession_WithNoPeers_ShouldReturnEmptyList()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);

        // Act
        var peers = _sut.GetPeersInSession(session.Id);

        // Assert
        peers.Should().BeEmpty();
    }

    [Fact]
    public void GetPeersInSession_WithPeers_ShouldReturnAllPeers()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);
        _sut.AddPeerToSession(session.Id, "connection1");
        _sut.AddPeerToSession(session.Id, "connection2");

        // Act
        var peers = _sut.GetPeersInSession(session.Id);

        // Assert
        peers.Should().HaveCount(2);
        peers.Select(p => p.ConnectionId).Should().Contain("connection1");
        peers.Select(p => p.ConnectionId).Should().Contain("connection2");
    }

    [Fact]
    public void GetPeersInSession_WithInvalidSession_ShouldReturnEmptyList()
    {
        // Act
        var peers = _sut.GetPeersInSession("nonexistent");

        // Assert
        peers.Should().BeEmpty();
    }

    #endregion

    #region GetPeerByConnectionId Tests

    [Fact]
    public void GetPeerByConnectionId_WithValidId_ShouldReturnPeer()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);
        _sut.AddPeerToSession(session.Id, "connection1");

        // Act
        var peer = _sut.GetPeerByConnectionId("connection1");

        // Assert
        peer.Should().NotBeNull();
        peer!.ConnectionId.Should().Be("connection1");
    }

    [Fact]
    public void GetPeerByConnectionId_WithInvalidId_ShouldReturnNull()
    {
        // Act
        var peer = _sut.GetPeerByConnectionId("nonexistent");

        // Assert
        peer.Should().BeNull();
    }

    [Fact]
    public void GetPeerByConnectionId_AfterRemoval_ShouldReturnNull()
    {
        // Arrange
        var session = _sut.CreateSession(TestUserId);
        _sut.AddPeerToSession(session.Id, "connection1");
        _sut.RemovePeerFromSession(session.Id, "connection1");

        // Act
        var peer = _sut.GetPeerByConnectionId("connection1");

        // Assert
        peer.Should().BeNull();
    }

    #endregion
}
