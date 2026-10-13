const env = (k: string, d: string) => process.env[k] ?? d;

export const config = {
  secret: env('SW_SECRET', 'dev-secret-change-me'),
  internalKey: env('SW_INTERNAL_KEY', 'dev-internal-key'),
  ports: {
    gateway: Number(env('GATEWAY_PORT', '8080')),
    auth: Number(env('AUTH_PORT', '4001')),
    lobby: Number(env('LOBBY_PORT', '4002')),
    game: Number(env('GAME_PORT', '4003')),
    profile: Number(env('PROFILE_PORT', '4004')),
  },
  urls: {
    auth: env('AUTH_URL', 'http://localhost:4001'),
    lobby: env('LOBBY_URL', 'http://localhost:4002'),
    game: env('GAME_URL', 'http://localhost:4003'),
    profile: env('PROFILE_URL', 'http://localhost:4004'),
  },
  modsDir: env('SW_MODS_DIR', new URL('../../../mods', import.meta.url).pathname),
  dataDir: env('SW_DATA_DIR', new URL('../../../data', import.meta.url).pathname),
};
