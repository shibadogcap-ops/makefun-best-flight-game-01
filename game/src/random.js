// random.js — deterministic randomness for KESTREL POST.
// The sim must never call Math.random/Date.now; every "random" value comes
// from a seeded generator or a hash of world coordinates.

// mulberry32 — small fast PRNG returning floats in [0, 1).
export function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// hash2 — deterministic hash of integer grid coords + seed -> [0, 1).
// Used as the base of the value-noise lattice; pure function of its inputs.
export function hash2(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + (seed >>> 0) * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

// valueNoise2 — smooth bilinear-interpolated value noise in [0, 1).
// scale = metres per noise cell (larger = smoother).
export function valueNoise2(x, z, scale, seed) {
  const gx = x / scale;
  const gz = z / scale;
  const ix = Math.floor(gx);
  const iz = Math.floor(gz);
  const fx = smooth(gx - ix);
  const fz = smooth(gz - iz);

  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);

  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fz;
}

// fbm2 — fractal Brownian motion: stacked octaves of valueNoise2.
// Returns roughly [0, 1); use octaves for terrain variation.
export function fbm2(x, z, scale, seed, octaves = 4, gain = 0.5) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let s = scale;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x, z, s, seed + i * 101);
    norm += amp;
    amp *= gain;
    s *= 0.5;
  }
  return sum / norm;
}
