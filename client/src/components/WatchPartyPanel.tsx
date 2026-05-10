import { useEffect, useRef, useState } from 'react';
import { watchPartyService, loadResumePoint } from '../services';
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
  // Late-joiner toast: when a follower's transfer completes while
  // host is mid-playback, surface a 'Rewind for everyone?' prompt
  // showing the joiner's friendly name.
  const [lateJoiner, setLateJoiner] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    watchPartyService.on('onStateChange', (s) => setState({ ...s }));
    watchPartyService.on('onPeersChange', (p) => setPeers(new Map(p)));
    watchPartyService.on('onPeerCompletedForward', (peerId) => {
      setLateJoiner(peerId);
      // Auto-dismiss after 15 s if host doesn't act.
      window.setTimeout(() => {
        setLateJoiner((cur) => (cur === peerId ? null : cur));
      }, 15000);
    });
    return () => {
      watchPartyService.off('onStateChange');
      watchPartyService.off('onPeersChange');
      watchPartyService.off('onPeerCompletedForward');
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
  const [pendingMode, setPendingMode] = useState<'forward' | 'local'>('forward');

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset for re-pick
    if (!file) return;
    if (state.role === 'idle') {
      // Look up a saved resume point. If we have one and the user
      // confirms, kick off the host with a queued seek-on-ready.
      let resumeAt: number | null = null;
      const resume = await loadResumePoint(file);
      if (resume) {
        const mm = Math.floor(resume.anchorTime / 60);
        const ss = Math.floor(resume.anchorTime % 60).toString().padStart(2, '0');
        const ok = window.confirm(
          `Resume "${file.name}" at ${mm}:${ss}?\n\nClick Cancel to start from the beginning.`,
        );
        if (ok) resumeAt = resume.anchorTime;
      }
      try {
        await watchPartyService.startAsHost(file, pendingMode);
        if (resumeAt !== null) {
          // Queue the seek for once the video has metadata. The
          // attachVideoElement loadedmetadata handler runs hostSeek
          // -> which broadcasts. Until then we just remember it.
          watchPartyService.setPendingHostSeek(resumeAt);
        }
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

          {/* Late-joiner 'rewind for everyone' toast (host only). */}
          {lateJoiner && state.role === 'host' && (
            <LateJoinerToast peerId={lateJoiner} onDismiss={() => setLateJoiner(null)} />
          )}

          {/* IDLE state: pick mode then file */}
          {state.role === 'idle' && <CodecSupportBanner />}
          {state.role === 'idle' && (
            <div className="space-y-3 py-2">
              <p className="text-sm text-slate-300">
                Watch a video together with everyone in this session.
              </p>
              <div className="grid gap-2">
                <label
                  className={`flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors ${
                    pendingMode === 'forward'
                      ? 'border-purple-500/60 bg-purple-500/10'
                      : 'border-slate-700/50 hover:bg-white/5'
                  }`}
                >
                  <input
                    type="radio"
                    name="wp-mode"
                    value="forward"
                    checked={pendingMode === 'forward'}
                    onChange={() => setPendingMode('forward')}
                    className="mt-1 accent-purple-500"
                  />
                  <span className="text-xs">
                    <span className="block text-slate-200 font-medium">
                      Send and watch (recommended)
                    </span>
                    <span className="block text-slate-500">
                      You pick a file. Sendie sends it to everyone over the existing
                      peer connections, then we play it together with synced controls.
                      Receivers don&apos;t need their own copy. Time to first frame
                      depends on the slowest receiver&apos;s connection.
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
                      Local-file sync (skip transfer)
                    </span>
                    <span className="block text-slate-500">
                      Use this when every viewer ALREADY has the same file on disk.
                      Plays instantly, but each viewer has to pick their copy.
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

          {/* FOLLOWER in forward mode without a file or playbackUrl yet: show transfer progress */}
          {state.role === 'follower' && state.mode === 'forward' && !state.localFile && !state.playbackUrl && (
            <ForwardReceiverProgress state={state} onLeave={handleLeave} />
          )}

          {/* HOST or FOLLOWER once we have something to play: show the player */}
          {(state.localFile || state.playbackUrl) && (
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
  // Stream-mode host diagnostic: number of MediaStreamTracks currently
  // produced by captureStream(). 0 means we are not actually streaming
  // anything (the source hasn't started playing); UI shows a big
  // 'Click to start streaming' overlay in that case.
  const [streamTracks, setStreamTracks] = useState(0);
  const [paused, setPaused] = useState(true);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  // Mute state for the follower video. Default UNMUTED (user wants
  // sound). The drift loop attempts unmuted play first and falls back
  // to muted if the browser denies autoplay; we mirror the actual
  // element state via the volumechange event so this stays in sync.
  // Also wired to a manual toggle pill in the player overlay.
  const [followerMuted, setFollowerMuted] = useState(false);

  // Convert the File to an object URL exactly once. Revoke on unmount
  // to free the kernel-side resources. If the service has set an
  // explicit playbackUrl (e.g. a MediaSource URL for F-progressive),
  // use that instead of creating one from the File. The service owns
  // that URL's lifecycle.
  useEffect(() => {
    if (state.playbackUrl) {
      setObjectUrl(state.playbackUrl);
      return;
    }
    if (!state.localFile) return;
    const url = URL.createObjectURL(state.localFile);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [state.localFile, state.playbackUrl]);

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
    const onVolumeChange = () => { setFollowerMuted(el.muted); };
    const onError = () => {
      const err = el.error;
      const msg = err?.code === 4
        ? 'This file format is not playable in your browser. Try a different file (H.264/AAC mp4 works in all browsers).'
        : err?.message || 'Video playback error.';
      setDecodeError(msg);
    };
    // Clear stale errors when a new source loads successfully. This
    // matters for the MSE -> Blob fallback path: the MSE attempt
    // sets a decode error, then the Blob URL takes over and plays
    // fine, but the error stuck around and hid the mute pill.
    const onLoadedData = () => setDecodeError(null);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('volumechange', onVolumeChange);
    el.addEventListener('error', onError);
    el.addEventListener('loadeddata', onLoadedData);
    const i = window.setInterval(updateTracks, 500);
    updateTracks();
    onVolumeChange();
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('volumechange', onVolumeChange);
      el.removeEventListener('error', onError);
      el.removeEventListener('loadeddata', onLoadedData);
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
  // Forward-mode host gate: don't autoplay until every receiver has
  // gotten the whole file. Otherwise host plays alone for several
  // seconds while the bytes are still on the wire.
  const allPeersReceived = (() => {
    if (state.mode !== 'forward' || !isHost) return true;
    const followers = Array.from(peers.values()).filter((p) => p.peerId !== state.hostPeerId);
    if (followers.length === 0) return false; // no peers yet, wait
    // Use forwardProgress map (set by the service per peer).
    for (const f of followers) {
      const pct = state.forwardProgress.get(f.peerId) ?? 0;
      if (pct < 1) return false;
    }
    return true;
  })();

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

  // Picture-in-Picture toggle. Available in Chrome / Edge / Firefox /
  // Safari (desktop). The pop-out window is browser-managed so it
  // survives switching tabs; sync continues because the underlying
  // <video> element doesn't move (only its rendering surface does).
  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled;
  const [inPip, setInPip] = useState(false);
  // Keep the inPip flag in sync with the actual element via the
  // 'enterpictureinpicture' / 'leavepictureinpicture' events. Without
  // this, the user can exit PiP via the browser's own X button and our
  // label gets stale.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const onEnter = () => setInPip(true);
    const onLeave = () => setInPip(false);
    el.addEventListener('enterpictureinpicture', onEnter);
    el.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      el.removeEventListener('enterpictureinpicture', onEnter);
      el.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, [objectUrl]);
  const handlePip = async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement === el) {
        await document.exitPictureInPicture();
      } else {
        await el.requestPictureInPicture();
      }
    } catch (err) {
      console.warn('[watch-party] picture-in-picture request failed:', err);
    }
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
          {pipSupported && (
            <button
              onClick={handlePip}
              className="px-2 py-1 rounded text-xs text-slate-300 hover:text-slate-100 hover:bg-white/5 transition-colors"
              title={inPip ? 'Exit Picture-in-Picture' : 'Picture-in-Picture (pop video into a floating window)'}
            >
              {inPip ? '⧉ Exit PiP' : '⧉ PiP'}
            </button>
          )}
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
            // Host autoplay only when ready to start. In forward mode
            // we wait for every receiver to finish the transfer; if
            // we autoplay now, the host watches alone for several
            // seconds while the bytes are still in flight.
            autoPlay={isHost && allPeersReceived}
            muted={(isHost && state.mode === 'stream') || (!isHost && followerMuted)}
            className="w-full max-h-[60vh] rounded bg-black border border-slate-700"
          />
          {/* Forward-mode host gate: hold playback until all peers
              have received the file. Shows current per-peer progress.
              Disappears as soon as all peers hit 100%. */}
          {isHost && state.mode === 'forward' && !allPeersReceived && !decodeError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-white p-4">
              <span className="text-2xl">📡</span>
              <span className="text-sm font-medium">Sending to viewers...</span>
              <div className="w-full max-w-xs space-y-1">
                {Array.from(peers.values())
                  .filter((p) => p.peerId !== state.hostPeerId)
                  .map((p) => {
                    const pct = Math.round((state.forwardProgress.get(p.peerId) ?? 0) * 100);
                    return (
                      <div key={p.peerId} className="text-[11px]">
                        <div className="flex justify-between gap-2">
                          <span className="font-mono truncate">{p.peerId.slice(0, 8)}</span>
                          <span className="tabular-nums">{pct}%</span>
                        </div>
                        <div className="h-1 rounded bg-slate-700 overflow-hidden">
                          <div className="h-full bg-purple-400 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                {peers.size <= 1 && (
                  <p className="text-[11px] text-slate-300 text-center">
                    Waiting for at least one viewer to join...
                  </p>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                Playback will start automatically when everyone is ready.
              </p>
            </div>
          )}
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
          {/* Follower autoplay-fallback overlay. Two flavors:
              - If still paused (rare; muted autoplay should succeed),
                clicking forces play().
              - If playing but muted, show a small 'click to unmute'
                affordance in the bottom-right; clicking unmutes via
                a user gesture. */}
          {!isHost && paused && !decodeError && (
            <button
              onClick={() => {
                const el = videoRef.current;
                if (!el) return;
                // Try unmuted first (user gesture grants
                // autoplay-with-sound exemption); fall back to muted
                // if even the gesture path is denied for some reason.
                el.play().catch(() => {
                  el.muted = true;
                  el.play().catch(() => {});
                });
              }}
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white"
            >
              <span className="text-2xl">▶</span>
              <span className="text-sm font-medium">Click to start watching</span>
            </button>
          )}
          {!isHost && !paused && !decodeError && (
            <button
              onClick={() => {
                const el = videoRef.current;
                if (!el) return;
                el.muted = !el.muted;
                // volumechange listener will sync state.
              }}
              className="absolute bottom-2 right-2 px-3 py-1.5 rounded-full text-xs font-medium bg-black/70 hover:bg-black/90 text-white border border-white/20"
              title={followerMuted ? 'Unmute' : 'Mute'}
            >
              {followerMuted ? '🔇 Tap to unmute' : '🔊 Mute'}
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

      {/* Receiver progressive-playback status. When MSE is active and
          the transfer is still in flight, the player has already
          started but the user might wonder whether they're missing
          bytes. Show the receive percentage so the answer is visible. */}
      {!isHost && state.playbackUrl && state.mode === 'forward' && (
        <ProgressiveStatus state={state} />
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
          peers={peers}
          selfPeerId={state.hostPeerId}
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
  peers: ReadonlyMap<string, WatchPartyPeerInfo>;
  selfPeerId: string | null;
}

function HostControls({ duration, videoRef, playbackRate, onPlay, onPause, onSeek, onRate, peers, selfPeerId }: HostControlsProps) {
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  // Friendly-name lookup for the per-peer dot tooltips on the
  // seekbar. Mirrors PeerStrip's labelFor.
  const peerStore = useAppStore((s) => s.peers);
  const labelFor = (peerId: string): string => {
    return peerStore.get(peerId)?.friendlyName ?? peerId.slice(0, 8);
  };

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

  const skip = (delta: number) => {
    const target = Math.max(0, Math.min(duration || time + delta, time + delta));
    watchPartyService.hostSeek(target);
  };

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
      <button
        onClick={() => skip(-10)}
        className="px-2 py-1 rounded text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
        title="Back 10 seconds (synced for everyone)"
      >
        ⏪ 10s
      </button>
      <button
        onClick={() => skip(10)}
        className="px-2 py-1 rounded text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
        title="Forward 10 seconds (synced for everyone)"
      >
        10s ⏩
      </button>
      <div className="relative flex-1 min-w-[8rem]">
        <input
          type="range"
          min={0}
          max={duration}
          step={0.5}
          value={time}
          onChange={onSeek}
          className="w-full accent-purple-500"
          title={`Seek (synced for everyone) — ${fmtTime(time)} / ${fmtTime(duration)}`}
        />
        {/* Per-peer playhead dots overlaid on the seekbar. Reuses the
            mediaTime each follower already broadcasts in wp-peer-state.
            pointer-events-none so they don't block the slider. */}
        {duration > 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center">
            {Array.from(peers.values())
              .filter((p) => p.peerId !== selfPeerId && typeof p.mediaTime === 'number')
              .map((p) => {
                const pct = Math.min(100, Math.max(0, (p.mediaTime! / duration) * 100));
                const color =
                  p.state === 'idle'      ? 'bg-slate-400'  :
                  p.state === 'buffering' ? 'bg-amber-400'  :
                                            'bg-emerald-400';
                return (
                  <span
                    key={p.peerId}
                    className={`absolute h-2 w-2 rounded-full border border-slate-900 -translate-x-1/2 ${color}`}
                    style={{ left: `${pct}%` }}
                    title={`${labelFor(p.peerId)}: ${fmtTime(p.mediaTime!)}`}
                  />
                );
              })}
          </div>
        )}
      </div>
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

// Suppress unused warnings; props kept exported for ABI stability while
// we migrate other code that imports them.
export type { StreamFollowerProps as _StreamFollowerProps };

function LateJoinerToast({ peerId, onDismiss }: { peerId: string; onDismiss: () => void }) {
  const peerStore = useAppStore((s) => s.peers);
  const name = peerStore.get(peerId)?.friendlyName ?? peerId.slice(0, 8);
  const handleRewind = () => {
    watchPartyService.hostSeek(0);
    onDismiss();
  };
  return (
    <div className="flex items-center justify-between gap-2 text-xs rounded border border-purple-500/40 bg-purple-500/10 text-purple-100 p-2">
      <span>
        <span className="font-mono">{name}</span> just finished receiving. Rewind so they can watch from the start?
      </span>
      <span className="flex gap-1 shrink-0">
        <button
          onClick={handleRewind}
          className="px-2 py-1 rounded font-medium bg-purple-600 hover:bg-purple-700 text-white"
        >
          Rewind
        </button>
        <button
          onClick={onDismiss}
          className="px-2 py-1 rounded text-purple-200 hover:bg-white/5"
        >
          Dismiss
        </button>
      </span>
    </div>
  );
}

function ProgressiveStatus({ state }: { state: WatchPartyState }) {
  const hostId = state.hostPeerId ?? '';
  const pct = Math.round(((state.forwardProgress.get(hostId) ?? 0) * 100));
  if (pct >= 100) return null;
  return (
    <p className="text-[11px] text-slate-500">
      Streaming progressively while we receive — {pct}% of the file delivered.
    </p>
  );
}

function ForwardReceiverProgress({
  state,
  onLeave,
}: {
  state: WatchPartyState;
  onLeave: () => void;
}) {
  const hostId = state.hostPeerId ?? '';
  const pct = Math.round(((state.forwardProgress.get(hostId) ?? 0) * 100));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
        <span className="truncate font-mono text-slate-300" title={state.mediaName ?? ''}>
          {state.mediaName || 'Receiving file...'}
        </span>
        <button
          onClick={onLeave}
          className="px-2 py-1 rounded text-xs text-slate-300 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          Leave
        </button>
      </div>
      <div className="rounded bg-slate-950/60 border border-slate-700 p-3 space-y-2">
        <p className="text-xs text-slate-300">
          Receiving from host... playback will start automatically when the file finishes.
        </p>
        <div className="h-2 rounded bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-purple-500 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[11px] text-slate-500 tabular-nums">{pct}%</p>
      </div>
    </div>
  );
}

function CodecSupportBanner() {
  const probe = (() => {
    if (typeof document === 'undefined') return null;
    const v = document.createElement('video');
    return {
      h264: !!v.canPlayType('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'),
      webm: !!v.canPlayType('video/webm; codecs="vp8,vorbis"'),
    };
  })();
  if (!probe) return null;
  if (probe.h264) return null;
  return (
    <div className="text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 p-2 space-y-1">
      <p className="font-medium">Heads up: this browser cannot decode H.264 mp4.</p>
      <p className="text-amber-200/80">
        Firefox on Linux (and some hardened Linux installs of other browsers) ship without
        H.264/AAC codecs. mp4 watch parties will fail with &ldquo;No video with supported
        format and MIME type found.&rdquo; Workarounds:
      </p>
      <ul className="list-disc list-inside text-amber-200/80 ml-1">
        <li>Use Chrome, Edge, or Brave instead (they bundle H.264).</li>
        {probe.webm && <li>Or use a WebM/VP8 file, which works here.</li>}
        <li>
          Or install <code className="font-mono text-amber-100">ffmpeg</code> and{' '}
          <code className="font-mono text-amber-100">gstreamer-libav</code> at the OS level
          and restart Firefox.
        </li>
      </ul>
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