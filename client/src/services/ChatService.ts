import { multiPeerWebRTCService } from './MultiPeerWebRTCService';
import { useAppStore } from '../stores/appStore';

/**
 * In-memory chat for the current session. Owns:
 *   - the per-session list of messages (cleared on session leave)
 *   - the inbound rate limit so a malicious peer cannot flood the UI
 *   - send/broadcast over the dedicated 'chat' data channel
 *
 * Out of scope: persistence beyond the session, markdown rendering,
 * inline previews, search, reactions, typing indicators. All of those
 * are tracked in docs/realtime-av-and-rich-chat-proposal.md.
 *
 * The chat data channel is separate from the file-transfer channel so
 * a multi-MB transfer in flight does not delay typing.
 */

export interface ChatMessage {
  id: string;          // local-unique id
  ts: number;          // sender's send timestamp (Date.now())
  receivedAt: number;  // local clock when we received it
  peerId: string | 'self';
  body: string;
  // Friendly name resolved at receive time. Stored so renaming after the
  // fact (peer reconnects with a new ECDSA keypair) does not retroactively
  // change history.
  fromLabel: string;
}

interface WireMessage {
  type: 'chat';
  id: string;
  ts: number;
  body: string;
}

// Cap inbound messages per peer at 50/sec (sliding 1s window). Above the
// cap we drop. The threshold is generous enough for normal humans and
// strict enough to prevent a malicious peer from drowning the UI.
const RATE_LIMIT_MAX = 50;
const RATE_LIMIT_WINDOW_MS = 1000;

// Cap individual message bodies at 8 KiB. Bigger values get truncated on
// send and rejected on receive. If you need to share more than 8 KiB of
// text, send a file.
const MAX_MESSAGE_BYTES = 8 * 1024;

// Cap the in-memory message list. We never persist; this is just a cap on
// memory while a session is open.
const MAX_MESSAGES = 1000;

export type ChatEvents = {
  onMessage: (msg: ChatMessage) => void;
};

class ChatService {
  private events: Partial<ChatEvents> = {};
  private messages: ChatMessage[] = [];
  // Per-peer recent timestamps for the sliding-window rate limit.
  private inboundTimestamps: Map<string, number[]> = new Map();
  private nextId = 1;

  constructor() {
    multiPeerWebRTCService.on('onChatMessage', (peerId, raw) => {
      this.receive(peerId, raw);
    });
    multiPeerWebRTCService.on('onPeerDisconnected', (peerId) => {
      // Don't drop the peer's history; just stop accepting new messages
      // from them. inboundTimestamps for that peer are pruned next time
      // they reconnect.
      this.inboundTimestamps.delete(peerId);
    });
  }

  on<K extends keyof ChatEvents>(event: K, handler: ChatEvents[K]): void {
    this.events[event] = handler;
  }

  off<K extends keyof ChatEvents>(event: K): void {
    delete this.events[event];
  }

  /**
   * Snapshot of all chat messages for the current session. Order is
   * delivery order locally; if peers send concurrently the order between
   * them is best-effort (no global clock).
   */
  getMessages(): readonly ChatMessage[] {
    return this.messages;
  }

  /**
   * Send a chat message to every peer whose chat channel is open.
   * Returns the locally-recorded ChatMessage so the page can append it
   * to its render even if no peer received it yet.
   */
  send(body: string, selfLabel: string): ChatMessage | null {
    const trimmed = body.trim();
    if (!trimmed) return null;
    const truncated = trimmed.length > MAX_MESSAGE_BYTES
      ? trimmed.slice(0, MAX_MESSAGE_BYTES)
      : trimmed;

    const wire: WireMessage = {
      type: 'chat',
      id: `${Date.now()}-${this.nextId++}`,
      ts: Date.now(),
      body: truncated,
    };
    multiPeerWebRTCService.broadcastChat(JSON.stringify(wire));

    const msg: ChatMessage = {
      id: wire.id,
      ts: wire.ts,
      receivedAt: wire.ts,
      peerId: 'self',
      body: truncated,
      fromLabel: selfLabel,
    };
    this.appendMessage(msg);
    return msg;
  }

  /**
   * Clear all messages and per-peer rate state. Called on session leave.
   */
  reset(): void {
    this.messages = [];
    this.inboundTimestamps.clear();
  }

  // ---------------------------------------------------------------------

  private receive(peerId: string, raw: string): void {
    if (!this.allowInbound(peerId)) {
      // Silently drop. We don't surface a "you are being rate-limited"
      // message because that would be a free way for an attacker to fill
      // the UI with their own error messages.
      return;
    }

    let parsed: WireMessage;
    try {
      parsed = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }
    if (parsed.type !== 'chat') return;
    if (typeof parsed.body !== 'string') return;
    if (parsed.body.length > MAX_MESSAGE_BYTES) return;
    if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return;
    if (typeof parsed.id !== 'string' || parsed.id.length > 256) return;

    // Resolve the sender's friendly name at receive time. If we don't have
    // one yet (verification not complete), fall back to a short connection
    // ID prefix. The label is stored on the message so it survives the
    // peer changing keypairs later in the session.
    const peer = useAppStore.getState().peers.get(peerId);
    const fromLabel = peer?.friendlyName ?? `Peer ${peerId.substring(0, 8)}`;

    const msg: ChatMessage = {
      id: parsed.id,
      ts: parsed.ts,
      receivedAt: Date.now(),
      peerId,
      body: parsed.body,
      fromLabel,
    };
    this.appendMessage(msg);
  }

  private appendMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) {
      // Drop oldest. Cheap because Sendie sessions are bounded in length
      // anyway (24h hard cap with host present) and chat is bursty.
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
    this.events.onMessage?.(msg);
  }

  private allowInbound(peerId: string): boolean {
    const now = Date.now();
    const list = this.inboundTimestamps.get(peerId) ?? [];
    // Drop entries older than the window.
    const fresh = list.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length >= RATE_LIMIT_MAX) {
      this.inboundTimestamps.set(peerId, fresh);
      return false;
    }
    fresh.push(now);
    this.inboundTimestamps.set(peerId, fresh);
    return true;
  }
}

export const chatService = new ChatService();
