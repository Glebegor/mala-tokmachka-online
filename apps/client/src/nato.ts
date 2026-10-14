/**
 * NATO APP-6 style unit markers drawn on canvas and registered as map images on demand.
 * Frame shape = affiliation (friendly rectangle, hostile diamond); colour = side; icon = branch;
 * mark on top of the frame = echelon (size of the formation); chevrons to its right = veterancy rank;
 * triangles to its left = buffs (green, up) and debuffs (red, down);
 * below the frame: the mobility indicator of vehicles (two wheels = wheeled, a track = tracked), and for troops on foot
 * three wheels while they ride in column (transport mode). A vehicle in column gets a yellow indicator and a » mark.
 */
export const NATO_PREFIX = 'nato|';
const SIZE = 64; // css px, rendered at 2x
const INK = '#0b0d10';

/** Marker colours: each nation keeps its colour (Ukraine blue, Russia red) for its own player and the enemy alike; allies are green. */
export const NATION_COLOR = ['#3d8bff', '#ff4d4d'] as const;
export const ALLY_COLOR = '#34c26b';
export type Relation = 'own' | 'ally' | 'enemy';

export interface NatoSpec {
  hostile: boolean;
  color: string;
  symbol: string;
  echelon: string; // '', '•', '•••', 'I', 'II', 'III', 'X'
  rank: number;
  selected: boolean;
  own: boolean;
  transport: boolean;
  /** Vehicle mobility shown under the frame: 'wheeled', 'tracked' or '' (on foot). */
  mobility?: string;
  /** Cut off in a cauldron. */
  encircled?: boolean;
  /** Number of buffs / debuffs shown as pips on the left of the frame. */
  buffs?: number;
  debuffs?: number;
}

export function natoId(s: NatoSpec): string {
  return `${NATO_PREFIX}${s.hostile ? 'h' : 'f'}|${s.color}|${s.symbol}|${s.echelon}|${s.rank}|${s.selected ? 1 : 0}|${s.own ? 1 : 0}|${s.transport ? 1 : 0}|${s.encircled ? 1 : 0}|${Math.min(4, s.buffs ?? 0)}|${Math.min(4, s.debuffs ?? 0)}|${s.mobility ?? ''}`;
}

export function parseNatoId(id: string): NatoSpec | null {
  if (!id.startsWith(NATO_PREFIX)) return null;
  const [, aff, color, symbol, echelon, rank, sel, own, tr, enc, bf, df, mob] = id.split('|');
  return { hostile: aff === 'h', color, symbol, echelon, rank: Number(rank), selected: sel === '1', own: own === '1', transport: tr === '1', encircled: enc === '1', buffs: Number(bf) || 0, debuffs: Number(df) || 0, mobility: mob ?? '' };
}

/**
 * Map markers are drawn in layers so that only a few dozen images exist: a base image (frame, colour, branch symbol,
 * mobility, selection) and small overlays aligned on the same centre for rank chevrons, buff/debuff pips, the echelon
 * mark and the cauldron ring. Baking everything into one image made every combination a new image, and every new image
 * makes the map re-upload its whole icon texture.
 */
export interface NatoLayers {
  icon: string;
  ovRank: string;
  ovPips: string;
  ovEch: string;
  ovRing: string;
}
export function natoLayers(s: NatoSpec): NatoLayers {
  const h = s.hostile ? 'h' : 'f';
  const b = Math.min(4, s.buffs ?? 0), d = Math.min(4, s.debuffs ?? 0);
  return {
    icon: `nb|${h}|${s.color}|${s.symbol}|${s.selected ? 1 : 0}|${s.own ? 1 : 0}|${s.transport ? 1 : 0}|${s.mobility ?? ''}`,
    ovRank: s.rank > 0 ? `no|rank|${h}|${Math.min(5, s.rank)}` : '',
    ovPips: b + d > 0 ? `no|pips|${h}|${b}|${d}` : '',
    ovEch: s.echelon ? `no|ech|${h}|${s.echelon}` : '',
    ovRing: s.encircled ? `no|ring|${h}` : '',
  };
}
/** Paint a base or overlay image from its id (see `natoLayers`); null if the id is not a marker image. */
export function drawNatoImage(id: string): ImageData | null {
  const f = id.split('|');
  const none: NatoParts = { base: false, echelon: false, ring: false, pips: false, rank: false };
  const blank: NatoSpec = { hostile: f[1] === 'h', color: '#000000', symbol: '', echelon: '', rank: 0, selected: false, own: false, transport: false };
  if (f[0] === 'nb') {
    return drawNato({ ...blank, color: f[2], symbol: f[3], selected: f[4] === '1', own: f[5] === '1', transport: f[6] === '1', mobility: f[7] ?? '' }, { ...none, base: true });
  }
  if (f[0] !== 'no') return null;
  const hostile = f[2] === 'h';
  if (f[1] === 'rank') return drawNato({ ...blank, hostile, rank: Number(f[3]) }, { ...none, rank: true });
  if (f[1] === 'pips') return drawNato({ ...blank, hostile, buffs: Number(f[3]), debuffs: Number(f[4]) }, { ...none, pips: true });
  if (f[1] === 'ech') return drawNato({ ...blank, hostile, echelon: f[3] }, { ...none, echelon: true });
  if (f[1] === 'ring') return drawNato({ ...blank, hostile, encircled: true }, { ...none, ring: true });
  return null;
}

/** Echelon mark for a formation of n units. */
export function echelonFor(n: number): string {
  if (n >= 48) return 'X';
  if (n >= 24) return 'III';
  if (n >= 12) return 'II';
  if (n >= 6) return 'I';
  if (n >= 3) return '•••';
  return '•';
}

/** Standard pastel fill for a side colour (APP-6 uses light fills with black line work). */
function pastel(hex: string, mix: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${c.map((v) => Math.round(v + (255 - v) * mix)).join(',')})`;
}

/** Which parts of a marker to paint: the base (frame, symbol, mobility) and the overlays drawn as separate images. */
export interface NatoParts {
  base: boolean;
  echelon: boolean;
  ring: boolean;
  pips: boolean;
  rank: boolean;
}
const ALL: NatoParts = { base: true, echelon: true, ring: true, pips: true, rank: true };

export function drawNato(spec: NatoSpec, parts: NatoParts = ALL): ImageData {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE * 2;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.scale(2, 2);
  const cx = 32, cy = 31;
  const hw = spec.hostile ? 18 : 20, hh = spec.hostile ? 18 : 13.5;
  const frame = new Path2D();
  if (spec.hostile) {
    frame.moveTo(cx, cy - hh);
    frame.lineTo(cx + hw, cy);
    frame.lineTo(cx, cy + hh);
    frame.lineTo(cx - hw, cy);
    frame.closePath();
  } else {
    frame.rect(cx - hw, cy - hh, hw * 2, hh * 2);
  }

  if (parts.base) {
    // selection halo, then a thin light casing so the black frame reads on the dark map
    g.lineJoin = 'round';
    g.strokeStyle = spec.selected ? '#ffe45c' : 'rgba(255,255,255,0.55)';
    g.lineWidth = spec.selected ? 7.5 : 4.2;
    g.stroke(frame);

    g.fillStyle = pastel(spec.color, spec.own ? 0.5 : 0.68);
    g.fill(frame);

    // branch icon in black, clipped to the frame
    g.save();
    g.clip(frame);
    g.strokeStyle = g.fillStyle = INK;
    g.lineWidth = 2.2;
    g.lineCap = 'round';
    const line = (x1: number, y1: number, x2: number, y2: number) => (g.beginPath(), g.moveTo(cx + x1, cy + y1), g.lineTo(cx + x2, cy + y2), g.stroke());
    const oval = () => (g.beginPath(), g.roundRect(cx - 10.5, cy - 5.2, 21, 10.4, 5.2), g.stroke());
    // inside a diamond the diagonals run between the mid-points of its sides
    const dx = spec.hostile ? hw / 2 : hw, dy = spec.hostile ? hh / 2 : hh;
    switch (spec.symbol) {
      case 'infantry':
        line(-dx, -dy, dx, dy);
        line(-dx, dy, dx, -dy);
        break;
      case 'armor':
        oval();
        break;
      case 'mechanized':
        line(-dx, -dy, dx, dy);
        line(-dx, dy, dx, -dy);
        oval();
        break;
      case 'artillery':
        g.beginPath();
        g.arc(cx, cy, 4.6, 0, Math.PI * 2);
        g.fill();
        break;
      case 'uav':
        g.beginPath();
        g.moveTo(cx - 12, cy - 4);
        g.lineTo(cx, cy + 3.2);
        g.lineTo(cx + 12, cy - 4);
        g.lineTo(cx, cy - 0.6);
        g.closePath();
        g.fill();
        break;
      case 'recon':
        line(-dx, dy, dx, -dy);
        break;
      case 'antitank':
        g.beginPath();
        g.moveTo(cx - 8, cy + 6);
        g.lineTo(cx, cy - 6);
        g.lineTo(cx + 8, cy + 6);
        g.stroke();
        break;
      case 'assault':
        line(-hw, -hh, hw, hh);
        line(-hw, hh, hw, -hh);
        g.beginPath();
        g.arc(cx, cy, 3.5, 0, Math.PI * 2);
        g.fill();
        break;
      case 'antiair':
        g.beginPath();
        g.ellipse(cx, cy + hh, hw, hh * 0.9, 0, Math.PI, 0);
        g.stroke();
        break;
      case 'engineer':
        line(-9, 4, -9, -4);
        line(-9, -4, 9, -4);
        line(9, -4, 9, 4);
        line(0, -4, 0, 4);
        break;
      case 'motorized':
        line(-dx, -dy, dx, dy);
        line(-dx, dy, dx, -dy);
        line(0, -hh, 0, hh);
        break;
      case 'fuel':
        g.beginPath();
        g.moveTo(cx, cy - 7);
        g.quadraticCurveTo(cx + 6, cy + 1, cx, cy + 6);
        g.quadraticCurveTo(cx - 6, cy + 1, cx, cy - 7);
        g.fill();
        break;
      case 'supply': {
        // a bar across the lower part of the frame (in a diamond it must sit higher to stay readable)
        const y = spec.hostile ? hh * 0.42 : hh - 7;
        line(-hw, y, hw, y);
        break;
      }
      case 'medical':
        // APP-6 medical: a cross
        line(0, -hh + 3, 0, hh - 3);
        line(-hw * 0.55, 0, hw * 0.55, 0);
        break;
      case 'maintenance':
        // APP-6 maintenance: a bar with a hook at each end
        line(-7, 0, 7, 0);
        g.beginPath();
        g.arc(cx - 9, cy, 3, -Math.PI / 2, Math.PI / 2, true);
        g.stroke();
        g.beginPath();
        g.arc(cx + 9, cy, 3, Math.PI / 2, -Math.PI / 2, true);
        g.stroke();
        break;
      case 'missile':
        g.beginPath();
        g.moveTo(cx, cy - 9);
        g.lineTo(cx + 3, cy - 4);
        g.lineTo(cx + 3, cy + 5);
        g.lineTo(cx + 6, cy + 9);
        g.lineTo(cx - 6, cy + 9);
        g.lineTo(cx - 3, cy + 5);
        g.lineTo(cx - 3, cy - 4);
        g.closePath();
        g.fill();
        break;
      default:
        g.beginPath();
        g.arc(cx, cy, 2.5, 0, Math.PI * 2);
        g.fill();
    }
    g.restore();

    g.strokeStyle = INK;
    g.lineWidth = spec.own ? 2.6 : 2;
    g.lineJoin = 'miter';
    g.stroke(frame);

    let below = cy + hh + (spec.hostile ? 1 : 3.5);
    const wheel = (x: number, y: number, fill: string) => {
      g.beginPath();
      g.arc(x, y, 2.3, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = INK;
      g.lineWidth = 1.3;
      g.stroke();
    };
    const squeeze = spec.hostile ? 0.6 : 1;
    const fill = spec.transport ? '#ffd84a' : '#ffffff';
    if (spec.mobility === 'wheeled') {
      // APP-6 mobility indicator: two wheels under the frame
      below += 1.5;
      for (const ox of [-6, 6]) wheel(cx + ox * squeeze, below, fill);
      below += 4.5;
    } else if (spec.mobility === 'tracked') {
      // a track: an elongated rounded band under the frame
      below += 1.2;
      g.beginPath();
      g.roundRect(cx - 11 * squeeze, below - 2.6, 22 * squeeze, 5.2, 2.6);
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = INK;
      g.lineWidth = 1.4;
      g.stroke();
      below += 4.5;
    } else if (spec.transport) {
      // troops on foot riding in column: three wheels
      below += 1.5;
      for (const ox of [-8, 0, 8]) wheel(cx + ox * squeeze, below, '#ffffff');
      below += 4.5;
    }
    if (spec.transport && spec.mobility) {
      // vehicle driving in column: » beside the indicator
      g.font = '700 9px ui-monospace, Menlo, monospace';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.lineWidth = 2.6;
      g.strokeStyle = INK;
      g.fillStyle = '#ffd84a';
      g.strokeText('»', cx + 13 * squeeze, below - 4.5);
      g.fillText('»', cx + 13 * squeeze, below - 4.5);
    }

  }
  if (parts.echelon) {
    if (spec.echelon) {
      g.fillStyle = '#ffffff';
      g.strokeStyle = INK;
      g.lineWidth = 3;
      g.font = '700 12px ui-monospace, Menlo, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const y = cy - hh - 7;
      g.strokeText(spec.echelon, cx, y);
      g.fillText(spec.echelon, cx, y);
    }

  }
  if (parts.ring) {
    // encircled: broken ring around the marker
    if (spec.encircled) {
      g.save();
      g.setLineDash([4, 3]);
      g.lineWidth = 2;
      for (const [color, width] of [[INK, 3.6], ['#ffd84a', 1.8]] as const) {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        g.ellipse(cx, cy, hw + 6, hh + 7, 0, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    }

  }
  if (parts.pips) {
    // buffs (green, pointing up) and debuffs (red, pointing down) stacked on the left-hand side of the frame
    const pips = [...Array(Math.min(4, spec.buffs ?? 0)).fill(true), ...Array(Math.min(4, spec.debuffs ?? 0)).fill(false)].slice(0, 5);
    if (pips.length) {
      const x = cx - hw - 7;
      g.lineJoin = 'round';
      pips.forEach((good: boolean, i: number) => {
        const y = cy + (i - (pips.length - 1) / 2) * 7.6;
        const s = good ? -1 : 1;
        g.beginPath();
        g.moveTo(x, y + 3.3 * s);
        g.lineTo(x + 4, y - 2.8 * s);
        g.lineTo(x - 4, y - 2.8 * s);
        g.closePath();
        g.fillStyle = good ? '#4ade80' : '#ff5a5a';
        g.strokeStyle = INK;
        g.lineWidth = 1.3;
        g.fill();
        g.stroke();
      });
    }

  }
  if (parts.rank) {
    // veterancy: chevrons stacked on the right-hand side of the frame
    if (spec.rank > 0) {
      const n = Math.min(spec.rank, 5);
      const x = cx + hw + 6.5;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const [color, width] of [[INK, 3.6], ['#ffd84a', 1.9]] as const) {
        g.strokeStyle = color;
        g.lineWidth = width;
        for (let i = 0; i < n; i++) {
          const y = cy + ((n - 1) / 2 - i) * 5.4;
          g.beginPath();
          g.moveTo(x - 3.2, y + 1.8);
          g.lineTo(x, y - 1.8);
          g.lineTo(x + 3.2, y + 1.8);
          g.stroke();
        }
      }
    }
  }
  return g.getImageData(0, 0, SIZE * 2, SIZE * 2);
}
