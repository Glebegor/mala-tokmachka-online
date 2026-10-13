import vm from 'node:vm';
import type { Hooks, ScriptSource } from '@sw/core';

export interface ScriptApi {
  giveResource(playerId: string, res: string, amount: number): void;
  teamPlayers(team: number): string[];
  toast(text: string): void;
}

const PRELUDE = `(function (host) {
  var H = {};
  globalThis.sw = Object.freeze({
    on: function (ev, fn) { if (typeof fn === 'function') (H[String(ev)] || (H[String(ev)] = [])).push(fn); },
    giveResource: function (p, r, n) { host.give(String(p), String(r), Number(n)); },
    teamPlayers: function (t) { return JSON.parse(host.team(Number(t))); },
    toast: function (s) { host.toast(String(s)); },
    log: function () { host.log(Array.prototype.join.call(arguments, ' ')); }
  });
  globalThis.__dispatch = function (ev, json) {
    var d = JSON.parse(json);
    (H[ev] || []).forEach(function (f) { try { f(d); } catch (e) { host.log('handler error: ' + e); } });
  };
})`;

/**
 * Runs mod scripts in a separate V8 context with a tiny, closure-hidden API.
 * node:vm is not a hard security boundary: only load mods you trust (local mods only by design).
 */
export class ScriptHost implements Hooks {
  private ctx: vm.Context;

  constructor(scripts: ScriptSource[], api: ScriptApi, log: (msg: string) => void = console.log) {
    this.ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    const host = {
      give: (p: string, r: string, n: number) => Number.isFinite(n) && api.giveResource(p, r, Math.max(-1e6, Math.min(1e6, n))),
      team: (t: number) => JSON.stringify(api.teamPlayers(t)),
      toast: (s: string) => api.toast(s.slice(0, 120)),
      log: (s: string) => log(`[script] ${s}`),
    };
    (vm.runInContext(PRELUDE, this.ctx, { timeout: 100 }) as (h: typeof host) => void)(host);
    for (const s of scripts) {
      try {
        vm.runInContext(s.source, this.ctx, { timeout: 200, filename: `${s.modId}/${s.file}` });
      } catch (e) {
        log(`[script] ${s.modId}/${s.file} failed to load: ${e}`);
      }
    }
  }

  emit(event: string, data: Record<string, unknown>) {
    try {
      vm.runInContext(`__dispatch(${JSON.stringify(event)}, ${JSON.stringify(JSON.stringify(data))})`, this.ctx, { timeout: 25 });
    } catch (e) {
      console.warn(`[script] event ${event} aborted: ${e}`);
    }
  }
}
