import { useEffect, useRef, useState } from 'react';
import { voiceService } from '../services/VoiceService';

/**
 * Voice PoC controls: Start / Stop / Mute, plus a self-meter so the user
 * sees their mic is hot.
 *
 * Intentionally minimal. No volume slider, no peer-by-peer mute, no
 * input-device picker. This is a proof of concept; if it sticks around,
 * we expand it in the implementation plan that follows.
 */
export function VoiceControls() {
  const [active, setActive] = useState(voiceService.isActive());
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const meterRaf = useRef<number | null>(null);

  useEffect(() => {
    voiceService.on('onStarted', () => setActive(true));
    voiceService.on('onStopped', () => setActive(false));
    voiceService.on('onError', (err) => setError(err.message));
    return () => {
      voiceService.off('onStarted');
      voiceService.off('onStopped');
      voiceService.off('onError');
    };
  }, []);

  // Drive the self-meter on requestAnimationFrame while active.
  useEffect(() => {
    if (!active) {
      if (meterRaf.current !== null) cancelAnimationFrame(meterRaf.current);
      setLevel(0);
      return;
    }
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setLevel(voiceService.getLocalLevel());
      meterRaf.current = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelled = true;
      if (meterRaf.current !== null) cancelAnimationFrame(meterRaf.current);
    };
  }, [active]);

  const handleStart = async () => {
    setError(null);
    try {
      await voiceService.start();
    } catch (err) {
      setError((err as Error).message ?? 'Could not start voice');
    }
  };

  const handleStop = async () => {
    await voiceService.stop();
    setMuted(false);
  };

  const handleToggleMute = () => {
    const next = !muted;
    voiceService.setMuted(next);
    setMuted(next);
  };

  return (
    <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700 flex items-center gap-3">
      {!active ? (
        <button
          onClick={handleStart}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-green-600 hover:bg-green-700 text-white transition-colors flex items-center gap-2"
          title="Start voice (requires mic permission)"
        >
          <span>🎙️</span>
          <span>Start voice</span>
        </button>
      ) : (
        <>
          <button
            onClick={handleStop}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-red-600/30 hover:bg-red-600/50 text-red-200 border border-red-600/50 transition-colors"
            title="Stop sharing audio"
          >
            ⏹ Stop
          </button>
          <button
            onClick={handleToggleMute}
            className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
              muted
                ? 'bg-gray-700 text-gray-300 border-gray-600'
                : 'bg-purple-600/20 text-purple-300 border-purple-600/40'
            }`}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? '🔇 Muted' : '🎤 Live'}
          </button>
          {/* Self-meter: 8 bars that light up with the local mic amplitude. */}
          <div className="flex items-end gap-0.5 h-5">
            {Array.from({ length: 8 }).map((_, i) => {
              const threshold = (i + 1) / 8;
              const lit = !muted && level >= threshold;
              return (
                <span
                  key={i}
                  className={`w-1 rounded-sm transition-colors ${lit ? 'bg-green-400' : 'bg-gray-700'}`}
                  style={{ height: `${(i + 1) * 12.5}%` }}
                />
              );
            })}
          </div>
        </>
      )}
      {error && (
        <span className="text-xs text-red-400 ml-2">{error}</span>
      )}
    </div>
  );
}
