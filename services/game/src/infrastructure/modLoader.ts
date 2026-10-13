import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_RULES, type BuildingDef, type MapDef, type ResourceDef, type Ruleset, type UnitDef } from '@sw/core';

interface ModManifest {
  id: string;
  name: string;
  version: string;
  content: {
    rules?: string;
    resources?: string;
    buildings?: string;
    units?: string;
    maps?: string[];
    theme?: string;
    scripts?: string[];
  };
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8'));

function mergeById<T extends { id: string }>(target: T[], incoming: T[]) {
  for (const item of incoming) {
    const i = target.findIndex((t) => t.id === item.id);
    if (i >= 0) target[i] = item;
    else target.push(item);
  }
}

/** Loads every mod directory (or the ids in `only`) in load order: `base` first, then alphabetical. */
export async function loadRuleset(modsDir: string, only?: string[]): Promise<Ruleset> {
  const dirs = (await readdir(modsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  dirs.sort((a, b) => (a === 'base' ? -1 : b === 'base' ? 1 : a.localeCompare(b)));

  const rs: Ruleset = { mods: [], rules: { ...DEFAULT_RULES }, resources: [], buildings: [], units: [], maps: [], themes: [], scripts: [] };

  for (const dir of dirs) {
    const root = join(modsDir, dir);
    let manifest: ModManifest;
    try {
      manifest = await readJson<ModManifest>(join(root, 'mod.json'));
    } catch {
      continue;
    }
    if (only?.length && !only.includes(manifest.id)) continue;
    const c = manifest.content;
    rs.mods.push({ id: manifest.id, name: manifest.name, version: manifest.version });
    if (c.rules) Object.assign(rs.rules, await readJson(join(root, c.rules)));
    if (c.resources) mergeById<ResourceDef>(rs.resources, await readJson(join(root, c.resources)));
    if (c.buildings) mergeById<BuildingDef>(rs.buildings, await readJson(join(root, c.buildings)));
    if (c.units) mergeById<UnitDef>(rs.units, await readJson(join(root, c.units)));
    for (const m of c.maps ?? []) mergeById<MapDef>(rs.maps, [await readJson(join(root, m))]);
    if (c.theme) rs.themes.push({ modId: manifest.id, css: await readFile(join(root, c.theme), 'utf8') });
    for (const s of c.scripts ?? []) rs.scripts.push({ modId: manifest.id, file: s, source: await readFile(join(root, s), 'utf8') });
  }

  validate(rs);
  return rs;
}

function validate(rs: Ruleset) {
  if (!rs.buildings.some((b) => b.id === 'hq')) throw new Error('ruleset needs a building with id "hq"');
  if (!rs.maps.length) throw new Error('ruleset has no maps');
  const units = new Set(rs.units.map((u) => u.id));
  for (const b of rs.buildings) for (const u of b.trains ?? []) if (!units.has(u)) throw new Error(`building ${b.id} trains unknown unit ${u}`);
  const res = new Set(rs.resources.map((r) => r.id));
  const check = (what: string, m?: Record<string, number>) => {
    for (const k of Object.keys(m ?? {})) if (!res.has(k)) throw new Error(`${what} uses unknown resource ${k}`);
  };
  rs.buildings.forEach((b) => (check(b.id, b.cost), check(b.id, b.produces), check(b.id, b.consumes)));
  rs.units.forEach((u) => check(u.id, u.cost));
}
