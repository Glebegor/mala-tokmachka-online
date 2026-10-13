import { snapshotFor, type BotDifficulty, type PlayerStats, Sim, type ClientMsg, type InitMsg, type Ruleset, type ServerMsg, type SlotInit, type Team } from '@sw/core';
import { ScriptHost } from '../infrastructure/scriptHost';
import { Bot } from './bot';

export interface Connection {
  send(msg: ServerMsg): void;
  close(): void;
}

/** Port: where finished matches are reported (the profile service). */
export interface MatchReporter {
  report(result: { matchId: string; mapId: string; seconds: number; winner: Team | null; players: { id: string; name: string; team: Team; stats: PlayerStats }[] }): Promise<void>;
}

const COUNTDOWN_MS = 3000;
const LOAD_TIMEOUT_MS = 25000; // start anyway if a client never reports that its map is drawn

export class Match {
  readonly sim: Sim;
  private conns = new Map<string, Connection>();
  private bots: Bot[];
  private timer: NodeJS.Timeout;
  private ended = false;
  private msgBudget = new Map<string, { t: number; n: number }>();
  private idleTicks = 0;
  onClose: () => void = () => {};
  /** loading: waiting for players to draw the map; countdown: 3-2-1; running: the simulation advances. */
  private phase: 'loading' | 'countdown' | 'running' = 'loading';
  private ready = new Set<string>();
  private createdAt = Date.now();
  private startAt = 0;
  private reporter: MatchReporter | null = null;

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

  setReporter(r: MatchReporter) {
    this.reporter = r;
  }

  /** Seconds left before the start: 3..1, 0 when running, -1 while players are still loading. */
  private countdown(): number {
    if (this.phase === 'running') return 0;
    if (this.phase === 'loading') return -1;
    return Math.max(1, Math.ceil((this.startAt - Date.now()) / 1000));
  }

  private advancePhase() {
    if (this.phase === 'loading') {
      const humans = this.humanIds();
      const connected = humans.filter((id) => this.conns.has(id));
      const allReady = connected.length > 0 && connected.every((id) => this.ready.has(id));
      // a match with no human players has nobody to wait for
      if (!humans.length) this.phase = 'running';
      else if (allReady || Date.now() - this.createdAt > LOAD_TIMEOUT_MS) {
        this.phase = 'countdown';
        this.startAt = Date.now() + COUNTDOWN_MS;
      }
    } else if (this.phase === 'countdown' && Date.now() >= this.startAt) {
      this.phase = 'running';
    }
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
    conn.send(snapshotFor(this.sim, playerId, me.team, [], this.countdown()));
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
    if (msg.t === 'ready') return void this.ready.add(playerId);
    if (this.phase !== 'running') return this.conns.get(playerId)?.send({ t: 'error', reason: 'the match has not started yet' });
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
    if (this.phase !== 'running') {
      // before the start nothing moves, but players still get snapshots so they can find their base
      this.advancePhase();
      if (++this.idleTicks % snapEvery === 0) {
        for (const [pid, conn] of this.conns) {
          const p = sim.player(pid);
          if (p) conn.send(snapshotFor(sim, pid, p.team, [], this.countdown()));
        }
      }
      return;
    }
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
    if (sim.world.winner !== null || sim.world.time >= sim.ruleset.rules.matchSeconds) {
      if (!this.ended) {
        this.ended = true;
        this.broadcast({ t: 'end', winner: sim.world.winner, reason: sim.world.winReason ?? 'match over' });
        this.reporter
          ?.report({
            matchId: this.id,
            mapId: sim.world.mapId,
            seconds: sim.world.time,
            winner: sim.world.winner,
            players: this.slots.filter((s) => !s.bot).map((s) => ({ id: s.id, name: s.name, team: s.team, stats: sim.world.stats[s.id] })),
          })
          .catch((e) => console.warn(`[game] could not report match ${this.id}: ${e}`));
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
