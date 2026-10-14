import { distKm, isReconDrone, isStrikeDrone, type BuildingDef, type Command, type LngLat, type SnapMsg, type UnitDef, type UnitView } from '@sw/core';
import { clear, h } from './dom';

/** Picking state shared with the map: route = two clicks on buildings, barrage and launch = one click on the map. */
export interface Pickers {
  route: { unitId: number; fromBuilding?: number; resType?: string } | null;
  /** Click a vehicle to drive over and give it fuel. */
  fuel: { unitId: number } | null;
  bombard: { unitIds: number[] } | null;
  /** Launch the drones a vehicle carries at the clicked spot. */
  launch: { transport: number } | null;
}

export interface HudContext {
  snap: SnapMsg;
  me: string;
  myTeam: 0 | 1;
  sel: Set<number>;
  defU: Map<string, UnitDef>;
  defB: Map<string, BuildingDef>;
  roadMult: number;
  fuelPerKm: number;
  pick: Pickers;
  send(cmd: Command): void;
  toast(text: string, bad?: boolean): void;
  rerender(): void;
  icon(d: UnitDef, rank: number): HTMLElement;
  pos(u: UnitView): LngLat;
}

const RES_LABEL: Record<string, string> = { ore: 'Ore', metal: 'Metal', fuel: 'Fuel', ammo: 'Ammo', any: 'Any cargo' };

export function formatEta(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${Math.round(sec % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Rough arrival time along the planned path: road speed while driving in column, a cross-country average otherwise. */
export function etaSeconds(u: UnitView, d: UnitDef, roadMult: number, from: LngLat): number | null {
  const pts = u.path?.length ? u.path : u.target ? [u.target] : [];
  if (!pts.length) return null;
  let km = 0;
  let prev = from;
  for (const p of pts) (km += distKm(prev, p)), (prev = p);
  const speed = d.speed * (d.kind === 'air' ? 1 : u.transport ? roadMult : 0.7) * (u.sprint ? 2 : 1);
  return speed > 0 ? km / speed : null;
}

/**
 * Bottom command panel for the selected units (from the akira branch): stop, fire discipline, sprint and stamina,
 * fuel and refuelling, delivery routes for trucks, riding in vehicles, and artillery barrages.
 */
export function renderUnitHud(el: HTMLElement, c: HudContext) {
  clear(el);
  const list = c.snap.units.filter((u) => c.sel.has(u.id) && u.owner === c.me);
  if (!list.length) return void (el.style.display = 'none');
  el.style.display = 'flex';
  const first = list[0];
  const d0 = c.defU.get(first.def)!;
  const single = list.length === 1;
  const ids = list.map((u) => u.id);

  // 1. title, fuel endurance, ETA / delivery state
  const lines: string[] = [];
  const fuelled = list.filter((u) => u.fuel !== undefined);
  if (fuelled.length) {
    const avg = fuelled.reduce((a, u) => a + (u.fuel ?? 0), 0) / fuelled.length;
    const d = c.defU.get(fuelled[0].def)!;
    const burn = (d.kind === 'air' ? 0.08 : c.fuelPerKm) * d.speed * (list.some((u) => u.sprint) ? 1.5 : 1);
    lines.push(`Fuel for ~${formatEta(avg / Math.max(burn, 1e-4))} of driving`);
  }
  if (first.haul) {
    const res = first.haul.resType ? ` [${RES_LABEL[first.haul.resType] ?? first.haul.resType}]` : '';
    if (first.haul.state === 'loading') lines.push(`Loading${res} (${Math.ceil(first.haul.timer ?? 5)}s)`);
    else if (first.haul.state === 'unloading') lines.push(`Unloading${res} (${Math.ceil(first.haul.timer ?? 4)}s)`);
    else {
      const eta = etaSeconds(first, d0, c.roadMult, c.pos(first));
      lines.push(`${first.haul.state === 'to_to' ? 'To unloading' : 'To loading'}${res}${eta ? `: ~${formatEta(eta)}` : ''}`);
    }
  } else if (first.fuelTo) {
    const t = c.snap.units.find((u) => u.id === first.fuelTo);
    lines.push(`Taking fuel to ${t ? c.defU.get(t.def)?.name ?? 'a vehicle' : 'a vehicle'}`);
  } else if (first.isLoitering) {
    lines.push('Patrolling a 4 km circle');
  } else if (d0.missile && !first.target) {
    lines.push('On the launcher: right click a target to fire');
  } else {
    const etas = list.map((u) => etaSeconds(u, c.defU.get(u.def)!, c.roadMult, c.pos(u)) ?? 0);
    const eta = Math.max(...etas);
    if (eta > 0) lines.push(`Arrives in ~${formatEta(eta)}`);
  }
  el.append(
    h('div', { class: 'hud-sec' },
      single ? c.icon(d0, first.rank) : null,
      h('div', {}, h('div', { class: 'hud-title' }, single ? d0.name : `${list.length} units`), ...lines.map((t) => h('div', { class: 'hud-line' }, t))),
    ),
  );

  // 2. stop
  el.append(h('button', { class: 'hud-btn', title: 'Stop everything (S)', onClick: () => {
    c.send({ type: 'stop', units: ids });
    c.send({ type: 'bombard', units: ids, target: null });
    c.pick.route = c.pick.bombard = c.pick.launch = c.pick.fuel = null;
    c.rerender();
  } }, 'Stop'));

  // 3. fire discipline
  const mode = first.fireMode ?? 'auto';
  const fm = (m: 'auto' | 'return' | 'hold', label: string, title: string) =>
    h('button', { class: mode === m ? 'active' : '', title, onClick: () => c.send({ type: 'fireMode', units: ids, mode: m }) }, label);
  el.append(h('div', { class: 'btn-group', title: 'Fire discipline' },
    fm('auto', 'Fire at will', 'Engage any enemy in range'),
    fm('return', 'Return fire', 'Only shoot back once hit'),
    fm('hold', 'Hold fire', 'Never shoot (stay hidden)')));

  // 4. sprint and stamina (ground only)
  const ground = list.filter((u) => c.defU.get(u.def)!.kind !== 'air');
  if (ground.length) {
    const on = ground.some((u) => u.sprint);
    el.append(h('button', { class: 'hud-btn' + (on ? ' active' : ''), title: 'Double speed: infantry tire (60 s of running, 3 min to recover), vehicles burn 50% more fuel', onClick: () => c.send({ type: 'sprint', units: ids, active: !on }) }, `Sprint ${on ? 'ON' : 'OFF'}`));
    const tired = ground.filter((u) => u.stamina !== undefined);
    if (tired.length) el.append(meter('Stamina', tired.reduce((a, u) => a + (u.stamina ?? 100), 0) / tired.length, 'stamina'));
  }

  // 5. fuel gauge and refuelling
  if (fuelled.length) {
    const pct = (fuelled.reduce((a, u) => a + (u.fuel ?? 0), 0) / Math.max(1, fuelled.reduce((a, u) => a + (u.maxFuel ?? 100), 0))) * 100;
    const onlyStrike = list.every((u) => isStrikeDrone(c.defU.get(u.def)));
    const recon = list.some((u) => isReconDrone(c.defU.get(u.def)));
    el.append(h('div', { class: 'hud-sec' },
      meter('Fuel', pct, 'fuel'),
      onlyStrike ? null : h('button', { class: 'hud-btn sm', title: recon ? 'Fly to the nearest airfield' : 'Drive to the nearest filling station, fuel truck or base', onClick: () => {
        if (recon && !c.snap.buildings.some((b) => b.def === 'airfield' && b.team === c.myTeam && b.progress >= 1)) return c.toast('No airfield to refuel at: build one', true);
        c.send({ type: 'refuel', units: ids });
      } }, 'Refuel')));
  }

  // 5b. hand fuel to another vehicle (tankers from their load, other vehicles from their own tank)
  if (single && d0.kind === 'ground' && (d0.fuelOnly || first.fuel !== undefined)) {
    const picking = c.pick.fuel?.unitId === first.id;
    el.append(h('button', { class: 'hud-btn sm' + (picking ? ' active' : ''), title: d0.fuelOnly ? 'Drive to a vehicle and fill its tank from your load' : 'Drive to a vehicle and give it fuel from your own tank (keeps a quarter)', onClick: () => {
      c.pick.fuel = picking ? null : { unitId: first.id };
      if (!picking) c.toast('Click the vehicle to refuel (yours or an ally’s; right click or Esc cancels)');
      c.rerender();
    } }, picking ? 'Cancel' : 'Give fuel…'));
  }

  // 6. trucks: delivery route, cargo, passengers
  if (single && d0.cargoCap) {
    const cargo = first.cargo?.res ?? {};
    const load = Object.values(cargo).reduce((a, v) => a + v, 0);
    let control: HTMLElement;
    if (c.pick.route?.unitId === first.id) {
      const from = c.pick.route.fromBuilding ? c.snap.buildings.find((b) => b.id === c.pick.route!.fromBuilding) : null;
      const opts = d0.fuelOnly ? [] : ['ore', 'metal', 'ammo', 'any'];
      if (from && opts.length && !c.pick.route.resType) c.pick.route.resType = opts[0];
      control = h('div', { class: 'route-box' },
        h('b', {}, from ? 'Step 2 of 2: click where to unload' : 'Step 1 of 2: click where to load'),
        from && opts.length ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Carry:'), ...opts.map((o) =>
          h('button', { class: 'hud-btn sm' + (c.pick.route!.resType === o ? ' active' : ''), onClick: (e: MouseEvent) => (e.stopPropagation(), (c.pick.route!.resType = o), c.rerender()) }, RES_LABEL[o]))) : null,
        h('button', { class: 'hud-btn sm warn', onClick: () => ((c.pick.route = null), c.rerender()) }, 'Cancel (Esc)'));
    } else if (first.haul) {
      const name = (id: number) => c.defB.get(c.snap.buildings.find((b) => b.id === id)?.def ?? '')?.name ?? 'site';
      control = h('div', { class: 'route-box' },
        h('b', {}, `Route: ${name(first.haul.fromBuilding)} → ${name(first.haul.toBuilding)}${first.haul.resType ? ` (${RES_LABEL[first.haul.resType] ?? first.haul.resType})` : ''}`),
        h('button', { class: 'hud-btn sm warn', onClick: () => c.send({ type: 'stop', units: [first.id] }) }, 'Stop route'));
    } else {
      control = h('button', { class: 'hud-btn', title: 'Set up a standing delivery between two of your buildings', onClick: () => {
        c.pick.route = { unitId: first.id };
        c.toast('Delivery route: click the building to load at');
        c.rerender();
      } }, 'Set delivery route');
    }
    const passengers = first.cargo?.passengers?.length ?? 0;
    const detail = d0.fuelOnly ? `Tank: ${Math.round(cargo.fuel ?? 0)} / ${d0.cargoCap}` : `Cargo: ${Math.round(load)} / ${d0.cargoCap}${load ? ` (${Object.entries(cargo).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')})` : ''}`;
    el.append(h('div', { class: 'hud-sec col' }, control,
      h('div', { class: 'row' }, h('span', { class: 'hud-line' }, detail + (d0.passengerCap ? ` · riders ${passengers}/${d0.passengerCap}` : '')),
        passengers ? h('button', { class: 'hud-btn sm', onClick: () => c.send({ type: 'disembark', transport: first.id }) }, `Dismount (${passengers})`) : null)));
  }

  // 7. infantry: ride in the nearest vehicle with room
  const foot = list.filter((u) => (c.defU.get(u.def)!.mobility ?? 'foot') === 'foot' && c.defU.get(u.def)!.kind === 'ground');
  if (foot.length) {
    const at = c.pos(foot[0]);
    const ride = c.snap.units
      .filter((t) => t.owner === c.me && (c.defU.get(t.def)?.passengerCap ?? 0) > (t.cargo?.passengers?.length ?? 0) && distKm(at, c.pos(t)) <= 10)
      .sort((a, b) => distKm(at, c.pos(a)) - distKm(at, c.pos(b)))[0];
    if (ride) {
      const td = c.defU.get(ride.def)!;
      const room = (td.passengerCap ?? 0) - (ride.cargo?.passengers?.length ?? 0);
      const n = Math.min(room, foot.length);
      el.append(h('button', { class: 'hud-btn sm', title: `Board the ${td.name} (${room} seats free)`, onClick: () => {
        for (const u of foot.slice(0, n)) c.send({ type: 'board', unit: u.id, transport: ride.id });
      } }, `Board ${td.name} (${n})`));
    }
  }

  // 8. small drones: ride on the nearest vehicle with a free launcher, or launch the ones on board
  const small = list.filter((u) => c.defU.get(u.def)!.launchable);
  if (small.length) {
    const at = c.pos(small[0]);
    const carrier = c.snap.units
      .filter((t) => t.owner === c.me && (c.defU.get(t.def)?.droneCap ?? 0) > (t.cargo?.drones?.length ?? 0) && distKm(at, c.pos(t)) <= 10)
      .sort((a, b) => distKm(at, c.pos(a)) - distKm(at, c.pos(b)))[0];
    if (carrier) {
      const td = c.defU.get(carrier.def)!;
      const n = Math.min((td.droneCap ?? 0) - (carrier.cargo?.drones?.length ?? 0), small.length);
      el.append(h('button', { class: 'hud-btn sm', title: `Put ${n} drone${n === 1 ? '' : 's'} on the ${td.name}'s launcher`, onClick: () => {
        for (const u of small.slice(0, n)) c.send({ type: 'board', unit: u.id, transport: carrier.id });
      } }, `Load on ${td.name} (${n})`));
    } else el.append(h('div', { class: 'hud-line' }, 'Fits a pickup launcher: bring a pickup within 10 km to load it'));
  }
  if (single && d0.droneCap) {
    const carried = (first.cargo?.drones ?? []).length;
    const picking = c.pick.launch?.transport === first.id;
    el.append(h('div', { class: 'hud-sec col' },
      h('div', { class: 'hud-line' }, `Drone launcher: ${carried}/${d0.droneCap}${carried ? '' : ' · select small drones next to it and press Load'}`),
      carried ? h('div', { class: 'row' },
        h('button', { class: 'hud-btn sm' + (picking ? ' active' : ''), title: 'Click the spot to send them to: strike drones dive on it, recon drones circle it', onClick: () => {
          c.pick.launch = picking ? null : { transport: first.id };
          if (!picking) c.toast('Click where to send the drones (right click or Esc cancels)');
          c.rerender();
        } }, picking ? 'Cancel' : 'Launch at…'),
        h('button', { class: 'hud-btn sm', title: 'Launch them here: recon drones circle the vehicle, strike drones wait for orders', onClick: () => c.send({ type: 'launch', transport: first.id }) }, 'Launch here')) : null));
  }

  // 9. artillery barrage
  const guns = list.filter((u) => c.defU.get(u.def)!.minRange);
  if (guns.length) {
    const dg = c.defU.get(guns[0].def)!;
    const picking = !!c.pick.bombard;
    el.append(h('div', { class: 'hud-sec col' },
      h('div', { class: 'hud-line warn' }, `Artillery: ${dg.minRange}–${dg.range} km`),
      h('div', { class: 'row' },
        h('button', { class: 'hud-btn sm' + (picking ? ' active' : ''), onClick: () => {
          c.pick.bombard = picking ? null : { unitIds: guns.map((u) => u.id) };
          if (!picking) c.toast('Click the area to shell (right click or Esc cancels)');
          c.rerender();
        } }, picking ? 'Cancel' : 'Barrage area'),
        guns.some((u) => u.bombardTarget) ? h('button', { class: 'hud-btn sm warn', onClick: () => c.send({ type: 'bombard', units: guns.map((u) => u.id), target: null }) }, 'Cease fire') : null)));
  }
}

function meter(label: string, pct: number, kind: string) {
  const v = Math.max(0, Math.min(100, pct));
  return h('div', { class: 'meter-wrap' }, h('div', { class: 'meter-label' }, h('span', {}, label), h('span', {}, `${Math.round(v)}%`)), h('div', { class: 'meter-bar' }, h('div', { class: `meter-fill ${kind}`, style: { width: `${v}%` } })));
}
