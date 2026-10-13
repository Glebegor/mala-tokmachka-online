import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { User, UserRepository } from '../domain/user';

/** File-backed repository; swap for Postgres by implementing the same port. */
export class JsonUserRepository implements UserRepository {
  private cache: User[] | null = null;
  constructor(private file: string) {}

  private async load(): Promise<User[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.cache = [];
    }
    return this.cache!;
  }

  async findByName(name: string) {
    return (await this.load()).find((u) => u.name.toLowerCase() === name.toLowerCase());
  }

  async save(user: User) {
    const all = await this.load();
    all.push(user);
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2));
  }
}
