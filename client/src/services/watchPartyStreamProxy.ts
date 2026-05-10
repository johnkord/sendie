/**
 * Page-side glue for the watch-party byte-range Service Worker.
 *
 * Receiver only. Manages the SW lifecycle and the postMessage
 * roundtrip:
 *
 *  <video src="/wp-stream/<sessionId>">
 *      |
 *      v
 *  Service Worker (public/wp-stream/sw.js)
 *      |  postMessage({ type: 'range-request', requestId, start, end })
 *      v
 *  This module's `onRangeRequest` callback
 *      |  caller forwards over data channel
 *      v
 *  Host -> wp-bytes-range-res chunks
 *      |
 *      v
 *  This module's `deliverRange(requestId, ArrayBuffer)`
 *      |  postMessage({ type: 'range-response', requestId, data }, [data])
 *      v
 *  SW resolves the original fetch with the bytes
 */

const SW_URL = '/wp-stream/sw.js';
const SW_SCOPE = '/wp-stream/';

class WatchPartyStreamProxy {
  private registrationPromise: Promise<ServiceWorker | null> | null = null;
  private rangeForwarder: ((req: { requestId: number; start: number; end: number }) => void) | null = null;

  /**
   * Lazily register the SW and resolve once it is the controller of
   * this page (so postMessage to it actually goes somewhere).
   *
   * Returns null if the browser doesn't support SW or registration
   * fails. Caller should fall back to the chunked-forward path.
   */
  async ensureRegistered(): Promise<ServiceWorker | null> {
    if (!('serviceWorker' in navigator)) return null;
    if (!this.registrationPromise) {
      this.registrationPromise = (async () => {
        try {
          const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
          // Wait for the SW to be active and controlling the page.
          // Multiple paths to active depending on whether the SW is
          // brand-new or already installed:
          //   - reg.active is non-null -> already active.
          //   - reg.installing / reg.waiting -> wait for state change.
          let sw = reg.active;
          if (!sw) {
            sw = await new Promise<ServiceWorker>((resolve) => {
              const candidate = reg.installing ?? reg.waiting;
              if (!candidate) {
                // shouldn't happen; resolve null-ish through reg.active
                // when ready event fires.
                navigator.serviceWorker.ready.then((r) => resolve(r.active!));
                return;
              }
              candidate.addEventListener('statechange', () => {
                if (candidate.state === 'activated') resolve(candidate);
              });
            });
          }
          // Make sure THIS page is now controlled by the SW. clients.claim()
          // in the SW handles this on activation, but if we just called
          // register on a fresh page we still need the controllerchange
          // event before navigator.serviceWorker.controller becomes set.
          if (!navigator.serviceWorker.controller) {
            await new Promise<void>((resolve) => {
              navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
              // Belt-and-suspenders: poll for a few hundred ms in case
              // the event already fired.
              const t = setInterval(() => {
                if (navigator.serviceWorker.controller) {
                  clearInterval(t);
                  resolve();
                }
              }, 50);
              setTimeout(() => { clearInterval(t); resolve(); }, 3000);
            });
          }
          // Wire the page-side message router.
          navigator.serviceWorker.addEventListener('message', (event) => {
            const msg = event.data;
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'range-request' && this.rangeForwarder) {
              this.rangeForwarder(msg);
            }
          });
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
    sw.postMessage({
      type: 'register-session',
      sessionId: opts.sessionId,
      mediaSize: opts.mediaSize,
      mediaType: opts.mediaType,
    });
    return `/wp-stream/${opts.sessionId}`;
  }

  /**
   * Fulfill a range request previously emitted via onRangeRequest.
   * Transfers the buffer to the SW (zero-copy where supported).
   */
  deliverRange(requestId: number, data: ArrayBuffer): void {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return;
    sw.postMessage({ type: 'range-response', requestId, data }, [data]);
  }

  failRange(requestId: number, error: string): void {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return;
    sw.postMessage({ type: 'range-error', requestId, error });
  }

  endSession(sessionId: string): void {
    const sw = navigator.serviceWorker?.controller;
    if (sw) sw.postMessage({ type: 'unregister-session', sessionId });
    this.rangeForwarder = null;
  }
}

export const watchPartyStreamProxy = new WatchPartyStreamProxy();
