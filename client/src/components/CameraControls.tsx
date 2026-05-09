import { useEffect, useRef, useState } from 'react';
import { cameraService, MAX_VIDEO_PEERS } from '../services';

/**
 * Start camera / Stop camera with self-preview and a device picker.
 *
 * The device picker surfaces every videoinput including OBS Virtual
 * Camera (Windows DirectShow / macOS DAL plugin / Linux v4l2loopback).
 * Without it, getUserMedia would always grab the OS default device,
 * which is usually NOT the user's preferred OBS scene; the picker fixes
 * that without forcing the user into OS-level "default device" settings.
 */
const STORAGE_KEY = 'sendie:camera-device-id';

export function CameraControls() {
  const [active, setActive] = useState(cameraService.isActive());
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const previewRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    cameraService.on('onStarted', () => {
      setActive(true);
      // After a successful getUserMedia call, device labels are populated
      // (browsers gate labels behind permission). Refresh the list so the
      // user sees real names instead of 'Camera 1'.
      void refreshDevices();
    });
    cameraService.on('onStopped', () => setActive(false));
    cameraService.on('onError', (err) => setError(err.message));
    return () => {
      cameraService.off('onStarted');
      cameraService.off('onStopped');
      cameraService.off('onError');
    };
  }, []);

  const refreshDevices = async () => {
    const list = await cameraService.listDevices();
    setDevices(list);
    // If the previously selected device is gone (OBS closed, USB cam
    // unplugged), clear the selection so the next start uses default.
    if (deviceId && !list.some((d) => d.deviceId === deviceId)) {
      setDeviceId('');
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  };

  // Initial enumerate + subscribe to devicechange. The first call before
  // permission grant returns labels as empty strings; we re-enumerate
  // after onStarted fires (above) once we have permission.
  useEffect(() => {
    void refreshDevices();
    const unsub = cameraService.onDevicesChanged(() => void refreshDevices());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bind the local stream to the preview <video> whenever active flips.
  useEffect(() => {
    if (!previewRef.current) return;
    previewRef.current.srcObject = active ? cameraService.getLocalStream() : null;
  }, [active]);

  const handleStart = async () => {
    setError(null);
    try {
      await cameraService.start({ deviceId: deviceId || undefined });
    } catch (err) {
      setError((err as Error).message ?? 'Could not start camera');
    }
  };

  const handleStop = async () => {
    await cameraService.stop();
  };

  const handleDeviceChange = (id: string) => {
    setDeviceId(id);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  // Format a label, surfacing OBS Virtual Camera distinctly. Some
  // browsers report 'OBS Virtual Camera' (Windows), 'OBS-Camera' (macOS),
  // or '/dev/video10' style v4l2loopback nodes (Linux). We match
  // case-insensitively on common substrings.
  const formatLabel = (d: MediaDeviceInfo, idx: number): string => {
    const raw = d.label || `Camera ${idx + 1}`;
    if (/obs/i.test(raw)) return `🎬 ${raw}`;
    return raw;
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {!active ? (
        <>
          <button
            onClick={handleStart}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors flex items-center gap-2"
            title={`Start camera (max ${MAX_VIDEO_PEERS} simultaneous video streams)`}
          >
            <span>📹</span>
            <span>Start camera</span>
          </button>
          {devices.length > 1 && (
            <select
              value={deviceId}
              onChange={(e) => handleDeviceChange(e.target.value)}
              className="text-xs bg-slate-950/60 border border-slate-700 rounded px-2 py-1 text-slate-200 focus:outline-none focus:border-blue-500 max-w-[18rem]"
              title="Pick a video input device, including OBS Virtual Camera if running."
            >
              <option value="">Default device</option>
              {devices.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {formatLabel(d, i)}
                </option>
              ))}
            </select>
          )}
        </>
      ) : (
        <>
          <button
            onClick={handleStop}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-red-600/30 hover:bg-red-600/50 text-red-200 border border-red-600/50 transition-colors"
            title="Stop sharing video"
          >
            ⏹ Stop
          </button>
          <video
            ref={previewRef}
            autoPlay
            muted
            playsInline
            className="h-16 w-auto rounded border border-gray-600 bg-black"
            title="Self preview"
          />
        </>
      )}
      {error && <span className="text-xs text-red-400 ml-2">{error}</span>}
    </div>
  );
}
