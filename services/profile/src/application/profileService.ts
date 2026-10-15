import { HttpError } from '@sw/kit';
import { applyMatch, emptyProfile, type MatchReport, type Profile, type ProfileRepository } from '../domain/profile';

export class ProfileService {
  constructor(private repo: ProfileRepository) {}

  /** A player who has not finished a match yet still has a (blank) profile. */
  async get(id: string, name = 'Unknown'): Promise<Profile> {
    return (await this.repo.get(id)) ?? emptyProfile(id, name);
  }

  async record(report: MatchReport) {
    if (!report || typeof report.matchId !== 'string' || !Array.isArray(report.players)) throw new HttpError(400, 'bad report');
    const at = Date.now();
    await this.repo.saveMatch({ ...report, at, timeline: Array.isArray(report.timeline) ? report.timeline : [] });
    // careers are kept for people, not bots
    for (const player of report.players) {
      if (player.bot) continue;
      const current = await this.get(player.id, player.name);
      await this.repo.save(applyMatch(current, report, player, at));
    }
  }

  async match(id: string) {
    const m = await this.repo.getMatch(id);
    if (!m) throw new HttpError(404, 'match not found');
    return m;
  }

  async leaderboard(limit = 10) {
    const all = await this.repo.all();
    return all
      .filter((p) => p.matches > 0)
      .sort((a, b) => b.wins - a.wins || b.kills - a.kills)
      .slice(0, limit)
      .map(({ id, name, matches, wins, kills }) => ({ id, name, matches, wins, kills }));
  }
}
