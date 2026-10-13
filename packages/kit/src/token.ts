import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
  sub: string;
  name: string;
  exp: number;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function sign(payload: Omit<TokenPayload, 'exp'>, secret: string, ttlSec = 86400): string {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verify(token: string | undefined, secret: string): TokenPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

export function bearer(header: string | string[] | undefined): string | undefined {
  const h = Array.isArray(header) ? header[0] : header;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}
