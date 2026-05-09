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
  // Pulse the indicator while we're not in a settled state. Tiny detail
  // but turns "static char that means connecting" into "system is doing
  // something on your behalf right now".
  const isPending = status === 'connecting' || status === 'waiting-for-peer' || status === 'partially-connected';

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`text-lg ${config.color} ${isPending ? 'animate-pulse' : ''}`} aria-hidden>{config.icon}</span>
          <span className={`text-sm font-medium ${config.color}`}>{config.label}</span>
        </div>

        {connectedPeerCount > 0 && (
          <span className="text-xs text-slate-500">
            {connectedPeerCount}/{maxPeers > 2 ? maxPeers : 2} peers
          </span>
        )}
      </div>

      {sessionId && (
        <p className="mt-2 text-xs text-slate-500">
          Session <code className="ml-1 bg-slate-800/80 px-1.5 py-0.5 rounded text-slate-300 font-mono">{sessionId}</code>
        </p>
      )}

      {error && (
        <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <div className="flex items-start gap-2">
            <span className="text-red-400 flex-shrink-0" aria-hidden>
              {isRateLimitError ? '⏱️' : '⚠️'}
            </span>
            <p className="text-sm text-red-300">
              {error}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
