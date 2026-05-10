/**
 * Sendie watch-party byte-range proxy Service Worker.
 *
 * Intercepts fetches for /wp-stream/<sessionId> URLs and translates
 * them into MessageChannel requests to the registered client (the
 * receiver's page).
 *
 * Why a Service Worker? Browsers play normal mp4 / mov / mkv via
 * <video src=URL> with byte-range fetches. By making the SW the
 * "server" that responds to those fetches with bytes piped from the
 * peer's data channel, the browser's own demuxer parses the file
 * and we sidestep the entire MSE pipeline that gave us trouble.
 *
 * Lifecycle: registered on demand by the page, scope = /wp-stream/.
 * The page registers a session via a MessageChannel pair so the SW
 * can talk to the page even though the page itself is OUT of the
 * SW's scope (which would otherwise prevent the SW from finding
 * the page via clients API). The page sends one MessagePort with
 * the register-session message; SW posts range-requests on it and
 * receives range-responses on it.
 */
/* eslint-disable */
/* global self */

const VERSION = 'sendie-wp-stream-sw-4';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// sessionId -> { port, mediaSize, mediaType }
const sessions = new Map();
// requestId -> { resolve, reject }
const pendingRequests = new Map();
let nextRequestId = 1;

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'register-session') {
    const port = event.ports?.[0];
    if (!port) {
      console.warn('[wp-stream-sw] register-session missing port');
      return;
    }
    sessions.set(msg.sessionId, {
      port,
      mediaSize: msg.mediaSize,
      mediaType: msg.mediaType || 'video/mp4',
    });
    port.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'range-response') {
        const pending = pendingRequests.get(m.requestId);
        if (pending) {
          pendingRequests.delete(m.requestId);
          pending.resolve(m.data);
        }
      } else if (m.type === 'range-error') {
        const pending = pendingRequests.get(m.requestId);
        if (pending) {
          pendingRequests.delete(m.requestId);
          pending.reject(new Error(m.error || 'range failed'));
        }
      }
    };
    // Confirm registration via the same port (so caller knows we're ready).
    port.postMessage({ type: 'session-registered', sessionId: msg.sessionId });
    console.log('[wp-stream-sw] registered session', msg.sessionId, 'size', msg.mediaSize);
  } else if (msg.type === 'unregister-session') {
    const s = sessions.get(msg.sessionId);
    if (s) {
      try { s.port.close(); } catch { /* ignore */ }
      sessions.delete(msg.sessionId);
    }
  } else if (msg.type === 'ping') {
    event.source?.postMessage?.({ type: 'pong', version: VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/wp-stream/')) return;
  const parts = url.pathname.split('/').filter(Boolean);
  const sessionId = parts[1];
  if (!sessionId || sessionId === 'sw.js') return;
  const session = sessions.get(sessionId);
  if (!session) {
    console.warn('[wp-stream-sw] no session for', sessionId, 'have:', Array.from(sessions.keys()));
    event.respondWith(new Response('No such session', { status: 404 }));
    return;
  }

  const range = event.request.headers.get('Range');
  let start = 0;
  let end = session.mediaSize - 1;
  let isRange = false;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      isRange = true;
      start = parseInt(m[1], 10);
      end = m[2] ? parseInt(m[2], 10) : session.mediaSize - 1;
    }
  }
  start = Math.max(0, start);
  end = Math.min(session.mediaSize - 1, end);
  if (start > end) {
    event.respondWith(new Response('', { status: 416 }));
    return;
  }

  event.respondWith(handleRangeRequest(session, sessionId, start, end, isRange));
});

async function handleRangeRequest(session, sessionId, start, end, isRange) {
  const requestId = nextRequestId++;
  console.log('[wp-stream-sw] range', sessionId, start, '-', end, '(req', requestId, ')');

  let data;
  try {
    data = await new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      session.port.postMessage({ type: 'range-request', requestId, sessionId, start, end });
      setTimeout(() => {
        if (pendingRequests.delete(requestId)) {
          reject(new Error('range request timeout (30s)'));
        }
      }, 30000);
    });
  } catch (err) {
    console.warn('[wp-stream-sw] range failed:', err.message);
    return new Response(`Range error: ${err.message}`, { status: 502 });
  }

  const length = data.byteLength;
  const headers = new Headers({
    'Content-Type': session.mediaType,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  if (isRange) {
    headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${session.mediaSize}`);
  }
  return new Response(data, { status: isRange ? 206 : 200, headers });
}
