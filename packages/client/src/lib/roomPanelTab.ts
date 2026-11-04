export type RoomPanelTab = 'details' | 'files' | 'room' | 'plans' | 'brain';

/** Ask the app to open the room panel for `roomId` on `tab`. App opens the
 *  panel; RoomPanel picks the tab — at mount from `pending`, or from the event
 *  when it is already showing that room. */
export const OPEN_ROOM_TAB_EVENT = 'overlord:openRoomTab';

let pending: { roomId: string; tab: RoomPanelTab } | null = null;

export function openRoomTab(roomId: string, tab: RoomPanelTab): void {
  pending = { roomId, tab };
  window.dispatchEvent(new CustomEvent(OPEN_ROOM_TAB_EVENT, { detail: { roomId, tab } }));
}

/** Consume a pending request for `roomId`, if any. */
export function takeRoomTab(roomId: string): RoomPanelTab | null {
  if (pending?.roomId !== roomId) return null;
  const { tab } = pending;
  pending = null;
  return tab;
}
