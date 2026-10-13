import { callJson, config } from '@sw/kit';
import type { MatchLauncher } from '../application/lobbyService';
import type { Room } from '../domain/room';

export class HttpMatchLauncher implements MatchLauncher {
  async launch(room: Room) {
    const out = await callJson(`${config.urls.game}/matches`, {
      body: { settings: room.settings, slots: room.slots },
      headers: { 'x-internal-key': config.internalKey },
    });
    return out.matchId as string;
  }
}
