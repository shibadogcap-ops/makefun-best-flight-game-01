// shots.js — deterministic screenshot scenes for ?shot=<name>&seed=N.
// Each scene poses a real sortie (createSortie + field overrides, a few fixed
// steps where motion helps) and renders one complete frame through the same
// drawWorld/drawHud/drawCockpit path the game uses. Unknown names -> 'cover'.

import { createSortie, viewFor } from './missions.js';
import { RUNWAYS, FEATURES } from './world.js';
import { drawWorld } from './render.js';
import { drawHud, drawCockpit } from './cockpit.js';

const DEG = Math.PI / 180;

function pose(plane, fields) {
  Object.assign(plane, fields);
  return plane;
}

// --- scenes -------------------------------------------------------------------

// 'cover' — mission 1 mid-flight: ~280 m short of ring 2 on its approach
// line, ring centred large ahead above the message band, ring 1 done.
function shotCover(seed) {
  const s = createSortie(0, seed);
  const p = pose(s.plane, {
    x: 211, z: 1123, alt: 80,
    headingDeg: 172, pitchDeg: 2, bankDeg: -8,
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
  v.world.rings = []; // landing phase — no flown rings in frame
  return { world: v.world, hud: v.hud, plane: p };
}

// 'drop' — mission 2 over Gull Rock: ~70 m up, ~350 m short of the drop
// zone on a heading toward it, one crate under its open parachute below
// and ahead (~35 m under the plane) with the zone circle beyond.
function shotDrop(seed) {
  const s = createSortie(1, seed);
  const DZ = FEATURES.dropZone;
  const hDeg = 78;
  const hr = hDeg * DEG;
  const dirX = Math.sin(hr), dirZ = -Math.cos(hr);
  const px = DZ.x - dirX * 350;
  const pz = DZ.z - dirZ * 350;
  const p = pose(s.plane, {
    x: px, z: pz, alt: 70,
    headingDeg: hDeg, pitchDeg: -3, bankDeg: -6,
    throttle: 0.7, speed: 48, fuel: 78,
    airborne: true, stalled: false, crashed: null, landed: null,
  });
  // Staged as ~1.4 s under canopy: below and ahead of the plane, chute open.
  s.crates = [{
    x: px + dirX * 200,
    z: pz + dirZ * 200,
    alt: p.alt - 34,
    vx: 4, vz: -1, vy: -6,
    chute: true, landed: false, score: null,
  }];
  s.cratesCarried = 2; // one away, two still aboard
  s.timerSec = 75;
  s.message = 'CRATE AWAY — 1 OF 3';
  s.messageT = 3;
  const v = viewFor(s);
  return { world: v.world, hud: v.hud, plane: p };
}

// 'storm' — mission 4 at dusk in rain: banked on the Lantern Point orbit,
// lighthouse dead ahead with its beam sweeping into frame, gusts shaking
// the camera. timerSec is chosen so the beam (ang = t*0.85) points west,
// down-range of the camera.
function shotStorm(seed) {
  const s = createSortie(3, seed);
  s.orbitDeg = 210;
  const p = pose(s.plane, {
    x: -1970, z: 1160, alt: 60,
    headingDeg: 263, pitchDeg: 4, bankDeg: 25,
    throttle: 0.8, speed: 54, fuel: 55,
    airborne: true, stalled: false, crashed: null, landed: null,
  });
  s.env = { windX: 5, windZ: -4, gustX: 5, gustZ: -3.5 };
  s.timerSec = 310;
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
