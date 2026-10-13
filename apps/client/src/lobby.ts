import type { BotDifficulty, RoomInfo, RoomSettings } from '@sw/core';
import { api, type Session } from './api';
import { clear, h } from './dom';

type Opt<T> = { v: T; label: string };

function select<T extends string | number>(label: string, value: T, opts: Opt<T>[], disabled: boolean, onChange: (v: T) => void) {
  const el = h('select', { disabled: disabled || undefined },
    ...opts.map((o) => h('option', { value: String(o.v), selected: o.v === value || undefined }, o.label)));
  el.addEventListener('change', () => onChange((typeof value === 'number' ? Number(el.value) : el.value) as T));
  return h('label', { class: 'field' }, h('span', {}, label), el);
}

function toggle(label: string, value: boolean, disabled: boolean, onChange: (v: boolean) => void) {
  const el = h('input', { type: 'checkbox', checked: value || undefined, disabled: disabled || undefined });
  el.addEventListener('change', () => onChange(el.checked));
  return h('label', { class: 'field check' }, el, h('span', {}, label));
}

export function showLobby(app: HTMLElement, s: Session, cb: { onLogout(): void; onMatch(matchId: string): void }) {
  clear(app);
  let stopped = false;
  let maps: { id: string; name: string }[] = [];
  void api.maps().then((m) => (maps = m)).catch(() => {});
  let editing = false; // pause polling re-render while a control has focus
  const body = h('div', { class: 'lobby-body' });
  const msg = h('div', { class: 'error' });

  const guard = async (fn: () => Promise<unknown>) => {
    try {
      msg.textContent = '';
      await fn();
    } catch (e) {
      msg.textContent = (e as Error).message;
    }
    await refresh(true);
  };

  const settingsPanel = (room: RoomInfo, isHost: boolean) => {
    const st = room.settings;
    const set = (patch: Partial<RoomSettings>) => guard(() => api.settings(room.id, patch));
    return h('div', { class: 'settings' },
      h('h3', {}, 'Match settings', isHost ? null : h('span', { class: 'muted' }, ' (host only)')),
      select('Map', st.mapId, (maps.length ? maps : [{ id: st.mapId, name: st.mapId }]).map((m) => ({ v: m.id, label: m.name })), !isHost, (v) => set({ mapId: v })),
      select('Duration', st.matchMinutes, [10, 20, 30, 45, 60, 90].map((m) => ({ v: m, label: `${m} min` })), !isHost, (v) => set({ matchMinutes: v })),
      select('Team size', st.teamSize, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ v: n, label: `${n} v ${n}` })), !isHost, (v) => set({ teamSize: v })),
      toggle('Fill empty slots with bots', st.fillBots, !isHost, (v) => set({ fillBots: v })),
      select<BotDifficulty>('Bot difficulty', st.botDifficulty, [{ v: 'easy', label: 'Easy' }, { v: 'normal', label: 'Normal' }, { v: 'hard', label: 'Hard' }], !isHost, (v) => set({ botDifficulty: v })),
      select('Starting resources', st.startResources, [{ v: 'low', label: 'Low (×0.5)' }, { v: 'normal', label: 'Normal' }, { v: 'high', label: 'High (×2.5)' }], !isHost, (v) => set({ startResources: v })),
      select('Front speed', st.frontSpeed, [{ v: 0.5, label: 'Slow' }, { v: 1, label: 'Normal' }, { v: 2, label: 'Fast' }], !isHost, (v) => set({ frontSpeed: v as 0.5 | 1 | 2 })),
      toggle('Fog of war', st.fogOfWar, !isHost, (v) => set({ fogOfWar: v })),
    );
  };

  const teamColumn = (room: RoomInfo, team: 0 | 1, isHost: boolean) => {
    const slots = room.slots.filter((x) => x.team === team);
    const full = slots.length >= room.settings.teamSize;
    return h('div', { class: `team t${team}` },
      h('h3', {}, `${team === 0 ? 'Ukraine' : 'Russia'} `, h('span', { class: 'muted' }, `${slots.length}/${room.settings.teamSize}`)),
      ...slots.map((x) =>
        h('div', { class: 'slot' + (x.bot ? ' bot' : '') },
          h('span', {}, x.name || 'Bot', x.id === room.host ? ' ★' : ''),
          isHost && x.bot ? h('button', { class: 'ghost sm', title: 'Remove bot', onClick: () => guard(() => api.removeBot(room.id, x.id)) }, '×') : null,
        ),
      ),
      h('div', { class: 'row' },
        !room.slots.some((x) => x.id === s.user.id && x.team === team) ? h('button', { disabled: full || undefined, onClick: () => guard(() => api.join(room.id, team)) }, 'Join') : null,
        isHost ? h('button', { disabled: full || undefined, onClick: () => guard(() => api.addBot(room.id, team)) }, '+ Bot') : null,
      ),
    );
  };

  async function refresh(force = false) {
    if (stopped) return;
    if (editing && !force) return;
    const rooms = await api.rooms();
    const mine = rooms.find((r) => r.slots.some((x) => x.id === s.user.id));
    if (mine?.status === 'playing' && mine.matchId) {
      stopped = true;
      return cb.onMatch(mine.matchId);
    }
    clear(body);
    if (mine) {
      const isHost = mine.host === s.user.id;
      body.append(
        h('div', { class: 'card' },
          h('div', { class: 'row between' }, h('h2', {}, mine.name), h('span', { class: 'muted' }, maps.find((m) => m.id === mine.settings.mapId)?.name ?? mine.settings.mapId)),
          h('div', { class: 'room-grid' },
            h('div', { class: 'teams' }, teamColumn(mine, 0, isHost), teamColumn(mine, 1, isHost)),
            settingsPanel(mine, isHost),
          ),
          h('p', { class: 'muted' }, mine.settings.fillBots ? `Empty slots are filled with ${mine.settings.botDifficulty} bots at start.` : 'Only players and bots you add will play (each side gets at least one bot).'),
          h('div', { class: 'row' },
            isHost ? h('button', { class: 'primary', onClick: () => guard(() => api.start(mine.id)) }, 'Start match') : h('span', { class: 'muted' }, 'Waiting for host…'),
            h('button', { onClick: () => guard(() => api.leave(mine.id)) }, 'Leave'),
          ),
        ),
      );
    } else {
      body.append(
        h('div', { class: 'card' },
          h('div', { class: 'row between' }, h('h2', {}, 'Open rooms'), h('button', { class: 'primary', onClick: () => guard(() => api.createRoom(`${s.user.name}'s room`, 0)) }, 'Create room')),
          rooms.length === 0 ? h('p', { class: 'muted' }, 'No rooms yet. Create one.') : null,
          ...rooms.map((r) =>
            h('div', { class: 'room' },
              h('span', {}, r.name),
              h('span', { class: 'muted' }, `${r.slots.filter((x) => !x.bot).length} players · ${r.settings.teamSize}v${r.settings.teamSize} · ${r.status}`),
              h('button', { onClick: () => guard(() => api.join(r.id, 0)) }, r.status === 'open' ? 'Join' : 'Rejoin'),
            ),
          ),
        ),
      );
    }
  }

  app.append(
    h('div', { class: 'lobby' },
      h('div', { class: 'row between topbar' },
        h('div', { class: 'logo small' }, 'MALA TOKMACHKA', h('span', {}, 'ONLINE')),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, s.user.name), h('button', { onClick: () => ((stopped = true), cb.onLogout()) }, 'Sign out')),
      ),
      body, msg,
    ),
  );
  // don't rebuild the form under an open dropdown
  app.addEventListener('focusin', (e) => (editing = (e.target as HTMLElement).tagName === 'SELECT'));
  app.addEventListener('focusout', () => (editing = false));

  void refresh().catch((e) => (msg.textContent = String(e.message)));
  const timer = setInterval(() => {
    if (stopped) return clearInterval(timer);
    refresh().catch(() => {});
  }, 1500);
}
