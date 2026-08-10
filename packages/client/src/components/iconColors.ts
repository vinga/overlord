import type { WorkerIcon } from '../types';

/** The colour a fresh worker gets when no icon has spoken for it. */
export const DEFAULT_WORKER_COLOR = 'hsl(30, 75%, 58%)';

/**
 * Picking a glyph in the ColorPicker also applies this colour, so the office
 * grid reads at a glance (red = bug, green = ticket/done, blue = task…).
 * The session colour stays freely editable afterwards — hue/lightness presets
 * and the slider overwrite this without touching the icon.
 *
 * Keyed by WorkerIcon, so a new glyph in WORKER_ICONS fails the build here
 * until it gets a colour.
 */
export const ICON_COLORS: Record<WorkerIcon, string> = {
  user: DEFAULT_WORKER_COLOR,         // orange — the neutral default
  ticket: 'hsl(272, 70%, 64%)',       // violet — refining magic
  story: 'hsl(103, 52%, 47%)',        // grass green — JIRA story
  bug: 'hsl(0, 72%, 55%)',            // red — broken
  task: 'hsl(201, 72%, 55%)',         // blue — JIRA task
  investigate: DEFAULT_WORKER_COLOR,  // orange
  notes: DEFAULT_WORKER_COLOR,        // orange
  btw: DEFAULT_WORKER_COLOR,          // orange
  docs: DEFAULT_WORKER_COLOR,         // orange
  config: DEFAULT_WORKER_COLOR,       // orange
  teach: DEFAULT_WORKER_COLOR,        // orange
  done: 'hsl(148, 58%, 42%)',         // deep green — finished
  release: DEFAULT_WORKER_COLOR,      // orange
  dashboard: DEFAULT_WORKER_COLOR,    // orange
};
