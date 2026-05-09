import { useEffect, useRef, useState } from 'react';

/**
 * Cross-vendor fullscreen helpers. iOS Safari exposes a separate
 * webkitEnterFullscreen on HTMLVideoElement (not on arbitrary elements
 * via requestFullscreen) for a long time; we try the standard API first
 * and fall back to it.
 *
 * Returns true if a fullscreen API was available and invoked.
 */
type IOSVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type IOSDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };

function enterFullscreen(el: HTMLElement): boolean {
  const video = el as IOSVideo;
  if (typeof el.requestFullscreen === 'function') {
    el.requestFullscreen().catch(() => {});
    return true;
  }
  if (typeof video.webkitEnterFullscreen === 'function') {
    video.webkitEnterFullscreen();
    return true;
  }
  return false;
}

function exitFullscreen(): void {
  const doc = document as IOSDoc;
  if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
    void document.exitFullscreen();
  } else if (doc.webkitFullscreenElement && typeof doc.webkitExitFullscreen === 'function') {
    doc.webkitExitFullscreen();
  }
}

interface VideoTileProps {
  /** Bound on mount; the parent service must supply a valid stream. */
  getStream: () => MediaStream | null;
  /** Subscribe-once handle; calls cb whenever the stream for this peer changes. */
  onStreamChanged: (cb: () => void) => () => void;
  /** Top-left label text. */
  label: string;
  /** Optional second-line muted speaker indicator. */
  micMuted?: boolean;
  /** Tailwind size classes for the wrapper, e.g. 'w-64 max-h-48' or 'w-full'. */
  sizeClasses: string;
  /** What kind of content this is. Affects the icon and whether the
   *  receiver should default to mute (camera = silent, screen = audio
   *  follows the stream). */
  kind: 'camera' | 'screen';
  /** Whether to show audio mute toggle. Driven by the parent because
   *  it's the parent that knows whether the stream has audio tracks. */
  hasAudio?: boolean;
  /** Optional extra controls in the bottom-right (mute toggle, etc.). */
  rightControls?: React.ReactNode;
  /** Receives the underlying <video> element so callers can imperatively
   *  drive el.muted / el.play() (used for screen-share audio toggle). */
  videoElRef?: React.MutableRefObject<HTMLVideoElement | null>;
  /** Called the first time autoplay() rejects, e.g. autoplay-with-sound
   *  blocked. The caller can render a "click to enable audio" overlay. */
  onAutoplayBlocked?: () => void;
}

/**
 * Common <video> tile with:
 *   - object-contain so portrait-orientation phone footage letterboxes
 *     instead of being center-cropped to a 16:9 box
 *   - explicit play() after every srcObject swap for iOS Safari
 *   - tap-to-toggle controls overlay so the fullscreen button doesn't
 *     compete with the video for attention all the time
 *   - cross-vendor fullscreen including iOS webkitEnterFullscreen
 */
export function VideoTile({
  getStream,
  onStreamChanged,
  label,
  micMuted,
  sizeClasses,
  kind,
  rightControls,
  videoElRef,
  onAutoplayBlocked,
}: VideoTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const innerVideoRef = useRef<HTMLVideoElement | null>(null);
  const [controlsVisible, setControlsVisible] = useState(false);
  // Track our own fullscreen state so we can swap the enter/exit
  // button rather than always showing both. fullscreenchange fires on
  // both standard and webkit-prefixed APIs.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => {
      const doc = document as IOSDoc;
      const fsEl = document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      // Treat "in fullscreen" as "this tile's container or its video is
      // the fullscreen element". Comparing to null catches the exit
      // case on both standard and webkit-prefixed APIs.
      setIsFullscreen(
        fsEl === containerRef.current || fsEl === innerVideoRef.current,
      );
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // Forward our internal ref to the optional caller-supplied ref.
  const setVideoRef = (el: HTMLVideoElement | null) => {
    innerVideoRef.current = el;
    if (videoElRef) videoElRef.current = el;
  };

  useEffect(() => {
    const bind = () => {
      const el = innerVideoRef.current;
      if (!el) return;
      const stream = getStream();
      if (el.srcObject !== stream) {
        el.srcObject = stream ?? null;
      }
      if (stream) {
        // play() must be re-called when srcObject changes. iOS will
        // honor the call even without a user gesture as long as the
        // video stays muted (camera) or the stream's audio was opted
        // into via a user gesture upstream (screen-share).
        el.play().catch(() => {
          // Autoplay rejected; the user can tap the tile to start it.
          onAutoplayBlocked?.();
        });
      }
    };
    bind();
    const unsub = onStreamChanged(bind);
    return unsub;
  }, [getStream, onStreamChanged, onAutoplayBlocked]);

  // Auto-hide overlay controls after a couple seconds of inactivity.
  useEffect(() => {
    if (!controlsVisible) return;
    const id = window.setTimeout(() => setControlsVisible(false), 2500);
    return () => window.clearTimeout(id);
  }, [controlsVisible]);

  const handleTileClick = () => {
    setControlsVisible((v) => !v);
  };

  const handleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Prefer fullscreening the wrapper div (so labels and our overlay
    // come along). On iOS where requestFullscreen is missing on
    // arbitrary elements, fall back to the <video>'s native API,
    // which does its own fullscreen presentation without our chrome.
    const target = containerRef.current ?? innerVideoRef.current;
    if (!target) return;
    if (!enterFullscreen(target) && innerVideoRef.current) {
      enterFullscreen(innerVideoRef.current);
    }
  };

  const handleExitFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    exitFullscreen();
  };

  const icon = kind === 'screen' ? '🖥️' : '👤';

  return (
    <div
      ref={containerRef}
      onClick={handleTileClick}
      className={`relative group bg-black rounded border border-slate-700 overflow-hidden ${sizeClasses}`}
    >
      <video
        ref={setVideoRef}
        autoPlay
        playsInline
        // object-contain letterboxes portrait sources (phone vertical
        // video) inside a landscape container instead of center-cropping
        // to a 9:16 sliver. The black background fills the gaps, which
        // is what every video player does.
        className="w-full h-full object-contain bg-black"
      />

      {/* Bottom-left label, always visible but subtle. */}
      <div className="pointer-events-none absolute bottom-1 left-1 px-2 py-0.5 bg-black/70 rounded text-xs text-white font-mono flex items-center gap-1.5">
        <span aria-hidden>{icon}</span>
        <span className="truncate max-w-[12rem]">{label}</span>
        {kind === 'screen' && <span className="text-slate-400 text-[10px]">screen</span>}
        {micMuted && (
          <span className="text-slate-400" title="Microphone muted">🔇</span>
        )}
      </div>

      {/* Right-side controls: shown on hover (desktop) or tap (mobile).
          Pointer-events on the inner buttons ensure clicks on them
          don't bubble back into handleTileClick. */}
      <div
        className={`
          absolute top-1 right-1 flex items-center gap-1
          transition-opacity duration-150
          ${controlsVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
        `}
      >
        {rightControls}
        {!isFullscreen && (
          <button
            onClick={handleFullscreen}
            className="p-1.5 bg-black/60 hover:bg-black/80 rounded text-white transition-colors"
            title="Fullscreen"
            aria-label="Fullscreen"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5" />
            </svg>
          </button>
        )}
        {isFullscreen && (
          <button
            onClick={handleExitFullscreen}
            className="p-1.5 bg-black/60 hover:bg-black/80 rounded text-white transition-colors"
            title="Exit fullscreen"
            aria-label="Exit fullscreen"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
