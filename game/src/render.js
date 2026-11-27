// render.js — the 3D world view for KESTREL POST.
// Pseudo-3D chase camera: sky + ridge silhouettes + drifting clouds, then a
// scanline ground pass that slices a once-baked top-down map texture along
// view rays, then projected features (volcano, lighthouse, towns, target,
// rings, crates, plane shadow) and finally the Kestrel sprite itself.
// Everything in the draw path is deterministic: no Math.random, cloud and
// house layouts come from createRng seeds computed once at module load.

import { VIEW, PALETTES, WORLD } from './config.js';
import { groundHeight, groundType, RUNWAYS, FEATURES } from './world.js';
import { createRng, fbm2, hash2 } from './random.js';

const DEG = Math.PI / 180;
const W = VIEW.width;          // 1280
const H3D = 524;               // bottom of the 3D view (panel starts here)
const CY = H3D / 2;            // centre of the view plane
const FOCAL = 1150;            // px — ~58 deg horizontal field of view
const MAP = 1024;              // baked map texture size
const MAP_SPAN = WORLD.size;   // world metres covered by the texture
const TAU = Math.PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

// --- colour helpers ---------------------------------------------------------

const rgbCache = new Map();
function rgb(hex) {
  let c = rgbCache.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, c);
  }
  return c;
}
function mixHex(a, b, t) {
  const A = rgb(a), B = rgb(b);
  return `rgb(${Math.round(lerp(A[0], B[0], t))},${Math.round(lerp(A[1], B[1], t))},${Math.round(lerp(A[2], B[2], t))})`;
}
function shadeHex(hex, f) { // f<1 darkens, f>1 lightens
  const A = rgb(hex);
  const g = (v) => clamp(Math.round(v * f), 0, 255);
  return `rgb(${g(A[0])},${g(A[1])},${g(A[2])})`;
}
function rgba(hex, a) {
  const A = rgb(hex);
  return `rgba(${A[0]},${A[1]},${A[2]},${a})`;
}

// --- headless-safe canvas ---------------------------------------------------

const hasDOM = typeof document !== 'undefined';

// Null canvas context: every method a no-op, gradients return an object with
// addColorStop. Lets buildMapTexture/drawWorld run under a bare node harness.
const NULL_CTX = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') {
      return () => ({ addColorStop() {} });
    }
    if (prop === 'measureText') return () => ({ width: 0 });
    if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
    if (prop === 'canvas') return null;
    return () => {};
  },
  set() { return true; },
});

function makeCanvas(w, h) {
  if (hasDOM) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return { width: w, height: h, getContext: () => NULL_CTX };
}

// --- palette-derived colours (cached per palette name) ----------------------

const palCache = new Map();
function palette(name) {
  let p = palCache.get(name);
  if (p) return p;
  const P = PALETTES[name] || PALETTES.noon;
  p = {
    P,
    horizon: P.skyHorizon,
    ridge: [
      mixHex(P.skyHorizon, P.panel, 0.45),
      mixHex(P.skyHorizon, P.panel, 0.65),
      mixHex(P.skyTop, P.panel, 0.55),
    ],
    cloud: name === 'dusk' ? mixHex('#ffffff', P.skyHorizon, 0.45) : '#ffffff',
    cloudAlpha: name === 'dusk' ? 0.4 : 0.8,
    seaSparkle: shadeHex(P.seaNear, 1.25),
    road: mixHex(P.sand, P.rock, 0.45),
    done: '#4fd08a',
  };
  palCache.set(name, p);
  return p;
}

// Sun placement differs by time of day (fractions of the view).
const SUNS = {
  noon: { fx: 0.78, fy: 0.16, r: 52, col: '#ffe9a8', glow: 'rgba(255,236,170,0.35)' },
  dusk: { fx: 0.52, fy: 0.9, r: 64, col: '#ffab5e', glow: 'rgba(255,150,80,0.4)' },
};

// --- baked top-down map -----------------------------------------------------

export function worldToMap(x, z) {
  return [(x + MAP_SPAN / 2) / MAP_SPAN, (z + MAP_SPAN / 2) / MAP_SPAN];
}

function mapColour(t, P, pal) {
  switch (t) {
    case 'sea': return P.seaNear;
    case 'grass': return P.grass;
    case 'fieldA': return P.fieldA;
    case 'fieldB': return P.fieldB;
    case 'sand': return P.sand;
    case 'rock': return P.rock;
    case 'ash': return P.ash;
    case 'town': return P.townWall;
    case 'runway': return P.runway;
    case 'road': return pal.road;
    default: return P.seaNear;
  }
}

// Paint the whole 6000x6000 world into a 1024x1024 canvas, once per palette.
export function buildMapTexture(paletteName = 'noon') {
  const pal = palette(paletteName);
  const P = pal.P;
  const c = makeCanvas(MAP, MAP);
  const g = c.getContext('2d');
  const k = MAP / MAP_SPAN; // canvas px per metre

  // Sea base.
  g.fillStyle = P.seaNear;
  g.fillRect(0, 0, MAP, MAP);

  // Deterministic sparkle on the water.
  g.fillStyle = pal.seaSparkle;
  for (let i = 0; i < 2600; i++) {
    const x = Math.floor(hash2(i, 17, 991) * MAP);
    const y = Math.floor(hash2(i, 91, 557) * MAP);
    const s = hash2(i, 33, 211) < 0.85 ? 1 : 2;
    g.globalAlpha = 0.12 + hash2(i, 7, 88) * 0.25;
    g.fillRect(x, y, s, s);
  }
  g.globalAlpha = 1;

  // Terrain: sample groundType on a 2-texel grid, fill 2x2 blocks.
  const step = 2;
  for (let py = 0; py < MAP; py += step) {
    for (let px = 0; px < MAP; px += step) {
      const wx = -MAP_SPAN / 2 + ((px + step / 2) / MAP) * MAP_SPAN;
      const wz = -MAP_SPAN / 2 + ((py + step / 2) / MAP) * MAP_SPAN;
      const t = groundType(wx, wz);
      if (t === 'sea') continue; // sea base already painted
      let col = mapColour(t, P, pal);
      // Towns read as roof-coloured speckles over pale walls.
      if (t === 'town' && hash2(px, py, 4242) < 0.34) col = P.townRoof;
      g.fillStyle = col;
      g.fillRect(px, py, step, step);
    }
  }

  // Runways drawn precisely on top of the sampled terrain.
  for (const r of RUNWAYS) {
    const [mx, my] = [worldToMap(r.x, r.z)[0] * MAP, worldToMap(r.x, r.z)[1] * MAP];
    g.save();
    g.translate(mx, my);
    g.rotate(r.headingDeg * DEG - Math.PI / 2);
    const L = r.length * k, Wd = r.width * k;
    g.fillStyle = P.runway;
    g.fillRect(-L / 2, -Wd / 2, L, Wd);
    // White threshold bars at both ends.
    g.fillStyle = P.runwayMark;
    const barOff = (r.length / 2 - 22) * k;
    const barT = 9 * k, barW = (r.width - 10) * k;
    for (const s of [-1, 1]) {
      g.fillRect(s * barOff - barT / 2, -barW / 2, barT, barW);
    }
    // Centreline dashes.
    const dashW = 2.6 * k;
    for (let d = -r.length / 2 + 34; d < r.length / 2 - 30; d += 26) {
      g.fillRect(d * k - 6 * k, -dashW / 2, 12 * k, dashW);
    }
    g.restore();
  }

  // Drop-zone circle on Gull Rock.
  const dz = FEATURES.dropZone;
  const [dx, dy] = [worldToMap(dz.x, dz.z)[0] * MAP, worldToMap(dz.x, dz.z)[1] * MAP];
  g.strokeStyle = P.ring;
  g.lineWidth = 3;
  g.setLineDash([10, 7]);
  g.beginPath();
  g.arc(dx, dy, dz.radius * k, 0, TAU);
  g.stroke();
  g.setLineDash([]);

  return c;
}

const mapCache = new Map();
function getMap(paletteName) {
  let m = mapCache.get(paletteName);
  if (!m) {
    m = buildMapTexture(paletteName);
    mapCache.set(paletteName, m);
  }
  return m;
}

// --- deterministic scenery data ----------------------------------------------

// Houses: a deterministic cluster inside each town radius.
const HOUSES = [];
{
  const rng = createRng(1234);
  for (const t of FEATURES.towns) {
    const n = clamp(Math.floor(t.radius / 9), 8, 42);
    for (let i = 0; i < n; i++) {
      const a = rng() * TAU;
      const rr = Math.sqrt(rng()) * t.radius * 0.78;
      HOUSES.push({
        x: t.x + Math.cos(a) * rr,
        z: t.z + Math.sin(a) * rr,
        s: 5 + rng() * 6,          // footprint metres
        h: 3.6 + rng() * 2.4,      // wall height metres
        seed: rng(),
      });
    }
  }
}

// Clouds: world-anchored billboards, drift with timeSec (deterministic).
const CLOUDS = [];
{
  const rng = createRng(7);
  for (let i = 0; i < 26; i++) {
    CLOUDS.push({
      x: (rng() * 2 - 1) * 3200,
      z: (rng() * 2 - 1) * 3200,
      alt: 240 + rng() * 220,
      w: 260 + rng() * 320,       // sprite world width, metres
      drift: 5 + rng() * 7,       // m/s
      ph: rng() * TAU,
    });
  }
}

// Cloud sprite, rendered once per palette (puffy blob cluster).
const spriteCache = new Map();
function cloudSprite(pal) {
  let s = spriteCache.get(pal.P === PALETTES.dusk ? 'dusk' : 'noon');
  if (s !== undefined) return s;
  const c = makeCanvas(192, 96);
  const g = c.getContext('2d');
  const rng = createRng(99);
  g.fillStyle = pal.cloud;
  for (let i = 0; i < 9; i++) {
    const bx = 30 + rng() * 132;
    const by = 34 + rng() * 26;
    const br = 14 + rng() * 22;
    g.globalAlpha = 0.5 + rng() * 0.3;
    g.beginPath();
    g.ellipse(bx, by, br, br * 0.55, 0, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
  spriteCache.set(pal.P === PALETTES.dusk ? 'dusk' : 'noon', c);
  return c;
}

// Distant ridge profiles: fbm heights sampled across the screen each frame.
const RIDGES = [
  { seed: 11, amp: 46, par: 0.010, base: 0.10 },
  { seed: 47, amp: 78, par: 0.022, base: 0.16 },
  { seed: 83, amp: 120, par: 0.040, base: 0.24 },
];

// Rain streaks: precomputed drops, positions wrap by timeSec (no RNG in draw).
const RAIN = [];
{
  const rng = createRng(42);
  for (let i = 0; i < 160; i++) {
    RAIN.push({
      x: rng() * W,
      y: rng() * (H3D + 80),
      v: 620 + rng() * 380,
      len: 12 + rng() * 14,
      drift: 60 + rng() * 60,
    });
  }
}

// --- camera ------------------------------------------------------------------

// Chase camera ~26 m behind and ~8 m above the plane, pitched with it.
function makeCamera(plane) {
  const h = (plane.headingDeg || 0) * DEG;
  const dirX = Math.sin(h), dirZ = -Math.cos(h);
  const cx = plane.x - dirX * 26;
  const cz = plane.z - dirZ * 26;
  const gh = groundHeight(cx, cz);
  const cy = Math.max((plane.alt || 0) + 8, gh + 2.4);

  const pitch = clamp((plane.pitchDeg || 0) * DEG, -0.5, 0.5);
  const cp = Math.cos(pitch);
  // Forward (pitched), camera-right, camera-up basis vectors.
  const fx = dirX * cp, fy = Math.sin(pitch), fz = dirZ * cp;
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const ul = Math.hypot(ux, uy, uz) || 1;

  return {
    x: cx, y: cy, z: cz, gh,
    fx, fy, fz,
    rx, ry: 0, rz,
    ux: ux / ul, uy: uy / ul, uz: uz / ul,
    pitch,
    hRad: h,
    dirX, dirZ,
  };
}

// Project a world point {x,y,z} (y = metres above sea) to screen coords.
function project(cam, x, y, z) {
  const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
  const zc = dx * cam.fx + dy * cam.fy + dz * cam.fz;
  if (zc < 2) return null;
  const xc = dx * cam.rx + dz * cam.rz;
  const yc = dx * cam.ux + dy * cam.uy + dz * cam.uz;
  return {
    x: W / 2 + (xc / zc) * FOCAL,
    y: CY - (yc / zc) * FOCAL,
    z: zc,
  };
}

// --- sky ---------------------------------------------------------------------

function drawSky(ctx, cam, pal, paletteName, plane, timeSec) {
  const horizonY = clamp(CY + Math.tan(cam.pitch) * FOCAL, 60, H3D - 30);

  // Gradient sky.
  const grad = ctx.createLinearGradient(0, 0, 0, horizonY + 4);
  grad.addColorStop(0, pal.P.skyTop);
  grad.addColorStop(1, pal.P.skyHorizon);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, horizonY + 4);

  // Sun.
  const sun = SUNS[paletteName] || SUNS.noon;
  const sx = W * sun.fx;
  const sy = paletteName === 'dusk' ? horizonY * sun.fy : H3D * sun.fy;
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, sun.r * 3.2);
  glow.addColorStop(0, sun.glow);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(sx - sun.r * 3.2, sy - sun.r * 3.2, sun.r * 6.4, sun.r * 6.4);
  ctx.fillStyle = sun.col;
  ctx.beginPath();
  ctx.arc(sx, sy, sun.r, 0, TAU);
  ctx.fill();

  // Ridge silhouettes with heading parallax.
  const hdg = plane.headingDeg || 0;
  for (let li = 0; li < RIDGES.length; li++) {
    const R = RIDGES[li];
    ctx.fillStyle = pal.ridge[li];
    ctx.globalAlpha = 0.55 + li * 0.18;
    ctx.beginPath();
    ctx.moveTo(-8, horizonY + 6);
    const off = hdg * R.par * 57.3 + li * 913;
    for (let sx = -8; sx <= W + 8; sx += 16) {
      const n = fbm2(sx * 0.045 + off, li * 31.7, 90, R.seed, 3);
      const y = horizonY - (4 + n * R.amp);
      ctx.lineTo(sx, y);
    }
    ctx.lineTo(W + 8, horizonY + 6);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Drifting cloud billboards, far to near.
  const sprite = cloudSprite(pal);
  const clouds = [];
  for (const c of CLOUDS) {
    // Wrap the drift into the world bounds — deterministic in timeSec.
    let wx = c.x + c.drift * timeSec;
    wx = ((wx + 3400) % 6800 + 6800) % 6800 - 3400;
    const p = project(cam, wx, c.alt, c.z);
    if (p && p.z > 30 && p.y < horizonY + 60) clouds.push({ p, c });
  }
  clouds.sort((a, b) => b.p.z - a.p.z);
  if (sprite && hasDOM) {
    ctx.globalAlpha = pal.cloudAlpha;
    for (const { p, c } of clouds) {
      const cw = (FOCAL * c.w) / p.z;
      const ch = cw * (96 / 192);
      ctx.drawImage(sprite, p.x - cw / 2, p.y - ch * 0.62, cw, ch);
    }
    ctx.globalAlpha = 1;
  }

  return horizonY;
}

// --- ground scanlines ---------------------------------------------------------

// Intersect the view ray for screen row `rowY` at screen x `sx` with the
// ground plane at the terrain height under the camera.
function rayGround(cam, rowY, sx, ghCam) {
  const e = cam.pitch - Math.atan((rowY - CY) / FOCAL);
  const sinE = Math.sin(e);
  if (sinE >= -0.0004) return null;
  const t = (ghCam - cam.y) / sinE;
  if (!(t > 8) || t > 30000) return null;
  const cosE = Math.cos(e);
  const tanA = (sx - W / 2) / FOCAL;
  const n = Math.hypot(1, tanA);
  const cosA = 1 / n, sinA = tanA / n;
  // Horizontal ray direction = forward*cosA + right*sinA (unit length).
  const hx = cam.dirX * cosA + Math.cos(cam.hRad) * sinA;
  const hz = -Math.cos(cam.hRad) * cosA + Math.sin(cam.hRad) * sinA;
  return {
    x: cam.x + hx * cosE * t,
    z: cam.z + hz * cosE * t,
    t,
  };
}

function drawGround(ctx, cam, pal, map, horizonY) {
  const rowH = 4;
  const k = MAP / MAP_SPAN;
  const horizonCol = pal.horizon;

  for (let y = Math.max(0, Math.floor(horizonY)); y < H3D; y += rowH) {
    const yc = y + rowH / 2;
    const p0 = rayGround(cam, yc, 0, cam.gh);
    const p1 = rayGround(cam, yc, W, cam.gh);
    const pm = rayGround(cam, yc, W / 2, cam.gh);
    if (!p0 || !p1 || !pm) continue;
    if (pm.t < 12) continue; // inside the near plane — skip safely

    // Segment endpoints in map-texture pixel space.
    const m0x = (p0.x + MAP_SPAN / 2) * k, m0y = (p0.z + MAP_SPAN / 2) * k;
    const m1x = (p1.x + MAP_SPAN / 2) * k, m1y = (p1.z + MAP_SPAN / 2) * k;
    const dx = m1x - m0x, dy = m1y - m0y;
    const L = Math.hypot(dx, dy);
    if (L < 0.4) continue;
    const ux = dx / L, uy = dy / L;

    // Affine map: segment -> screen row with a small x margin so rows abut.
    const margin = 3;
    const su = (W + margin * 2) / L;          // screen px per map px, along
    const sn = clamp(su, 0.2, 4);             // screen px per map px, across
    const a = su * ux;
    const b = -sn * uy;
    const c = su * uy;
    const d = sn * ux;
    const e = -(su * (ux * m0x + uy * m0y)) - margin;
    const f = yc + sn * (uy * m0x - ux * m0y);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, W, Math.min(rowH, H3D - y));
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(map, 0, 0);
    ctx.restore();

    // Distance fog toward the horizon colour.
    const fog = clamp((pm.t - 550) / 3400, 0, 0.88);
    if (fog > 0.01) {
      ctx.fillStyle = rgba(horizonCol, fog);
      ctx.fillRect(0, y, W, rowH);
    }
  }
}

// --- projected features -------------------------------------------------------

function drawVolcano(ctx, cam, pal, v) {
  const baseY = groundHeight(v.x, v.z);
  const apex = project(cam, v.x, baseY + v.height, v.z);
  const base = project(cam, v.x, baseY, v.z);
  if (!apex || !base || base.z < 30) return;
  const rb = (FOCAL * v.coneRadius * 0.92) / base.z;
  const apexY = apex.y;
  const baseYp = base.y;
  const cx = base.x;
  const midY = lerp(baseYp, apexY, 0.45);

  // Two shaded faces of the cone + base skirt.
  ctx.fillStyle = shadeHex(pal.P.rock, 0.8);
  ctx.beginPath();
  ctx.moveTo(cx - rb * 0.82, baseYp - rb * 0.08);
  ctx.lineTo(cx - rb * 0.1, midY);
  ctx.lineTo(cx, midY);
  ctx.lineTo(cx, baseYp + rb * 0.3);
  ctx.lineTo(cx - rb * 0.55, baseYp + rb * 0.16);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = pal.P.rock;
  ctx.beginPath();
  ctx.moveTo(cx + rb * 0.82, baseYp - rb * 0.08);
  ctx.lineTo(cx + rb * 0.1, midY);
  ctx.lineTo(cx, midY);
  ctx.lineTo(cx, baseYp + rb * 0.3);
  ctx.lineTo(cx + rb * 0.55, baseYp + rb * 0.16);
  ctx.closePath();
  ctx.fill();

  // Ash cap near the summit.
  ctx.fillStyle = pal.P.ash;
  ctx.beginPath();
  ctx.moveTo(cx - rb * 0.1, midY);
  ctx.lineTo(cx + rb * 0.1, midY);
  ctx.lineTo(cx, apexY + rb * 0.12);
  ctx.closePath();
  ctx.fill();
}

function drawLighthouse(ctx, cam, pal, paletteName, timeSec) {
  const L = FEATURES.lighthouse;
  const baseY = groundHeight(L.x, L.z);
  const topY = baseY + 34;
  const b = project(cam, L.x, baseY, L.z);
  const t = project(cam, L.x, topY, L.z);
  if (!b || !t || b.z < 25) return;
  const wBot = (FOCAL * 5) / b.z, wTop = wBot * 0.55;

  // Tower: tapered quad, pale with a dark lantern room.
  ctx.fillStyle = pal.P.townWall;
  ctx.beginPath();
  ctx.moveTo(b.x - wBot / 2, b.y);
  ctx.lineTo(t.x - wTop / 2, t.y);
  ctx.lineTo(t.x + wTop / 2, t.y);
  ctx.lineTo(b.x + wBot / 2, b.y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shadeHex(pal.P.townWall, 0.72);
  ctx.fillRect(t.x - wTop * 0.75, t.y - wTop * 1.6, wTop * 1.5, wTop * 1.6);
  ctx.fillStyle = '#2a2d33';
  ctx.fillRect(t.x - wTop * 0.55, t.y - wTop * 2.6, wTop * 1.1, wTop * 1.1);

  // Rotating beam at dusk.
  if (paletteName === 'dusk') {
    const ang = timeSec * 0.85;
    const len = 750;
    const spread = 0.045;
    const p1 = project(cam, L.x + Math.sin(ang - spread) * len, topY + 3, L.z - Math.cos(ang - spread) * len);
    const p2 = project(cam, L.x + Math.sin(ang + spread) * len, topY + 3, L.z - Math.cos(ang + spread) * len);
    if (p1 && p2) {
      ctx.fillStyle = 'rgba(255,214,140,0.16)';
      ctx.beginPath();
      ctx.moveTo(t.x, t.y - wTop);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawHouse(ctx, cam, pal, h) {
  const gy = groundHeight(h.x, h.z);
  const b = project(cam, h.x, gy, h.z);
  if (!b || b.z < 18 || b.z > 2600) return false;
  const w = (FOCAL * h.s) / b.z;
  const wallH = (FOCAL * h.h) / b.z;
  const roofH = w * 0.42;

  // Walls.
  ctx.fillStyle = pal.P.townWall;
  ctx.fillRect(b.x - w / 2, b.y - wallH, w, wallH);
  // Gable roof.
  ctx.fillStyle = pal.P.townRoof;
  ctx.beginPath();
  ctx.moveTo(b.x - w * 0.62, b.y - wallH);
  ctx.lineTo(b.x, b.y - wallH - roofH);
  ctx.lineTo(b.x + w * 0.62, b.y - wallH);
  ctx.closePath();
  ctx.fill();
  // Shade side.
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.moveTo(b.x, b.y - wallH - roofH);
  ctx.lineTo(b.x + w * 0.62, b.y - wallH);
  ctx.lineTo(b.x + w * 0.62, b.y - wallH - roofH * 0.4);
  ctx.closePath();
  ctx.fill();
  return true;
}

function drawTarget(ctx, cam, pal, target, timeSec) {
  const gy = groundHeight(target.x, target.z);
  const p = project(cam, target.x, gy + 0.6, target.z);
  if (!p) return;
  const pulse = 1 + 0.14 * Math.sin(timeSec * 5);
  const rx = ((FOCAL * 46) / p.z) * pulse;
  const ry = rx * 0.42;
  ctx.strokeStyle = pal.P.ringNext;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, rx, ry, 0, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = pal.P.ringNext;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, rx, ry, 0, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = pal.P.ringNext;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4, 0, TAU);
  ctx.fill();
}

function drawShadow(ctx, cam, plane) {
  const gy = groundHeight(plane.x, plane.z);
  const agl = Math.max(0, (plane.alt || 0) - gy);
  if (agl > 260) return;
  const p = project(cam, plane.x, gy + 0.4, plane.z);
  if (!p) return;
  const grow = 1 + agl * 0.012;
  const rx = ((FOCAL * 7) / p.z) * grow;
  const alpha = clamp(0.42 - agl / 700, 0.05, 0.42);
  ctx.fillStyle = `rgba(10,14,18,${alpha})`;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, rx, rx * 0.4, 0, 0, TAU);
  ctx.fill();
}

function drawRing(ctx, cam, pal, ring, timeSec) {
  const p = project(cam, ring.x, ring.alt || 0, ring.z);
  if (!p) return;
  const radius = ring.radius || 40;
  const rx = (FOCAL * radius) / p.z;
  const ry = rx * 0.38;
  const pulse = 0.75 + 0.25 * Math.sin(timeSec * 6);
  let col, alpha, lw;
  if (ring.status === 'next') { col = pal.P.ringNext; alpha = pulse; lw = 5; }
  else if (ring.status === 'done') { col = pal.done; alpha = 0.32; lw = 3; }
  else { col = pal.P.ring; alpha = 0.55; lw = 3.5; }
  ctx.strokeStyle = col;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = lw;
  ctx.shadowColor = col;
  ctx.shadowBlur = ring.status === 'next' ? 16 : 8;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, rx, ry, 0, 0, TAU);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = alpha * 0.5;
  ctx.lineWidth = lw * 2.6;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, rx, ry, 0, 0, TAU);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawCrate(ctx, cam, pal, crate) {
  const gy = groundHeight(crate.x, crate.z);
  const y = crate.landed ? gy + 0.9 : (crate.alt || gy + 30);
  const p = project(cam, crate.x, y, crate.z);
  if (!p) return;
  const s = (FOCAL * 1.9) / p.z;
  // Parachute canopy: arc above the crate while it is under canopy.
  if (!crate.landed) {
    const cp = project(cam, crate.x, y + 5.5, crate.z);
    if (cp) {
      const cr = (FOCAL * 4.2) / cp.z;
      ctx.strokeStyle = pal.P.townWall;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1.5, s * 0.22);
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, cr, Math.PI, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(cp.x - cr, cp.y);
      ctx.lineTo(p.x - s * 0.4, p.y - s * 0.4);
      ctx.moveTo(cp.x + cr, cp.y);
      ctx.lineTo(p.x + s * 0.4, p.y - s * 0.4);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  // The crate itself: small taped box.
  ctx.fillStyle = pal.P.townRoof;
  ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s * 0.28);
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(p.x - s / 2, p.y - s / 2, s, s);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - s / 2);
  ctx.lineTo(p.x, p.y + s / 2);
  ctx.stroke();
}

// --- the Kestrel sprite --------------------------------------------------------

function drawKestrel(ctx, cam, pal, plane, timeSec) {
  // The camera is anchored to the plane: project it, then clamp into the
  // lower-centre of the view so it always reads clearly.
  const p = project(cam, plane.x, (plane.alt || 0) + 1, plane.z);
  let sx = p ? p.x : W / 2;
  let sy = p ? p.y : H3D - 60;
  sx = clamp(lerp(W / 2, sx, 0.35), W / 2 - 60, W / 2 + 60);
  sy = clamp(sy, H3D - 170, H3D - 24);
  sy += Math.sin(timeSec * 2.1) * 1.4;                    // gentle bob
  sy -= (plane.pitchDeg || 0) * 1.4;                     // pitch shifts it
  sx += Math.sin(timeSec * 1.3) * 0.9;

  const bank = clamp((plane.bankDeg || 0) * DEG, -1.1, 1.1);
  const thr = clamp(plane.throttle || 0, 0, 1);
  const skin = pal.P.townWall;
  const wingCol = shadeHex(pal.P.townWall, 0.78);
  const stripe = pal.P.townRoof;

  ctx.save();
  ctx.translate(sx, sy);

  // Spinning prop disc at the nose (top of the sprite, far side).
  const phase = timeSec * (14 + thr * 46);
  ctx.save();
  ctx.translate(0, -56);
  ctx.fillStyle = `rgba(235,240,245,${(0.10 + 0.10 * thr).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(0, 0, 14, 4.6, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(235,240,245,0.4)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(0, 0, 14, 4.6, 0, 0, TAU);
  ctx.stroke();
  // Rotating blade chords inside the disc.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, 14, 4.6, 0, 0, TAU);
  ctx.clip();
  ctx.strokeStyle = 'rgba(235,240,245,0.28)';
  for (let i = 0; i < 3; i++) {
    const a = phase + (i * Math.PI) / 3;
    const ca = Math.cos(a) * 15, sa = Math.sin(a) * 5.2;
    ctx.beginPath();
    ctx.moveTo(-ca, -sa);
    ctx.lineTo(ca, sa);
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();

  // Main wing: foreshortens and tips up/down with bank.
  const cosB = Math.cos(bank), sinB = Math.sin(bank);
  const tipX = 9 + 66 * cosB;
  const tipY = 34 * sinB;
  for (const side of [-1, 1]) {
    const tx = side * tipX;
    const ty = -6 + side * tipY;
    ctx.fillStyle = wingCol;
    ctx.beginPath();
    ctx.moveTo(side * 9, -13);
    ctx.lineTo(tx, ty - 4.5);
    ctx.lineTo(tx * 0.97, ty + 5);
    ctx.lineTo(side * 9, 0);
    ctx.closePath();
    ctx.fill();
    // Leading-edge highlight.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(side * 9, -13);
    ctx.lineTo(tx, ty - 4.5);
    ctx.stroke();
  }

  // Fuselage: teardrop from nose (top) to tail (bottom).
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.moveTo(0, -52);
  ctx.bezierCurveTo(8, -44, 10, -28, 9, -8);
  ctx.bezierCurveTo(8, 12, 6, 26, 0, 38);
  ctx.bezierCurveTo(-6, 26, -8, 12, -9, -8);
  ctx.bezierCurveTo(-10, -28, -8, -44, 0, -52);
  ctx.fill();
  // Belly shade.
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.moveTo(0, 6);
  ctx.bezierCurveTo(6, 14, 6, 26, 0, 37);
  ctx.bezierCurveTo(-6, 26, -6, 14, 0, 6);
  ctx.fill();

  // Mail satchel stripe along the spine.
  ctx.fillStyle = stripe;
  ctx.fillRect(-2.2, -34, 4.4, 40);

  // Canopy + glint.
  ctx.fillStyle = '#8fc3e0';
  ctx.beginPath();
  ctx.ellipse(0, -36, 4.6, 7.5, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(-1, -38, 2.6, Math.PI * 0.9, Math.PI * 1.5);
  ctx.stroke();

  // Tailplane.
  ctx.fillStyle = wingCol;
  ctx.beginPath();
  ctx.moveTo(-7, 30);
  ctx.lineTo(-30, 36);
  ctx.lineTo(-30, 41);
  ctx.lineTo(-7, 38);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(7, 30);
  ctx.lineTo(30, 36);
  ctx.lineTo(30, 41);
  ctx.lineTo(7, 38);
  ctx.closePath();
  ctx.fill();

  // Fin with red tip (vertical stabilizer, seen edge-on at the tail).
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.moveTo(-4.5, 14);
  ctx.lineTo(0, -12);
  ctx.lineTo(4.5, 14);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#c8503c';
  ctx.beginPath();
  ctx.moveTo(-3.1, -4);
  ctx.lineTo(0, -12);
  ctx.lineTo(3.1, -4);
  ctx.closePath();
  ctx.fill();

  // Fixed gear hint.
  ctx.strokeStyle = 'rgba(20,20,20,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-4, 34);
  ctx.lineTo(-6, 42);
  ctx.moveTo(4, 34);
  ctx.lineTo(6, 42);
  ctx.stroke();

  ctx.restore();
}

// --- screen-space helpers -----------------------------------------------------

// Off-screen indicator: clamp to the view edge, chevron toward the target.
function drawChevron(ctx, p, colour, label) {
  const m = 46;
  const x = clamp(p.x, m, W - m);
  const y = clamp(p.y, m, H3D - m);
  const ang = Math.atan2(p.y - y, p.x - x);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.fillStyle = colour;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-8, -9);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-8, 9);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = colour;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, x, y - 14);
}

function drawRain(ctx, weather, timeSec) {
  const rain = clamp(weather.rain || 0, 0, 1);
  if (rain <= 0.01) return;
  const n = Math.floor(rain * RAIN.length);
  const slant = 8;
  ctx.strokeStyle = 'rgba(200,220,240,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const d = RAIN[i];
    const y = (d.y + timeSec * d.v) % (H3D + 80) - 40;
    const x = (d.x + timeSec * d.drift) % (W + 80) - 40;
    ctx.moveTo(x, y);
    ctx.lineTo(x + slant, y + d.len);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawVignette(ctx, paletteName) {
  if (paletteName !== 'dusk') return;
  const g = ctx.createRadialGradient(W / 2, H3D / 2, H3D * 0.45, W / 2, H3D / 2, H3D * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(24,10,34,0.42)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H3D);
}

// --- main entry ---------------------------------------------------------------

// view = { plane, paletteName, rings, crates, target, weather, timeSec }
export function drawWorld(ctx, view) {
  const plane = (view && view.plane) || { x: 0, z: 0, alt: 0, headingDeg: 0 };
  const paletteName = (view && view.paletteName) || 'noon';
  const rings = (view && view.rings) || [];
  const crates = (view && view.crates) || [];
  const target = view && view.target;
  const weather = (view && view.weather) || {};
  const timeSec = (view && view.timeSec) || 0;
  const pal = palette(paletteName);

  const cam = makeCamera(plane);
  const horizonY = drawSky(ctx, cam, pal, paletteName, plane, timeSec);
  const map = getMap(paletteName);

  // Camera shake: deterministic gust noise, applied to the 3D portion only.
  const shake = weather.shake || 0;
  const shx = shake * Math.sin(timeSec * 23.7) + shake * 0.6 * Math.sin(timeSec * 41.3);
  const shy = shake * Math.cos(timeSec * 19.1) * 0.8;

  ctx.save();
  ctx.translate(shx, shy);

  drawGround(ctx, cam, pal, map, horizonY);
  drawShadow(ctx, cam, plane);

  // Projected features, far to near.
  const items = [];
  items.push({ z: 1e9, fn: () => drawVolcano(ctx, cam, pal, FEATURES.volcano) });
  items.push({ z: project(cam, FEATURES.lighthouse.x, 20, FEATURES.lighthouse.z)?.z ?? 1e8,
    fn: () => drawLighthouse(ctx, cam, pal, paletteName, timeSec) });
  for (const h of HOUSES) {
    const d2 = (h.x - cam.x) ** 2 + (h.z - cam.z) ** 2;
    if (d2 > 2500 * 2500) continue;
    items.push({ z: Math.sqrt(d2), fn: () => drawHouse(ctx, cam, pal, h) });
  }
  if (target) {
    const p = project(cam, target.x, groundHeight(target.x, target.z), target.z);
    if (p) items.push({ z: p.z, fn: () => drawTarget(ctx, cam, pal, target, timeSec) });
  }
  for (const ring of rings) {
    const p = project(cam, ring.x, ring.alt || 0, ring.z);
    if (p) items.push({ z: p.z, fn: () => drawRing(ctx, cam, pal, ring, timeSec) });
  }
  for (const crate of crates) {
    const p = project(cam, crate.x, crate.alt || 0, crate.z);
    if (p) items.push({ z: p.z, fn: () => drawCrate(ctx, cam, pal, crate) });
  }
  items.sort((a, b) => b.z - a.z);
  for (const it of items) it.fn();

  drawKestrel(ctx, cam, pal, plane, timeSec);
  ctx.restore();

  // Edge chevrons for the active objective, drawn in screen space.
  const chevCol = pal.P.ringNext;
  const nextRing = rings.find((r) => r.status === 'next');
  if (nextRing) {
    const p = project(cam, nextRing.x, nextRing.alt || 0, nextRing.z);
    if (p && (p.x < 20 || p.x > W - 20 || p.y < 20 || p.y > H3D - 20)) {
      const dist = Math.round(Math.hypot(nextRing.x - plane.x, nextRing.z - plane.z));
      drawChevron(ctx, p, chevCol, `${dist.toLocaleString('en-US')} m`);
    }
  }
  if (target) {
    const p = project(cam, target.x, groundHeight(target.x, target.z), target.z);
    if (p && (p.x < 20 || p.x > W - 20 || p.y < 20 || p.y > H3D - 20)) {
      const dist = Math.round(Math.hypot(target.x - plane.x, target.z - plane.z));
      drawChevron(ctx, p, chevCol, `OBJ ${dist.toLocaleString('en-US')} m`);
    }
  }

  drawRain(ctx, weather, timeSec);
  drawVignette(ctx, paletteName);
}
