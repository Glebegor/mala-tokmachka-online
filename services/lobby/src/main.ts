import { config, serve } from '@sw/kit';
import { LobbyService } from './application/lobbyService';
import { HttpMatchLauncher } from './infrastructure/gameClient';
import { lobbyRoutes } from './interface/http';

const lobby = new LobbyService(new HttpMatchLauncher());
serve(lobbyRoutes(lobby, config.secret), config.ports.lobby, 'lobby');
// drop rooms whose match is over or was closed because everyone left
setInterval(() => void lobby.sweep(), 5000);
