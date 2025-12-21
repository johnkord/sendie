import type { TransferState } from '../types';
import { formatFileSize, formatSpeed, calculateETA, calculateProgress, getFileIcon } from '../utils/formatters';

interface TransferProgressProps {
  transfer: TransferState;
  onCancel?: () => void;
}

export function TransferProgress({ transfer, onCancel }: TransferProgressProps) {
  const progress = calculateProgress(transfer.bytesTransferred, transfer.fileSize);
  const eta = calculateETA(transfer.bytesTransferred, transfer.fileSize, transfer.speed);
  const icon = getFileIcon(transfer.fileType);
  
  const isActive = transfer.status === 'transferring' || transfer.status === 'pending';
  const isComplete = transfer.status === 'completed';
  const isFailed = transfer.status === 'failed' || transfer.status === 'cancelled';

  return (
    <div className={`
      bg-gray-800/50 rounded-lg p-4 border
      ${isComplete ? 'border-green-500/30' : isFailed ? 'border-red-500/30' : 'border-gray-700'}
    `}>
      <div className="flex items-start gap-3">
        <span className="text-2xl">{icon}</span>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium text-white truncate" title={transfer.fileName}>
              {transfer.fileName}
            </h3>
            <span className={`
              text-xs px-2 py-0.5 rounded-full
              ${transfer.direction === 'send' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300'}
            `}>
              {transfer.direction === 'send' ? '↑ Sending' : '↓ Receiving'}
            </span>
          </div>
          
          <p className="text-sm text-gray-400 mt-1">
            {formatFileSize(transfer.bytesTransferred)} / {formatFileSize(transfer.fileSize)}
            {isActive && transfer.speed > 0 && (
              <span className="ml-2">• {formatSpeed(transfer.speed)}</span>
            )}
            {isActive && (
              <span className="ml-2">• ETA: {eta}</span>
            )}
          </p>

          {/* Progress bar */}
          <div className="mt-2 h-2 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`
                h-full transition-all duration-300
                ${isComplete ? 'bg-green-500' : isFailed ? 'bg-red-500' : 'bg-purple-500'}
              `}
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="flex items-center justify-between mt-2">
            <span className={`
              text-sm
              ${isComplete ? 'text-green-400' : isFailed ? 'text-red-400' : 'text-gray-400'}
            `}>
              {isComplete && '✓ Complete'}
              {isFailed && (transfer.status === 'cancelled' ? '✕ Cancelled' : '✕ Failed')}
              {isActive && `${progress}%`}
            </span>

            {isActive && onCancel && (
              <button
                onClick={onCancel}
                className="text-sm text-gray-400 hover:text-red-400 transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
