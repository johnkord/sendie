import { useEffect, useRef } from 'react';
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

  useEffect(() => {
    const bind = () => {
      const el = ref.current;
      if (!el) return;
      const stream = screenShareService.getRemoteStream(peerId);
      if (el.srcObject !== stream) {
        el.srcObject = stream ?? null;
      }
      if (stream) {
        el.play().catch(() => {
          // Browser will retry on next user interaction.
        });
      }
    };
    bind();
    const unsub = screenShareService.onRemoteStreamChanged((changedPeerId) => {
      if (changedPeerId === peerId) bind();
    });
    return unsub;
  }, [peerId]);

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
      <div className="absolute bottom-1 left-1 px-2 py-0.5 bg-black/70 rounded text-xs text-white font-mono flex items-center gap-1">
        <span>🖥️</span>
        <span>{label}</span>
        <span className="text-gray-400">screen</span>
      </div>
    </div>
  );
}
