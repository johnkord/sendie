import type { PeerConnectionState } from '../types';

interface PeerListProps {
  peers: Map<string, PeerConnectionState>;
  onRemovePeer?: (peerId: string) => void;
}

const statusConfig: Record<PeerConnectionState['status'], { color: string; icon: string; label: string }> = {
  connecting: { color: 'text-yellow-400', icon: '◐', label: 'Connecting' },
  connected: { color: 'text-green-400', icon: '●', label: 'Connected' },
  disconnected: { color: 'text-gray-400', icon: '○', label: 'Disconnected' },
  failed: { color: 'text-red-400', icon: '✕', label: 'Failed' },
};

export function PeerList({ peers, onRemovePeer }: PeerListProps) {
  const peerArray = Array.from(peers.entries());
  
  if (peerArray.length === 0) {
    return null;
  }

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-300">
          Connected Peers ({peerArray.filter(([_, p]) => p.status === 'connected').length}/{peerArray.length})
        </h3>
      </div>
      
      <div className="space-y-2">
        {peerArray.map(([peerId, state]) => {
          const config = statusConfig[state.status];
          
          return (
            <div 
              key={peerId}
              className="flex items-center justify-between p-2 bg-gray-700/50 rounded-lg"
            >
              <div className="flex items-center gap-3">
                <span className={`text-lg ${config.color}`}>{config.icon}</span>
                <div>
                  <p className="text-sm text-white font-mono">
                    {peerId.substring(0, 12)}...
                  </p>
                  <p className={`text-xs ${config.color}`}>
                    {config.label}
                    {state.dataChannelOpen && ' • Data channel open'}
                  </p>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                {state.sasCode && (
                  <div className="px-2 py-1 bg-purple-900/30 rounded border border-purple-500/30">
                    <p className="text-xs text-purple-300 font-mono">{state.sasCode}</p>
                  </div>
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
