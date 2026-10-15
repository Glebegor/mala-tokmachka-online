import { api, type Session } from './api';
import { clear, h } from './dom';
import { statsView } from './stats';

const time = (sec: number) => (sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`);

/** Career statistics of the signed-in player plus the top players by wins. */
export async function showProfile(box: HTMLElement, s: Session, onBack: () => void) {
  // a past match's full statistics in a window over the profile
  const openMatch = async (id: string) => {
    const close = () => overlay.remove();
    const overlay = h('div', { class: 'overlay', onClick: (e: MouseEvent) => e.target === overlay && close() }, h('div', { class: 'card stats-card' }, h('p', { class: 'muted' }, 'Loading…')));
    document.body.append(overlay);
    const card = overlay.firstElementChild as HTMLElement;
    try {
      const r = await api.match(id);
      clear(card);
      card.append(statsView(r, s.user.id), h('div', { class: 'row' }, h('button', { class: 'primary', onClick: close }, 'Close')));
    } catch (e) {
      clear(card);
      card.append(h('p', { class: 'error' }, `This match was not saved in detail (older matches have only the summary): ${(e as Error).message}`), h('button', { onClick: close }, 'Close'));
    }
  };
  clear(box);
  box.append(h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading profile…')));
  try {
    const [p, top] = await Promise.all([api.profile(), api.leaderboard()]);
    const tile = (label: string, value: string | number) => h('div', { class: 'tile' }, h('b', {}, value), h('span', {}, label));
    const rate = p.matches ? `${Math.round((p.wins / p.matches) * 100)}%` : '—';
    const kd = p.unitsLost ? (p.kills / p.unitsLost).toFixed(2) : p.kills ? String(p.kills) : '—';
    clear(box);
    box.append(
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h2', {}, s.user.name), h('button', { onClick: onBack }, 'Back to rooms')),
        h('div', { class: 'tiles' },
          tile('matches', p.matches), tile('wins', p.wins), tile('losses', p.losses), tile('draws', p.draws), tile('win rate', rate), tile('time played', time(p.secondsPlayed)),
          tile('units destroyed', p.kills), tile('units lost', p.unitsLost), tile('kill / loss', kd), tile('units trained', p.unitsTrained),
          tile('buildings built', p.buildingsBuilt), tile('buildings destroyed', p.buildingsDestroyed), tile('damage dealt', p.damage.toLocaleString('en-US')),
        ),
        h('h3', {}, 'Recent matches'),
        p.recent.length === 0 ? h('p', { class: 'muted' }, 'No finished matches yet. Statistics are recorded when a match ends.') : null,
        ...p.recent.map((m) =>
          h('div', { class: 'room clickable', title: 'Show the statistics of this match', onClick: () => openMatch(m.matchId) },
            h('span', { class: `result ${m.result}` }, m.result.toUpperCase()),
            h('span', {}, m.mapId),
            h('span', { class: 'muted' }, `${m.kills} destroyed · ${m.losses} lost · ${time(m.seconds)} · ${new Date(m.at).toLocaleDateString('en-GB')}`),
            h('span', { class: 'link' }, 'Statistics ›'),
          ),
        ),
      ),
      h('div', { class: 'card' },
        h('h3', {}, 'Top players'),
        top.length === 0 ? h('p', { class: 'muted' }, 'Nobody has finished a match yet.') : null,
        ...top.map((t, i) => h('div', { class: 'room' }, h('span', {}, `${i + 1}. ${t.name}`), h('span', { class: 'muted' }, `${t.wins} wins · ${t.matches} matches · ${t.kills} destroyed`))),
      ),
    );
  } catch (e) {
    clear(box);
    box.append(h('div', { class: 'card' }, h('p', { class: 'error' }, `Could not load the profile: ${(e as Error).message}`), h('button', { onClick: onBack }, 'Back to rooms')));
  }
}
