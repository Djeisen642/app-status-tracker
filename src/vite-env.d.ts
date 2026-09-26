/// <reference types="vite/client" />

/** The app version, from package.json (see vite.config.ts). */
declare const __APP_VERSION__: string;
/** The short commit hash this was built from, or `null` outside a git checkout. */
declare const __BUILD_COMMIT__: string | null;
/** When `vite build`/`vite dev` started, as an ISO 8601 timestamp. */
declare const __BUILD_DATE__: string;
