import { HttpError, Router, bearer, config, ok, verify } from '@sw/kit';
import type { ProfileService } from '../application/profileService';

export function profileRoutes(profiles: ProfileService, secret: string) {
  const who = (headers: Record<string, any>) => {
    const p = verify(bearer(headers.authorization), secret);
    if (!p) throw new HttpError(401, 'unauthorized');
    return { id: p.sub, name: p.name };
  };
  return new Router()
    .get('/me', async (r) => {
      const me = who(r.headers);
      return ok(await profiles.get(me.id, me.name));
    })
    .get('/leaderboard', async (r) => (who(r.headers), ok(await profiles.leaderboard())))
    .get('/players/:id', async (r) => (who(r.headers), ok(await profiles.get(r.params.id))))
    .post('/matches', async (r) => {
      // only the game service may report results
      if (r.headers['x-internal-key'] !== config.internalKey) throw new HttpError(403, 'internal only');
      await profiles.record(r.body);
      return ok();
    });
}
