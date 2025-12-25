import { useCallback } from 'react';
import type { QueuedFile } from '../types';
import { formatFileSize } from '../utils/formatters';

interface FileQueueProps {
  queuedFiles: QueuedFile[];
  broadcastMode: boolean;
  onRemoveFile: (id: string) => void;
  onClearQueue: (broadcastOnly?: boolean) => void;
  onToggleBroadcastMode: () => void;
}

export function FileQueue({
  queuedFiles,
  broadcastMode,
  onRemoveFile,
  onClearQueue,
  onToggleBroadcastMode,
}: FileQueueProps) {
  const oneTimeFiles = queuedFiles.filter((f) => !f.isBroadcast);
  const broadcastFiles = queuedFiles.filter((f) => f.isBroadcast);

  const totalOneTimeSize = oneTimeFiles.reduce((acc, f) => acc + f.file.size, 0);
  const totalBroadcastSize = broadcastFiles.reduce((acc, f) => acc + f.file.size, 0);

  const handleClearOneTime = useCallback(() => {
    onClearQueue(false);
  }, [onClearQueue]);

  const handleClearBroadcast = useCallback(() => {
    // Remove only broadcast files
    broadcastFiles.forEach((f) => onRemoveFile(f.id));
  }, [broadcastFiles, onRemoveFile]);

  if (queuedFiles.length === 0 && !broadcastMode) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Broadcast Mode Toggle */}
      <div className="p-4 bg-gray-800/50 rounded-lg border border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">📡</span>
            <div>
              <span className="text-sm font-medium text-gray-300">Broadcast Mode</span>
              <p className="text-xs text-gray-500">
                {broadcastMode 
                  ? 'Files will auto-send to everyone who joins' 
                  : 'Enable to send files to all new joiners'}
              </p>
            </div>
          </div>
          <button
            onClick={onToggleBroadcastMode}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              broadcastMode ? 'bg-purple-600' : 'bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                broadcastMode ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Queued Files (One-time) */}
      {oneTimeFiles.length > 0 && (
        <div className="p-4 bg-gray-800/50 rounded-lg border border-gray-700">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">📋</span>
              <span className="text-sm font-medium text-gray-300">
                Queued Files ({oneTimeFiles.length})
              </span>
              <span className="text-xs text-gray-500">
                {formatFileSize(totalOneTimeSize)} total
              </span>
            </div>
            <button
              onClick={handleClearOneTime}
              className="text-xs text-gray-400 hover:text-red-400 transition-colors"
            >
              Clear all
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            These files will be sent when someone joins the session.
          </p>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {oneTimeFiles.map((qf) => (
              <FileQueueItem
                key={qf.id}
                queuedFile={qf}
                onRemove={() => onRemoveFile(qf.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Broadcast Files */}
      {broadcastFiles.length > 0 && (
        <div className="p-4 bg-purple-900/30 rounded-lg border border-purple-700/50">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">📡</span>
              <span className="text-sm font-medium text-purple-300">
                Broadcast Files ({broadcastFiles.length})
              </span>
              <span className="text-xs text-purple-400">
                {formatFileSize(totalBroadcastSize)} total
              </span>
            </div>
            <button
              onClick={handleClearBroadcast}
              className="text-xs text-purple-400 hover:text-red-400 transition-colors"
            >
              Clear all
            </button>
          </div>
          <p className="text-xs text-purple-400/70 mb-3">
            These files will be sent to everyone who joins.
          </p>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {broadcastFiles.map((qf) => (
              <FileQueueItem
                key={qf.id}
                queuedFile={qf}
                onRemove={() => onRemoveFile(qf.id)}
                isBroadcast
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface FileQueueItemProps {
  queuedFile: QueuedFile;
  onRemove: () => void;
  isBroadcast?: boolean;
}

function FileQueueItem({ queuedFile, onRemove, isBroadcast }: FileQueueItemProps) {
  const { file } = queuedFile;

  return (
    <div 
      className={`flex items-center justify-between p-2 rounded-md ${
        isBroadcast ? 'bg-purple-800/30' : 'bg-gray-700/50'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-sm">📄</span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm truncate ${isBroadcast ? 'text-purple-200' : 'text-gray-200'}`}>
            {file.name}
          </p>
          <p className={`text-xs ${isBroadcast ? 'text-purple-400' : 'text-gray-500'}`}>
            {formatFileSize(file.size)}
          </p>
        </div>
      </div>
      <button
        onClick={onRemove}
        className={`p-1 rounded transition-colors ${
          isBroadcast 
            ? 'text-purple-400 hover:text-red-400 hover:bg-purple-800/50' 
            : 'text-gray-400 hover:text-red-400 hover:bg-gray-700'
        }`}
        title="Remove from queue"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
