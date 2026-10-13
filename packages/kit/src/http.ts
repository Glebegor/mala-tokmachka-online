import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: any;
}
export interface Res {
  status: number;
  body: unknown;
}
export type Handler = (req: Req) => Res | Promise<Res>;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }
  get = (p: string, h: Handler) => this.add('GET', p, h);
  post = (p: string, h: Handler) => this.add('POST', p, h);

  async dispatch(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const segs = url.pathname.split('/').filter(Boolean);
      for (const r of this.routes) {
        if (r.method !== req.method || r.parts.length !== segs.length) continue;
        const params: Record<string, string> = {};
        const match = r.parts.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(segs[i])), true) : p === segs[i]));
        if (!match) continue;
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        const out = await r.handler({ method: req.method!, path: url.pathname, query: url.searchParams, params, headers: req.headers, body });
        return send(res, out.status, out.body);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'internal error' });
    }
  }
}

export const ok = (body: unknown = { ok: true }): Res => ({ status: 200, body });

function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256_000) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

export function serve(router: Router, port: number, name: string) {
  const server = createServer((req, res) => void router.dispatch(req, res));
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') console.error(`[${name}] port ${port} is already in use. Stop the other process (lsof -ti :${port} | xargs kill) or set another port via env.`);
    else console.error(`[${name}] server error: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, () => console.log(`[${name}] listening on :${port}`));
  return server;
}

export async function callJson(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const r = await fetch(url, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status, data?.error ?? `upstream ${r.status}`);
  return data;
}
