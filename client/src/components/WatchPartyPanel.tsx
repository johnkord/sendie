import { useEffect, useRef, useState } from 'react';
import { watchPartyService } from '../services';
import type { WatchPartyState, WatchPartyPeerInfo } from '../services';
import { useAppStore } from '../stores/appStore';
import { formatFileSize } from '../utils/formatters';

/**
 * Watch-party panel: lets one peer host a synced playback session and
 * everyone else join with their local copy of the same media file.
 *
 * Implementation of slice 1 from
 * docs/synced-media-playback-proposal.md. Drag-drop / click to load a
 * local file. Host gets play / pause / seek controls; followers see a
 * passive video player that converges on the host's timeline via
 * WatchPartyService's drift loop.
 */
export function WatchPartyPanel() {
  const [state, setState] = useState<WatchPartyState>(() => ({ ...watchPartyService.getState() }));
  const [peers, setPeers] = useState<ReadonlyMap<string, WatchPartyPeerInfo>>(
    () => new Map(watchPartyService.getPeers()),
  );
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    watchPartyService.on('onStateChange', (s) => setState({ ...s }));
    watchPartyService.on('onPeersChange', (p) => setPeers(new Map(p)));
    return () => {
      watchPartyService.off('onStateChange');
      watchPartyService.off('onPeersChange');
    };
  }, []);

  // Auto-expand when a watch party becomes active so users notice; do
  // not auto-collapse on idle, the user can close manually.
  useEffect(() => {
    if (state.role !== 'idle') setOpen(true);
  }, [state.role]);

  const handlePickFile = () => fileInputRef.current?.click();

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset for re-pick
    if (!file) return;
    if (state.role === 'idle') {
      try {
        await watchPartyService.startAsHost(file);
      } catch (err) {
        console.error('Watch party start failed:', err);
      }
    } else if (state.role === 'follower') {
      watchPartyService.setFollowerFile(file);
    }
  };

  const handleLeave = () => watchPartyService.leave();

  const titleSuffix = state.role === 'host' ? ' (host)' : state.role === 'follower' ? ' (follower)' : '';

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-900/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-white/5 transition-colors rounded-xl"
        title={open ? 'Hide watch party' : 'Show watch party'}
      >
        <div className="flex items-center gap-2">
          <span aria-hidden>🎬</span>
          <span className="text-sm font-medium text-slate-200">Watch together{titleSuffix}</span>
          {state.role !== 'idle' && (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              live
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-700/50 p-3 space-y-3">
          {state.error && (
            <p className="text-xs text-red-300/90 bg-red-500/10 border border-red-500/30 rounded p-2">
              {state.error}
            </p>
          )}

          {/* IDLE state: prompt to start */}
          {state.role === 'idle' && (
            <div className="text-center space-y-2 py-4">
              <p className="text-sm text-slate-300">
                Pick a video file to start a synced watch party.
              </p>
              <p className="text-xs text-slate-500">
                Each peer loads their own local copy; Sendie syncs play, pause, and seek.
              </p>
              <button
                onClick={handlePickFile}
                className="px-4 py-2 rounded-md text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white transition-colors"
              >
                🎬 Start watch party
              </button>
            </div>
          )}

          {/* FOLLOWER without a file yet: prompt to load matching */}
          {state.role === 'follower' && !state.localFile && (
            <div className="space-y-2">
              <p className="text-sm text-slate-200">
                <span className="font-mono text-slate-100">{state.mediaName}</span> is being watched.
              </p>
              <p className="text-xs text-slate-500">
                Pick your local copy of this file to join. We don&apos;t verify the bytes match —
                use the same movie at the same encoding for best sync.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handlePickFile}
                  className="px-3 py-1.5 rounded-md text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white transition-colors"
                >
                  Pick local file
                </button>
                <button
                  onClick={handleLeave}
                  className="px-3 py-1.5 rounded-md text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                >
                  Decline
                </button>
              </div>
            </div>
          )}

          {/* HOST or FOLLOWER with a file loaded: show the player */}
          {state.localFile && (
            <WatchPartyPlayer state={state} peers={peers} onLeave={handleLeave} />
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,audio/*"
            className="hidden"
            onChange={handleFileSelected}
          />
        </div>
      )}
    </div>
  );
}

interface PlayerProps {
  state: WatchPartyState;
  peers: ReadonlyMap<string, WatchPartyPeerInfo>;
  onLeave: () => void;
}

function WatchPartyPlayer({ state, peers, onLeave }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  // Local mirror of the playback rate so the dropdown knows what's
  // active. Updated in sync with the video element by the
  // WatchPartyService for the host, by the drift loop for followers.
  const [playbackRate, setPlaybackRate] = useState(1);

  // Convert the File to an object URL exactly once. Revoke on unmount
  // to free the kernel-side resources.
  useEffect(() => {
    if (!state.localFile) return;
    const url = URL.createObjectURL(state.localFile);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [state.localFile]);

  // Bind the video element to the watch-party service. Service sets up
  // the drift loop on followers and event forwarding on the host.
  useEffect(() => {
    if (!videoRef.current) return;
    const detach = watchPartyService.attachVideoElement(videoRef.current);
    return detach;
  }, [objectUrl]);

  // Track playbackRate changes from outside (the service sets
  // videoEl.playbackRate during drift correction; we want our
  // dropdown to reflect that without forcing a re-render every frame).
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onRate = () => setPlaybackRate(el.playbackRate);
    el.addEventListener('ratechange', onRate);
    return () => el.removeEventListener('ratechange', onRate);
  }, [objectUrl]);

  const isHost = state.role === 'host';

  // Host controls: explicit buttons rather than relying solely on the
  // <video controls> attribute, because we want to route them through
  // the service so the lookahead-reservation pattern applies.
  const handlePlay = () => isHost && watchPartyService.hostPlay();
  const handlePause = () => isHost && watchPartyService.hostPause();
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isHost) return;
    const seconds = parseFloat(e.target.value);
    watchPartyService.hostSeek(seconds);
  };
  const handleRate = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!isHost) return;
    const rate = parseFloat(e.target.value);
    watchPartyService.hostSetPlaybackRate(rate);
  };

  // Render readiness summary: ready / total accepted (excluding idle).
  const readyCount = Array.from(peers.values()).filter((p) => p.state === 'ready').length;
  const totalCount = peers.size;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-slate-400 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate font-mono text-slate-300" title={state.mediaName ?? ''}>
            {state.mediaName}
          </span>
          {state.localFile && (
            <span className="text-slate-500 shrink-0">
              {formatFileSize(state.localFile.size)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span title={`${readyCount} of ${totalCount} peers ready`}>
            {readyCount}/{totalCount} ready
          </span>
          <button
            onClick={onLeave}
            className="px-2 py-1 rounded text-xs text-slate-300 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Leave the watch party"
          >
            Leave
          </button>
        </div>
      </div>

      {objectUrl && (
        <video
          ref={videoRef}
          src={objectUrl}
          // Followers must NOT show native controls (would let them
          // desync). Hosts get controls so they can scrub via the
          // browser's UI; we forward play/pause/seeked via service.
          controls={isHost}
          playsInline
          // Followers need to attempt unmuted playback to sync audio,
          // which requires an autoplay-with-sound exception. Browsers
          // grant this only after a user gesture; the click-to-pick
          // flow upstream usually counts. If it doesn't, the service
          // surfaces 'click to enable playback' via state.error.
          className="w-full max-h-[60vh] rounded bg-black border border-slate-700"
        />
      )}

      {/* Custom seekbar / rate picker for the host, since the service
          intercepts these to apply lookahead reservation. Followers
          see a read-only progress strip with peer dots. */}
      {isHost && state.mediaDuration > 0 && (
        <HostControls
          duration={state.mediaDuration}
          videoRef={videoRef}
          playbackRate={playbackRate}
          onPlay={handlePlay}
          onPause={handlePause}
          onSeek={handleSeek}
          onRate={handleRate}
        />
      )}

      <PeerStrip peers={peers} duration={state.mediaDuration} />
    </div>
  );
}

interface HostControlsProps {
  duration: number;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  playbackRate: number;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRate: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}

function HostControls({ duration, videoRef, playbackRate, onPlay, onPause, onSeek, onRate }: HostControlsProps) {
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);

  // Drive the time slider from the underlying element.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    const onTime = () => setTime(el.currentTime);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('timeupdate', onTime);
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('timeupdate', onTime);
    };
  }, [videoRef]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {paused ? (
        <button
          onClick={onPlay}
          className="px-3 py-1 rounded text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white"
          title="Play (synced for everyone)"
        >
          ▶ Play
        </button>
      ) : (
        <button
          onClick={onPause}
          className="px-3 py-1 rounded text-sm font-medium bg-slate-700 hover:bg-slate-600 text-white"
          title="Pause (synced for everyone)"
        >
          ⏸ Pause
        </button>
      )}
      <input
        type="range"
        min={0}
        max={duration}
        step={0.5}
        value={time}
        onChange={onSeek}
        className="flex-1 min-w-[8rem] accent-purple-500"
        title={`Seek (synced for everyone) — ${fmtTime(time)} / ${fmtTime(duration)}`}
      />
      <span className="text-xs font-mono text-slate-400 tabular-nums">
        {fmtTime(time)} / {fmtTime(duration)}
      </span>
      <select
        value={playbackRate}
        onChange={onRate}
        className="text-xs bg-slate-950/60 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200"
        title="Playback rate (synced for everyone)"
      >
        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
          <option key={r} value={r}>{r}x</option>
        ))}
      </select>
    </div>
  );
}

interface PeerStripProps {
  peers: ReadonlyMap<string, WatchPartyPeerInfo>;
  duration: number;
}

function PeerStrip({ peers, duration }: PeerStripProps) {
  const peerStore = useAppStore((s) => s.peers);
  const localFriendlyName = useAppStore((s) => s.connection.localFriendlyName);
  if (peers.size === 0) return null;
  const labelFor = (peerId: string): string => {
    if (peerId === 'self') return 'you';
    const fn = peerStore.get(peerId)?.friendlyName;
    if (fn) return fn;
    // The host's own row uses the local connection id, which is not in
    // the peer store; show the user's own friendly name.
    if (localFriendlyName) return `${localFriendlyName} (you)`;
    return peerId.slice(0, 8);
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2 text-xs text-slate-400">
        {Array.from(peers.values()).map((p) => {
          const dotColor =
            p.state === 'idle'      ? 'bg-slate-500'  :
            p.state === 'buffering' ? 'bg-amber-400'  :
                                      'bg-emerald-400';
          const pct = duration > 0 && p.mediaTime !== undefined
            ? `${Math.min(100, (p.mediaTime / duration) * 100).toFixed(0)}%`
            : '–';
          const label = labelFor(p.peerId);
          return (
            <div
              key={p.peerId}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-800/50 border border-slate-700/30"
              title={`${label}: ${p.state}${p.mediaTime !== undefined ? ` at ${fmtTime(p.mediaTime)}` : ''}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
              <span className="font-mono text-[10px] text-slate-300 truncate max-w-[8rem]">
                {label}
              </span>
              <span className="text-[10px] text-slate-500 tabular-nums">{pct}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
