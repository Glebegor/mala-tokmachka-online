import { randomUUID } from 'node:crypto';
import { HttpError, sign } from '@sw/kit';
import type { PasswordHasher, UserRepository } from '../domain/user';

export class AuthService {
  constructor(private users: UserRepository, private hasher: PasswordHasher, private secret: string) {}

  async register(name: string, password: string) {
    name = clean(name);
    if (!/^[\p{L}\p{N}_\- ]{3,20}$/u.test(name)) throw new HttpError(400, 'name must be 3-20 letters/digits');
    if (typeof password !== 'string' || password.length < 6) throw new HttpError(400, 'password must be 6+ characters');
    if (await this.users.findByName(name)) throw new HttpError(409, 'name taken');
    const user = { id: randomUUID(), name, passwordHash: await this.hasher.hash(password), createdAt: Date.now() };
    await this.users.save(user);
    return this.session(user.id, user.name);
  }

  async login(name: string, password: string) {
    const user = await this.users.findByName(clean(name));
    if (!user || !(await this.hasher.verify(String(password), user.passwordHash))) throw new HttpError(401, 'wrong name or password');
    return this.session(user.id, user.name);
  }

  private session(id: string, name: string) {
    return { token: sign({ sub: id, name }, this.secret), user: { id, name } };
  }
}

const clean = (s: unknown) => String(s ?? '').trim();
