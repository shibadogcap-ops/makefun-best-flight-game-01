// config.js — every tuning number and palette colour for KESTREL POST.
// Units: metres, m/s, metres above sea level. Angles in degrees for state,
// radians only inside flight.js where trig is needed.

export const VIEW = { width: 1280, height: 720 };

// Fixed simulation step; render may run faster or slower, the sim never does.
export const STEP = 1 / 60;

export const WORLD = {
  size: 6000,      // metres, world spans -3000..3000 on both axes
  seaLevel: 0,     // metres above sea level
};

// Aircraft tuning. The Kestrel is a single-prop mail plane: friendly but honest.
export const PLANE = {
  maxThrustSpeed: 78,      // m/s — top speed in a full-throttle level dive/climb mix
  idleSpeedTarget: 46,     // m/s — equilibrium the plane settles to at idle throttle
  engineAccel: 6.5,        // m/s^2 static thrust accel at full throttle
  dragCoeff: 0.00105,      // quadratic drag; top speed ≈ sqrt(engineAccel/dragCoeff) ≈ 79
  stallSpeed: 24,          // m/s — below this, wings stall at level/climb
  rotateSpeed: 30,         // m/s — rotate/lift-off speed on the roll
  maxBankDeg: 55,          // bank clamp
  bankRate: 90,            // deg/s toward commanded bank
  turnRateFullBank: 6.5,   // deg/s at max bank and cruise speed
  pitchRate: 55,           // deg/s pitch response
  maxPitchDeg: 22,         // pitch clamp airborne
  climbRate: 5.2,          // m/s per unit sin(pitch) at cruise (finesse)
  diveRate: 4.0,           // extra sink/descend authority
  stallSink: 7.5,          // m/s sink while stalled
  stallNoseDrop: 0.35,     // fraction of pitch lost per second while stalled
  liftBleedBank: 0.55,     // fraction of lift lost at max bank (altitude sag)
  overspeedDamageAt: 95,   // m/s — sustained above this = stress damage
  overspeedDamageRate: 2.5,// damage per second over the threshold
  fuelCapacity: 100,       // fuel units
  fuelBurnIdle: 0.55,      // per second at throttle 0
  fuelBurnFull: 3.2,       // per second at throttle 1 (scaled by throttle)
  damage: {
    hardLanding: 18,       // flat damage for a HARD touchdown
    roughLanding: 6,
    terrainStrike: 60,
    waterDitch: 45,
    overspeedPerSec: 0.12, // damage per (m/s over threshold) per second
  },
  gearDown: true,          // fixed-gear Kestrel — always down
};

// Landing grades, worst last. touchdown = { vs (m/s sink), bank (deg), headingErr (deg) }
export const LANDING = {
  perfectVs: 1.6,   // max sink rate for PERFECT
  smoothVs: 2.6,
  roughVs: 4.0,
  hardVs: 5.5,      // beyond this is a HARD landing even on a runway
  maxBankSmooth: 8,
  maxBankRough: 15,
  maxHeadingErr: 12,  // deg off runway heading still counts as aligned
};

// Palettes — one warm "amber" style shared by both times of day.
export const PALETTES = {
  noon: {
    skyTop: '#4f9fd8', skyHorizon: '#bfe3ee',
    seaNear: '#2e7fa8', seaFar: '#7fb9cc',
    grass: '#7fae5a', fieldA: '#b8a24e', fieldB: '#8fae6a',
    sand: '#e0c98f', rock: '#8d8578', ash: '#5b564e',
    townRoof: '#b4552f', townWall: '#e8d9b8',
    runway: '#5d6670', runwayMark: '#f2e9d0',
    ring: '#ffd76a', ringNext: '#ff9d4d', panel: '#2c2a26',
  },
  dusk: {
    skyTop: '#3a3f6e', skyHorizon: '#e8905a',
    seaNear: '#3a4f7a', seaFar: '#c98a6a',
    grass: '#6d8a52', fieldA: '#a8884e', fieldB: '#7a8a60',
    sand: '#d8a878', rock: '#6e5f58', ash: '#4a423e',
    townRoof: '#8a4a3a', townWall: '#d8b898',
    runway: '#4a4f5a', runwayMark: '#e8d0a8',
    ring: '#ffb45e', ringNext: '#ff7d3d', panel: '#241f22',
  },
};

// localStorage key for campaign progress (stars per mission).
export const BEST_KEY = 'kestrel-post-best';
