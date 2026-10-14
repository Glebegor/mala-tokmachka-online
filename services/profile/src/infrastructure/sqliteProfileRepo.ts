import { mkdirSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchReport, Profile, ProfileRepository } from '../domain/profile';

/**
 * SQLite storage (Node's built-in driver): one row per player profile and one per finished match with its full report.
 * On first start an existing profiles.json from the old file storage is imported (and renamed so it is not read twice).
 */
export class SqliteProfileRepository implements ProfileRepository {
  private db: DatabaseSync;

  constructor(file: string, legacyJson?: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, at INTEGER NOT NULL, map_id TEXT NOT NULL, seconds INTEGER NOT NULL, winner INTEGER, reason TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS match_players (match_id TEXT NOT NULL, player_id TEXT NOT NULL, name TEXT NOT NULL, team INTEGER NOT NULL, bot INTEGER NOT NULL,
        kills INTEGER, losses INTEGER, damage INTEGER, PRIMARY KEY (match_id, player_id));
      CREATE INDEX IF NOT EXISTS match_players_player ON match_players (player_id);
    `);
    if (legacyJson && existsSync(legacyJson) && !(this.db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n) {
      try {
        const old = JSON.parse(readFileSync(legacyJson, 'utf8')) as Profile[];
        for (const p of old) this.saveSync(p);
        renameSync(legacyJson, `${legacyJson}.imported`);
        console.log(`[profile] imported ${old.length} profiles from ${legacyJson}`);
      } catch (e) {
        console.warn(`[profile] could not import ${legacyJson}: ${(e as Error).message}`);
      }
    }
  }

  private saveSync(p: Profile) {
    this.db.prepare('INSERT INTO profiles (id, name, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data').run(p.id, p.name, JSON.stringify(p));
  }

  async get(id: string) {
    const row = this.db.prepare('SELECT data FROM profiles WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Profile) : undefined;
  }

  async all() {
    return (this.db.prepare('SELECT data FROM profiles').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Profile);
  }

  async save(p: Profile) {
    this.saveSync(p);
  }

  async saveMatch(m: MatchReport) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT OR REPLACE INTO matches (id, at, map_id, seconds, winner, reason, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(m.matchId, m.at ?? Date.now(), m.mapId, Math.round(m.seconds), m.winner, m.reason ?? null, JSON.stringify(m));
      const row = this.db.prepare('INSERT OR REPLACE INTO match_players (match_id, player_id, name, team, bot, kills, losses, damage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const p of m.players) row.run(m.matchId, p.id, p.name, p.team, p.bot ? 1 : 0, p.stats.kills, p.stats.losses, Math.round(p.stats.damage));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async getMatch(id: string) {
    const row = this.db.prepare('SELECT data FROM matches WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as MatchReport) : undefined;
  }
}
