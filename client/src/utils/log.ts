/**
 * Tiny logger that suppresses chatty `debug` output in production builds.
 *
 * Why: peer connection IDs and SAS computations were being logged on every
 * event; a malicious browser extension that scrapes console output could
 * map every session a user has joined. Errors and warnings still go to the
 * console because they're useful for support.
 */

const isDev = import.meta.env.DEV;

export const log = {
  debug: isDev ? console.log.bind(console) : () => {},
  info: isDev ? console.info.bind(console) : () => {},
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
