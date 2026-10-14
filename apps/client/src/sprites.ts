/**
 * Aircraft sprites, seen from above with the nose up (they are rotated to their heading on the map).
 * Drones with artwork use their black silhouette from /drones/<def>.png; the rest (small launchable drones, missiles)
 * are drawn here. Every silhouette is then tinted by relation: own blue, allies green, enemy red.
 */
const SIZE = 256;

/** Defs with a silhouette PNG; anything else is drawn procedurally. */
const ARTWORK = new Set(['drone_fire_point', 'drone_liutyi', 'drone_mini_shark', 'drone_orion', 'drone_pd2', 'drone_shahed']);
const ALIAS: Record<string, string> = { drone: 'drone_pd2' };

const loaded = new Map<string, Promise<HTMLImageElement | null>>();
function load(src: string): Promise<HTMLImageElement | null> {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = src;
    });
    loaded.set(src, p);
  }
  return p;
}

/** Black silhouette for craft without artwork. */
function drawSilhouette(g: CanvasRenderingContext2D, def: string) {
  g.fillStyle = '#000';
  g.save();
  g.translate(SIZE / 2, SIZE / 2);
  const poly = (pts: number[][]) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
  };
  if (def.startsWith('missile_')) {
    const ballistic = def === 'missile_iskander';
    const len = ballistic ? 92 : 100;
    const w = ballistic ? 13 : 10;
    // body with an ogive nose
    g.beginPath();
    g.moveTo(0, -len);
    g.quadraticCurveTo(w, -len + 22, w, -len + 40);
    g.lineTo(w, len - 12);
    g.lineTo(-w, len - 12);
    g.lineTo(-w, -len + 40);
    g.quadraticCurveTo(-w, -len + 22, 0, -len);
    g.fill();
    if (ballistic) {
      poly([[-w, len - 40], [-w - 16, len], [-w, len - 6]]);
      poly([[w, len - 40], [w + 16, len], [w, len - 6]]);
    } else {
      // cruise missile: pop-out wings mid-body and a small tail
      poly([[-w, -6], [-w - 62, 22], [-w - 62, 30], [-w, 18]]);
      poly([[w, -6], [w + 62, 22], [w + 62, 30], [w, 18]]);
      poly([[-w, len - 34], [-w - 22, len - 6], [-w, len - 12]]);
      poly([[w, len - 34], [w + 22, len - 6], [w, len - 12]]);
    }
  } else if (def === 'drone_lancet') {
    // tandem X-wings on a slim body
    g.fillRect(-7, -82, 14, 160);
    for (const y of [-46, 44]) {
      g.save();
      g.translate(0, y);
      for (const a of [0.55, -0.55]) {
        g.save();
        g.rotate(a);
        g.fillRect(-58, -4.5, 116, 9);
        g.restore();
      }
      g.restore();
    }
  } else {
    // small flying wing (ZALA and anything else)
    poly([[0, -46], [96, 26], [90, 40], [20, 22], [0, 34], [-20, 22], [-90, 40], [-96, 26]]);
    g.fillRect(-5, 22, 10, 28);
  }
  g.restore();
}

/** Sprite for one aircraft, tinted (`color`) and, when selected, with a yellow glow. */
export async function aircraftSprite(def: string, color: string, selected: boolean): Promise<HTMLCanvasElement> {
  const name = ALIAS[def] ?? def;
  const base = document.createElement('canvas');
  base.width = base.height = SIZE;
  const b = base.getContext('2d')!;
  const img = ARTWORK.has(name) ? await load(`/drones/${name}.png`) : null;
  if (img) b.drawImage(img, 0, 0, SIZE, SIZE);
  else drawSilhouette(b, name);
  // tint: keep the silhouette's shape, replace its colour
  b.globalCompositeOperation = 'source-in';
  b.fillStyle = color;
  b.fillRect(0, 0, SIZE, SIZE);

  const out = document.createElement('canvas');
  out.width = out.height = SIZE;
  const g = out.getContext('2d')!;
  // a dark rim keeps light colours readable on the map; the selection glow goes outside it
  g.shadowColor = selected ? '#ffe45c' : 'rgba(0,0,0,0.85)';
  g.shadowBlur = selected ? 22 : 6;
  g.drawImage(base, 0, 0);
  if (selected) g.drawImage(base, 0, 0);
  return out;
}
