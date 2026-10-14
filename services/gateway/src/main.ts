import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { config, verify } from '@sw/kit';

/** Public entry point: routes REST to auth/lobby and authenticates the realtime socket into the game service. */
const upstreams: Record<string, string> = { '/api/auth': config.urls.auth, '/api/lobby': config.urls.lobby, '/api/profile': config.urls.profile };

async function proxy(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const prefix = Object.keys(upstreams).find((p) => url.pathname.startsWith(p + '/'));
  if (!prefix) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    const r = await fetch(upstreams[prefix] + url.pathname.slice(prefix.length) + url.search, {
      method: req.method,
      headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
      body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"service unavailable"}');
  }
}

const server = createServer((req, res) => void proxy(req, res));
// game traffic is JSON (an 18 MB map on join, ~80 KB snapshots five times a second): compressing it cuts the bytes several
// times over, which matters on slower links (Tailscale, Wi-Fi)
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 } } });

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const claims = verify(url.searchParams.get('token') ?? undefined, config.secret);
  const matchId = url.searchParams.get('match');
  if (url.pathname !== '/ws' || !claims || !matchId) return void socket.destroy();

  const upstream = new WebSocket(`${config.urls.game.replace(/^http/, 'ws')}/match/${encodeURIComponent(matchId)}?player=${encodeURIComponent(claims.sub)}`, {
    headers: { 'x-internal-key': config.internalKey },
  });
  upstream.once('error', () => socket.destroy());
  upstream.once('open', () => {
    wss.handleUpgrade(req, socket, head, (client) => {
      client.on('message', (d) => upstream.readyState === WebSocket.OPEN && upstream.send(d.toString()));
      upstream.on('message', (d) => client.readyState === WebSocket.OPEN && client.send(d.toString()));
      client.on('close', () => upstream.close());
      upstream.on('close', () => client.close());
    });
  });
});

server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(e.code === 'EADDRINUSE' ? `[gateway] port ${config.ports.gateway} is already in use (lsof -ti :${config.ports.gateway} | xargs kill)` : `[gateway] ${e.message}`);
  process.exit(1);
});
server.listen(config.ports.gateway, () => console.log(`[gateway] listening on :${config.ports.gateway}`));
