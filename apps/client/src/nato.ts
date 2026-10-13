/**
 * NATO APP-6 style unit markers drawn on canvas and registered as map images on demand.
 * Frame shape = affiliation (friendly rectangle, hostile diamond); colour = side; icon = branch;
 * mark above the frame = echelon (size of a group); chevrons below = veterancy rank.
 */
export const NATO_PREFIX = 'nato|';
const SIZE = 64; // css px, rendered at 2x
const DARK = '#0b0d10';

export interface NatoSpec {
  hostile: boolean;
  color: string;
  symbol: string;
  echelon: string; // '', '•', '•••', 'I', 'II', 'III', 'X'
  rank: number;
  selected: boolean;
  own: boolean;
}

export function natoId(s: NatoSpec): string {
  return `${NATO_PREFIX}${s.hostile ? 'h' : 'f'}|${s.color}|${s.symbol}|${s.echelon}|${s.rank}|${s.selected ? 1 : 0}|${s.own ? 1 : 0}`;
}

export function parseNatoId(id: string): NatoSpec | null {
  if (!id.startsWith(NATO_PREFIX)) return null;
  const [, aff, color, symbol, echelon, rank, sel, own] = id.split('|');
  return { hostile: aff === 'h', color, symbol, echelon, rank: Number(rank), selected: sel === '1', own: own === '1' };
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

export function drawNato(spec: NatoSpec): ImageData {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE * 2;
  const g = c.getContext('2d')!;
  g.scale(2, 2);
  const cx = 32, cy = 34;
  const frame = new Path2D();
  if (spec.hostile) {
    frame.moveTo(cx, cy - 19);
    frame.lineTo(cx + 19, cy);
    frame.lineTo(cx, cy + 19);
    frame.lineTo(cx - 19, cy);
    frame.closePath();
  } else {
    frame.rect(cx - 21, cy - 14, 42, 28);
  }

  if (spec.selected) {
    g.save();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 7;
    g.lineJoin = 'round';
    g.stroke(frame);
    g.restore();
  }
  g.fillStyle = DARK;
  g.fill(frame);
  g.globalAlpha = spec.own ? 0.42 : 0.24;
  g.fillStyle = spec.color;
  g.fill(frame);
  g.globalAlpha = 1;

  // branch icon, clipped to the frame
  g.save();
  g.clip(frame);
  g.strokeStyle = g.fillStyle = '#f2f5f8';
  g.lineWidth = 2.4;
  g.lineCap = 'round';
  const hw = spec.hostile ? 19 : 21, hh = spec.hostile ? 19 : 14;
  const line = (x1: number, y1: number, x2: number, y2: number) => (g.beginPath(), g.moveTo(cx + x1, cy + y1), g.lineTo(cx + x2, cy + y2), g.stroke());
  switch (spec.symbol) {
    case 'infantry':
      line(-hw, -hh, hw, hh);
      line(-hw, hh, hw, -hh);
      break;
    case 'armor':
      g.beginPath();
      g.roundRect(cx - 11, cy - 5.5, 22, 11, 5.5);
      g.stroke();
      break;
    case 'mechanized':
      line(-hw, -hh, hw, hh);
      line(-hw, hh, hw, -hh);
      g.beginPath();
      g.roundRect(cx - 11, cy - 5.5, 22, 11, 5.5);
      g.stroke();
      break;
    case 'artillery':
      g.beginPath();
      g.arc(cx, cy, 5, 0, Math.PI * 2);
      g.fill();
      break;
    case 'uav':
      g.beginPath();
      g.moveTo(cx - 13, cy - 4);
      g.lineTo(cx, cy + 3);
      g.lineTo(cx + 13, cy - 4);
      g.lineTo(cx, cy - 0.5);
      g.closePath();
      g.fill();
      break;
    case 'recon':
      line(-hw, hh, hw, -hh);
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

  g.strokeStyle = spec.color;
  g.lineWidth = spec.own ? 3 : 2.4;
  g.lineJoin = 'miter';
  g.stroke(frame);

  if (spec.echelon) {
    g.fillStyle = '#ffffff';
    g.strokeStyle = DARK;
    g.lineWidth = 3;
    g.font = '700 13px ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const y = spec.hostile ? 9 : 12;
    g.strokeText(spec.echelon, cx, y);
    g.fillText(spec.echelon, cx, y);
  }

  // veterancy chevrons
  if (spec.rank > 0) {
    const n = Math.min(spec.rank, 5);
    const y = spec.hostile ? 58 : 54;
    g.strokeStyle = '#e8c35a';
    g.lineWidth = 2;
    g.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const x = cx + (i - (n - 1) / 2) * 7;
      g.beginPath();
      g.moveTo(x - 3, y + 2);
      g.lineTo(x, y - 2);
      g.lineTo(x + 3, y + 2);
      g.stroke();
    }
  }
  return g.getImageData(0, 0, SIZE * 2, SIZE * 2);
}
