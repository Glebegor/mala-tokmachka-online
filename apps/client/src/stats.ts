import type { MatchReport, Team, TimelinePoint } from '@sw/core';
import { h } from './dom';

const SIDE = ['Ukraine', 'Russia'];
const COLOR = ['#3d8bff', '#ff4d4d'];
const dur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`);
const n = (v: number) => Math.round(v).toLocaleString('en-US');

/** Line chart of one timeline series for both sides (plain SVG). */
function chart(title: string, timeline: TimelinePoint[], pick: (p: TimelinePoint) => [number, number]) {
  const W = 300, H = 120, PAD = 22;
  const pts = timeline.length ? timeline : [{ t: 0, score: [0, 0], units: [0, 0], buildings: [0, 0], cities: [0, 0] } as TimelinePoint];
  const tMax = Math.max(1, pts[pts.length - 1].t);
  const vMax = Math.max(1, ...pts.flatMap((p) => pick(p)));
  const x = (t: number) => PAD + (t / tMax) * (W - PAD - 6);
  const y = (v: number) => H - 16 - (v / vMax) * (H - 30);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.classList.add('st-chart');
  const el = (tag: string, attrs: Record<string, string | number>) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    svg.append(e);
    return e;
  };
  el('line', { x1: PAD, y1: H - 16, x2: W - 6, y2: H - 16, class: 'axis' });
  el('text', { x: PAD - 4, y: y(vMax) + 4, class: 'lbl', 'text-anchor': 'end' }).textContent = n(vMax);
  el('text', { x: PAD - 4, y: H - 13, class: 'lbl', 'text-anchor': 'end' }).textContent = '0';
  el('text', { x: W - 6, y: H - 3, class: 'lbl', 'text-anchor': 'end' }).textContent = dur(tMax);
  for (const team of [0, 1] as Team[]) {
    el('polyline', { points: pts.map((p) => `${x(p.t).toFixed(1)},${y(pick(p)[team]).toFixed(1)}`).join(' '), fill: 'none', stroke: COLOR[team], 'stroke-width': 2, 'stroke-linejoin': 'round' });
  }
  return h('div', { class: 'st-chart-box' }, h('b', {}, title), svg as unknown as HTMLElement);
}

/** The statistics of a finished match: result, side totals, every player, and how it went over time. */
export function statsView(r: MatchReport, me: string): HTMLElement {
  const mine = r.players.find((p) => p.id === me);
  const result = r.winner === null ? 'DRAW' : mine ? (mine.team === r.winner ? 'VICTORY' : 'DEFEAT') : `${SIDE[r.winner].toUpperCase()} WINS`;
  const last = r.timeline[r.timeline.length - 1];
  const total = (team: Team, k: keyof MatchReport['players'][number]['stats']) => r.players.filter((p) => p.team === team).reduce((a, p) => a + (p.stats[k] ?? 0), 0);
  const mvp = [...r.players].sort((a, b) => b.stats.damage - a.stats.damage)[0];
  const sideCard = (team: Team) =>
    h('div', { class: `st-side t${team}${r.winner === team ? ' won' : ''}` },
      h('h4', {}, SIDE[team], r.winner === team ? h('span', { class: 'st-won' }, 'WINNER') : null),
      h('div', { class: 'st-nums' },
        ...([['destroyed', total(team, 'kills')], ['lost', total(team, 'losses')], ['damage', total(team, 'damage')], ['trained', total(team, 'unitsTrained')], ['built', total(team, 'buildingsBuilt')], ['cities', last?.cities[team] ?? 0]] as [string, number][])
          .map(([label, v]) => h('div', {}, h('b', {}, n(v)), h('span', {}, label)))));
  const rows = [...r.players].sort((a, b) => a.team - b.team || b.stats.damage - a.stats.damage);
  return h('div', { class: 'stats-view' },
    h('div', { class: 'st-head' },
      h('h2', { class: `st-result ${result === 'VICTORY' ? 'win' : result === 'DEFEAT' ? 'loss' : ''}` }, result),
      h('div', { class: 'muted' }, `${r.reason} · ${dur(r.seconds)} · ${r.mapId}${r.at ? ` · ${new Date(r.at).toLocaleString('en-GB')}` : ''}`)),
    h('div', { class: 'st-sides' }, sideCard(0), sideCard(1)),
    h('div', { class: 'st-charts' },
      chart('Score', r.timeline, (p) => p.score),
      chart('Army (units)', r.timeline, (p) => p.units),
      chart('Cities held', r.timeline, (p) => p.cities)),
    h('table', { class: 'st-table' },
      h('thead', {}, h('tr', {}, ...['Player', 'Destroyed', 'Lost', 'K/L', 'Damage', 'Trained', 'Built', 'Razed'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...rows.map((p) =>
        h('tr', { class: `t${p.team}${p.id === me ? ' me' : ''}` },
          h('td', {}, h('i', { class: 'dot', style: { background: COLOR[p.team] } }), p.name || 'Bot', p.bot ? h('span', { class: 'tag' }, 'BOT') : null, p.id === mvp?.id ? h('span', { class: 'tag mvp' }, 'MVP') : null),
          h('td', {}, n(p.stats.kills)), h('td', {}, n(p.stats.losses)),
          h('td', {}, p.stats.losses ? (p.stats.kills / p.stats.losses).toFixed(2) : p.stats.kills ? '∞' : '—'),
          h('td', {}, n(p.stats.damage)), h('td', {}, n(p.stats.unitsTrained)), h('td', {}, n(p.stats.buildingsBuilt)), h('td', {}, n(p.stats.buildingsDestroyed))))),
    ),
    h('p', { class: 'muted small' }, 'Saved to your profile: open it any time from Profile → Recent matches.'),
  );
}
