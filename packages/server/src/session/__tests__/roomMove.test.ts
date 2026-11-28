import { describe, it, expect } from 'vitest';
import { matchRoom, sessionRoomCwd, type RoomRef } from '../roomConfig.js';

const rooms: RoomRef[] = [
  { id: 'Users-me-work-api', name: 'api', cwd: '/Users/me/work/api' },
  { id: 'Users-me-play-api', name: 'api', cwd: '/Users/me/play/api' },
  { id: 'Users-me-work-Overlord', name: 'Overlord', cwd: '/Users/me/work/Overlord' },
];

describe('sessionRoomCwd', () => {
  it('is the folder the session runs in when it was never moved', () => {
    expect(sessionRoomCwd({ cwd: '/a' })).toBe('/a');
  });

  it('is the override once the session was moved', () => {
    expect(sessionRoomCwd({ cwd: '/a', roomCwd: '/b' })).toBe('/b');
  });

  it('ignores an empty override', () => {
    expect(sessionRoomCwd({ cwd: '/a', roomCwd: '' })).toBe('/a');
  });
});

describe('matchRoom', () => {
  it('matches a room id', () => {
    expect(matchRoom(rooms, 'Users-me-play-api')).toEqual({ room: rooms[1] });
  });

  it('matches a folder, with or without a trailing slash', () => {
    expect(matchRoom(rooms, '/Users/me/work/api')).toEqual({ room: rooms[0] });
    expect(matchRoom(rooms, '/Users/me/work/api/')).toEqual({ room: rooms[0] });
  });

  it('matches a unique name case-insensitively', () => {
    expect(matchRoom(rooms, 'overlord')).toEqual({ room: rooms[2] });
    expect(matchRoom(rooms, '  Overlord ')).toEqual({ room: rooms[2] });
  });

  it('reports every room sharing an ambiguous name', () => {
    expect(matchRoom(rooms, 'api')).toEqual({ candidates: [rooms[0], rooms[1]] });
  });

  it('reports no candidates for an unknown room', () => {
    expect(matchRoom(rooms, 'nope')).toEqual({ candidates: [] });
  });

  it('does not match a name prefix', () => {
    expect(matchRoom(rooms, 'Over')).toEqual({ candidates: [] });
  });
});
