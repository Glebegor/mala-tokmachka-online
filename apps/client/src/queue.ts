import type { SnapMsg, UnitDef } from '@sw/core';
import { h } from './dom';

type Item = SnapMsg['queue'][number];

export interface QueueContext {
  me: string;
  defU: Map<string, UnitDef>;
  playerName(id: string): string;
  icon(d: UnitDef): HTMLElement;
  cancel(item: number): void;
}

const fmt = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : `${Math.ceil(sec)}s`);

/** Seconds until each order is done: the head trains now, the rest wait their turn at the same building. */
export function finishTimes(items: Item[]): Map<number, number> {
  const out = new Map<number, number>();
  const acc = new Map<number, number>();
  for (const q of items) {
    const t = (acc.get(q.building) ?? 0) + q.remaining;
    acc.set(q.building, t);
    out.set(q.id, t);
  }
  return out;
}

/**
 * Training queue of one building as columns: one card per order (icon, name, time, progress), empty slots dashed.
 * Cards are keyed by order id and updated in place every snapshot, so a click on × is never lost to a rebuild.
 */
export class QueueList {
  readonly el: HTMLElement;
  private title = h('b', {});
  private sub = h('span', {});
  private list = h('div', { class: 'queue-cols' });
  private slots: HTMLElement[] = [];
  private rows = new Map<number, { row: HTMLElement; bar: HTMLElement; time: HTMLElement; pos: HTMLElement }>();

  constructor(private ctx: QueueContext, private cap: number, name: string) {
    this.title.textContent = name;
    this.el = h('div', { class: 'queue-panel' }, h('div', { class: 'queue-head' }, h('em', {}, 'Production'), this.title, this.sub), this.list);
  }

  update(items: Item[]) {
    const { ctx } = this;
    const done = finishTimes(items);
    const total = items.length ? Math.max(...items.map((q) => done.get(q.id)!)) : 0;
    this.sub.textContent = items.length ? `${items.length}/${this.cap} · done in ${fmt(total)}` : `empty · ${this.cap} slots`;
    const alive = new Set(items.map((q) => q.id));
    for (const [id, r] of this.rows) if (!alive.has(id)) r.row.remove(), this.rows.delete(id);
    items.forEach((q, i) => {
      let r = this.rows.get(q.id);
      const d = ctx.defU.get(q.unit);
      if (!r) {
        const bar = h('i', {});
        const time = h('small', {});
        const pos = h('span', { class: 'qpos' });
        const mine = q.owner === ctx.me;
        const row = h('div', { class: 'qcard' + (mine ? ' mine' : ' theirs'), title: `${d?.name ?? q.unit}${mine ? '' : ` · ordered by ${ctx.playerName(q.owner)}`}` },
          pos,
          mine ? h('button', { class: 'qx', title: 'Cancel this order (full refund)', onClick: (e: MouseEvent) => (e.stopPropagation(), ctx.cancel(q.id)) }, '×') : null,
          h('div', { class: 'qicon' }, d ? ctx.icon(d) : ''),
          h('b', {}, d?.name ?? q.unit),
          time,
          h('div', { class: 'qbar' }, bar),
        );
        r = { row, bar, time, pos };
        this.rows.set(q.id, r);
      }
      if (this.list.children[i] !== r.row) this.list.insertBefore(r.row, this.list.children[i] ?? null);
      const active = i === 0;
      r.row.classList.toggle('active', active);
      r.pos.textContent = String(i + 1);
      const pct = active ? Math.max(0, Math.min(1, 1 - q.remaining / Math.max(0.01, q.total))) : 0;
      r.bar.style.width = `${pct * 100}%`;
      r.time.textContent = active ? fmt(q.remaining) : `in ${fmt(done.get(q.id)!)}`;
    });
    // dashed placeholders for the free slots, always after the orders
    while (this.slots.length < this.cap - items.length) this.slots.push(h('div', { class: 'qcard empty' }));
    while (this.slots.length > this.cap - items.length) this.slots.pop()!.remove();
    for (const e of this.slots) this.list.append(e);
  }
}

/**
 * Production strip over the map: one chip per building that is training something for you, with a progress ring,
 * time left and how many more orders wait there. Clicking a chip opens the building.
 */
export class ProductionDock {
  readonly el = h('div', { class: 'prod-dock' });
  private chips = new Map<number, { chip: HTMLElement; ring: SVGCircleElement; time: HTMLElement; more: HTMLElement; unit: string }>();

  constructor(private ctx: QueueContext, private open: (building: number) => void) {}

  update(all: Item[]) {
    // a building appears when it holds at least one of my orders; its chip shows whatever it is training now
    const byBuilding = new Map<number, Item[]>();
    for (const q of all) byBuilding.set(q.building, [...(byBuilding.get(q.building) ?? []), q]);
    const mine = [...byBuilding].filter(([, qs]) => qs.some((q) => q.owner === this.ctx.me));
    const alive = new Set(mine.map(([b]) => b));
    for (const [b, c] of this.chips) if (!alive.has(b)) c.chip.remove(), this.chips.delete(b);
    for (const [b, qs] of mine) {
      const q = qs[0];
      let c = this.chips.get(b);
      if (c && c.unit !== q.unit) c.chip.remove(), this.chips.delete(b), (c = undefined);
      if (!c) {
        const d = this.ctx.defU.get(q.unit);
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 36 36');
        svg.classList.add('pring');
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        for (const [k, v] of Object.entries({ cx: '18', cy: '18', r: '16' })) ring.setAttribute(k, v);
        svg.append(ring);
        const time = h('b', {});
        const more = h('em', {});
        const chip = h('button', { class: 'pchip', title: d?.name ?? q.unit, onClick: () => this.open(b) }, h('span', { class: 'pico' }, d ? this.ctx.icon(d) : '', svg as unknown as HTMLElement), time, more);
        c = { chip, ring, time, more, unit: q.unit };
        this.chips.set(b, c);
        this.el.append(chip);
      }
      const pct = Math.max(0, Math.min(1, 1 - q.remaining / Math.max(0.01, q.total)));
      c.ring.style.strokeDashoffset = String(100.5 * (1 - pct));
      c.time.textContent = fmt(q.remaining);
      c.more.textContent = qs.length > 1 ? `+${qs.length - 1}` : '';
      c.chip.classList.toggle('theirs', q.owner !== this.ctx.me);
    }
    this.el.style.display = this.chips.size ? 'flex' : 'none';
  }
}
