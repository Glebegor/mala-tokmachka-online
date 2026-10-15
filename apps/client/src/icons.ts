/** Built-in 16×16 icons. Mods reference them by name in `resources.json`; any other value is shown as a text glyph. */
const PATHS: Record<string, string> = {
  coin: '<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.2v7.6M10.2 6.2H7.2a1.3 1.3 0 000 2.6h1.6a1.3 1.3 0 010 2.6H5.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  bolt: '<path d="M9.3 1 3.2 9h3.9l-.9 6 6.6-8.4H8.5z" fill="currentColor"/>',
  person: '<circle cx="8" cy="4.8" r="2.7" fill="currentColor"/><path d="M2.6 14.4c0-3.1 2.4-5.1 5.4-5.1s5.4 2 5.4 5.1z" fill="currentColor"/>',
  rock: '<path d="M2.5 11.5 4 6l4-3.2 4.3 2L13.6 11 9.3 13.6z" fill="currentColor"/>',
  ingot: '<path d="M4 6h8l2.4 4H1.6z" fill="currentColor"/><path d="M1 11h14v2.5H1z" fill="currentColor" opacity=".7"/>',
  shell: '<path d="M6 1.5c1.6 0 2.6 2 2.6 4.4V12H3.4V5.9C3.4 3.5 4.4 1.5 6 1.5z" fill="currentColor"/><path d="M3 12.6h6v1.9H3z" fill="currentColor" opacity=".75"/><path d="M11 5c.9 0 1.5 1.2 1.5 2.6V12h-3V7.6C9.5 6.2 10.1 5 11 5z" fill="currentColor" opacity=".7"/><path d="M9.3 12.6h3.4v1.9H9.3z" fill="currentColor" opacity=".5"/>',
  drop: '<path d="M8 1.4S3.4 6.4 3.4 9.6a4.6 4.6 0 009.2 0C12.6 6.4 8 1.4 8 1.4z" fill="currentColor"/>',
};

export function iconHtml(name: string | undefined, color: string): string {
  if (name && PATHS[name]) return `<svg class="ico-svg" viewBox="0 0 16 16" style="color:${color}">${PATHS[name]}</svg>`;
  if (name) return `<span class="ico-svg glyph-ico" style="color:${color}">${name.slice(0, 2)}</span>`;
  return `<span class="ico-svg dot-ico" style="background:${color}"></span>`;
}

/** Buffs and debuffs: icon, name and what it does (`v` is the value sent by the server). */
const pct = (v: number) => `${Math.round(v * 100)}%`;
export const STATUS: Record<string, { name: string; icon: string; text: (v: number) => string }> = {
  cover: { name: 'In cover', icon: '<path d="M8 1.5 13.5 3.5v4.2c0 3.2-2.3 5.6-5.5 6.8C4.8 13.3 2.5 10.9 2.5 7.7V3.5z" fill="currentColor"/>', text: (v) => `Takes ${pct(v)} less damage from the terrain it stands in.` },
  concealed: { name: 'Concealed', icon: '<path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 13 13 3" stroke="currentColor" stroke-width="1.6"/>', text: (v) => `Enemies must come within ${pct(v)} of their normal sight range to spot it.` },
  highground: { name: 'High ground', icon: '<path d="M1.5 13 6 5l2.5 4 2-2.5 4 6.5z" fill="currentColor"/>', text: (v) => `Sees ${pct(v - 1)} further.` },
  fortified: { name: 'Fortified', icon: '<path d="M2.5 14V5h2v2h2V5h3v2h2V5h2v9z" fill="currentColor"/>', text: (v) => `Near trenches or bunkers: incoming damage is divided by ${v.toFixed(2)}.` },
  veteran: { name: 'Veteran', icon: '<path d="M8 1.5l1.9 4.1 4.4.5-3.3 3 .9 4.4L8 11.3l-3.9 2.2.9-4.4-3.3-3 4.4-.5z" fill="currentColor"/>', text: (v) => `Rank bonus: deals ${pct(v - 1)} more damage, with more health and range.` },
  exposed: { name: 'Exposed', icon: '<path d="M8 1.5 14.5 13h-13z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 6v3.5M8 11.2v.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>', text: (v) => `In the water: takes ${pct(v)} more damage.` },
  lowsight: { name: 'Poor sight', icon: '<path d="M1.5 8s2.4-3.2 6.5-3.2S14.5 8 14.5 8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 10.5 3 12.5M8 11v2.2M12 10.5l1 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>', text: (v) => `Sight range cut to ${pct(v)} by the terrain.` },
  slowed: { name: 'Slowed', icon: '<path d="M3 3.5 8 8l5-4.5M3 8.5 8 13l5-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', text: (v) => `Moves at ${pct(v)} speed across this terrain. Roads avoid this.` },
  transport: { name: 'Transport mode', icon: '<path d="M1.5 4h8v6h-8zM9.5 6h3l2 2.2V10h-5z" fill="currentColor"/><circle cx="4.5" cy="11.5" r="1.7" fill="currentColor"/><circle cx="11.5" cy="11.5" r="1.7" fill="currentColor"/>', text: (v) => `Driving in column: cannot fire and takes ${pct(v - 1)} more damage.` },
  citydefense: { name: 'Home city', icon: '<path d="M2 14V7l3-2v2l3-2v2l3-2v9z" fill="currentColor"/><path d="M12 14V4h2v10z" fill="currentColor"/>', text: (v) => `Fighting near a city your side holds: takes ${pct(v)} less damage.` },
  sprint: { name: 'Sprinting', icon: '<path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" fill="currentColor"/>', text: () => 'Moving at double speed: infantry tire, vehicles burn 50% more fuel.' },
  lowfuel: { name: 'Low fuel', icon: '<path d="M8 2S4 7 4 9.6a4 4 0 008 0C12 7 8 2 8 2z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.6 11h4.8" stroke="currentColor" stroke-width="1.5"/>', text: (v) => `Only ${pct(v)} fuel left: refuel at a filling station, fuel truck, base or (drones) an airfield.` },
  nofuel: { name: 'Out of fuel', icon: '<path d="M8 2S4 7 4 9.6a4 4 0 008 0C12 7 8 2 8 2z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M4 4l8 9" stroke="currentColor" stroke-width="1.6"/>', text: () => 'Cannot move until refuelled. Send a fuel truck.' },
  supplied: { name: 'Resupplying', icon: '<path d="M5.5 2c1.3 0 2 1.6 2 3.4V12h-4V5.4C3.5 3.6 4.2 2 5.5 2zM10.5 2c1.3 0 2 1.6 2 3.4V12h-4V5.4C8.5 3.6 9.2 2 10.5 2z" fill="currentColor"/><path d="M3 12.8h10v1.7H3z" fill="currentColor"/>', text: (v) => `An ammo depot or base is in range: refilling rounds (${pct(v)} full).` },
  crowded: { name: 'Crowded', icon: '<circle cx="4.5" cy="6" r="2" fill="currentColor"/><circle cx="11.5" cy="6" r="2" fill="currentColor"/><circle cx="8" cy="4.5" r="2" fill="currentColor"/><path d="M1.5 13.5c0-2.2 1.4-3.4 3-3.4s3 1.2 3.5 3.4M8 13.5c.5-2.2 1.9-3.4 3.5-3.4s3 1.2 3 3.4" fill="currentColor"/>', text: (v) => `Too many troops in one place (more than 6 within 1.5 km): they take ${Math.round((v - 1) * 100)}% more damage, deal less and push the front less. Spread out.` },
  dugin: { name: 'Dug in', icon: '<path d="M1.5 12.5h13M3 12.5l2-4h6l2 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M6 8.5V6.5a2 2 0 014 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/>', text: (v) => `Has stood its ground: takes ${pct(v)} less damage (5% more every 15 s still, up to 40%). Moving loses it.` },
  healing: { name: 'Being treated', icon: '<path d="M6.3 2h3.4v4.3H14v3.4H9.7V14H6.3V9.7H2V6.3h4.3z" fill="currentColor"/>', text: () => 'A medic, mechanic or field hospital is restoring its strength.' },
  lowmorale: { name: 'Low morale', icon: '<path d="M8 2a6 6 0 100 12A6 6 0 008 2z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.4 11c.7-.9 1.6-1.3 2.6-1.3s1.9.4 2.6 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="6.6" r="1" fill="currentColor"/><circle cx="10" cy="6.6" r="1" fill="currentColor"/>', text: (v) => `Shaken: deals ${pct(v)} of its normal damage. Morale returns out of the fight, faster near the base or a field hospital.` },
  broken: { name: 'Breaking', icon: '<path d="M8 2a6 6 0 100 12A6 6 0 008 2z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 5l6 6M11 5l-6 6" stroke="currentColor" stroke-width="1.5"/>', text: (v) => `Morale at ${pct(v)}: fights at half strength and, if encircled, will surrender when it runs out.` },
  lowammo: { name: 'Low ammo', icon: '<path d="M8 2c1.4 0 2.2 1.8 2.2 3.8V12H5.8V5.8C5.8 3.8 6.6 2 8 2z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.8 10h4.4V12H5.8z" fill="currentColor"/>', text: (v) => `Only ${pct(v)} of its rounds left: bring it near an ammo depot or base.` },
  noammo: { name: 'Out of ammo', icon: '<path d="M8 2c1.4 0 2.2 1.8 2.2 3.8V12H5.8V5.8C5.8 3.8 6.6 2 8 2z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 3l10 10" stroke="currentColor" stroke-width="1.6"/>', text: () => 'No rounds left: it cannot fire until it refills at an ammo depot or base.' },
  encircled: { name: 'Encircled', icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/>', text: (v) => `Cut off in a cauldron: deals only ${pct(v)} damage and loses strength every second.` },
  entrenched: { name: 'Sector Defense', icon: '<path d="M8 1.5 13.5 3.5v4.2c0 3.2-2.3 5.6-5.5 6.8C4.8 13.3 2.5 10.9 2.5 7.7V3.5z" fill="currentColor"/><path d="M8 4.5v7" stroke="#0b0d10" stroke-width="1.6"/>', text: (v) => `Defending 2x2 km sector: takes ${pct(v * 0.65)} less direct fire damage. Drones and artillery bypass this defense.` },
};

export function statusIconHtml(id: string, good: boolean): string {
  const s = STATUS[id];
  return `<svg class="st-ico ${good ? 'good' : 'bad'}" viewBox="0 0 16 16">${s?.icon ?? '<circle cx="8" cy="8" r="4" fill="currentColor"/>'}</svg>`;
}
