/// <reference types="vite/client" />

// mp4box.js ships no TypeScript types. We dynamic-import it from
// watchPartyTransmux.ts; the file declares its own minimal interface
// for the surface we use. Suppress the implicit-any module error.
declare module 'mp4box';
