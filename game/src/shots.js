// shots.js — deterministic screenshot scenes for ?shot=<name>&seed=N.
// Each scene poses a real sortie (createSortie + field overrides, a few fixed
// steps where motion helps) and renders one complete frame through the same
// drawWorld/drawHud/drawCockpit path the game uses. Unknown names -> 'cover'.

import { STEP } from './config.js';
import { createSortie, stepSortie, viewFor } from './missions.js';
import { RUNWAYS, FEATURES } from './world.js';
import { drawWorld } from './render.js';
import { drawHud, drawCockpit } from './cockpit.js';

const DEG = Math.PI / 180;
const NO_INPUT = { held: new Set(), pressed: new Set() };

function pose(plane, fields) {
  Object.assign(plane, fields);
  return plane;
}

// --- scenes -------------------------------------------------------------------

// 'cover' — mission 1 mid-flight: over the Kestrel coast at ~110 m, heading
// south toward ring 2 of 3 with ring 1 already done. The money shot.
function shotCover(seed) {
  const s = createSortie(0, seed);
  const p = pose(s.plane, {
    x: 200, z: 1050, alt: 110,
    headingDeg: 180, pitchDeg: 2, bankDeg: -8,
    throttle: 0.7, speed: 55, fuel: 82, damage: 0,
    airborne: true, stalled: false, crashed: null, landed: null,
  });
  s.rings[0].status = 'done';
  s.rings[1].status = 'next';
  s.rings[2].status = 'todo';
  s.env = { windX: 2, windZ: 1, gustX: 0.6, gustZ: -0.5 };
  s.timerSec = 55;
  s.message = 'RING 1 OF 3';
  s.messageT = 3;
  const v = viewFor(s);
  return { world: v.world, hud: v.hud, plane: p };
}

// 'approach' — final to Port Saffron: ~35 m AGL on the runway heading,
// 500 m short of the threshold, slight descent, runway centred ahead.
function shotApproach(seed) {
  const s = createSortie(0, seed);
  s.rings.forEach((r) => { r.status = 'done'; });
  const rwy = RUNWAYS[1]; // Port Saffron, heading 360
  const p = pose(s.plane, {
    x: rwy.threshold.x - rwy.dirX * 500,
    z: rwy.threshold.z - rwy.dirZ * 500,
    alt: 36,
    headingDeg: rwy.headingDeg, pitchDeg: -4, bankDeg: 1,
    throttle: 0.35, speed: 33, verticalSpeed: -2.4,
    fuel: 70, airborne: true, stalled: false, crashed: null, landed: null,
  });
  s.env = { windX: 2, windZ: 1, gustX: 0, gustZ: 0 };
  s.timerSec = 170;
  const v = viewFor(s);
  return { world: v.world, hud: v.hud, plane: p };
}

// 'drop' — mission 2 over Gull Rock: ~90 m, one crate under its parachute
// below-ahead, drop zone circle on the water/rock ahead.
function shotDrop(seed) {
  const s = createSortie(1, seed);
  const DZ = FEATURES.dropZone;
  const p = pose(s.plane, {
    x: DZ.x - 240, z: DZ.z + 140, alt: 92,
    headingDeg: 62, pitchDeg: 1, bankDeg: -6,
    throttle: 0.7, speed: 48, fuel: 78,
    airborne: true, stalled: false, crashed: null, landed: null,
  });
  const h = p.headingDeg * DEG;
  s.crates = [{
    x: p.x + Math.sin(h) * 170,
    z: p.z - Math.cos(h) * 170,
    alt: p.alt - 28,
    vx: 2, vz: -1, vy: -6,
    chute: true, landed: false, score: null,
  }];
  s.cratesCarried = 2; // one away, two still aboard
  // A couple of seconds of real sim so the crate drifts under its canopy.
  for (let i = 0; i < 40; i += 1) stepSortie(s, NO_INPUT, STEP);
  s.timerSec = 75;
  s.message = 'CRATE AWAY — 1 OF 3';
  s.messageT = 3;
  const v = viewFor(s);
  return { world: v.world, hud: v.hud, plane: p };
}

// 'storm' — mission 4 at dusk in rain: banked in the orbit near Lantern
// Point, lighthouse beam sweeping, gusts shaking the camera.
function shotStorm(seed) {
  const s = createSortie(3, seed);
  s.orbitDeg = 210;
  const LH = FEATURES.lighthouse;
  const p = pose(s.plane, {
    x: LH.x + 330, z: LH.z - 40, alt: 135,
    headingDeg: 0, pitchDeg: 2, bankDeg: 25,
    throttle: 0.8, speed: 54, fuel: 55,
    airborne: true, stalled: false, crashed: null, landed: null,
  });
  s.env = { windX: 5, windZ: -4, gustX: 5, gustZ: -3.5 };
  s.timerSec = 95;
  const v = viewFor(s);
  return { world: v.world, hud: v.hud, plane: p };
}

/**
 * Build the named scene (cover | approach | drop | storm; unknown -> cover)
 * and return { world, hud, plane } ready for drawWorld/drawHud/drawCockpit.
 */
export function stageShot(name, seed = 1) {
  switch (name) {
    case 'approach': return shotApproach(seed);
    case 'drop': return shotDrop(seed);
    case 'storm': return shotStorm(seed);
    case 'cover':
    default: return shotCover(seed);
  }
}

// Draw one complete frame: world, HUD readouts, lit cockpit panel.
export function renderShot(ctx, name, seed = 1) {
  const s = stageShot(name, seed);
  drawWorld(ctx, s.world);
  drawHud(ctx, s.plane, s.hud);
  drawCockpit(ctx, s.plane, s.hud);
  return s;
}
