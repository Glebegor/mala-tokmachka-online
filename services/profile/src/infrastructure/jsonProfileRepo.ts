import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Profile, ProfileRepository } from '../domain/profile';

/** File-backed repository; swap for a database by implementing the same port. */
export class JsonProfileRepository implements ProfileRepository {
  private cache: Map<string, Profile> | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private file: string) {}

  private async load() {
    if (this.cache) return this.cache;
    try {
      this.cache = new Map((JSON.parse(await readFile(this.file, 'utf8')) as Profile[]).map((p) => [p.id, p]));
    } catch {
      this.cache = new Map();
    }
    return this.cache;
  }

  async get(id: string) {
    return (await this.load()).get(id);
  }

  async all() {
    return [...(await this.load()).values()];
  }

  async save(profile: Profile) {
    const all = await this.load();
    all.set(profile.id, profile);
    // writes are queued so two match reports can never interleave on disk
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify([...all.values()], null, 2));
    });
    await this.writing;
  }
}
