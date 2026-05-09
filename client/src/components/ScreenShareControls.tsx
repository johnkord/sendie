import { useEffect, useRef, useState } from 'react';
import { screenShareService, MAX_SCREEN_PEERS } from '../services';

/**
 * Start screen share / Stop screen share with a small self-preview.
 *
 * Mirrors CameraControls. Disables the start button on browsers that
 * don't support getDisplayMedia (notably mobile Safari and Firefox
 * Android), with a tooltip explaining why.
 */
export function ScreenShareControls() {
  const [active, setActive] = useState(screenShareService.isActive());
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const supported = screenShareService.isSupported();

  useEffect(() => {
    screenShareService.on('onStarted', () => {
      setActive(true);
      setError(null);
    });
    screenShareService.on('onStopped', () => setActive(false));
    screenShareService.on('onError', (err) => setError(err.message));
    return () => {
      screenShareService.off('onStarted');
      screenShareService.off('onStopped');
      screenShareService.off('onError');
    };
  }, []);

  // Bind the local stream to the preview <video> whenever active flips.
  useEffect(() => {
    if (!previewRef.current) return;
    previewRef.current.srcObject = active ? screenShareService.getLocalStream() : null;
  }, [active]);

  const handleStart = async () => {
    setError(null);
    try {
      await screenShareService.start();
    } catch (err) {
      // Cancellation is reported via onError as a soft "Screen share cancelled".
      setError((err as Error).message ?? 'Could not start screen share');
    }
  };

  const handleStop = async () => {
    await screenShareService.stop();
  };

  return (
    <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700 flex items-center gap-3">
      {!active ? (
        <button
          onClick={handleStart}
          disabled={!supported}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
            supported
              ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
          }`}
          title={
            supported
              ? `Share your screen (max ${MAX_SCREEN_PEERS} simultaneous shares in the room)`
              : 'Screen sharing requires a desktop browser (not supported on mobile)'
          }
        >
          <span>🖥️</span>
          <span>Share screen</span>
        </button>
      ) : (
        <>
          <button
            onClick={handleStop}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-red-600/30 hover:bg-red-600/50 text-red-200 border border-red-600/50 transition-colors"
            title="Stop sharing your screen"
          >
            ⏹ Stop sharing
          </button>
          <video
            ref={previewRef}
            autoPlay
            muted
            playsInline
            // h-24 (96px) so the sharer can verify what's actually
            // captured at a glance. Cameras need much less; screens have
            // small text everywhere.
            className="h-24 w-auto rounded border border-gray-600 bg-black"
            title="Self preview (what others see)"
          />
        </>
      )}
      {error && <span className="text-xs text-red-400 ml-2">{error}</span>}
    </div>
  );
}
