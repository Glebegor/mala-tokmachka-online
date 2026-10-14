import { HttpError, Router, config, ok } from '@sw/kit';
import type { SlotInit } from '@sw/core';
import type { MatchManager } from '../application/matchManager';

export function gameRoutes(mm: MatchManager) {
  const internal = (h: Record<string, any>) => {
    if (h['x-internal-key'] !== config.internalKey) throw new HttpError(403, 'internal only');
  };
  return new Router()
    .post('/matches', (r) => {
      internal(r.headers);
      const slots: SlotInit[] = (r.body?.slots ?? []).map((s: any) => ({ id: String(s.id), name: String(s.name), team: Number(s.team) === 1 ? 1 : 0, bot: !!s.bot }));
      try {
        return ok({ matchId: mm.create(r.body?.settings ?? {}, slots).id });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    })
    // the lobby asks whether a match still runs (empty matches close themselves)
    .get('/matches/:id', (r) => {
      internal(r.headers);
      if (!mm.get(r.params.id)) throw new HttpError(404, 'no such match');
      return ok({ running: true });
    })
    .get('/mods', () => ok(mm.rules.mods))
    .get('/maps', () => ok(mm.rules.maps.map((m) => ({ id: m.id, name: m.name }))))
    .get('/health', () => ok());
}
