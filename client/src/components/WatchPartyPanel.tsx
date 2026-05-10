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
  // Mode chosen at the IDLE prompt; remembered until the file is
  // selected. 'stream' (default) lets receivers join with no setup.
  // 'local' is the BYO-file fallback.
  const [pendingMode, setPendingMode] = useState<'stream' | 'local'>('stream');

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset for re-pick
    if (!file) return;
    if (state.role === 'idle') {
      try {
        await watchPartyService.startAsHost(file, pendingMode);
      } catch (err) {
        console.error('Watch party start failed:', err);
        // surface to user via state.error path
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

          {/* IDLE state: pick mode then file */}
          {state.role === 'idle' && (
            <div className="space-y-3 py-2">
              <p className="text-sm text-slate-300">
                Watch a video together with everyone in this session.
              </p>
              <div className="grid gap-2">
                <label
                  className={`flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors ${
                    pendingMode === 'stream'
                      ? 'border-purple-500/60 bg-purple-500/10'
                      : 'border-slate-700/50 hover:bg-white/5'
                  }`}
                >
                  <input
                    type="radio"
                    name="wp-mode"
                    value="stream"
                    checked={pendingMode === 'stream'}
                    onChange={() => setPendingMode('stream')}
                    className="mt-1 accent-purple-500"
                  />
                  <span className="text-xs">
                    <span className="block text-slate-200 font-medium">
                      Stream live (recommended)
                    </span>
                    <span className="block text-slate-500">
                      You play the file, friends watch it streamed in real time. No setup
                      for them. Up to 4 viewers.
                    </span>
                  </span>
                </label>
                <label
                  className={`flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors ${
                    pendingMode === 'local'
                      ? 'border-purple-500/60 bg-purple-500/10'
                      : 'border-slate-700/50 hover:bg-white/5'
                  }`}
                >
                  <input
                    type="radio"
                    name="wp-mode"
                    value="local"
                    checked={pendingMode === 'local'}
                    onChange={() => setPendingMode('local')}
                    className="mt-1 accent-purple-500"
                  />
                  <span className="text-xs">
                    <span className="block text-slate-200 font-medium">
                      Local-file sync
                    </span>
                    <span className="block text-slate-500">
                      Everyone loads their own copy of the same file; Sendie just syncs
                      play, pause, and seek. Best quality and works for big rooms, but
                      every peer needs the file already.
                    </span>
                  </span>
                </label>
              </div>
              <button
                onClick={handlePickFile}
                className="w-full px-4 py-2 rounded-md text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white transition-colors"
              >
                🎬 Pick a video to start
              </button>
            </div>
          )}

          {/* FOLLOWER, local mode without a file yet: prompt to load matching */}
          {state.role === 'follower' && state.mode === 'local' && !state.localFile && (
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

          {/* HOST in either mode (with a file), or FOLLOWER in local mode with a file: show local-source player */}
          {state.localFile && (
            <WatchPartyPlayer state={state} peers={peers} onLeave={handleLeave} />
          )}

          {/* FOLLOWER in stream mode: show the incoming RTC stream */}
          {state.role === 'follower' && state.mode === 'stream' && (
            <StreamFollowerView state={state} peers={peers} onLeave={handleLeave} />
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
  // Stream-mode host diagnostic: number of MediaStreamTracks currently
  // produced by captureStream(). 0 means we are not actually streaming
  // anything (the source hasn't started playing); UI shows a big
  // 'Click to start streaming' overlay in that case.
  const [streamTracks, setStreamTracks] = useState(0);
  const [paused, setPaused] = useState(true);
  const [decodeError, setDecodeError] = useState<string | null>(null);

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
  // In stream mode, also pipe the rendered output into the WebRTC fanout.
  useEffect(() => {
    if (!videoRef.current) return;
    const detach = watchPartyService.attachVideoElement(videoRef.current);
    let detachStream: () => void = () => {};
    if (state.role === 'host' && state.mode === 'stream') {
      detachStream = watchPartyService.attachStreamSourceElement(videoRef.current);
    }
    return () => {
      detach();
      detachStream();
    };
  }, [objectUrl, state.role, state.mode]);

  // Watch the host's stream-track count + decode errors. Drives the
  // 'Click to start streaming' overlay and the codec error message.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const updateTracks = () => {
      setStreamTracks(watchPartyService.getStreamTrackCount());
    };
    const onPlay = () => { setPaused(false); updateTracks(); };
    const onPause = () => { setPaused(true); updateTracks(); };
    const onError = () => {
      const err = el.error;
      const msg = err?.code === 4
        ? 'This file format is not playable in your browser. Try a different file (H.264/AAC mp4 works in all browsers).'
        : err?.message || 'Video playback error.';
      setDecodeError(msg);
    };
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('error', onError);
    const i = window.setInterval(updateTracks, 500);
    updateTracks();
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('error', onError);
      clearInterval(i);
    };
  }, [objectUrl]);

  const handleStartStream = () => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = true; // muted autoplay is universally allowed
    el.play().catch((err) => {
      console.error('[watch-party] manual play() failed:', err);
    });
  };

  // Track playbackRate changes from outside.
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

      {decodeError && (
        <p className="text-xs text-red-300/90 bg-red-500/10 border border-red-500/30 rounded p-2">
          {decodeError}
        </p>
      )}

      {objectUrl && (
        <div className="relative">
          <video
            ref={videoRef}
            src={objectUrl}
            // Followers must NOT show native controls (would let them
            // desync). Hosts get controls so they can scrub via the
            // browser's UI; we forward play/pause/seeked via service.
            controls={isHost}
            playsInline
            // Critical for stream mode: captureStream() returns an empty
            // MediaStream until the element actually plays, so followers
            // would be stuck on 'connecting...' forever if the host's
            // <video> doesn't start. Per HTML spec, captureStream()
            // taps audio upstream of the mute stage, so muting the
            // host's local playback does NOT silence what peers receive.
            // The host can click the speaker icon to unmute for
            // themselves.
            autoPlay={isHost}
            muted={isHost && state.mode === 'stream'}
            className="w-full max-h-[60vh] rounded bg-black border border-slate-700"
          />
          {/* Stream-mode host overlay: shows whenever we don't yet have
              live tracks flowing. The big button forces a play() on a
              fresh user-gesture click, which always succeeds. */}
          {isHost && state.mode === 'stream' && (paused || streamTracks === 0) && !decodeError && (
            <button
              onClick={handleStartStream}
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white"
            >
              <span className="text-2xl">▶</span>
              <span className="text-sm font-medium">Click to start streaming</span>
              <span className="text-[11px] text-slate-300">
                Tracks live: {streamTracks} (need at least 1)
              </span>
            </button>
          )}
        </div>
      )}
      {isHost && state.mode === 'stream' && !decodeError && (
        <p className="text-[11px] text-slate-500">
          Your video plays muted locally so it could start automatically; viewers still
          hear audio. Click the speaker icon in the player to unmute for yourself.
          {streamTracks > 0 && ` Streaming ${streamTracks} track${streamTracks === 1 ? '' : 's'} to viewers.`}
        </p>
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

interface StreamFollowerProps {
  state: WatchPartyState;
  peers: ReadonlyMap<string, WatchPartyPeerInfo>;
  onLeave: () => void;
}

function StreamFollowerView({ state, peers, onLeave }: StreamFollowerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hasStream, setHasStream] = useState<boolean>(() => watchPartyService.getRemoteStream() !== null);
  const [needsClickToPlay, setNeedsClickToPlay] = useState(false);

  // Subscribe to remote-stream changes from the service. When the host's
  // RTC track lands, bind it to <video srcObject> and play().
  useEffect(() => {
    const bind = () => {
      const stream = watchPartyService.getRemoteStream();
      const el = videoRef.current;
      if (!el) return;
      if (stream) {
        if (el.srcObject !== stream) {
          el.srcObject = stream;
        }
        // play() may be rejected by autoplay policy if the user has
        // not gestured. Show a 'click to play' prompt rather than
        // silently failing.
        el.play().then(() => setNeedsClickToPlay(false)).catch(() => setNeedsClickToPlay(true));
        setHasStream(true);
      } else {
        el.srcObject = null;
        setHasStream(false);
      }
    };
    bind();
    const off = watchPartyService.onRemoteStreamChanged(bind);
    return () => { off(); };
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-slate-400 flex-wrap">
        <div className="min-w-0">
          <span className="truncate font-mono text-slate-300" title={state.mediaName ?? ''}>
            {state.mediaName || 'Streaming'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!hasStream && <span className="text-slate-500">connecting…</span>}
          <button
            onClick={onLeave}
            className="px-2 py-1 rounded text-xs text-slate-300 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Leave the watch party"
          >
            Leave
          </button>
        </div>
      </div>
      <div className="relative">
        <video
          ref={videoRef}
          // No controls; the host owns the timeline. Mute toggle could be
          // wired later; for v1.5 the user uses the system volume.
          playsInline
          autoPlay
          className="w-full max-h-[60vh] rounded bg-black border border-slate-700"
        />
        {needsClickToPlay && (
          <button
            onClick={() => {
              videoRef.current?.play().then(() => setNeedsClickToPlay(false)).catch(() => {});
            }}
            className="absolute inset-0 flex items-center justify-center bg-black/60 text-white text-sm font-medium"
          >
            ▶ Click to start watching
          </button>
        )}
      </div>
      <PeerStrip peers={peers} duration={state.mediaDuration} />
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
