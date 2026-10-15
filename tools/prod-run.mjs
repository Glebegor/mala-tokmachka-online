#!/usr/bin/env node
// Production run: `npm run docker-prod:run`
//   - creates .env.prod with random secrets the first time (kept for later runs, so logins survive restarts)
//   - builds and starts every service with Docker Compose (restart unless stopped)
//   - waits until the game answers and prints where to open it: this machine, the LAN and Tailscale
// Options: SW_PORT=8080 npm run docker-prod:run   (default port 5173); SW_PROJECT=name for a separate stack
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = `${root}.env.prod`;

// 1. secrets
const env = existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) : {};
let changed = false;
for (const k of ['SW_SECRET', 'SW_INTERNAL_KEY']) if (!env[k]) (env[k] = randomBytes(32).toString('hex')), (changed = true);
if (process.env.SW_PORT && env.SW_PORT !== process.env.SW_PORT) (env.SW_PORT = process.env.SW_PORT), (changed = true);
env.SW_PORT ??= '5173';
if (changed || !existsSync(envFile)) {
  writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  console.log('[prod] wrote .env.prod (secrets kept for later runs)');
}

// 2. build and start
const project = process.env.SW_PROJECT ?? 'state-war'; // same project as `docker compose up`, so data volumes carry over
const compose = ['compose', '-p', project, '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml', '--env-file', '.env.prod'];
const up = spawnSync('docker', [...compose, 'up', '-d', '--build', '--remove-orphans'], { cwd: root, stdio: 'inherit' });
if (up.status !== 0) process.exit(up.status ?? 1);

// 3. wait for it to answer
const port = env.SW_PORT;
const deadline = Date.now() + 120_000;
let okPage = false;
let okApi = false;
while (Date.now() < deadline && !(okPage && okApi)) {
  try {
    okPage ||= (await fetch(`http://127.0.0.1:${port}/`)).ok;
    // any answer from the lobby (401 without a login) means the whole chain client → gateway → lobby is up
    okApi ||= [200, 401].includes((await fetch(`http://127.0.0.1:${port}/api/lobby/rooms`)).status);
  } catch { /* not up yet */ }
  if (!(okPage && okApi)) await new Promise((r) => setTimeout(r, 1500));
}
if (!okPage || !okApi) {
  console.error('[prod] the app did not come up in time; see: npm run docker-prod:logs');
  process.exit(1);
}

// 4. where to open it
const urls = [`http://localhost:${port}`];
for (const list of Object.values(networkInterfaces())) {
  for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}${a.address.startsWith('100.') ? '   (Tailscale)' : ''}`);
}
try {
  const ts = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
  if (ts && !urls.some((u) => u.includes(ts))) urls.push(`http://${ts}:${port}   (Tailscale)`);
} catch { /* tailscale not installed */ }
console.log(`\n[prod] Mala Tokmachka Online is running:\n${urls.map((u) => '  ' + u).join('\n')}\n`);
console.log('[prod] logs: npm run docker-prod:logs   stop: npm run docker-prod:stop');
