/**
 * Pure utility functions for bridge pipe name derivation and normalization.
 * These are extracted from index.ts to make them unit-testable.
 */

/**
 * Normalize legacy "overlord-brg-{x}" pipe names to "overlord-new-{x}".
 * The bridge binary always uses the "overlord-new-" prefix; sessions stored
 * before this convention was enforced may have the old "brg-" prefix.
 */
export function normalizePipeName(pipeName: string): string {
  if (pipeName.startsWith('overlord-brg-')) {
    return 'overlord-new-' + pipeName.slice('overlord-brg-'.length);
  }
  return pipeName;
}

/**
 * Derive a pipe name from a bridge marker embedded in a session name.
 * The marker is "brg-{ts}" (embedded as ___BRG:brg-{ts} in --name flag).
 * The bridge binary uses "overlord-new-{ts}" as the socket name.
 * So strip the "brg-" prefix and prepend "overlord-new-".
 */
export function derivePipeNameFromMarker(marker: string): string {
  const suffix = marker.startsWith('brg-') ? marker.slice(4) : marker;
  return `overlord-new-${suffix}`;
}

/**
 * Resolve the pipe name for a bridge session given a marker and optional pending entry.
 * Returns null if the pending entry has expired (>30s old), signalling the connect should abort.
 */
export function resolvePipeName(
  marker: string,
  pending: { pipeName: string; timestamp: number } | undefined,
  now: number,
): string | null {
  if (pending) {
    if (now - pending.timestamp > 30_000) return null; // expired
    return pending.pipeName;
  }
  return derivePipeNameFromMarker(marker);
}

/**
 * Determine if a bridge session is reconnecting (already seen) vs connecting for the first time.
 * Mutates the Set by adding sessionId, so `has()` MUST be called before `add()`.
 * Returns true if this is a reconnect (replay: true should be sent), false for first connect.
 */
export function computeIsReconnect(linkedSessions: Set<string>, sessionId: string): boolean {
  const isReconnect = linkedSessions.has(sessionId);
  linkedSessions.add(sessionId);
  return isReconnect;
}
