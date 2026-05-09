import { useEffect, useRef } from 'react';
import { cameraService } from '../services';
import type { PeerConnectionState } from '../types';

interface RemoteVideosProps {
  peers: Map<string, PeerConnectionState>;
}

/**
 * Renders a <video> tile per peer who is currently sharing a camera.
 * The MediaStream lives in CameraService (it is not a serializable Zustand
 * value); we re-bind on every render where the peer's cameraState flag
 * indicates they are sharing.
 *
 * Layout: simple flex-wrap grid. Up to MAX_VIDEO_PEERS tiles.
 */
export function RemoteVideos({ peers }: RemoteVideosProps) {
  const sharing = Array.from(peers.entries()).filter(
    ([, p]) => p.cameraState?.sharing,
  );
  if (sharing.length === 0) return null;

  return (
    <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
      <div className="flex flex-wrap gap-3">
        {sharing.map(([peerId, p]) => (
          <RemoteVideoTile key={peerId} peerId={peerId} peer={p} />
        ))}
      </div>
    </div>
  );
}

function RemoteVideoTile({
  peerId,
  peer,
}: {
  peerId: string;
  peer: PeerConnectionState;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  // Subscribe to camera service stream changes. The data-channel
  // 'camera-state' message can arrive before WebRTC's ontrack event,
  // so we cannot rely on React re-rendering with a fresh stream;
  // we re-bind on every notification for this peer.
  useEffect(() => {
    const bind = () => {
      const el = ref.current;
      if (!el) return;
      const stream = cameraService.getRemoteStream(peerId);
      if (el.srcObject !== stream) {
        el.srcObject = stream ?? null;
      }
      if (stream) {
        el.play().catch(() => {
          // Browser will retry on next interaction; nothing to do here.
        });
      }
    };
    // Bind once on mount in case the stream is already there.
    bind();
    // Subscribe to future updates for THIS peer.
    const unsub = cameraService.onRemoteStreamChanged((changedPeerId) => {
      if (changedPeerId === peerId) bind();
    });
    return unsub;
  }, [peerId]);

  const label =
    peer.friendlyName ?? `Peer ${peerId.substring(0, 8)}`;

  return (
    <div className="relative">
      <video
        ref={ref}
        autoPlay
        playsInline
        className="w-64 h-36 rounded border border-gray-600 bg-black object-cover"
      />
      <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-xs text-white font-mono">
        {label}
        {peer.voiceState?.sharing && peer.voiceState.muted && (
          <span className="ml-1 text-gray-400" title="Microphone muted">🔇</span>
        )}
      </div>
    </div>
  );
}
