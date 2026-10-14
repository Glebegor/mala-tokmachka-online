import { DEFAULT_SETTINGS, type RoomInfo, type RoomSettings, type RoomSlot } from '@sw/core';

export const MAX_TEAM_SIZE = 8;

export type Room = RoomInfo;

export function slotsOf(room: Room, team: 0 | 1) {
  return room.slots.filter((s) => s.team === team);
}

export function addSlot(room: Room, slot: RoomSlot): boolean {
  if (room.status !== 'open') return false;
  if (slotsOf(room, slot.team).length >= room.settings.teamSize) return false;
  room.slots.push(slot);
  return true;
}

let botCounter = 0;
export const newBot = (team: 0 | 1): RoomSlot => ({ id: `bot-${Date.now().toString(36)}-${botCounter++}`, name: '', team, bot: true });

export function nameBots(room: Room) {
  for (const team of [0, 1] as const) {
    slotsOf(room, team).filter((s) => s.bot).forEach((s, i) => (s.name = `Bot ${team === 0 ? 'UA' : 'RU'}-${i + 1}`));
  }
}

/** Pad teams with bots: up to teamSize when fillBots is on, otherwise just guarantee one unit per side. */
export function fillWithBots(room: Room) {
  for (const team of [0, 1] as const) {
    const target = room.settings.fillBots ? room.settings.teamSize : 1;
    while (slotsOf(room, team).length < target) room.slots.push(newBot(team));
  }
  nameBots(room);
}

export function sanitizeSettings(input: Partial<RoomSettings> | undefined, base: RoomSettings = DEFAULT_SETTINGS): RoomSettings {
  const i = input ?? {};
  const oneOf = <T,>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  return {
    mapId: typeof i.mapId === 'string' && i.mapId.length < 40 ? i.mapId : base.mapId,
    matchMinutes: Number(i.matchMinutes) === 0 ? 0 : Math.min(90, Math.max(5, Math.round(Number(i.matchMinutes ?? base.matchMinutes)) || base.matchMinutes)),
    teamSize: Math.min(MAX_TEAM_SIZE, Math.max(1, Math.round(Number(i.teamSize ?? base.teamSize)) || base.teamSize)),
    fillBots: typeof i.fillBots === 'boolean' ? i.fillBots : base.fillBots,
    botDifficulty: oneOf(i.botDifficulty, ['easy', 'normal', 'hard'] as const, base.botDifficulty),
    startResources: oneOf(i.startResources, ['low', 'normal', 'high'] as const, base.startResources),
    frontSpeed: oneOf(Number(i.frontSpeed), [0.5, 1, 2] as const, base.frontSpeed),
    fogOfWar: typeof i.fogOfWar === 'boolean' ? i.fogOfWar : base.fogOfWar,
  };
}
