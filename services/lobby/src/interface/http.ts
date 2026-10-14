import { HttpError, Router, bearer, ok, verify } from '@sw/kit';
import type { LobbyService, Identity } from '../application/lobbyService';

export function lobbyRoutes(lobby: LobbyService, secret: string) {
  const who = (headers: Record<string, any>): Identity => {
    const p = verify(bearer(headers.authorization), secret);
    if (!p) throw new HttpError(401, 'unauthorized');
    return { id: p.sub, name: p.name };
  };
  const team = (v: unknown): 0 | 1 => (Number(v) === 1 ? 1 : 0);

  return new Router()
    .get('/maps', async (r) => (who(r.headers), ok(await lobby.maps())))
    .get('/rooms', (r) => (who(r.headers), ok(lobby.list())))
    .post('/rooms', (r) => ok(lobby.create(who(r.headers), r.body?.name, r.body?.settings, team(r.body?.team))))
    .post('/rooms/leave', (r) => (lobby.leaveAll(who(r.headers).id), ok()))
    .post('/rooms/:id/join', (r) => ok(lobby.join(who(r.headers), r.params.id, team(r.body?.team))))
    .post('/rooms/:id/leave', (r) => (lobby.leaveAll(who(r.headers).id), ok()))
    .post('/rooms/:id/settings', (r) => ok(lobby.updateSettings(who(r.headers), r.params.id, r.body ?? {})))
    .post('/rooms/:id/bots', (r) => ok(lobby.addBot(who(r.headers), r.params.id, team(r.body?.team))))
    .post('/rooms/:id/bots/remove', (r) => ok(lobby.removeBot(who(r.headers), r.params.id, String(r.body?.slot))))
    .post('/rooms/:id/start', async (r) => ok(await lobby.start(who(r.headers), r.params.id)));
}
