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

  async running(matchId: string) {
    try {
      await callJson(`${config.urls.game}/matches/${encodeURIComponent(matchId)}`, { headers: { 'x-internal-key': config.internalKey } });
      return true;
    } catch (e) {
      if ((e as { status?: number }).status === 404) return false;
      throw e;
    }
  }

  async maps() {
    return (await callJson(`${config.urls.game}/maps`)) as { id: string; name: string }[];
  }
}
