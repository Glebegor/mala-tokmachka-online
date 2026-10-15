import assert from 'node:assert/strict';
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteProfileRepository } from '../src/infrastructure/sqliteProfileRepo';
import { ProfileService } from '../src/application/profileService';
import { emptyProfile } from '../src/domain/profile';
// Profile database: SQLite storage of careers and full match reports.
const dir = mkdtempSync(join(tmpdir(), 'sw-profile-'));
const legacy = `${dir}/profiles.json`;
writeFileSync(legacy, JSON.stringify([{ ...emptyProfile('old', 'Veteran'), matches: 3, wins: 2 }]));
const repo = new SqliteProfileRepository(`${dir}/p.sqlite`, legacy);
const svc = new ProfileService(repo);
assert.equal((await svc.get('old')).wins, 2, 'old JSON profiles imported');
assert.ok(!existsSync(legacy) && existsSync(`${legacy}.imported`), 'and the file set aside');
const stats = (k: number) => ({ kills: k, losses: 1, buildingsBuilt: 2, buildingsDestroyed: 0, unitsTrained: 5, damage: 1234 });
const report = { matchId: 'm1', mapId: 'ukraine', seconds: 600, winner: 0 as const, reason: 'all points captured',
  players: [{ id: 'a', name: 'Alice', team: 0 as const, bot: false, stats: stats(7) }, { id: 'bot-1', name: 'Bot RU-1', team: 1 as const, bot: true, stats: stats(3) }],
  timeline: [{ t: 0, score: [0, 0] as [number, number], units: [4, 4] as [number, number], buildings: [1, 1] as [number, number], cities: [5, 5] as [number, number] }] };
await svc.record(report);
await svc.record(report); // reported twice: counted once
const alice = await svc.get('a');
assert.equal(alice.matches, 1); assert.equal(alice.wins, 1); assert.equal(alice.kills, 7);
assert.equal((await repo.get('bot-1')), undefined, 'no career for bots');
const m = await svc.match('m1');
assert.equal(m.players.length, 2, 'the stored match keeps every player, bots too');
assert.equal(m.timeline.length, 1); assert.ok(m.at! > 0);
// survives a restart
const repo2 = new SqliteProfileRepository(`${dir}/p.sqlite`);
const again = new ProfileService(repo2);
assert.equal((await again.get('a')).kills, 7);
assert.equal((await again.match('m1')).reason, 'all points captured');
repo.close();
repo2.close();
console.log('profile database ok');
try { rmSync(dir, { recursive: true, force: true }); } catch {}
