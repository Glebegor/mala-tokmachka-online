import { distKm, isReconDrone, isStrikeDrone, SECTOR_CELL, type BuildingDef, type Command, type Formation, type LngLat, type SnapMsg, type Stance, type UnitDef, type UnitView } from '@sw/core';
import { clear, h } from './dom';

/** Picking state shared with the map: route = two clicks on buildings, barrage and launch = one click on the map. */
export interface Pickers {
  /** Delivery route being put together: stops in order (buildings load or unload, map clicks are waypoints). */
  route: { unitId: number; stops: RouteStop[]; resType?: string; minLoad?: number } | null;
  /** Click a vehicle to drive over and give it fuel. */
  fuel: { unitId: number } | null;
  bombard: { unitIds: number[] } | null;
  /** Launch the drones a vehicle carries at the clicked spot. */
  launch: { transport: number } | null;
  /** Launch craft waiting at a launcher at the clicked spot. */
  launchFrom?: { building: number; units: number[] } | null;
  /** Set a production building's rally point with the next map click. */
  rally?: { building: number } | null;
  /** The route just sent: put back for editing if the server refuses it. */
  sentRoute?: { route: NonNullable<Pickers['route']>; at: number } | null;
}

export interface RouteStop {
  action: 'load' | 'unload' | 'via';
  building?: number;
  pos?: LngLat;
  once?: boolean;
}

/** How the next move orders are given (kept between selections). */
export interface OrderStyle {
  attack: boolean;
  formation: Formation;
}

export interface HudContext {
  orders: OrderStyle;
  /** Own drones and missiles waiting at launchers (not on the map). */
  stored: UnitView[];
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
    const hl = first.haul;
    const res = hl.resType ? ` [${RES_LABEL[hl.resType] ?? hl.resType}]` : '';
    if (hl.noTrack) lines.push('No track to the next station: waiting for a connection');
    else if (hl.state === 'loading') lines.push(hl.waiting ? `Waiting for ${hl.minLoad && hl.minLoad > 1 ? `at least ${hl.minLoad}` : 'goods'} to load${res}` : `Loading${res} (${Math.ceil(hl.timer ?? 5)}s)`);
    else if (hl.state === 'unloading') lines.push(hl.waiting ? 'Waiting for room to unload: the store there is full' : `Unloading${res} (${Math.ceil(hl.timer ?? 4)}s)`);
    else if (hl.refuelAt) lines.push('Low on fuel: filling up, then back on the route');
    else {
      const eta = etaSeconds(first, d0, c.roadMult, c.pos(first));
      const st = hl.stops[hl.idx];
      lines.push(`${st?.action === 'load' ? 'To loading' : st?.action === 'unload' ? 'To unloading' : 'Via waypoint'} (stop ${hl.idx + 1}/${hl.stops.length})${res}${eta ? `: ~${formatEta(eta)}` : ''}`);
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
  if (d0.kind !== 'air') {
    const sec = c.snap.sectors?.find((s) => {
      const ix = Math.floor(first.pos[0] / SECTOR_CELL.lng);
      const iy = Math.floor(first.pos[1] / SECTOR_CELL.lat);
      return s.ix === ix && s.iy === iy;
    });
    if (sec) {
      if (sec.team === c.myTeam && sec.entrenchment > 0.05) {
        lines.push(`🛡️ Sector defense: ${Math.round(sec.entrenchment * 65)}% cover (${sec.defenders} def / ${sec.attackers} att)`);
      } else if (sec.contested) {
        lines.push(`⚔️ Assaulting sector (${sec.attackers} att vs ${sec.defenders} def)`);
      }
    }
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

  // 2b. behaviour: stance, retreat, how moves are carried out
  const ground = list.filter((u) => c.defU.get(u.def)!.kind !== 'air');
  if (ground.length) {
    const stance = ground[0].stance ?? 'hold';
    const st = (s: Stance, label: string, title: string) => h('button', { class: stance === s ? 'active' : '', title, onClick: () => c.send({ type: 'stance', units: ids, stance: s }) }, label);
    el.append(h('div', { class: 'btn-group', title: 'Stance: what they do on their own' },
      st('hold', 'Hold', 'Hold position: never move on their own, fire at what comes into range'),
      st('defend', 'Defend', 'Defend: engage enemies within 3 km of their post, then return to it'),
      st('aggressive', 'Aggressive', 'Aggressive: go after any enemy they see')));
    const ret = ground[0].retreatAt ?? 0;
    const rt = (v: number, label: string) => h('button', { class: ret === v ? 'active' : '', onClick: () => c.send({ type: 'retreat', units: ids, at: v }) }, label);
    el.append(h('div', { class: 'btn-group', title: 'Fall back to a field hospital or base by themselves when health drops below this' }, h('span', { class: 'bg-label' }, 'Retreat'), rt(0, 'Off'), rt(0.25, '25%'), rt(0.5, '50%')));
    const om = (attack: boolean, label: string, title: string) => h('button', { class: c.orders.attack === attack ? 'active' : '', title, onClick: () => ((c.orders.attack = attack), c.rerender()) }, label);
    el.append(h('div', { class: 'btn-group', title: 'How right click orders are carried out (A toggles)' },
      om(false, 'Move', 'Move: push through, firing on the way'), om(true, 'Attack', 'Attack-move: stop and fight whatever they meet')));
    if (ground.length > 1) {
      const fm = (f: Formation, label: string) => h('button', { class: c.orders.formation === f ? 'active' : '', onClick: () => ((c.orders.formation = f), c.rerender()) }, label);
      el.append(h('div', { class: 'btn-group', title: 'Formation at the destination (F cycles)' }, fm('spread', 'Spread'), fm('line', 'Line'), fm('column', 'Column'), fm('wedge', 'Wedge')));
    }
  }

  // 3. fire discipline
  const mode = first.fireMode ?? 'auto';
  const fm = (m: 'auto' | 'return' | 'hold', label: string, title: string) =>
    h('button', { class: mode === m ? 'active' : '', title, onClick: () => c.send({ type: 'fireMode', units: ids, mode: m }) }, label);
  el.append(h('div', { class: 'btn-group', title: 'Fire discipline' },
    fm('auto', 'Fire at will', 'Engage any enemy in range'),
    fm('return', 'Return fire', 'Only shoot back once hit'),
    fm('hold', 'Hold fire', 'Never shoot (stay hidden)')));

  // 4. sprint and stamina (ground only)
  if (ground.length) {
    const on = ground.some((u) => u.sprint);
    el.append(h('button', { class: 'hud-btn' + (on ? ' active' : ''), title: 'Double speed: infantry tire (60 s of running, 3 min to recover), vehicles burn 50% more fuel', onClick: () => c.send({ type: 'sprint', units: ids, active: !on }) }, `Sprint ${on ? 'ON' : 'OFF'}`));
    const tired = ground.filter((u) => u.stamina !== undefined);
    if (tired.length) el.append(meter('Stamina', tired.reduce((a, u) => a + (u.stamina ?? 100), 0) / tired.length, 'stamina'));
  }

  // 4a. morale
  const spirited = list.filter((u) => u.morale !== undefined);
  if (spirited.length) el.append(h('div', { class: 'hud-sec', title: 'Morale: falls when encircled, out of ammo or under fire; below 50 they fight worse; encircled at 0 they surrender' }, meter('Morale', spirited.reduce((a, u) => a + (u.morale ?? 100), 0) / spirited.length, 'morale')));

  // 4b. ammunition
  const armed = list.filter((u) => u.ammo !== undefined && c.defU.get(u.def)!.maxAmmo);
  if (armed.length) {
    const have = armed.reduce((a, u) => a + (u.ammo ?? 0), 0);
    const max = armed.reduce((a, u) => a + (c.defU.get(u.def)!.maxAmmo ?? 0), 0);
    el.append(h('div', { class: 'hud-sec', title: 'Rounds left; refill near an ammo depot or your base' }, meter(single ? `Ammo ${have}/${max}` : 'Ammo', (have / Math.max(1, max)) * 100, 'ammo')));
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

  // 6a. armoured carriers: riders only
  if (single && !d0.cargoCap && d0.passengerCap) {
    const riders = first.cargo?.passengers?.length ?? 0;
    el.append(h('div', { class: 'hud-sec col' }, h('div', { class: 'row' }, h('span', { class: 'hud-line' }, `Riders ${riders}/${d0.passengerCap}`),
      riders ? h('button', { class: 'hud-btn sm', onClick: () => c.send({ type: 'disembark', transport: first.id }) }, `Dismount (${riders})`) : null)));
  }

  // 6. trucks: delivery route, cargo, passengers
  if (single && d0.cargoCap) {
    const cargo = first.cargo?.res ?? {};
    const load = Object.values(cargo).reduce((a, v) => a + v, 0);
    let control: HTMLElement;
    const bname = (id?: number) => c.defB.get(c.snap.buildings.find((b) => b.id === id)?.def ?? '')?.name ?? 'site';
    const ACT: Record<string, string> = { load: 'Load', unload: 'Unload', via: 'Via' };
    if (c.pick.route?.unitId === first.id) {
      const r = c.pick.route;
      const firstLoad = r.stops.find((x) => x.action === 'load');
      const from = firstLoad ? c.snap.buildings.find((b) => b.id === firstLoad.building) : null;
      // the goods the loading site actually keeps (fuel is for tankers); "any" lets the truck take what each destination wants
      const stock = from?.storage ?? {};
      const opts = d0.fuelOnly ? [] : [...Object.keys(stock).filter((k) => k !== 'fuel'), 'any'];
      r.resType ??= 'any';
      r.minLoad ??= d0.cargoCap;
      const ready = r.stops.some((x) => x.action === 'load') && r.stops.some((x) => x.action === 'unload');
      const stopRow = (st: RouteStop, i: number) => h('div', { class: 'route-stop' },
        h('span', { class: 'n' }, String(i + 1)),
        st.action === 'via' ? h('span', {}, 'Waypoint') : h('button', { class: 'hud-btn sm', title: 'Switch between loading and unloading here', onClick: (e: MouseEvent) => (e.stopPropagation(), (st.action = st.action === 'load' ? 'unload' : 'load'), c.rerender()) }, ACT[st.action]),
        st.action !== 'via' ? h('span', {}, bname(st.building)) : null,
        h('button', { class: 'hud-btn sm warn', title: 'Remove this stop', onClick: (e: MouseEvent) => (e.stopPropagation(), r.stops.splice(i, 1), c.rerender()) }, '×'));
      const presets = [0, 150, 200, 500, 1000].filter((v) => v < (d0.cargoCap ?? 0));
      const minInput = h('input', { type: 'number', min: 1, max: d0.cargoCap, value: r.minLoad, class: 'min-load', title: 'Leave the last loading stop only with at least this much' });
      minInput.addEventListener('change', () => ((r.minLoad = Math.max(1, Math.min(d0.cargoCap!, Number((minInput as HTMLInputElement).value) || 1))), c.rerender()));
      control = h('div', { class: 'route-box' },
        h('b', {}, r.stops.length ? `Route: ${r.stops.length} stop${r.stops.length === 1 ? '' : 's'} (click buildings to add, the map for a waypoint; up to 6)` : 'Click the building to load at'),
        ...r.stops.map(stopRow),
        opts.length ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Carry:'), ...opts.map((o) =>
          h('button', { class: 'hud-btn sm' + (r.resType === o ? ' active' : ''), onClick: (e: MouseEvent) => (e.stopPropagation(), (r.resType = o), c.rerender()) },
            o === 'any' ? RES_LABEL.any : `${RES_LABEL[o] ?? o} ${Math.floor(stock[o] ?? 0)}`))) : null,
        h('div', { class: 'row' }, h('span', { class: 'muted', title: 'Leave the last loading stop only with at least this much on board' }, 'Leave with:'),
          ...presets.map((v) => h('button', { class: 'hud-btn sm' + ((v === 0 ? r.minLoad === d0.cargoCap : r.minLoad === v) ? ' active' : ''), onClick: (e: MouseEvent) => (e.stopPropagation(), (r.minLoad = v === 0 ? d0.cargoCap : v), c.rerender()) }, v === 0 ? 'Full' : String(v))),
          minInput),
        h('div', { class: 'row' },
          h('button', { class: 'hud-btn sm' + (ready ? ' active' : ''), disabled: !ready || undefined, onClick: (e: MouseEvent) => {
            e.stopPropagation();
            c.send({ type: 'setRoute', unit: first.id, stops: r.stops.map((x) => ({ action: x.action, building: x.building, pos: x.pos as [number, number] | undefined })), resType: r.resType, minLoad: r.minLoad });
            c.pick.sentRoute = { route: r, at: Date.now() };
            c.pick.route = null;
            c.rerender();
          } }, 'Start route'),
          h('button', { class: 'hud-btn sm warn', onClick: () => ((c.pick.route = null), c.rerender()) }, 'Cancel (Esc)')));
    } else if (first.haul) {
      const hl = first.haul;
      control = h('div', { class: 'route-box' },
        h('b', {}, `Route${hl.resType ? ` (${RES_LABEL[hl.resType] ?? hl.resType})` : ''}${hl.minLoad && hl.minLoad > 1 && hl.minLoad < (d0.cargoCap ?? 0) ? ` · leaves with ${hl.minLoad}+` : ''}`),
        h('div', { class: 'route-line' }, ...hl.stops.map((st, i) => h('span', { class: i === hl.idx ? 'cur' : '' }, `${i ? '→ ' : ''}${st.once ? 'Drop old cargo at' : ACT[st.action]}${st.action === 'via' ? '' : ` ${bname(st.building)}`}`))),
        h('button', { class: 'hud-btn sm warn', onClick: () => c.send({ type: 'stop', units: [first.id] }) }, 'Stop route'));
    } else {
      control = h('button', { class: 'hud-btn', title: 'Set up a standing delivery: load and unload stops and waypoints in a loop', onClick: () => {
        c.pick.route = { unitId: first.id, stops: [] };
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
    // small drones waiting at a launcher nearby can be taken on board
    const room = (d0.droneCap ?? 0) - (first.cargo?.drones?.length ?? 0);
    const near = room > 0 ? c.stored.filter((x) => x.parkedAt !== undefined && c.defU.get(x.def)?.launchable && distKm(x.pos, c.pos(first)) <= 10) : [];
    if (near.length) {
      const site = c.snap.buildings.find((b) => b.id === near[0].parkedAt);
      el.append(h('button', { class: 'hud-btn sm', title: 'Take small drones waiting at the launcher nearby on board', onClick: () => {
        for (const x of near.slice(0, room)) c.send({ type: 'board', unit: x.id, transport: first.id });
      } }, `Load from ${c.defB.get(site?.def ?? '')?.name ?? 'launcher'} (${Math.min(room, near.length)})`));
    }
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
