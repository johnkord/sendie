# Sendie - P2P File Transfer

Secure, browser-based peer-to-peer file transfer using WebRTC.

## Features

- 🔒 **End-to-End Encrypted** - WebRTC DTLS between browsers, with SAS-code identity verification bound to the DTLS fingerprint to defend against an active man-in-the-middle
- 👥 **Multi-Peer Sessions** - Share files with up to 10 people simultaneously
- 🚀 **No Size Limits** - Transfer files of any size (limited only by browser/device)
- 👤 **No Account Required to Join** - Recipients just need the session link (no login)
- 🔐 **Allow-Listed Session Creation** - Only approved Discord accounts can create sessions
- ⚡ **Direct P2P** - Files transfer directly between browsers, never touch a server
- 🔐 **Identity Verification** - Bound SAS code (compare 4 words out-of-band) authenticates the encrypted channel itself, not just the keys exchanged through it
- 👑 **Host Controls** - Session creators can lock sessions, kick peers, and restrict sending (enforced on both sender and receiver)
- 📋 **File Queue** - Queue files before anyone joins, auto-send when they connect
- 📡 **Broadcast Mode** - Automatically send files to every new person who joins
- ✅ **Per-File Consent** - Recipients explicitly accept each incoming file by default; auto-receive is opt-in
- 📤 **Host-Only Sending** - Optionally restrict file sending to host only

> **Note on Privacy vs Anonymity:** Sendie is privacy-focused (we can't see your files) but not anonymous (peers see each other's IPs). Use a VPN with WebRTC leak protection if you need to hide your IP. Tor Browser won't work as it disables WebRTC. See [docs/what-is-sendie.md](docs/what-is-sendie.md) for details.

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

- **Server**: Only handles signaling (session setup, ICE candidates)
- **File Data**: Transfers directly between browsers via WebRTC
- **Encryption**: DTLS encryption is automatic with WebRTC
- **Topology**: Full mesh - each peer connects to all others (max ~10 peers)

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
