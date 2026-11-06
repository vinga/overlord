import type { Session } from '../types';

// Raw shell sessions flip working/waiting on every burst of output, and notes
// sit in `waiting` forever — neither is agent activity.
export const isAgent = (s: Session) => s.sessionType !== 'raw' && s.sessionType !== 'note';

export const isBusy = (s: Session) => isAgent(s) && (s.state === 'working' || s.state === 'thinking');

/** The agent's turn ended — it stopped writing, even if a wakeup or
 *  background command will resume it later. Drives the unseen dot. */
export const turnEnded = (s: Session) => isAgent(s) && s.state === 'waiting';

/** Background command, Monitor watch, or scheduled wakeup in flight. */
export const hasBackground = (s: Session) => isAgent(s)
  && ((s.backgroundTasks?.length ?? 0) > 0 || (s.activeMonitors?.length ?? 0) > 0 || s.scheduledWakeupAt != null);
