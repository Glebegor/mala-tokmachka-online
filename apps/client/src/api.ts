import type { RoomInfo, RoomSettings, MatchReport } from '@sw/core';

export interface Session {
  token: string;
  user: { id: string; name: string };
}

export interface ProfileData {
  id: string;
  name: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  unitsLost: number;
  unitsTrained: number;
  buildingsBuilt: number;
  buildingsDestroyed: number;
  damage: number;
  secondsPlayed: number;
  recent: { matchId: string; mapId: string; at: number; seconds: number; result: 'win' | 'loss' | 'draw'; kills: number; losses: number }[];
}

const KEY = 'mto.session';

export const session = {
  get(): Session | null {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  set(s: Session | null) {
    try {
      s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable */
    }
  },
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const s = session.get();
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  login: (name: string, password: string) => call<Session>('/api/auth/login', { name, password }),
  register: (name: string, password: string) => call<Session>('/api/auth/register', { name, password }),
  maps: () => call<{ id: string; name: string }[]>('/api/lobby/maps'),
  profile: () => call<ProfileData>('/api/profile/me'),
  match: (id: string) => call<MatchReport>(`/api/profile/matches/${encodeURIComponent(id)}`),
  leaderboard: () => call<{ id: string; name: string; matches: number; wins: number; kills: number }[]>('/api/profile/leaderboard'),
  rooms: () => call<RoomInfo[]>('/api/lobby/rooms'),
  createRoom: (name: string, team: 0 | 1) => call<RoomInfo>('/api/lobby/rooms', { name, team }),
  settings: (id: string, patch: Partial<RoomSettings>) => call<RoomInfo>(`/api/lobby/rooms/${id}/settings`, patch),
  addBot: (id: string, team: 0 | 1) => call<RoomInfo>(`/api/lobby/rooms/${id}/bots`, { team }),
  removeBot: (id: string, slot: string) => call<RoomInfo>(`/api/lobby/rooms/${id}/bots/remove`, { slot }),
  join: (id: string, team: 0 | 1) => call<RoomInfo>(`/api/lobby/rooms/${id}/join`, { team }),
  leave: (id: string) => call(`/api/lobby/rooms/${id}/leave`, {}),
  start: (id: string) => call<RoomInfo>(`/api/lobby/rooms/${id}/start`, {}),
};
