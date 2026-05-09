import { useEffect, useRef, useState } from 'react';
import { screenShareService } from '../services';
import type { PeerConnectionState } from '../types';

interface RemoteScreensProps {
  peers: Map<string, PeerConnectionState>;
}

/**
 * Renders a large <video> tile per peer who is currently sharing their
 * screen. Distinct from RemoteVideos (which is camera tiles) so screen
 * shares can dominate the layout and camera tiles can shrink to a
 * filmstrip alongside.
 *
 * Layout: stacked, full-width tiles. Letterboxed via object-contain so we
 * don't crop legible text.
 */
export function RemoteScreens({ peers }: RemoteScreensProps) {
  const sharing = Array.from(peers.entries()).filter(
    ([, p]) => p.screenState?.sharing,
  );
  if (sharing.length === 0) return null;

  return (
    <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700 space-y-3">
      {sharing.map(([peerId, p]) => (
        <RemoteScreenTile key={peerId} peerId={peerId} peer={p} />
      ))}
    </div>
  );
}

function RemoteScreenTile({
  peerId,
  peer,
}: {
  peerId: string;
  peer: PeerConnectionState;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  // Track whether the remote stream actually has an audio track. We only
  // surface the mute toggle when there is something to mute (sender did
  // not opt into audio capture, or browser does not support it).
  const [hasAudio, setHasAudio] = useState(false);
  // Receiver-side mute. Remote screen-share audio defaults to UNMUTED if
  // the sender opted into capturing it; the receiver can mute locally
  // (e.g. if the audio is loud, distracting, or feeds back into their
  // mic). This is purely client-side; the sender keeps transmitting.
  const [muted, setMuted] = useState(false);
  // Autoplay-policy guard: a video with audio that has not had any user
  // interaction can fail to start. We surface a "Click to play" overlay
  // when the play() promise rejects so the user can fix it with a click.
  const [needsClick, setNeedsClick] = useState(false);

  useEffect(() => {
    const bind = () => {
      const el = ref.current;
      if (!el) return;
      const stream = screenShareService.getRemoteStream(peerId);
      if (el.srcObject !== stream) {
        el.srcObject = stream ?? null;
      }
      setHasAudio(!!stream && stream.getAudioTracks().length > 0);
      if (stream) {
        // Start unmuted so screen-share audio (the whole point of
        // opting in) is audible by default. If autoplay policy blocks
        // unmuted playback, we fall back to muted+overlay so the video
        // is still visible.
        el.muted = false;
        el.play()
          .then(() => setNeedsClick(false))
          .catch(() => {
            // Most browsers allow muted autoplay even without a gesture;
            // try again muted so the receiver at least sees the video.
            el.muted = true;
            setMuted(true);
            setNeedsClick(true);
            el.play().catch(() => {
              // Give up; user will click the overlay.
            });
          });
      }
    };
    bind();
    const unsub = screenShareService.onRemoteStreamChanged((changedPeerId) => {
      if (changedPeerId === peerId) bind();
    });
    return unsub;
  }, [peerId]);

  const handleToggleMute = () => {
    const el = ref.current;
    if (!el) return;
    const next = !muted;
    el.muted = next;
    setMuted(next);
    if (!next && needsClick) {
      // First user gesture; tell the autoplay policy we are good.
      el.play().then(() => setNeedsClick(false)).catch(() => {});
    }
  };

  const handleOverlayClick = () => {
    const el = ref.current;
    if (!el) return;
    el.muted = false;
    setMuted(false);
    setNeedsClick(false);
    el.play().catch(() => {});
  };

  const label = peer.friendlyName ?? `Peer ${peerId.substring(0, 8)}`;

  return (
    <div className="relative">
      <video
        ref={ref}
        autoPlay
        playsInline
        // object-contain so legible content (code, text) is not cropped.
        // max-h-[70vh] caps the tile so a 4K share doesn't push the rest
        // of the UI below the fold on smaller monitors.
        className="w-full max-h-[70vh] rounded border border-gray-600 bg-black object-contain"
      />
      {needsClick && (
        <button
          onClick={handleOverlayClick}
          className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-sm font-medium hover:bg-black/55 transition-colors rounded"
          title="Browser blocked autoplay with sound. Click to enable audio."
        >
          🔊 Click to enable screen-share audio
        </button>
      )}
      <div className="absolute bottom-1 left-1 px-2 py-0.5 bg-black/70 rounded text-xs text-white font-mono flex items-center gap-1.5">
        <span>🖥️</span>
        <span>{label}</span>
        <span className="text-gray-400">screen</span>
        {hasAudio && (
          <button
            onClick={handleToggleMute}
            className="ml-1 px-1 py-0.5 rounded hover:bg-white/10 transition-colors"
            title={muted ? 'Unmute screen-share audio' : 'Mute screen-share audio (locally)'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        )}
      </div>
    </div>
  );
}
