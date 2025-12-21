Peer-to-Peer Connection Setup and NAT Traversal

Establishing a peer-to-peer link on the web requires dealing with NAT (Network Address Translation) and firewalls in a user-friendly way. WebRTC handles this through a process called Interactive Connectivity Establishment (ICE). During ICE negotiation, the peers gather candidate network addresses (private and public) and exchange them via the signaling channel. A STUN server is used at this stage to find out each peer’s public IP and port (the “NAT traversal” trick)
telnyx.com
. In essence, STUN asks “what is my IP as seen from the internet?” so the browser can tell its peer how to reach it. If both peers can reach each other directly (e.g. at least one is on a public IP or their NATs allow hole punching), they will establish a direct UDP connection.

If direct connection fails due to very restrictive NATs or firewalls, the system can fall back to a TURN relay. A TURN server is essentially a lightweight relay that forwards data between the peers. Using a TURN server does introduce an intermediary for the data, but it’s only a router for the encrypted packets, not a store-and-forward server – the data still isn’t decrypted or stored. In most cases (with typical home or office NATs), WebRTC can achieve a direct P2P path using ICE+STUN, so the TURN relay is only a backup
telnyx.com
. The end result is that the two browsers get a viable network path between them without the users needing to manually configure anything. They do not need to exchange IP addresses themselves or open ports on their routers – WebRTC handles all of that under the hood.

It’s worth noting that the initial coordination (signaling) can be done by the website over a secure WebSocket or any server-side channel. This signaling server is not involved in the file transfer itself; it only carries session setup messages (offers, answers, ICE candidates, etc.)
stackoverflow.com
. As long as the signaling is done over HTTPS/WSS, the exchange of connection details is secure from eavesdroppers. After that, the actual file data flows over the direct channel between peers. This architecture greatly reduces any burden on the server – since files aren’t routed through it, the server’s bandwidth usage stays low and it never sees the files’ content.

End-to-End Encryption and Security

One of the major advantages of using WebRTC is that encryption is built-in by default. All WebRTC peer connections use DTLS (Datagram Transport Layer Security) for securing data channels, and SRTP for media streams. In practice, this means the file data is automatically encrypted on one end and decrypted on the other, with a secure key exchange happening during the WebRTC handshake. According to documentation, every WebRTC session is encrypted using industry-standard protocols; for data channels specifically, it uses DTLS to ensure confidentiality and integrity
telnyx.com
. In the case of our file-transfer application, this means as soon as the peers connect, they have a tunnel that is already protected against eavesdropping. Even if someone intercepts the traffic (or if a TURN relay is used), all they would see is encrypted gibberish.

For additional assurance, the application can allow (or force) the peers to perform an identity check once the connection is established. By exchanging public keys and verifying signatures, users can be confident that no third party has hijacked the session. For example, when each user shares their public key and then provides a digital signature (using their private key) on a known piece of data (such as a random challenge or the other party’s public key), the other side can validate this signature. A correct signature proves that the sender owns the corresponding private key, confirming their identity (at least in the context of this session). This process is essentially a simplified public-key authentication. It’s ad hoc in the sense that it doesn’t rely on a certificate authority or prior accounts – it’s a direct exchange between the two users for that session.

Because our scenario doesn’t involve pre-existing user accounts or a web-of-trust, the verification is limited to the session itself. In other words, it proves “this is the same person who began the session with you and possesses the key they originally shared,” not necessarily a real-world identity. However, it does thwart man-in-the-middle (MITM) attempts in which an attacker or malicious server might try to pose as one of the peers. If an attacker injected their own key during signaling, they would fail to produce a valid signature corresponding to the legitimate user’s key, alerting the users. For a friendly user-experience, we can use the Short Authentication String method mentioned earlier: both browsers can derive a short hash from the agreed encryption key and display it (for example, a 4-word or 4-hex-block code). The users can quickly compare these codes (via a phone call or any trusted channel); matching codes mean the connection is genuine and untampered
dev.to
dev.to
. This human verification step is simple but powerful – it’s been used in secure messengers to detect MITM attacks. In summary, with WebRTC’s strong encryption in transit and an added signature check or SAS verification, the session can be truly end-to-end secure, with the site merely brokering the introduction.

Transferring Large Files Efficiently

The solution is designed to handle files of essentially any size, limited only by the users’ environment (device capabilities and network bandwidth). Since files aren’t uploaded to a server at all, there’s no fixed size cap or cloud storage limit to worry about. As the FilePizza project confirms, a file can be “as big as your browser can handle” when using P2P WebRTC transfer
github.com
. In practice, sending a multi-gigabyte or even terabyte-scale file is possible, though it may take a long time depending on the connection speed of the two peers. Both the sender and receiver would need to keep their browsers open for the duration of the transfer (if the sender closes the page, the transfer halts)
github.com
. The web app can provide an indication of progress and perhaps an estimate of time, so users know to leave the window open.

Under the hood, the file can be split into smaller chunks or streamed in parts. This is important because it would be inefficient or impossible to load an entire 1 TB file into memory. Instead, the application can read the file in segments (using the HTML5 File API or streams) and send each chunk over the data channel sequentially. The WebRTC data channel ensures reliable delivery (it can be configured to be reliable like TCP), so chunks will arrive intact and in order, or be retransmitted if lost. The receiver’s side can append incoming chunks to a local Blob or write to the filesystem (e.g. using the File System Access API) incrementally. By pipeline streaming, memory usage stays manageable and the transfer can handle very large files.

One consideration is error recovery for very large transfers: if the connection drops mid-way (due to network issues or a browser crash), the simplest approach is to restart the session and perhaps resume from scratch. A more advanced implementation could implement a resumable transfer – for instance, by checkpointing which chunks were received and restarting from the last checkpoint. This would require some bookkeeping (maybe an MD5/SHA-256 for each chunk to verify integrity). However, initially, a simpler approach is fine if both users coordinate to re-send as needed.

Because the transport is P2P, transfer speeds will depend on the users’ upload/download bandwidth. In many cases, this can be faster than uploading to a cloud then downloading, especially if both users are on the same network (WebRTC can even work for LAN transfers with very high speeds). But even over the internet, this direct path can be efficient. Additionally, there’s no server-side throttling – the site isn’t a bottleneck since it’s not relaying the file. This is why FilePizza advertises cutting out the “middle-man layer” to achieve faster, more private file sharing
medium.com
.

Peer-to-Peer Connection Setup and NAT Traversal

Establishing a peer-to-peer link on the web requires dealing with NAT (Network Address Translation) and firewalls in a user-friendly way. WebRTC handles this through a process called Interactive Connectivity Establishment (ICE). During ICE negotiation, the peers gather candidate network addresses (private and public) and exchange them via the signaling channel. A STUN server is used at this stage to find out each peer’s public IP and port (the “NAT traversal” trick)
telnyx.com
. In essence, STUN asks “what is my IP as seen from the internet?” so the browser can tell its peer how to reach it. If both peers can reach each other directly (e.g. at least one is on a public IP or their NATs allow hole punching), they will establish a direct UDP connection.

If direct connection fails due to very restrictive NATs or firewalls, the system can fall back to a TURN relay. A TURN server is essentially a lightweight relay that forwards data between the peers. Using a TURN server does introduce an intermediary for the data, but it’s only a router for the encrypted packets, not a store-and-forward server – the data still isn’t decrypted or stored. In most cases (with typical home or office NATs), WebRTC can achieve a direct P2P path using ICE+STUN, so the TURN relay is only a backup
telnyx.com
. The end result is that the two browsers get a viable network path between them without the users needing to manually configure anything. They do not need to exchange IP addresses themselves or open ports on their routers – WebRTC handles all of that under the hood.

It’s worth noting that the initial coordination (signaling) can be done by the website over a secure WebSocket or any server-side channel. This signaling server is not involved in the file transfer itself; it only carries session setup messages (offers, answers, ICE candidates, etc.)
stackoverflow.com
. As long as the signaling is done over HTTPS/WSS, the exchange of connection details is secure from eavesdroppers. After that, the actual file data flows over the direct channel between peers. This architecture greatly reduces any burden on the server – since files aren’t routed through it, the server’s bandwidth usage stays low and it never sees the files’ content.

End-to-End Encryption and Security

One of the major advantages of using WebRTC is that encryption is built-in by default. All WebRTC peer connections use DTLS (Datagram Transport Layer Security) for securing data channels, and SRTP for media streams. In practice, this means the file data is automatically encrypted on one end and decrypted on the other, with a secure key exchange happening during the WebRTC handshake. According to documentation, every WebRTC session is encrypted using industry-standard protocols; for data channels specifically, it uses DTLS to ensure confidentiality and integrity
telnyx.com
. In the case of our file-transfer application, this means as soon as the peers connect, they have a tunnel that is already protected against eavesdropping. Even if someone intercepts the traffic (or if a TURN relay is used), all they would see is encrypted gibberish.

For additional assurance, the application can allow (or force) the peers to perform an identity check once the connection is established. By exchanging public keys and verifying signatures, users can be confident that no third party has hijacked the session. For example, when each user shares their public key and then provides a digital signature (using their private key) on a known piece of data (such as a random challenge or the other party’s public key), the other side can validate this signature. A correct signature proves that the sender owns the corresponding private key, confirming their identity (at least in the context of this session). This process is essentially a simplified public-key authentication. It’s ad hoc in the sense that it doesn’t rely on a certificate authority or prior accounts – it’s a direct exchange between the two users for that session.

Because our scenario doesn’t involve pre-existing user accounts or a web-of-trust, the verification is limited to the session itself. In other words, it proves “this is the same person who began the session with you and possesses the key they originally shared,” not necessarily a real-world identity. However, it does thwart man-in-the-middle (MITM) attempts in which an attacker or malicious server might try to pose as one of the peers. If an attacker injected their own key during signaling, they would fail to produce a valid signature corresponding to the legitimate user’s key, alerting the users. For a friendly user-experience, we can use the Short Authentication String method mentioned earlier: both browsers can derive a short hash from the agreed encryption key and display it (for example, a 4-word or 4-hex-block code). The users can quickly compare these codes (via a phone call or any trusted channel); matching codes mean the connection is genuine and untampered
dev.to
dev.to
. This human verification step is simple but powerful – it’s been used in secure messengers to detect MITM attacks. In summary, with WebRTC’s strong encryption in transit and an added signature check or SAS verification, the session can be truly end-to-end secure, with the site merely brokering the introduction.

Transferring Large Files Efficiently

The solution is designed to handle files of essentially any size, limited only by the users’ environment (device capabilities and network bandwidth). Since files aren’t uploaded to a server at all, there’s no fixed size cap or cloud storage limit to worry about. As the FilePizza project confirms, a file can be “as big as your browser can handle” when using P2P WebRTC transfer
github.com
. In practice, sending a multi-gigabyte or even terabyte-scale file is possible, though it may take a long time depending on the connection speed of the two peers. Both the sender and receiver would need to keep their browsers open for the duration of the transfer (if the sender closes the page, the transfer halts)
github.com
. The web app can provide an indication of progress and perhaps an estimate of time, so users know to leave the window open.

Under the hood, the file can be split into smaller chunks or streamed in parts. This is important because it would be inefficient or impossible to load an entire 1 TB file into memory. Instead, the application can read the file in segments (using the HTML5 File API or streams) and send each chunk over the data channel sequentially. The WebRTC data channel ensures reliable delivery (it can be configured to be reliable like TCP), so chunks will arrive intact and in order, or be retransmitted if lost. The receiver’s side can append incoming chunks to a local Blob or write to the filesystem (e.g. using the File System Access API) incrementally. By pipeline streaming, memory usage stays manageable and the transfer can handle very large files.

One consideration is error recovery for very large transfers: if the connection drops mid-way (due to network issues or a browser crash), the simplest approach is to restart the session and perhaps resume from scratch. A more advanced implementation could implement a resumable transfer – for instance, by checkpointing which chunks were received and restarting from the last checkpoint. This would require some bookkeeping (maybe an MD5/SHA-256 for each chunk to verify integrity). However, initially, a simpler approach is fine if both users coordinate to re-send as needed.

Because the transport is P2P, transfer speeds will depend on the users’ upload/download bandwidth. In many cases, this can be faster than uploading to a cloud then downloading, especially if both users are on the same network (WebRTC can even work for LAN transfers with very high speeds). But even over the internet, this direct path can be efficient. Additionally, there’s no server-side throttling – the site isn’t a bottleneck since it’s not relaying the file. This is why FilePizza advertises cutting out the “middle-man layer” to achieve faster, more private file sharing
medium.com
.

Verifying Key Ownership with Digital Signatures

To address the specific idea of having each person prove they own a public key: this can be achieved with a straightforward digital signature exchange as part of the session handshake. Here’s how it could work in our web app:

When a user joins the session, the app generates a new public/private key pair in the browser (for example, using the Web Cryptography API with an asymmetric algorithm like ECDSA or RSA). This is an ephemeral key pair just for this session. The public key is shared with the other peer (likely through the signaling channel or over the newly established data channel once ready).

Once each side has the other’s public key, the app has each user sign a piece of data with their private key. The data to sign could be chosen in various ways – a good choice is a random challenge string or a combination of both participants’ public keys and session ID (ensuring it’s unique to this session). For example, User A signs a message that says “I am A, here’s a random nonce N” and User B does similarly.

The signatures are then sent to the opposite peer. Using the previously received public key, each client verifies the signature it got from the other. A valid signature proves that the sender controls the private key corresponding to the public key they provided.

If the verification succeeds for both sides, they have mutual assurance that the peer on the other end is authentic (i.e. not an impostor), at least with respect to the keys that were exchanged. This fulfills the requirement of proving ownership of a public key.

If either signature check fails, the application would warn the users and abort the connection, since it indicates a possible MITM (someone in the middle might have tried to insert their own key that they don’t actually have a private key for, or there was data corruption).

This kind of ad hoc verification is simple but effective. It doesn’t require a central authority or login account; it’s just a direct cryptographic challenge. Keep in mind, however, that this verifies the connection integrity after the keys are exchanged. If the signaling process was compromised and a malicious party substituted their own public keys in transit, a naive implementation would have each peer verifying the attacker’s key (which the attacker can of course sign for, since it’s their key). In that scenario, the check would pass even though a MITM attack is happening. To counter that, we tie this step in with the earlier suggestions: use a secure signaling channel and/or have users compare a short fingerprint of the keys (SAS code) out-of-band. In practice, if the initial session link is shared over HTTPS and not publicly broadcast, the likelihood of a MITM is low, but it’s still best to include a verification mechanism. The SAS comparison is essentially a user-friendly version of cross-checking the public keys – it lets users confirm that the key each browser sees is identical, by confirming a short hash
dev.to
dev.to
. Thus, between the digital signatures and an optional SAS code confirmation, the users can be confident that each party is who they say they are (within the context of the session) and that the connection is secure end-to-end.

Existing Solutions and Technologies

Encouragingly, the approach described above isn’t just theoretical – there are existing open-source solutions that use similar methods:

ShareDrop – a web app for P2P file sharing inspired by Apple AirDrop. ShareDrop uses WebRTC data channels for transferring files directly and employs a simple signaling mechanism (originally using Firebase) to connect peers. The file data never touches any server; all transfers are encrypted and go straight between browsers
sharedrop.io
. ShareDrop shows that even in a local network or across the internet, two users can share files via browser with minimal setup. (One limitation noted is that ShareDrop might not work if both users are on certain VPNs or behind very restrictive NATs, unless a TURN server is available.)

FilePizza – another browser-based P2P file transfer tool. FilePizza famously lets you “drop a file and get a link” which you send to your peer; when they open that link, the WebRTC connection is established and the file streams directly from your browser to theirs
medium.com
. According to the FilePizza documentation, it eliminates the need for any intermediate server storage by using WebRTC, making the transfer fast and private
github.com
. The FilePizza backend acts only as a signaling service and tracker. In fact, FilePizza supports multiple recipients by having the original sender seed the file to several peers (much like a mini BitTorrent swarm, but all in browser)
github.com
. Its FAQ also confirms that there’s no built-in file size limit – the constraint is essentially your machine’s capability and the browser’s stability
github.com
. Additionally, all communication is encrypted via DTLS, as with any WebRTC app
github.com
. FilePizza’s codebase (which uses a library called PeerJS for managing WebRTC) could serve as a great reference implementation.

WebTorrent – this is a library/protocol that brings torrent-style file sharing to the web using WebRTC. While not exactly a two-person direct transfer (it’s more for swarm distribution), it’s another proof that large files (even multi-GB videos, etc.) can be shared P2P over browsers. WebTorrent uses WebRTC data channels under the hood to exchange torrent pieces between peers. For your use-case of one-to-one or few-to-few transfers, a simpler direct WebRTC connection (as in ShareDrop or FilePizza) is sufficient, but it’s good to know that WebRTC has been pushed to support large data transfers in projects like this as well.

Magic Wormhole & Others – outside the browser context, there are tools like Magic Wormhole (CLI tool for P2P file transfer with PAKE encryption) and OnionShare (which uses Tor for peer-to-peer file sharing via a temporary onion service). These aren’t web-based, but they tackle similar goals of secure direct transfer. The ideas from them – like using a short code to connect two parties in Magic Wormhole – could inspire the UX for the web app (for instance, generating a one-time code or link that the second user enters to join the session).

In building your solution, you won’t have to start from scratch. You can utilize WebRTC APIs directly or use helper libraries. For example, SimplePeer and PeerJS are popular JavaScript libraries that abstract some of the WebRTC setup complexities (signaling, ICE config) and let you focus on sending data. On the signaling side, you could use WebSockets on your own server, or even a serverless approach (some apps use Firebase/Firestore or WebRTC’s DataChannel in a bootstrapping mode). The signaling messages are small (a few kilobytes at most), so any lightweight method works.

Security-wise, the default WebRTC encryption is robust (DTLS is the same strength as HTTPS). If you implement the additional public key signature step, you might use the SubtleCrypto API in browsers for generating keys and signing/verifying. Ensure you use a well-vetted algorithm (e.g., ECDSA with P-256 or RSA-2048) and handle the keys carefully (they can be ephemeral, stored just in memory).

Lastly, if a purely web-based approach runs into limitations, a native application could be an alternative. A native app could use direct socket libraries or frameworks like libp2p, and might handle extremely large files or long-running transfers with more ease (since a browser might impose some overhead or timeouts). However, given the maturity of WebRTC, a web solution is advantageous: users don’t need to install anything, and modern browsers are optimized for long-lived WebRTC connections (for example, many video calls last hours, carrying data continuously). Therefore, building this as a web app should be quite feasible and is likely the best route initially.

Conclusion

In summary, yes – it is entirely possible to create a website that connects users for direct, encrypted file sharing without the files ever touching the server. The recommended approach is to use WebRTC peer-to-peer data channels. The site would act only as a meeting point (signaling the peers to find each other), and from then on the browsers negotiate a direct connection that is NAT-friendly (using ICE/STUN/TURN) and securely encrypted end-to-end with DTLS. Once connected, the users can exchange their own public keys or short verification codes to ensure the connection hasn’t been compromised, providing an extra layer of trust on top of the encryption
dev.to
dev.to
. File transfers occur directly over this channel, meaning you can send any file type of any size – even enormous files – as long as the sender and receiver have the bandwidth and time to complete the transfer
github.com
. This P2P design has been validated by existing applications (e.g. ShareDrop, FilePizza), which show that even through the browser you can achieve fast, private file sharing with no cloud storage involved
github.com
. By following a similar architecture – WebRTC for transport, secure signaling, and simple key verification – you can build a solution that meets all the requirements: no user logins needed, no IP addresses to manage, no firewall headaches for users, and end-to-end encrypted transfers that keep data between the participants only. It’s a modern, user-friendly way to send files, cutting out the middleman and keeping control in the hands of the users themselves
medium.com
.