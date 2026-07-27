/**
 * Client feature flags, read from Vite env at build / dev-server start.
 * Toggling any of these requires restarting the client (values are baked in).
 */

/**
 * Per-room session name prefix — the `prefix…` input in the room spawn dialog,
 * persisted per room in `/api/room-config` and prepended to spawned session names.
 *
 * OFF by default. Set `VITE_OVERLORD_ROOM_PREFIX=1` to restore the old behavior.
 * The server keeps storing the `prefix` field either way, so existing values
 * survive and come straight back when the flag is turned on.
 */
export const ROOM_PREFIX_ENABLED =
  import.meta.env.VITE_OVERLORD_ROOM_PREFIX === '1' ||
  import.meta.env.VITE_OVERLORD_ROOM_PREFIX === 'true';
