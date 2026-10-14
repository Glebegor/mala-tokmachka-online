import type { RoomInfo, RoomSettings } from '@sw/core';

export interface Session {
  token: string;
  user: { id: string; name: string };
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
  rooms: () => call<RoomInfo[]>('/api/lobby/rooms'),
  createRoom: (name: string, team: 0 | 1) => call<RoomInfo>('/api/lobby/rooms', { name, team }),
  settings: (id: string, patch: Partial<RoomSettings>) => call<RoomInfo>(`/api/lobby/rooms/${id}/settings`, patch),
  addBot: (id: string, team: 0 | 1) => call<RoomInfo>(`/api/lobby/rooms/${id}/bots`, { team }),
  removeBot: (id: string, slot: string) => call<RoomInfo>(`/api/lobby/rooms/${id}/bots/remove`, { slot }),
  join: (id: string, team: 0 | 1) => call<RoomInfo>(`/api/lobby/rooms/${id}/join`, { team }),
  leave: (id: string) => call(`/api/lobby/rooms/${id}/leave`, {}),
  leaveAll: () => call('/api/lobby/rooms/leave', {}),
  start: (id: string) => call<RoomInfo>(`/api/lobby/rooms/${id}/start`, {}),
};
