/**
 * Page-side glue for the watch-party byte-range Service Worker.
 *
 * Receiver only. Manages the SW lifecycle and a MessageChannel
 * roundtrip:
 *
 *  <video src="/wp-stream/<sessionId>">
 *      |
 *      v
 *  Service Worker (public/wp-stream/sw.js)
 *      |  port.postMessage({ type: 'range-request', requestId, start, end })
 *      v
 *  This module's `onRangeRequest` callback
 *      |  caller forwards over data channel
 *      v
 *  Host -> wp-bytes-range-res chunks
 *      |
 *      v
 *  This module's `deliverRange(requestId, ArrayBuffer)`
 *      |  port.postMessage({ type: 'range-response', requestId, data }, [data])
 *      v
 *  SW resolves the original fetch with the bytes
 *
 * MessageChannel design choice: we can't rely on
 * `navigator.serviceWorker.controller` because the page (at /) is
 * outside the SW's scope (/wp-stream/). The SW therefore can't find
 * us via clients.matchAll either. Solution: the page creates a
 * MessageChannel, sends one port to the SW with the register-session
 * message, and uses the other end as a private bidirectional channel
 * for the lifetime of the watch party.
 */

const SW_URL = '/wp-stream-sw.js';
const SW_SCOPE = '/';

class WatchPartyStreamProxy {
  private registrationPromise: Promise<ServiceWorker | null> | null = null;
  private rangeForwarder: ((req: { requestId: number; start: number; end: number }) => void) | null = null;
  // The MessagePort retained for the active session. SW posts
  // range-request on it; we post range-response on it.
  private port: MessagePort | null = null;

  /**
   * Lazily register the SW. Returns the active SW (not necessarily
   * controlling this page; we don't need that for postMessage).
   * Returns null if the browser doesn't support SW or registration
   * fails.
   */
  async ensureRegistered(): Promise<ServiceWorker | null> {
    if (!('serviceWorker' in navigator)) return null;
    if (!this.registrationPromise) {
      this.registrationPromise = (async () => {
        try {
          const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
          // Wait for the SW to be active.
          let sw = reg.active;
          if (!sw) {
            sw = await new Promise<ServiceWorker>((resolve) => {
              const candidate = reg.installing ?? reg.waiting;
              if (!candidate) {
                navigator.serviceWorker.ready.then((r) => resolve(r.active!));
                return;
              }
              candidate.addEventListener('statechange', () => {
                if (candidate.state === 'activated') resolve(candidate);
              });
            });
          }
          return sw;
        } catch (err) {
          console.warn('[wp-stream] SW registration failed:', err);
          return null;
        }
      })();
    }
    return this.registrationPromise;
  }

  /**
   * Register a session with the SW. Returns the URL the receiver's
   * <video> should bind to. The provided callback is invoked
   * asynchronously every time the SW asks for a byte range; caller
   * is expected to fetch those bytes and then call deliverRange.
   */
  async startSession(opts: {
    sessionId: string;
    mediaSize: number;
    mediaType: string;
    onRangeRequest: (req: { requestId: number; start: number; end: number }) => void;
  }): Promise<string | null> {
    const sw = await this.ensureRegistered();
    if (!sw) return null;
    this.rangeForwarder = opts.onRangeRequest;

    // Set up our private bidirectional channel.
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'range-request' && this.rangeForwarder) {
        this.rangeForwarder(msg);
      }
      // 'session-registered' confirmation arrives here too; we ignore.
    };
    // Send the other port to the SW. transfer = [port2].
    sw.postMessage({
      type: 'register-session',
      sessionId: opts.sessionId,
      mediaSize: opts.mediaSize,
      mediaType: opts.mediaType,
    }, [channel.port2]);
    return `/wp-stream/${opts.sessionId}`;
  }

  /**
   * Fulfill a range request previously emitted via onRangeRequest.
   * Transfers the buffer to the SW (zero-copy where supported).
   */
  deliverRange(requestId: number, data: ArrayBuffer): void {
    if (!this.port) return;
    this.port.postMessage({ type: 'range-response', requestId, data }, [data]);
  }

  failRange(requestId: number, error: string): void {
    if (!this.port) return;
    this.port.postMessage({ type: 'range-error', requestId, error });
  }

  endSession(sessionId: string): void {
    // Tell SW to drop the session and close our port.
    if (this.port) {
      try { this.port.close(); } catch { /* ignore */ }
      this.port = null;
    }
    // Best-effort: also notify the SW so it can drop its half.
    void (async () => {
      const sw = await this.ensureRegistered();
      sw?.postMessage({ type: 'unregister-session', sessionId });
    })();
    this.rangeForwarder = null;
  }
}

export const watchPartyStreamProxy = new WatchPartyStreamProxy();
