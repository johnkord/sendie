# Sendie - P2P File Transfer & Watch Party

Secure, browser-based peer-to-peer file transfer, voice, screen-share, and synced video watch-parties using WebRTC.

## Features

### File transfer
- 🔒 **End-to-end encrypted** — WebRTC DTLS between browsers, with bound SAS-code identity verification (compare 4 words out of band) that defends against an active man-in-the-middle attack on the encrypted channel itself
- 👥 **Multi-peer mesh** — up to 10 people in a session, full peer-to-peer mesh, no relay
- 🚀 **No size limit** — files of any size, limited only by browser/device. Large incoming files write directly to disk via the File System Access API or StreamSaver fallback
- ⚡ **Direct P2P** — files never touch a server
- 📋 **File queue** — queue files before peers join; auto-send on connect
- 📡 **Broadcast mode** — auto-send queued files to every new peer who joins
- ✅ **Per-file consent** — recipients accept each incoming file by default; auto-receive is opt-in (default on)
- 👑 **Host controls** — lock the session, kick peers, restrict sending to host only

### Voice, camera, screen share
- 🎙️ **Voice chat** — push-to-talk or always-on, with mute toggles and per-peer audio meters
- 📷 **Camera** — share video with the room; per-peer mute and live previews
- 🖥️ **Screen share** — share an entire screen, a window, or a browser tab. Tab/system audio capture supported on Chromium-family browsers; encoder cap of 4 receivers to prevent thermal throttling

### Synced media playback (watch party)
- 🎬 **Watch together** — pick a video file as the host, Sendie sends the bytes to every peer over the existing data channel, then the room watches together with synced play, pause, seek, and playback rate
- ⏪⏩ **Skip 10s** — host buttons that propagate to every viewer
- 💾 **Resume position** — leave and return; "Resume at 47:18?" prompt
- 👋 **Late-joiner rewind** — host gets a "rewind for everyone?" toast when a late peer finishes receiving
- 📁 **Local-file mode** — alternative for rooms that already have the file on disk; skips the transfer

### Identity & access
- 🔐 **Allow-listed session creation** — only approved Discord accounts can host sessions
- 👤 **No account required to join** — recipients just need the session link
- 🔐 **Bound SAS verification** — the 4-word compare authenticates the encrypted channel, not just the keys

> **Note on Privacy vs Anonymity:** Sendie is privacy-focused (we can't see your files, voice, or video) but not anonymous (peers see each other's IPs because P2P requires it). Use a VPN with WebRTC leak protection if you need to hide your IP. Tor Browser won't work; it disables WebRTC. See [docs/what-is-sendie.md](docs/what-is-sendie.md) for the full picture.

## Quick Start

### Prerequisites

- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- [Node.js 18+](https://nodejs.org/)

### Setup

```bash
# Install all dependencies
# From VS Code: Run Task > setup

# Or manually:
cd server/Sendie.Server && dotnet restore
cd client && npm install
```

### Running Locally

**Option 1: VS Code Tasks**
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type "Tasks: Run Task"
3. Select "run-all"

**Option 2: VS Code Debug**
1. Go to Run and Debug (Ctrl+Shift+D)
2. Select "Launch Full Stack" from the dropdown
3. Press F5

**Option 3: Manual**

Terminal 1 (Server):
```bash
cd server/Sendie.Server
dotnet run
```

Terminal 2 (Client):
```bash
cd client
npm run dev
```

Open http://localhost:5173 in your browser.

## How It Works

1. **Create a Session** - Sign in with Discord (must be on the allow-list) and click "Create New Session"
2. **Queue Files (Optional)** - Drop files before anyone joins—they'll auto-send when someone connects
3. **Share the Link** - Send the session link to anyone you want to share files with
4. **Connect** - Recipients open the link and join instantly—no login required
5. **Transfer** - Files send automatically if queued, or drag and drop to send more

> **Tip:** Enable **Broadcast Mode** to automatically send your files to everyone who joins the session.

> **Note:** Creating a session requires an allow-listed Discord account, but joining a session only requires the link. Recipients don't need to log in or have a Discord account.

### Architecture

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│  Browser A  │◄───────►│  Browser B  │◄───────►│  Browser C  │
│   (Peer)    │         │   (Peer)    │         │   (Peer)    │
└──────┬──────┘         └─────────────┘         └──────┬──────┘
       │                       ▲                       │
       │    WebRTC DataChannel │ (Full Mesh)           │
       └───────────────────────┼───────────────────────┘
                               │
                     ┌─────────┴─────────┐
                     │  Signaling Server │
                     │   (C# / .NET 8)   │
                     └───────────────────┘
```

- **Server**: Only handles signaling (session setup, ICE candidates) and Discord OAuth
- **File data, voice, video, screen, watch-party**: All flow peer-to-peer over WebRTC; never touches the server
- **Encryption**: DTLS is automatic with WebRTC; bound SAS verification protects the channel itself
- **Topology**: Full mesh (each peer connects to all others). Practical max ~10 peers; voice / camera / watch-party-stream cap somewhere lower depending on host hardware

## Project Structure

```
sendie/
├── server/                 # C# Backend
│   └── Sendie.Server/
│       ├── Program.cs      # Entry point & API endpoints
│       ├── Hubs/           # SignalR hubs
│       ├── Services/       # Business logic
│       └── Models/         # Data models
├── client/                 # TypeScript Frontend
│   ├── src/
│   │   ├── components/     # React components
│   │   ├── services/       # WebRTC, Signaling, Crypto
│   │   ├── stores/         # Zustand state management
│   │   ├── pages/          # Route pages
│   │   └── types/          # TypeScript types
│   └── vite.config.ts
├── docs/                   # Documentation
└── .vscode/                # VS Code configuration
    ├── launch.json         # Debug configurations
    └── tasks.json          # Build/run tasks
```

## Technology Stack

### Backend (C#)
- .NET 8
- ASP.NET Core Minimal API
- SignalR for WebSocket communication

### Frontend (TypeScript)
- React 18
- Vite
- Tailwind CSS
- Zustand (state management)
- Web Crypto API

## Security

- **Transport Encryption**: WebRTC DataChannels use DTLS 1.2/1.3
- **Identity Verification**: ECDSA key exchange with SAS code comparison
- **No Data Storage**: Files never touch the server
- **Session Isolation**: Each session is independent and ephemeral

## License

MIT
