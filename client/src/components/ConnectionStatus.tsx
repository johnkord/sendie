import type { ConnectionStatus } from '../types';

interface ConnectionStatusProps {
  status: ConnectionStatus;
  sessionId: string | null;
  connectedPeerCount: number;
  maxPeers: number;
  error: string | null;
}

const statusConfig: Record<ConnectionStatus, { label: string; color: string; icon: string }> = {
  disconnected: { label: 'Disconnected', color: 'text-gray-400', icon: '○' },
  connecting: { label: 'Connecting...', color: 'text-yellow-400', icon: '◐' },
  'waiting-for-peer': { label: 'Waiting for peers...', color: 'text-blue-400', icon: '◑' },
  connected: { label: 'Connected', color: 'text-green-400', icon: '●' },
  'partially-connected': { label: 'Partially Connected', color: 'text-yellow-400', icon: '◐' },
  verified: { label: 'Verified & Connected', color: 'text-green-400', icon: '✓' },
  error: { label: 'Error', color: 'text-red-400', icon: '✕' },
};

export function ConnectionStatusDisplay({ 
  status, 
  sessionId, 
  connectedPeerCount,
  maxPeers,
  error 
}: ConnectionStatusProps) {
  const config = statusConfig[status];
  const isRateLimitError = error?.includes('wait') || error?.includes('⏱️');

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-xl ${config.color}`}>{config.icon}</span>
          <span className={`font-medium ${config.color}`}>{config.label}</span>
        </div>
        
        {connectedPeerCount > 0 && (
          <span className="text-sm text-gray-400">
            {connectedPeerCount} peer{connectedPeerCount !== 1 ? 's' : ''} connected
            {maxPeers > 2 && ` (max ${maxPeers})`}
          </span>
        )}
      </div>

      {sessionId && (
        <p className="text-sm text-gray-400 mt-2">
          Session: <code className="bg-gray-700 px-2 py-0.5 rounded">{sessionId}</code>
        </p>
      )}

      {error && (
        <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <div className="flex items-start gap-2">
            <span className="text-red-400 flex-shrink-0">
              {isRateLimitError ? '⏱️' : '⚠️'}
            </span>
            <p className="text-sm text-red-400">
              {error}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
