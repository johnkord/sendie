import { useCallback, useEffect, useRef, useState } from 'react';
import { screenShareService } from '../services';
import type { PeerConnectionState } from '../types';
import { VideoTile } from './VideoTile';

interface RemoteScreensProps {
  peers: Map<string, PeerConnectionState>;
}

/**
 * Renders a large <video> tile per peer who is currently sharing their
 * screen. Distinct from RemoteVideos (which is camera tiles) so screen
 * shares can dominate the layout and camera tiles can shrink to a
 * filmstrip alongside.
 *
 * Layout: stacked, full-width tiles. object-contain so we don't crop
 * legible text.
 */
export function RemoteScreens({ peers }: RemoteScreensProps) {
  const sharing = Array.from(peers.entries()).filter(
    ([, p]) => p.screenState?.sharing,
  );
  if (sharing.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3 space-y-3">
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
  // Detect whether the remote screen stream actually carries audio
  // (sender can opt in via the picker dialog on Chromium). We watch
  // the stream-changed callbacks to pick up audio tracks that arrive
  // after the video.
  const [hasAudio, setHasAudio] = useState(false);
  const [muted, setMuted] = useState(false);
  const [needsClick, setNeedsClick] = useState(false);
  // Receives the underlying <video> from VideoTile so we can imperatively
  // drive its audio mute state without re-binding the stream.
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  const getStream = useCallback(
    () => screenShareService.getRemoteStream(peerId),
    [peerId],
  );
  const onStreamChanged = useCallback(
    (cb: () => void) =>
      screenShareService.onRemoteStreamChanged((changed) => {
        if (changed === peerId) cb();
      }),
    [peerId],
  );

  // Re-evaluate hasAudio whenever the stream changes (audio track may
  // arrive after video on a slow data channel). Also try to start
  // unmuted playback; VideoTile already started it muted.
  useEffect(() => {
    const refresh = () => {
      const stream = screenShareService.getRemoteStream(peerId);
      const audioPresent = !!stream && stream.getAudioTracks().length > 0;
      setHasAudio(audioPresent);
      const el = videoElRef.current;
      if (el && audioPresent) {
        el.muted = false;
        setMuted(false);
        el.play()
          .then(() => setNeedsClick(false))
          .catch(() => {
            // Autoplay-with-sound blocked. Fall back to muted so the
            // image still appears, and surface a click overlay.
            el.muted = true;
            setMuted(true);
            setNeedsClick(true);
            el.play().catch(() => {});
          });
      }
    };
    refresh();
    const unsub = screenShareService.onRemoteStreamChanged((changed) => {
      if (changed === peerId) refresh();
    });
    return unsub;
  }, [peerId]);

  const handleToggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = videoElRef.current;
    if (!el) return;
    const next = !muted;
    el.muted = next;
    setMuted(next);
    if (!next) {
      el.play().then(() => setNeedsClick(false)).catch(() => {});
    }
  };

  const handleEnableAudio = () => {
    const el = videoElRef.current;
    if (!el) return;
    el.muted = false;
    setMuted(false);
    setNeedsClick(false);
    el.play().catch(() => {});
  };

  const label = peer.friendlyName ?? `Peer ${peerId.substring(0, 8)}`;

  return (
    <div className="relative">
      <VideoTile
        kind="screen"
        label={label}
        // max-h-[70vh] cap so a 4K share doesn't push the rest of the
        // UI off-screen on smaller monitors.
        sizeClasses="w-full max-h-[70vh] aspect-video"
        getStream={getStream}
        onStreamChanged={onStreamChanged}
        videoElRef={videoElRef}
        rightControls={
          hasAudio ? (
            <button
              onClick={handleToggleMute}
              className="p-1.5 bg-black/60 hover:bg-black/80 rounded text-white transition-colors"
              title={muted ? 'Unmute screen-share audio' : 'Mute screen-share audio (locally)'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
          ) : undefined
        }
      />

      {needsClick && (
        <button
          onClick={handleEnableAudio}
          className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-sm font-medium hover:bg-black/55 transition-colors rounded"
          title="Browser blocked autoplay with sound. Click to enable audio."
        >
          🔊 Click to enable screen-share audio
        </button>
      )}
    </div>
  );
}

