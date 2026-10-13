import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { PasswordHasher } from '../domain/user';

const derive = (plain: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scrypt(plain, salt, 64, (e, k) => (e ? rej(e) : res(k))));

export class ScryptHasher implements PasswordHasher {
  async hash(plain: string) {
    const salt = randomBytes(16);
    return `${salt.toString('hex')}:${(await derive(plain, salt)).toString('hex')}`;
  }
  async verify(plain: string, hash: string) {
    const [s, h] = hash.split(':');
    const expected = Buffer.from(h, 'hex');
    const got = await derive(plain, Buffer.from(s, 'hex'));
    return got.length === expected.length && timingSafeEqual(got, expected);
  }
}
