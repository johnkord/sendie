import { useCallback } from 'react';
import type { QueuedFile } from '../types';
import { formatFileSize } from '../utils/formatters';

interface FileQueueProps {
  queuedFiles: QueuedFile[];
  broadcastMode: boolean;
  onRemoveFile: (id: string) => void;
  onClearOneTimeFiles: () => void;
  onClearBroadcastFiles: () => void;
  onToggleBroadcastMode: () => void;
}

export function FileQueue({
  queuedFiles,
  broadcastMode,
  onRemoveFile,
  onClearOneTimeFiles,
  onClearBroadcastFiles,
  onToggleBroadcastMode,
}: FileQueueProps) {
  const oneTimeFiles = queuedFiles.filter((f) => !f.isBroadcast);
  const broadcastFiles = queuedFiles.filter((f) => f.isBroadcast);

  const totalOneTimeSize = oneTimeFiles.reduce((acc, f) => acc + f.file.size, 0);
  const totalBroadcastSize = broadcastFiles.reduce((acc, f) => acc + f.file.size, 0);

  const handleClearOneTime = useCallback(() => {
    onClearOneTimeFiles();
  }, [onClearOneTimeFiles]);

  const handleClearBroadcast = useCallback(() => {
    onClearBroadcastFiles();
  }, [onClearBroadcastFiles]);

  return (
    <div className="space-y-3">
      {/* Broadcast Mode toggle: compact strip rather than a full card */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-700/50 bg-slate-900/40 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base" aria-hidden>📡</span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-200">Broadcast mode</div>
            <p className="text-xs text-slate-500 truncate">
              {broadcastMode
                ? 'Offer retained files to future joiners'
                : 'Do not retain files for later joiners'}
            </p>
          </div>
        </div>
        <button
          onClick={onToggleBroadcastMode}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            broadcastMode ? 'bg-purple-500' : 'bg-slate-600'
          }`}
          title={broadcastMode ? 'Disable broadcast mode' : 'Enable broadcast mode'}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              broadcastMode ? 'translate-x-5' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Queued Files (One-time) */}
      {oneTimeFiles.length > 0 && (
        <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
              <span aria-hidden>📋</span>
              <span>Queued · {oneTimeFiles.length}</span>
              <span className="text-slate-500 normal-case tracking-normal">
                {formatFileSize(totalOneTimeSize)}
              </span>
            </div>
            <button
              onClick={handleClearOneTime}
              className="text-xs text-slate-400 hover:text-red-400 transition-colors"
              title="Remove all queued files"
            >
              Clear
            </button>
          </div>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
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
        <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-purple-300">
              <span aria-hidden>📡</span>
              <span>Broadcast · {broadcastFiles.length}</span>
              <span className="text-purple-400/80 normal-case tracking-normal">
                {formatFileSize(totalBroadcastSize)}
              </span>
            </div>
            <button
              onClick={handleClearBroadcast}
              className="text-xs text-purple-300 hover:text-red-400 transition-colors"
              title="Remove all broadcast files"
            >
              Clear
            </button>
          </div>
          <p className="text-xs text-purple-300/70 mb-2">
            Offered to everyone who joins later.
          </p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
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
        isBroadcast ? 'bg-purple-500/10' : 'bg-slate-800/40'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-sm" aria-hidden>📄</span>
        <div className="min-w-0 flex-1">
          <p className={`text-sm truncate ${isBroadcast ? 'text-purple-100' : 'text-slate-200'}`}>
            {file.name}
          </p>
          <p className={`text-xs ${isBroadcast ? 'text-purple-300/80' : 'text-slate-500'}`}>
            {formatFileSize(file.size)}
          </p>
        </div>
      </div>
      <button
        onClick={onRemove}
        className={`p-1 rounded transition-colors ${
          isBroadcast
            ? 'text-purple-300 hover:text-red-400 hover:bg-purple-500/20'
            : 'text-slate-400 hover:text-red-400 hover:bg-slate-700'
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
