import { config, serve } from '@sw/kit';
import { LobbyService } from './application/lobbyService';
import { HttpMatchLauncher } from './infrastructure/gameClient';
import { lobbyRoutes } from './interface/http';

serve(lobbyRoutes(new LobbyService(new HttpMatchLauncher()), config.secret), config.ports.lobby, 'lobby');
