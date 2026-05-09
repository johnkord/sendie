import streamSaver from 'streamsaver';

/**
 * Pin StreamSaver's MITM iframe to a self-hosted copy under /streamsaver/.
 *
 * Why: StreamSaver's default `mitm` URL points at jimmywarting.github.io.
 * That means file bytes briefly transit a service worker hosted on a
 * third-party origin in the Firefox/Safari fallback path. We host our own
 * copy in client/public/streamsaver/ so bytes never leave Sendie's origin.
 *
 * Vendored files (kept in client/public/streamsaver/, copied at build time
 * from node_modules/streamsaver via the `vendor:streamsaver` npm script):
 *   - mitm.html
 *   - sw.js
 */
streamSaver.mitm = '/streamsaver/mitm.html';

// Defense-in-depth: assert the override took. If something replaces this
// module's import with the raw library at bundle time, the runtime check
// below trips before any file bytes can flow through a third-party origin.
if (
  typeof streamSaver.mitm !== 'string'
  || streamSaver.mitm.includes('jimmywarting.github.io')
  || !streamSaver.mitm.startsWith('/streamsaver/')
) {
  throw new Error(
    `streamSaverInit: mitm override failed; got '${streamSaver.mitm}'. ` +
    'Refusing to run with a third-party StreamSaver host.',
  );
}

export { default } from 'streamsaver';
