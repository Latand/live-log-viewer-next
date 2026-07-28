/**
 * The header a caller presents its Viewer capability on.
 *
 * Its own module, with no imports at all, because both sides of the network need it:
 * `spawnPolicy.ts` reads `node:path` and is server-only, so a client module importing
 * the constant from there drags a Node builtin into the browser bundle and fails the
 * webpack build — a break `tsc` cannot see, since the types are perfectly fine.
 *
 * `spawnPolicy` re-exports this, so there is still one definition and every existing
 * import keeps working.
 */
export const VIEWER_SPAWN_CAPABILITY_HEADER = "x-llv-spawn-capability";
