import { useCallback } from 'react';
import { cameraService } from '../services';
import type { PeerConnectionState } from '../types';
import { VideoTile } from './VideoTile';

interface RemoteVideosProps {
  peers: Map<string, PeerConnectionState>;
}

/**
 * Renders a <video> tile per peer who is currently sharing a camera.
 * The MediaStream lives in CameraService (it is not a serializable Zustand
 * value); VideoTile re-binds on every notification for the matching peer.
 *
 * Layout: simple flex-wrap grid. Up to MAX_VIDEO_PEERS tiles.
 */
export function RemoteVideos({ peers }: RemoteVideosProps) {
  const sharing = Array.from(peers.entries()).filter(
    ([, p]) => p.cameraState?.sharing,
  );
  if (sharing.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-900/40 p-3">
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
  const getStream = useCallback(
    () => cameraService.getRemoteStream(peerId),
    [peerId],
  );
  const onStreamChanged = useCallback(
    (cb: () => void) =>
      cameraService.onRemoteStreamChanged((changed) => {
        if (changed === peerId) cb();
      }),
    [peerId],
  );
  const label = peer.friendlyName ?? `Peer ${peerId.substring(0, 8)}`;

  return (
    <VideoTile
      kind="camera"
      label={label}
      micMuted={Boolean(peer.voiceState?.sharing && peer.voiceState.muted)}
      // Cap each tile at a manageable size; aspect ratio is preserved
      // by object-contain so portrait phone footage letterboxes inside
      // the 16:9-ish box rather than being center-cropped.
      sizeClasses="w-64 aspect-video"
      getStream={getStream}
      onStreamChanged={onStreamChanged}
    />
  );
}
