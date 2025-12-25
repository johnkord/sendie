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
    <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
      {/* Show local user's identity prominently */}
      {localFriendlyName && (
        <div className="mb-4 p-3 bg-indigo-900/30 rounded-lg border border-indigo-500/30">
          <div className="flex items-center gap-2">
            <span className="text-indigo-400 text-sm">You are:</span>
            <span className="text-white font-medium font-mono text-lg">{localFriendlyName}</span>
            {isHost && (
              <span className="px-2 py-0.5 bg-yellow-600/20 text-yellow-400 text-xs rounded-full border border-yellow-600/30">
                👑 Host
              </span>
            )}
          </div>
          <p className="text-xs text-indigo-300/70 mt-1">
            Share this name with others so they know who you are
          </p>
        </div>
      )}

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-300">
          {peerArray.length > 0 ? (
            <>Peers ({peerArray.filter(([_, p]) => p.status === 'connected').length}/{peerArray.length})</>
          ) : (
            <>Waiting for peers...</>
          )}
        </h3>
      </div>
      
      <div className="space-y-2">
        {peerArray.map(([peerId, state]) => {
          const config = statusConfig[state.status];
          const displayName = state.friendlyName || `Peer ${peerId.substring(0, 8)}`;
          const isPeerHost = peerId === hostConnectionId;
          
          return (
            <div 
              key={peerId}
              className="flex items-center justify-between p-2 bg-gray-700/50 rounded-lg"
            >
              <div className="flex items-center gap-3">
                <span className={`text-lg ${config.color}`}>{config.icon}</span>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm text-white font-mono">
                      {displayName}
                    </p>
                    {isPeerHost && (
                      <span className="px-1.5 py-0.5 bg-yellow-600/20 text-yellow-400 text-xs rounded border border-yellow-600/30">
                        👑 Host
                      </span>
                    )}
                  </div>
                  <p className={`text-xs ${config.color}`}>
                    {config.label}
                    {state.dataChannelOpen && ' • Ready to transfer'}
                  </p>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                {state.sasCode && state.status === 'connected' && (
                  <div className="group relative">
                    <div className="px-2 py-1 bg-purple-900/30 rounded border border-purple-500/30 cursor-help">
                      <p className="text-xs text-purple-300 font-mono">{state.sasCode}</p>
                    </div>
                    <div className="absolute bottom-full right-0 mb-2 hidden group-hover:block w-48 p-2 bg-gray-900 rounded-lg shadow-xl border border-gray-700 z-10">
                      <p className="text-xs text-gray-300">
                        <strong className="text-purple-300">Security code</strong>: Both of you should see this same code. If it doesn't match, don't transfer sensitive files.
                      </p>
                    </div>
                  </div>
                )}
                
                {/* Kick button (host only, can't kick yourself) */}
                {isHost && onKickPeer && (
                  <button
                    onClick={() => onKickPeer(peerId)}
                    className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-600/20 rounded transition-colors"
                    title="Kick from session"
                  >
                    🚫
                  </button>
                )}
                
                {onRemovePeer && (
                  <button
                    onClick={() => onRemovePeer(peerId)}
                    className="p-1 text-gray-400 hover:text-red-400 transition-colors"
                    title="Disconnect peer"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
