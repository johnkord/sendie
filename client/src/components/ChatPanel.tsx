import { useCallback, useEffect, useRef, useState } from 'react';
import { chatService, type ChatMessage } from '../services/ChatService';
import { useAppStore } from '../stores/appStore';

/**
 * Collapsible chat panel for the current session.
 *
 * Plain text only. We escape on render via React's text-node behavior; the
 * body is never set as innerHTML. Markdown / link previews / inline images
 * are explicitly out of scope for this round and tracked in the proposal.
 */
export function ChatPanel() {
  // Open by default. Users can collapse it; we remember the preference for
  // the lifetime of this tab via sessionStorage so a refresh keeps state.
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = sessionStorage.getItem('sendie.chat.open');
      return stored === null ? true : stored === '1';
    } catch {
      return true;
    }
  });
  const [messages, setMessages] = useState<readonly ChatMessage[]>(
    () => chatService.getMessages(),
  );
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const localFriendlyName = useAppStore(
    (s) => s.connection.localFriendlyName ?? 'You',
  );

  // Persist the open/closed preference per tab.
  useEffect(() => {
    try {
      sessionStorage.setItem('sendie.chat.open', open ? '1' : '0');
    } catch {
      // sessionStorage may be disabled in private browsing; fail silently.
    }
  }, [open]);

  useEffect(() => {
    chatService.on('onMessage', () => {
      setMessages([...chatService.getMessages()]);
      // If the panel is closed, bump the unread badge for inbound messages.
      // Self-messages always come in via send() so we can't tell from here;
      // the page below appends self via the same pathway, so just track
      // 'open' state.
      setUnread((u) => (open ? u : u + 1));
    });
    return () => {
      chatService.off('onMessage');
    };
  }, [open]);

  // Scroll to bottom whenever messages change AND panel is open.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // Reset unread when opening.
  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);

  const handleSend = useCallback(() => {
    const sent = chatService.send(draft, localFriendlyName);
    if (sent) {
      setMessages([...chatService.getMessages()]);
      setDraft('');
      // Refocus the input so the next message is one Tab away.
      inputRef.current?.focus();
    }
  }, [draft, localFriendlyName]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends, Shift+Enter inserts a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-900/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-white/5 transition-colors rounded-xl"
        title={open ? 'Hide chat' : 'Show chat'}
      >
        <div className="flex items-center gap-2">
          <span aria-hidden>💬</span>
          <span className="text-sm font-medium text-slate-200">Chat</span>
          {!open && unread > 0 && (
            <span className="px-1.5 py-0.5 text-xs font-medium bg-purple-500 text-white rounded-full">
              {unread}
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-slate-700/50 p-3">
          <div
            ref={scrollRef}
            className={`overflow-y-auto bg-slate-950/50 rounded p-2 space-y-1 text-sm ${
              messages.length === 0 ? 'h-32' : 'h-80'
            }`}
          >
            {messages.length === 0 ? (
              <p className="text-slate-500 text-center text-xs py-6">
                No messages yet. Say hi.
              </p>
            ) : (
              messages.map((m) => <MessageRow key={m.id} msg={m} />)
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message. Enter to send."
              className="flex-1 px-2 py-1.5 bg-slate-950/60 border border-slate-700 rounded text-sm text-white placeholder-slate-500 resize-none focus:border-purple-500 focus:outline-none"
              rows={1}
              maxLength={8192}
            />
            <button
              onClick={handleSend}
              disabled={!draft.trim()}
              className="px-3 py-1.5 rounded text-sm font-medium bg-purple-600 hover:bg-purple-700 disabled:bg-slate-800 disabled:cursor-not-allowed text-white transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageRow({ msg }: { msg: ChatMessage }) {
  const time = new Date(msg.ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const isSelf = msg.peerId === 'self';
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-2">
        <span
          className={`text-xs font-mono ${isSelf ? 'text-indigo-400' : 'text-purple-300'}`}
        >
          {msg.fromLabel}
        </span>
        <span className="text-[10px] text-gray-500">{time}</span>
      </div>
      {/* Plain text only. React renders text nodes; no innerHTML, no parsing. */}
      <p className="text-gray-100 whitespace-pre-wrap break-words">
        {msg.body}
      </p>
    </div>
  );
}
