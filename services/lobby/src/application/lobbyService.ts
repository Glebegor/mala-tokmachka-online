import { randomUUID } from 'node:crypto';
import { HttpError } from '@sw/kit';
import { DEFAULT_SETTINGS, type RoomSettings } from '@sw/core';
import { addSlot, fillWithBots, nameBots, newBot, sanitizeSettings, slotsOf, type Room } from '../domain/room';

export interface MatchLauncher {
  launch(room: Room): Promise<string>;
}

export interface Identity {
  id: string;
  name: string;
}

export class LobbyService {
  private rooms = new Map<string, Room>();
  constructor(private launcher: MatchLauncher) {}

  list() {
    return [...this.rooms.values()];
  }

  get(id: string) {
    const r = this.rooms.get(id);
    if (!r) throw new HttpError(404, 'room not found');
    return r;
  }

  create(who: Identity, name: string, settings: Partial<RoomSettings> | undefined, team: 0 | 1) {
    this.leaveAll(who.id);
    const room: Room = { id: randomUUID().slice(0, 8), name: String(name || `${who.name}'s room`).slice(0, 32), host: who.id, settings: sanitizeSettings(settings, DEFAULT_SETTINGS), slots: [], status: 'open' };
    addSlot(room, { id: who.id, name: who.name, team, bot: false });
    this.rooms.set(room.id, room);
    return room;
  }

  join(who: Identity, roomId: string, team: 0 | 1) {
    const room = this.get(roomId);
    const existing = room.slots.find((s) => s.id === who.id);
    if (room.status === 'playing') {
      if (existing) return room; // rejoin a running match
      throw new HttpError(409, 'match already started');
    }
    if (existing) {
      if (existing.team !== team && slotsOf(room, team).length < room.settings.teamSize) existing.team = team;
      return room;
    }
    this.leaveAll(who.id);
    if (!addSlot(room, { id: who.id, name: who.name, team, bot: false })) throw new HttpError(409, 'team is full');
    return room;
  }

  leaveAll(playerId: string) {
    for (const room of this.rooms.values()) {
      if (room.status === 'playing') continue;
      room.slots = room.slots.filter((s) => s.id !== playerId);
      if (!room.slots.some((s) => !s.bot)) this.rooms.delete(room.id);
      else if (room.host === playerId) room.host = room.slots.find((s) => !s.bot)!.id;
    }
  }

  private hostRoom(who: Identity, roomId: string) {
    const room = this.get(roomId);
    if (room.host !== who.id) throw new HttpError(403, 'only the host can do that');
    if (room.status !== 'open') throw new HttpError(409, 'match already started');
    return room;
  }

  updateSettings(who: Identity, roomId: string, patch: Partial<RoomSettings>) {
    const room = this.hostRoom(who, roomId);
    const next = sanitizeSettings({ ...room.settings, ...patch }, room.settings);
    for (const team of [0, 1] as const) {
      if (slotsOf(room, team).filter((s) => !s.bot).length > next.teamSize) throw new HttpError(409, 'team size is smaller than the players already in a team');
      // drop surplus bots when the team shrinks
      const slots = slotsOf(room, team);
      for (let i = slots.length - 1; i >= 0 && slotsOf(room, team).length > next.teamSize; i--) {
        if (slots[i].bot) room.slots.splice(room.slots.indexOf(slots[i]), 1);
      }
    }
    room.settings = next;
    return room;
  }

  addBot(who: Identity, roomId: string, team: 0 | 1) {
    const room = this.hostRoom(who, roomId);
    if (!addSlot(room, newBot(team))) throw new HttpError(409, 'team is full');
    nameBots(room);
    return room;
  }

  removeBot(who: Identity, roomId: string, slotId: string) {
    const room = this.hostRoom(who, roomId);
    const i = room.slots.findIndex((s) => s.id === slotId && s.bot);
    if (i < 0) throw new HttpError(404, 'bot not found');
    room.slots.splice(i, 1);
    nameBots(room);
    return room;
  }

  async start(who: Identity, roomId: string) {
    const room = this.get(roomId);
    if (room.host !== who.id) throw new HttpError(403, 'only the host can start');
    if (room.status !== 'open') throw new HttpError(409, 'already started');
    fillWithBots(room);
    room.matchId = await this.launcher.launch(room);
    room.status = 'playing';
    return room;
  }
}
