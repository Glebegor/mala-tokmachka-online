import { config, serve } from '@sw/kit';
import { MatchManager } from './application/matchManager';
import { loadRuleset } from './infrastructure/modLoader';
import { gameRoutes } from './interface/http';
import { attachWs } from './interface/ws';

const only = process.env.SW_MODS?.split(',').filter(Boolean);
const ruleset = await loadRuleset(config.modsDir, only);
console.log(`[game] mods: ${ruleset.mods.map((m) => `${m.id}@${m.version}`).join(', ')}`);

const manager = new MatchManager(ruleset);
attachWs(serve(gameRoutes(manager), config.ports.game, 'game'), manager);
