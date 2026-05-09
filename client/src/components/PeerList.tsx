import type { PeerConnectionState } from '../types';

interface PeerListProps {
  peers: Map<string, PeerConnectionState>;
  localFriendlyName?: string | null;
  onRemovePeer?: (peerId: string) => void;
  onKickPeer?: (peerId: string) => void;
  isHost?: boolean;
  hostConnectionId?: string | null;
}

const statusConfig: Record<PeerConnectionState['status'], { color: string; icon: string; label: string }> = {
  connecting: { color: 'text-yellow-400', icon: '◐', label: 'Connecting' },
  connected: { color: 'text-green-400', icon: '●', label: 'Connected' },
  disconnected: { color: 'text-gray-400', icon: '○', label: 'Disconnected' },
  failed: { color: 'text-red-400', icon: '✕', label: 'Failed' },
};

export function PeerList({ peers, localFriendlyName, onRemovePeer, onKickPeer, isHost, hostConnectionId }: PeerListProps) {
  const peerArray = Array.from(peers.entries());
  
  if (peerArray.length === 0 && !localFriendlyName) {
    return null;
  }

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4">
      {/* Local identity sits inline at the top of the same card so the
          peer list reads as "you, plus everyone else here" rather than
          "two stacked nested cards". */}
      {localFriendlyName && (
        <div className="mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs uppercase tracking-wide text-slate-500">You</span>
            <span className="text-base font-medium font-mono text-white">{localFriendlyName}</span>
            {isHost && (
              <span className="px-1.5 py-0.5 bg-amber-500/15 text-amber-300 text-xs rounded border border-amber-500/30 flex items-center gap-1">
                <span aria-hidden>👑</span><span>Host</span>
              </span>
            )}
          </div>
        </div>
      )}

      {peerArray.length > 0 && (
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Peers ({peerArray.filter(([_, p]) => p.status === 'connected').length}/{peerArray.length})
          </h3>
        </div>
      )}

      <div className="space-y-2">
        {peerArray.map(([peerId, state]) => {
          const config = statusConfig[state.status];
          const displayName = state.friendlyName || `Peer ${peerId.substring(0, 8)}`;
          const isPeerHost = peerId === hostConnectionId;

          return (
            <div
              key={peerId}
              className="flex items-center justify-between gap-2 p-2 bg-slate-800/40 rounded-lg border border-slate-700/30"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className={`text-base ${config.color}`} aria-hidden>{config.icon}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="text-sm text-white font-mono truncate">
                      {displayName}
                    </p>
                    {isPeerHost && (
                      <span className="px-1 py-0.5 bg-amber-500/15 text-amber-300 text-[10px] rounded border border-amber-500/30">
                        👑
                      </span>
                    )}
                    {state.voiceState?.sharing && (
                      <span
                        className={`text-sm ${state.voiceState.muted ? 'text-slate-400' : 'text-emerald-400'}`}
                        title={state.voiceState.muted ? 'Microphone muted' : 'Speaking'}
                      >
                        {state.voiceState.muted ? '🔇' : '🎙️'}
                      </span>
                    )}
                  </div>
                  <p className={`text-xs ${config.color}`}>
                    {config.label}
                    {state.dataChannelOpen && ' · Ready'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {state.sasCode && state.status === 'connected' && (
                  <div className="group relative">
                    <div className="px-1.5 py-0.5 bg-purple-500/10 rounded border border-purple-500/30 cursor-help">
                      <p className="text-[11px] text-purple-300 font-mono">{state.sasCode}</p>
                    </div>
                    <div className="absolute bottom-full right-0 mb-2 hidden group-hover:block w-56 p-2 bg-slate-950 rounded-lg shadow-xl border border-slate-700 z-10">
                      <p className="text-xs text-slate-300">
                        <strong className="text-purple-300">Security code</strong>: both of you should see this same code. Compare out-of-band (voice, in person) before sharing sensitive files.
                      </p>
                    </div>
                  </div>
                )}

                {isHost && onKickPeer && (
                  <button
                    onClick={() => onKickPeer(peerId)}
                    className="p-1 text-slate-400 hover:text-red-400 hover:bg-red-500/15 rounded transition-colors"
                    title="Kick from session"
                  >
                    🚫
                  </button>
                )}

                {onRemovePeer && (
                  <button
                    onClick={() => onRemovePeer(peerId)}
                    className="p-1 text-slate-400 hover:text-red-400 transition-colors"
                    title="Disconnect peer"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {peerArray.length === 0 && (
          <p className="text-xs text-slate-500 italic">Waiting for someone to join...</p>
        )}
      </div>
    </div>
  );
}
