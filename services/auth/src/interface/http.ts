import { Router, ok, verify, bearer, HttpError } from '@sw/kit';
import type { AuthService } from '../application/authService';

export function authRoutes(auth: AuthService, secret: string) {
  return new Router()
    .post('/register', async (r) => ok(await auth.register(r.body?.name, r.body?.password)))
    .post('/login', async (r) => ok(await auth.login(r.body?.name, r.body?.password)))
    .get('/me', (r) => {
      const p = verify(bearer(r.headers.authorization), secret);
      if (!p) throw new HttpError(401, 'unauthorized');
      return ok({ id: p.sub, name: p.name });
    });
}
