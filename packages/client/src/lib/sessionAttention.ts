import type { Session } from '../types';

// Raw shell sessions flip working/waiting on every burst of output, and notes
// sit in `waiting` forever — neither is agent activity.
export const isAgent = (s: Session) => s.sessionType !== 'raw' && s.sessionType !== 'note';

export const isBusy = (s: Session) => isAgent(s) && (s.state === 'working' || s.state === 'thinking');

/** Waiting on the user, not on a machine: a pending wakeup or background
 *  command means the harness will resume the session by itself. */
export const needsUser = (s: Session) => isAgent(s) && s.state === 'waiting'
  && s.scheduledWakeupAt == null && !(s.backgroundTasks?.length);

/** Background command, Monitor watch, or scheduled wakeup in flight. */
export const hasBackground = (s: Session) => isAgent(s)
  && ((s.backgroundTasks?.length ?? 0) > 0 || (s.activeMonitors?.length ?? 0) > 0 || s.scheduledWakeupAt != null);
