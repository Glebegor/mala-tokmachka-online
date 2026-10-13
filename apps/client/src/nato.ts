/**
 * NATO APP-6 style unit markers drawn on canvas and registered as map images on demand.
 * Frame shape = affiliation (friendly rectangle, hostile diamond); colour = side; icon = branch;
 * mark on top of the frame = echelon (size of the formation); chevrons to its right = veterancy rank;
 * wheels below = transport mode.
 */
export const NATO_PREFIX = 'nato|';
const SIZE = 64; // css px, rendered at 2x
const INK = '#0b0d10';

export interface NatoSpec {
  hostile: boolean;
  color: string;
  symbol: string;
  echelon: string; // '', '•', '•••', 'I', 'II', 'III', 'X'
  rank: number;
  selected: boolean;
  own: boolean;
  transport: boolean;
  /** Cut off in a cauldron. */
  encircled?: boolean;
}

export function natoId(s: NatoSpec): string {
  return `${NATO_PREFIX}${s.hostile ? 'h' : 'f'}|${s.color}|${s.symbol}|${s.echelon}|${s.rank}|${s.selected ? 1 : 0}|${s.own ? 1 : 0}|${s.transport ? 1 : 0}|${s.encircled ? 1 : 0}`;
}

export function parseNatoId(id: string): NatoSpec | null {
  if (!id.startsWith(NATO_PREFIX)) return null;
  const [, aff, color, symbol, echelon, rank, sel, own, tr, enc] = id.split('|');
  return { hostile: aff === 'h', color, symbol, echelon, rank: Number(rank), selected: sel === '1', own: own === '1', transport: tr === '1', encircled: enc === '1' };
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

export function drawNato(spec: NatoSpec): ImageData {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE * 2;
  const g = c.getContext('2d')!;
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
    case 'supply':
      line(-hw, hh - 7, hw, hh - 7);
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

  let below = cy + hh + (spec.hostile ? 1 : 3.5);
  // mobility indicator: wheels under the frame while driving in column (transport mode)
  if (spec.transport) {
    below += 1.5;
    for (const ox of [-8, 0, 8]) {
      g.beginPath();
      g.arc(cx + ox * (spec.hostile ? 0.6 : 1), below, 2.3, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.fill();
      g.strokeStyle = INK;
      g.lineWidth = 1.3;
      g.stroke();
    }
    below += 4.5;
  }

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
  return g.getImageData(0, 0, SIZE * 2, SIZE * 2);
}
