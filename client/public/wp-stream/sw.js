/**
 * Sendie watch-party byte-range proxy Service Worker.
 *
 * Intercepts fetches for /wp-stream/<sessionId> URLs and translates
 * them into MessageChannel requests to the registered client (the
 * receiver's page). The page handles the actual data-channel
 * roundtrip to the host.
 *
 * Why a Service Worker? Browsers play normal mp4 / mov / mkv via
 * <video src=URL> with byte-range fetches. By making the SW the
 * "server" that responds to those fetches with bytes piped from the
 * peer's data channel, the browser's own demuxer parses the file
 * and we sidestep the entire MSE pipeline that gave us trouble.
 *
 * Lifecycle: registered on demand by the page, scope = /wp-stream/.
 * Sessions are registered/unregistered explicitly so SW knows which
 * URLs to claim and which to 404.
 */
/* eslint-disable */
/* global self, clients */

const VERSION = 'sendie-wp-stream-sw-3';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// sessionId -> { clientId, mediaSize, mediaType }
const sessions = new Map();
// requestId -> { resolve, reject }
const pendingRequests = new Map();
let nextRequestId = 1;

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'register-session':
      sessions.set(msg.sessionId, {
        clientId: event.source.id,
        mediaSize: msg.mediaSize,
        mediaType: msg.mediaType || 'video/mp4',
      });
      event.source.postMessage({ type: 'session-registered', sessionId: msg.sessionId });
      break;
    case 'unregister-session':
      sessions.delete(msg.sessionId);
      break;
    case 'range-response': {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        pending.resolve(msg.data);
      }
      break;
    }
    case 'range-error': {
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        pendingRequests.delete(msg.requestId);
        pending.reject(new Error(msg.error || 'range failed'));
      }
      break;
    }
    case 'ping':
      event.source.postMessage({ type: 'pong', version: VERSION });
      break;
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/wp-stream/')) return;
  // /wp-stream/<sessionId>; ignore /wp-stream/sw.js itself.
  const parts = url.pathname.split('/').filter(Boolean);
  const sessionId = parts[1];
  if (!sessionId || sessionId === 'sw.js') return;
  const session = sessions.get(sessionId);
  if (!session) {
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
  const client = await self.clients.get(session.clientId);
  if (!client) {
    return new Response('Client gone', { status: 503 });
  }

  // Ask the page to fetch this range over the data channel.
  client.postMessage({ type: 'range-request', requestId, sessionId, start, end });

  let data;
  try {
    data = await new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (pendingRequests.delete(requestId)) {
          reject(new Error('range request timeout (30s)'));
        }
      }, 30000);
    });
  } catch (err) {
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
