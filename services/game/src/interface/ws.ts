import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from '@sw/kit';
import type { ClientMsg } from '@sw/core';
import type { MatchManager } from '../application/matchManager';

/** Trusted-gateway WebSocket endpoint: /match/:id?player=<userId>. */
export function attachWs(server: Server, mm: MatchManager) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const matchId = url.pathname.split('/')[2];
    const player = url.searchParams.get('player') ?? '';
    const match = mm.get(matchId);
    if (req.headers['x-internal-key'] !== config.internalKey || !match?.hasPlayer(player)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = { send: (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), close: () => ws.close() };
      match.connect(player, conn);
      ws.on('message', (raw) => {
        try {
          match.handle(player, JSON.parse(raw.toString()) as ClientMsg);
        } catch {
          /* ignore malformed frames */
        }
      });
      ws.on('close', () => match.disconnect(player, conn));
    });
  });
}
