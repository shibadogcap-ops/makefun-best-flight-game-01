// world.js — the Amber Isles: map data + pure ground functions.
// Everything here is deterministic: ground height/type are pure functions of
// (x, z) built on hashed value noise — no RNG state, no Math.random.
//
// Conventions: metres, x east, z south, world -3000..3000 on both axes.
// Heading degrees, 0 = north (-z), clockwise; direction = (sin h, -cos h).

import { WORLD } from './config.js';
import { valueNoise2, fbm2, hash2 } from './random.js';

const TERRAIN_SEED = 20261126;

// Ellipse islands. height = max terrain metres above sea level.
export const ISLANDS = [
  { name: 'Kestrel Isle',    cx: 0,     cz: 0,     rx: 1500, rz: 1100, height: 22 },
  { name: 'Port Saffron',    cx: 600,   cz: 2100,  rx: 900,  rz: 650,  height: 20 },
  { name: 'Gull Rock',       cx: 2300,  cz: -600,  rx: 380,  rz: 300,  height: 18 },
  { name: 'Cinder Isle',     cx: -1400, cz: -1900, rx: 800,  rz: 700,  height: 20 },
  { name: 'Lantern Point',   cx: -2300, cz: 1200,  rx: 220,  rz: 180,  height: 15 },
];

// Runway strips. Heading is the direction of travel (0 = north).
// threshold = the end the plane starts from / lines up with.
export const RUNWAYS = [
  {
    name: 'Kestrel Field', x: -200, z: 100, headingDeg: 90,
    length: 700, width: 45, plateau: 12,
  },
  {
    name: 'Port Saffron', x: 600, z: 2100, headingDeg: 0,
    length: 650, width: 42, plateau: 10,
  },
];

// Compute runway end positions once (direction = (sin h, -cos h)).
for (const r of RUNWAYS) {
  const rad = (r.headingDeg * Math.PI) / 180;
  const dx = Math.sin(rad), dz = -Math.cos(rad);
  r.dirX = dx; r.dirZ = dz;
  // Right-hand perpendicular for the local frame.
  r.perpX = Math.cos(rad); r.perpZ = Math.sin(rad);
  // Threshold = start end (behind centre along -dir), departure end = +dir.
  r.threshold = { x: r.x - dx * r.length / 2, z: r.z - dz * r.length / 2 };
  r.departure = { x: r.x + dx * r.length / 2, z: r.z + dz * r.length / 2 };
}

// Named features shared by physics (landing checks) and the renderer.
export const FEATURES = {
  towns: [
    { name: 'Bramblewick', x: 500, z: -350, radius: 150 },
    { name: 'Saffron',     x: 350, z: 1950, radius: 130 },
    { name: 'Gull huts',   x: 2300, z: -600, radius: 80 },
  ],
  volcano: { name: 'Mt. Cinder', x: -1400, z: -1900, height: 260, coneRadius: 380 },
  lighthouse: { name: 'Lantern Light', x: -2300, z: 1200 },
  dropZone: { x: 2300, z: -600, radius: 90 },
};

// Road strip: Kestrel Field threshold -> Bramblewick town.
const ROAD = {
  ax: RUNWAYS[0].threshold.x, az: RUNWAYS[0].threshold.z,
  bx: FEATURES.towns[0].x,     bz: FEATURES.towns[0].z,
  halfWidth: 12,
};

// --- geometry helpers -------------------------------------------------------

// Normalized ellipse distance of (x,z) from an island; < 1 inside the coast.
function ellipseDist(isle, x, z) {
  const dx = (x - isle.cx) / isle.rx;
  const dz = (z - isle.cz) / isle.rz;
  return Math.sqrt(dx * dx + dz * dz);
}

// The island containing (x, z), or null over open sea.
export function islandAt(x, z) {
  for (const isle of ISLANDS) {
    if (ellipseDist(isle, x, z) <= 1) return isle;
  }
  return null;
}

// The runway whose rectangle contains (x, z), or null.
// Point is tested in the runway's rotated local frame.
export function runwayAt(x, z) {
  for (const r of RUNWAYS) {
    const along = (x - r.x) * r.dirX + (z - r.z) * r.dirZ;
    const perp = (x - r.x) * r.perpX + (z - r.z) * r.perpZ;
    if (Math.abs(along) <= r.length / 2 && Math.abs(perp) <= r.width / 2) {
      return r;
    }
  }
  return null;
}

function distToSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + abx * t, cz = az + abz * t;
  return Math.hypot(px - cx, pz - cz);
}

// --- height -----------------------------------------------------------------

// Terrain height in metres above sea level at (x, z).
// Runway rectangles are flattened to their plateau height.
export function groundHeight(x, z) {
  const rwy = runwayAt(x, z);
  if (rwy) return rwy.plateau;

  let h = 0;

  // Island base: smooth ellipse falloff + gentle noise, faded at the coast.
  for (const isle of ISLANDS) {
    const d = ellipseDist(isle, x, z);
    if (d >= 1) continue;
    // smoothstep(1 - d): 0 at the waterline, 1 well inland.
    const t = 1 - d;
    const s = t * t * (3 - 2 * t);
    let isleH = isle.height * s;
    // rolling ground, only inland so the coast stays at sea level
    isleH += (fbm2(x, z, 260, TERRAIN_SEED + isle.rx, 3) - 0.5) * 7 * s;
    if (isleH > h) h = isleH;
  }

  // Mt. Cinder: volcanic cone rising to ~260 m at its summit.
  const v = FEATURES.volcano;
  const vd = Math.hypot(x - v.x, z - v.z);
  if (vd < v.coneRadius) {
    const cone = v.height * Math.max(0, 1 - vd / v.coneRadius);
    if (cone > h) h = cone;
  }

  return Math.max(0, h);
}

// --- surface type -----------------------------------------------------------

const SAND_RIM = 0.8; // normalized ellipse distance where beaches start

// Deterministic field-patchwork cell for the farm isles.
function fieldCell(x, z) {
  const cx = Math.floor(x / 150);
  const cz = Math.floor(z / 150);
  return hash2(cx, cz, TERRAIN_SEED + 77);
}

// groundType(x, z) -> one of:
// 'sea' | 'grass' | 'fieldA' | 'fieldB' | 'sand' | 'rock' | 'ash' |
// 'town' | 'runway' | 'road'
export function groundType(x, z) {
  // Man-made surfaces win over everything.
  if (runwayAt(x, z)) return 'runway';
  for (const t of FEATURES.towns) {
    if (Math.hypot(x - t.x, z - t.z) <= t.radius) return 'town';
  }
  if (distToSegment(x, z, ROAD.ax, ROAD.az, ROAD.bx, ROAD.bz) <= ROAD.halfWidth) {
    return 'road';
  }

  const isle = islandAt(x, z);
  if (!isle) return 'sea';
  const d = ellipseDist(isle, x, z);

  // Cinder Isle: ash fields around the cone.
  const v = FEATURES.volcano;
  if (isle.name === 'Cinder Isle' || Math.hypot(x - v.x, z - v.z) < 650) {
    if (Math.hypot(x - v.x, z - v.z) < v.coneRadius + 140) return 'ash';
  }

  // Lantern Point is bare rock; so is any genuinely high ground.
  if (isle.name === 'Lantern Point' || groundHeight(x, z) > 55) return 'rock';

  // Sand rim just inside the coastline.
  if (d > SAND_RIM) return 'sand';

  // Field patchwork inland on the two farm isles.
  if (isle.name === 'Kestrel Isle' || isle.name === 'Port Saffron') {
    const n = fieldCell(x, z);
    const wobble = valueNoise2(x, z, 400, TERRAIN_SEED + 5);
    if (n < 0.42 && wobble > 0.35) return 'fieldA';
    if (n < 0.84 && wobble > 0.3) return 'fieldB';
  }

  return 'grass';
}

// Convenience for the renderer: world bounds.
export { WORLD };
