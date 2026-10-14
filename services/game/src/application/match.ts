import { snapshotFor, type BotDifficulty, Sim, type ClientMsg, type InitMsg, type Ruleset, type ServerMsg, type SlotInit } from '@sw/core';
import { ScriptHost } from '../infrastructure/scriptHost';
import { Bot } from './bot';

export interface Connection {
  send(msg: ServerMsg): void;
  close(): void;
}

export class Match {
  readonly sim: Sim;
  private conns = new Map<string, Connection>();
  private bots: Bot[];
  private timer: NodeJS.Timeout;
  private ended = false;
  private msgBudget = new Map<string, { t: number; n: number }>();
  onClose: () => void = () => {};

  constructor(readonly id: string, readonly ruleset: Ruleset, mapId: string, readonly slots: SlotInit[], difficulty: BotDifficulty = 'normal') {
    this.sim = new Sim(ruleset, mapId, slots);
    const sim = this.sim;
    this.sim.setHooks(
      new ScriptHost(ruleset.scripts, {
        giveResource: (pid, res, n) => {
          const p = sim.player(pid);
          const def = ruleset.resources.find((r) => r.id === res);
          if (p && def) p.res[res] = Math.min(def.cap, Math.max(0, (p.res[res] ?? 0) + n));
        },
        teamPlayers: (team) => sim.world.players.filter((p) => p.team === team).map((p) => p.id),
        toast: (text) => this.broadcast({ t: 'toast', text }),
      }),
    );
    this.bots = slots.filter((s) => s.bot).map((s) => new Bot(s.id, difficulty));

    const r = ruleset.rules;
    const dt = 1 / r.tickRate;
    const snapEvery = Math.max(1, Math.round(r.tickRate / r.snapshotRate));
    this.timer = setInterval(() => this.tick(dt, snapEvery), 1000 * dt);
  }

  humanIds() {
    return this.slots.filter((s) => !s.bot).map((s) => s.id);
  }

  hasPlayer(id: string) {
    return this.slots.some((s) => s.id === id && !s.bot);
  }

  connect(playerId: string, conn: Connection) {
    this.conns.get(playerId)?.close();
    this.conns.set(playerId, conn);
    const me = this.sim.player(playerId)!;
    const { scripts: _s, maps: _m, ...pub } = this.ruleset;
    const init: InitMsg = {
      t: 'init',
      you: playerId,
      team: me.team,
      matchId: this.id,
      ruleset: pub,
      map: this.sim.map,
      players: this.sim.world.players.map(({ id, name, team, bot }) => ({ id, name, team, bot })),
    };
    conn.send(init);
    conn.send(snapshotFor(this.sim, playerId, me.team));
  }

  disconnect(playerId: string, conn: Connection) {
    if (this.conns.get(playerId) === conn) this.conns.delete(playerId);
  }

  handle(playerId: string, msg: ClientMsg) {
    const now = Date.now();
    const b = this.msgBudget.get(playerId) ?? { t: now, n: 0 };
    if (now - b.t > 1000) (b.t = now), (b.n = 0);
    if (++b.n > 40) return;
    this.msgBudget.set(playerId, b);

    if (msg.t === 'ping') return this.conns.get(playerId)?.send({ t: 'pong' });
    if (msg.t === 'cmd') {
      const res = this.sim.apply(playerId, msg.cmd);
      if (!res.ok) this.conns.get(playerId)?.send({ t: 'error', reason: res.reason });
    }
  }

  private broadcast(msg: ServerMsg) {
    for (const c of this.conns.values()) c.send(msg);
  }

  private tick(dt: number, snapEvery: number) {
    const sim = this.sim;
    for (const b of this.bots) b.think(sim);
    sim.step(dt);

    if (sim.world.tick % snapEvery === 0) {
      // shots are animation only: thin them out when a big battle would flood the wire
      let shots = sim.shots;
      sim.shots = [];
      if (shots.length > 160) {
        const keep = 160 / shots.length;
        shots = shots.filter(() => Math.random() < keep);
      }
      for (const [pid, conn] of this.conns) {
        const p = sim.player(pid);
        if (p) conn.send(snapshotFor(sim, pid, p.team, shots));
      }
    }
    if (sim.world.winner !== null || (sim.ruleset.rules.matchSeconds > 0 && sim.world.time >= sim.ruleset.rules.matchSeconds)) {
      if (!this.ended) {
        this.ended = true;
        this.broadcast({ t: 'end', winner: sim.world.winner, reason: sim.world.winReason ?? 'match over' });
        setTimeout(() => this.close(), 60_000);
      }
    }
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.onClose();
  }
}
