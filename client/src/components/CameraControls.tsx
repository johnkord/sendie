import { useEffect, useRef, useState } from 'react';
import { cameraService, MAX_VIDEO_PEERS } from '../services';

/**
 * Start camera / Stop camera with self-preview.
 *
 * Mirrors VoiceControls but for video. Refuses to start when the room is
 * already at the per-mesh video peer cap.
 */
export function CameraControls() {
  const [active, setActive] = useState(cameraService.isActive());
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    cameraService.on('onStarted', () => setActive(true));
    cameraService.on('onStopped', () => setActive(false));
    cameraService.on('onError', (err) => setError(err.message));
    return () => {
      cameraService.off('onStarted');
      cameraService.off('onStopped');
      cameraService.off('onError');
    };
  }, []);

  // Bind the local stream to the preview <video> whenever active flips.
  useEffect(() => {
    if (!previewRef.current) return;
    previewRef.current.srcObject = active ? cameraService.getLocalStream() : null;
  }, [active]);

  const handleStart = async () => {
    setError(null);
    try {
      await cameraService.start();
    } catch (err) {
      setError((err as Error).message ?? 'Could not start camera');
    }
  };

  const handleStop = async () => {
    await cameraService.stop();
  };

  return (
    <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700 flex items-center gap-3">
      {!active ? (
        <button
          onClick={handleStart}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors flex items-center gap-2"
          title={`Start camera (max ${MAX_VIDEO_PEERS} simultaneous video streams)`}
        >
          <span>📹</span>
          <span>Start camera</span>
        </button>
      ) : (
        <>
          <button
            onClick={handleStop}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-red-600/30 hover:bg-red-600/50 text-red-200 border border-red-600/50 transition-colors"
            title="Stop sharing video"
          >
            ⏹ Stop
          </button>
          <video
            ref={previewRef}
            autoPlay
            muted
            playsInline
            className="h-16 w-auto rounded border border-gray-600 bg-black"
            title="Self preview"
          />
        </>
      )}
      {error && <span className="text-xs text-red-400 ml-2">{error}</span>}
    </div>
  );
}
