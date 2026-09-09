/**
 * Elapsed since a background command started. There is no fire time to count
 * down to, so the desk badge shows how long the task has been running instead.
 */
export function formatElapsed(startedAt: string | undefined, now: number = Date.now()): string {
  if (!startedAt) return '';
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '';
  const secs = Math.max(0, Math.floor((now - started) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60 > 0 ? ` ${mins % 60}m` : ''}`;
}
