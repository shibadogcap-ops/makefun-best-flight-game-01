// missions.js — the five KESTREL POST sorties: briefing data, live sortie
// state, per-step objectives (rings, crate drops, lighthouse orbit,
// landing), and scoring.
//
// Pure simulation like flight.js: no DOM, no Math.random/Date.now. Gusts
// come from seeded value noise over elapsed time; sortie.rng carries a
// seeded PRNG for anything else that needs determinism.
//
// Conventions inherited from world.js/flight.js: metres, x east / z south,
// heading deg with 0 = north, direction = (sin h, -cos h).

import { STEP } from './config.js';
import { createPlane, stepPlane } from './flight.js';
import { RUNWAYS, FEATURES, groundHeight, runwayAt } from './world.js';
import { createRng, valueNoise2 } from './random.js';

const DEG = Math.PI / 180;
const RING_RADIUS = 26;
const DROP_ZONE = FEATURES.dropZone;
const LIGHTHOUSE = FEATURES.lighthouse;
const VOLCANO = FEATURES.volcano;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Smallest absolute angular difference a-b in degrees, in [-180, 180].
function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function dist2d(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

function fmtDist(d) {
  return d >= 1000 ? `${(d / 1000).toFixed(1)} KM` : `${Math.round(d)} M`;
}

// --- the five sorties ---------------------------------------------------------
// Ring rows are [x, z, alt]. Positions are placed along each route using the
// world.js anchors (runway thresholds/departures, FEATURES).

export const MISSIONS = [
  {
    id: 'first-post',
    name: 'FIRST POST',
    story:
      'The morning bag is light but the run to Port Saffron is all water. ' +
      'Three marker rings hang in the sea haze between the isles — thread ' +
      'them clean and the saffron postmaster will have his parcels by noon.',
    goal: 'Thread the three rings, then put her down on Port Saffron\'s strip.',
    palette: 'noon',
    wind: { x: 2, z: 1, gust: 1.5 },
    parTimeSec: 240,
    startRunwayIndex: 0,
    targetRunwayIndex: 1,
    rings: [
      [-100, 700, 80],
      [250, 1400, 110],
      [500, 1950, 100],
    ],
    objectives: ['rings', 'land'],
  },
  {
    id: 'gull-rock',
    name: 'MEDICINE FOR GULL ROCK',
    story:
      'Gull Rock\'s clinic is out of serum and the tide won\'t wait for a boat. ' +
      'Three crates ride in your bay — punch Space over the drop circle and ' +
      'let the chutes do their work, then fly home to Kestrel Field.',
    goal: 'Drop all three crates into the Gull Rock circle, then land Kestrel Field.',
    palette: 'noon',
    wind: { x: 6, z: -2, gust: 3 },
    parTimeSec: 300,
    startRunwayIndex: 0,
    targetRunwayIndex: 0,
    rings: [],
    cratesCarried: 3,
    objectives: ['drop', 'land'],
  },
  {
    id: 'long-water',
    name: 'THE LONG WATER',
    story:
      'The northern run is the longest water crossing in the Amber Isles and ' +
      'the wind is already leaning on your nose. Six rings mark the way home ' +
      'across the isles — watch the gauge, because this tank was only topped ' +
      'to four-fifths.',
    goal: 'Fly all six rings against the headwind and land back at Kestrel Field.',
    palette: 'noon',
    wind: { x: -2, z: 8, gust: 3 },
    parTimeSec: 420,
    startRunwayIndex: 1,
    targetRunwayIndex: 0,
    rings: [
      [550, 1500, 90],
      [900, 600, 120],
      [2300, -300, 100],
      [-800, -800, 130],
      [-1900, -600, 110],
      [-400, 400, 90],
    ],
    objectives: ['rings', 'land'],
  },
  {
    id: 'storm-line',
    name: 'STORM LINE',
    story:
      'The weather line is parked over Lantern Point and the beam is the only ' +
      'friendly light on the coast. Give the lighthouse one clean orbit in the ' +
      'gusts, then come home through the rain to Kestrel Field.',
    goal: 'Orbit Lantern Light once below 220 m, then land Kestrel Field.',
    palette: 'dusk',
    wind: { x: 5, z: -4, gust: 9 },
    rain: true,
    parTimeSec: 360,
    startRunwayIndex: 0,
    targetRunwayIndex: 0,
    rings: [],
    objectives: ['orbit', 'land'],
  },
  {
    id: 'cinder-survey',
    name: 'CINDER SURVEY',
    story:
      'The survey board wants the ash fields of Mt. Cinder mapped at three ' +
      'altitudes before the season closes. The volcano throws its own weather ' +
      '— keep her smooth, mark all three rings, and bring her back to Port ' +
      'Saffron.',
    goal: 'Fly the three survey rings at their altitude bands, then land Port Saffron.',
    palette: 'noon',
    wind: { x: -3, z: 2, gust: 4 },
    parTimeSec: 420,
    startRunwayIndex: 1,
    targetRunwayIndex: 1,
    rings: [
      [-1400, -1450, 120],
      [-1800, -1900, 220],
      [-1000, -1900, 320],
    ],
    ringRadius: 60,
    objectives: ['rings', 'land'],
  },
];

// --- sortie construction ------------------------------------------------------

// createSortie(missionIndex, seed) -> the live sortie state stepSortie drives.
export function createSortie(missionIndex, seed = 1) {
  const mission = MISSIONS[missionIndex % MISSIONS.length];
  const startRunway = RUNWAYS[mission.startRunwayIndex];
  const plane = createPlane(startRunway);
  if (mission.id === 'long-water') plane.fuel = 80; // THE LONG WATER runs a light tank

  const ringRadius = mission.ringRadius || RING_RADIUS;
  const rings = (mission.rings || []).map(([x, z, alt], i) => ({
    x, z, alt, radius: ringRadius,
    status: i === 0 ? 'next' : 'todo',
  }));

  const rngSeed = (seed >>> 0) ^ (missionIndex * 0x9e3779b9);
  return {
    missionIndex,
    mission,
    seed,
    rng: createRng(rngSeed),
    gustSeed: rngSeed ^ 0x51ab3f,
    plane,
    rings,
    crates: [],          // falling/landed supply crates (mission 2)
    cratesCarried: mission.cratesCarried || 0,
    cratesTotal: mission.cratesCarried || 0,
    dropPoints: 0,
    orbitDeg: 0,
    orbitDone: false,
    timerSec: 0,
    steps: 0,
    scoreEvents: [],
    status: 'flying',    // 'flying' | 'complete' | 'crashed'
    message: null,
    messageT: 0,
    env: { windX: 0, windZ: 0, gustX: 0, gustZ: 0 },
    results: null,
  };
}

// --- helpers ------------------------------------------------------------------

function setMessage(sortie, text, t = 3.5) {
  sortie.message = text;
  sortie.messageT = t;
}

function ringsDone(sortie) {
  return sortie.rings.every((r) => r.status === 'done');
}

function ringsDoneCount(sortie) {
  return sortie.rings.filter((r) => r.status === 'done').length;
}

// Wind environment for this step: base wind + smooth seeded gusts.
function windEnv(sortie) {
  const w = sortie.mission.wind;
  const t = sortie.timerSec;
  const s = sortie.gustSeed;
  const gustX = (valueNoise2(t * 0.8, 17.3, 1, s + 101) - 0.5) * 2 * w.gust;
  const gustZ = (valueNoise2(t * 0.63, 91.7, 1, s + 202) - 0.5) * 2 * w.gust;
  return { windX: w.x, windZ: w.z, gustX, gustZ };
}

// First objective not yet complete, or 'land' once everything else is done.
function currentObjective(sortie) {
  for (const o of sortie.mission.objectives) {
    if (o === 'rings' && !ringsDone(sortie)) return 'rings';
    if (o === 'drop' && sortie.cratesCarried > 0) return 'drop';
    if (o === 'orbit' && !sortie.orbitDone) return 'orbit';
    // 'land' is terminal — handled by touchdown, not a check here.
  }
  return 'land';
}

function priorObjectivesDone(sortie) {
  return currentObjective(sortie) === 'land';
}

// --- scoring ------------------------------------------------------------------

// Points earned so far (ring bonuses + resolved crate drops), for the HUD.
function earnedPoints(sortie) {
  return ringsDoneCount(sortie) * 150 + sortie.dropPoints;
}

// Full debrief score once the sortie resolves.
function computeResults(sortie, success, landingGrade) {
  const m = sortie.mission;
  const p = sortie.plane;
  let score = 0;
  if (success) {
    score = 600
      + ringsDoneCount(sortie) * 150
      + sortie.dropPoints
      + Math.max(0, m.parTimeSec - sortie.timerSec) * 2
      + p.fuel * 3
      - p.damage * 4;
    score = Math.max(0, Math.floor(score));
  }
  const stars = !success ? 0
    : score >= 1400 && p.damage < 25 ? 3
    : score >= 900 ? 2
    : 1;
  return {
    success,
    timeSec: sortie.timerSec,
    fuelLeft: p.fuel,
    landingGrade,
    ringsDone: ringsDoneCount(sortie),
    dropPoints: sortie.dropPoints,
    score,
    stars,
  };
}

function finish(sortie, success, landingGrade) {
  sortie.status = success ? 'complete' : 'crashed';
  sortie.results = computeResults(sortie, success, landingGrade);
}

// --- crate drops (mission 2) ---------------------------------------------------

function dropCrate(sortie) {
  const p = sortie.plane;
  const env = sortie.env;
  const hRad = p.headingDeg * DEG;
  const windX = env.windX + env.gustX;
  const windZ = env.windZ + env.gustZ;
  // Inherit the plane's ground-track velocity, then let the wind take over.
  const vx = p.speed * Math.sin(hRad) + windX;
  const vz = -p.speed * Math.cos(hRad) + windZ;
  sortie.crates.push({
    x: p.x, z: p.z, alt: p.alt,
    vx, vz, vy: p.verticalSpeed,
    chute: false, landed: false, score: null,
  });
  sortie.cratesCarried -= 1;
  const left = sortie.cratesCarried;
  setMessage(sortie,
    left > 0 ? `CRATE AWAY — ${sortie.cratesTotal - left} OF ${sortie.cratesTotal}`
             : 'LAST CRATE AWAY — GO HOME');
}

function stepCrates(sortie, dt) {
  const env = sortie.env;
  const windX = env.windX + env.gustX;
  const windZ = env.windZ + env.gustZ;
  for (const c of sortie.crates) {
    if (c.landed) continue;
    const agl = c.alt - groundHeight(c.x, c.z);
    if (!c.chute && agl < 60) c.chute = true;
    if (c.chute) {
      // Canopy out: settle to a ~6 m/s descent.
      c.vy += (-6 - c.vy) * Math.min(1, dt * 1.6);
    } else {
      c.vy -= 9.8 * dt;
      c.vy = Math.max(c.vy, -60);
    }
    // Horizontal inertia decays toward the wind drift.
    const k = Math.min(1, dt * 0.8);
    c.vx += (windX - c.vx) * k;
    c.vz += (windZ - c.vz) * k;
    c.x += c.vx * dt;
    c.z += c.vz * dt;
    c.alt += c.vy * dt;

    const gh = groundHeight(c.x, c.z);
    if (c.alt <= gh) {
      c.alt = gh;
      c.landed = true;
      const d = dist2d(c.x, c.z, DROP_ZONE.x, DROP_ZONE.z);
      c.score = d <= 30 ? 300 : d <= 60 ? 200 : d <= DROP_ZONE.radius ? 100 : 25;
      sortie.dropPoints += c.score;
      sortie.scoreEvents.push({ type: 'crate', points: c.score, dist: d });
      const label = c.score === 300 ? 'PERFECT DROP — +300'
        : c.score === 200 ? 'GOOD DROP — +200'
        : c.score === 100 ? 'ON THE ROCK — +100'
        : 'OFF ZONE — +25';
      setMessage(sortie, label);
    }
  }
}

// --- main step ------------------------------------------------------------------

// stepSortie(sortie, input, dt) — advance one fixed step. input is the
// { held:Set, pressed:Set } shape from input.js.
export function stepSortie(sortie, input, dt = STEP) {
  if (!sortie || sortie.status !== 'flying') return sortie;
  const p = sortie.plane;
  const m = sortie.mission;

  sortie.steps += 1;
  sortie.timerSec += dt;
  if (sortie.messageT > 0) sortie.messageT = Math.max(0, sortie.messageT - dt);

  sortie.env = windEnv(sortie);

  const prevHdg = p.headingDeg;
  const ev = stepPlane(p, input, dt, sortie.env);

  // CINDER SURVEY: the volcano throws convective bumps. Direct altitude
  // jitter while low over the cone — deterministic from the gust seed.
  if (m.id === 'cinder-survey' && p.airborne && !p.crashed) {
    const dVolc = dist2d(p.x, p.z, VOLCANO.x, VOLCANO.z);
    if (dVolc < 800 && p.alt < 480) {
      const n = valueNoise2(sortie.timerSec * 1.7, p.x * 0.01, 1, sortie.gustSeed + 777);
      const turb = (n - 0.5) * 5 * (1 - dVolc / 800);
      p.alt += turb * dt;
      p.verticalSpeed += turb;
    }
  }

  // STORM LINE: orbit objective — accumulate absolute heading change while
  // inside 420 m of the lighthouse and below 220 m.
  if (m.id === 'storm-line' && !sortie.orbitDone && p.airborne && !p.crashed) {
    const dLH = dist2d(p.x, p.z, LIGHTHOUSE.x, LIGHTHOUSE.z);
    if (dLH <= 420 && p.alt < 220) {
      sortie.orbitDeg += Math.abs(angleDiff(p.headingDeg, prevHdg));
      if (sortie.orbitDeg >= 355) {
        sortie.orbitDeg = 360;
        sortie.orbitDone = true;
        setMessage(sortie, 'ORBIT COMPLETE — HEAD HOME');
      }
    }
  }

  // Ring pass: 3D distance to the active ring centre.
  const nextRing = sortie.rings.find((r) => r.status === 'next');
  if (nextRing && p.airborne && !p.crashed) {
    const d = Math.hypot(p.x - nextRing.x, p.alt - nextRing.alt, p.z - nextRing.z);
    if (d < nextRing.radius) {
      nextRing.status = 'done';
      sortie.scoreEvents.push({ type: 'ring', points: 150 });
      const later = sortie.rings.find((r) => r.status === 'todo');
      if (later) later.status = 'next';
      const done = ringsDoneCount(sortie);
      const total = sortie.rings.length;
      setMessage(sortie, `RING ${done} OF ${total}`);
    }
  }

  // Crate release.
  if (input && input.pressed && input.pressed.has('drop') &&
      sortie.cratesCarried > 0 && p.airborne && !p.crashed) {
    dropCrate(sortie);
  }
  if (sortie.crates.length) stepCrates(sortie, dt);

  // Touchdown: success only on the target strip with every prior objective
  // done. A wrong-field landing just earns a scolding — take off again.
  if (ev.touchedDown) {
    const rwy = runwayAt(p.x, p.z);
    const idx = rwy ? RUNWAYS.indexOf(rwy) : -1;
    if (priorObjectivesDone(sortie) && idx === m.targetRunwayIndex) {
      finish(sortie, true, ev.touchedDown);
      setMessage(sortie, `MAIL DELIVERED — ${ev.touchedDown}`);
    } else if (rwy && idx !== m.targetRunwayIndex) {
      setMessage(sortie,
        `WRONG FIELD — THE MAIL GOES TO ${rwy.name.toUpperCase()}`, 4.5);
    } else {
      setMessage(sortie, 'OBJECTIVES INCOMPLETE — BACK UP AND FLY ON', 4.5);
    }
  }

  if (ev.crashed || p.crashed) {
    finish(sortie, false, null);
  }

  return sortie;
}

// --- views ---------------------------------------------------------------------

// objectiveText(sortie) -> { text, sub, progress } for the HUD.
export function objectiveText(sortie) {
  const m = sortie.mission;
  const p = sortie.plane;
  const obj = currentObjective(sortie);
  const sub = m.goal;

  if (obj === 'rings') {
    const ring = sortie.rings.find((r) => r.status === 'next');
    if (ring) {
      const d = dist2d(p.x, p.z, ring.x, ring.z);
      const done = ringsDoneCount(sortie);
      return {
        text: `FLY THE RINGS — NEXT RING ${fmtDist(d)}`,
        sub,
        progress: `RING ${done + 1}/${sortie.rings.length}`,
      };
    }
  }
  if (obj === 'drop') {
    const d = dist2d(p.x, p.z, DROP_ZONE.x, DROP_ZONE.z);
    const away = sortie.cratesTotal - sortie.cratesCarried;
    return {
      text: `DROP THE MEDICINE — GULL ROCK ${fmtDist(d)}`,
      sub,
      progress: `CRATES AWAY ${away}/${sortie.cratesTotal}`,
    };
  }
  if (obj === 'orbit') {
    const deg = Math.floor(sortie.orbitDeg);
    return {
      text: `ORBIT THE LIGHT — ${deg}°`,
      sub,
      progress: `${deg}/360°`,
    };
  }
  // 'land'
  const rwy = RUNWAYS[m.targetRunwayIndex];
  const d = dist2d(p.x, p.z, rwy.x, rwy.z);
  return {
    text: `LAND AT ${rwy.name.toUpperCase()} — ${fmtDist(d)}`,
    sub,
    progress: 'FINAL',
  };
}

function mapRingStatus(s) {
  return s === 'next' ? 'next' : s === 'done' ? 'done' : 'todo';
}

// viewFor(sortie) -> { world, hud } — the exact shapes render.js drawWorld
// and cockpit.js drawCockpit/drawHud consume.
export function viewFor(sortie) {
  const m = sortie.mission;
  const p = sortie.plane;
  const obj = currentObjective(sortie);
  const objText = objectiveText(sortie);

  // Ground target marker for drop / orbit / landing phases.
  let target = null;
  if (obj === 'drop') target = { x: DROP_ZONE.x, z: DROP_ZONE.z };
  else if (obj === 'orbit') target = { x: LIGHTHOUSE.x, z: LIGHTHOUSE.z };
  else if (obj === 'land') {
    const r = RUNWAYS[m.targetRunwayIndex];
    target = { x: r.x, z: r.z };
  }

  // Wind arrow direction (where the wind blows toward), deg.
  const env = sortie.env || {};
  const wx = (m.wind.x || 0) + (env.gustX || 0);
  const wz = (m.wind.z || 0) + (env.gustZ || 0);
  const windDeg = Math.atan2(wx, -wz) / DEG;

  // Camera shake: gust strength, plus extra buffeting near the volcano.
  const gustMag = Math.hypot(env.gustX || 0, env.gustZ || 0);
  const dVolc = dist2d(p.x, p.z, VOLCANO.x, VOLCANO.z);
  const turbShake = m.id === 'cinder-survey' && dVolc < 800 && p.alt < 480 ? 0.4 : 0;
  const shake = clamp(gustMag / 9 + turbShake, 0, 1);

  return {
    world: {
      plane: p,
      paletteName: m.palette,
      rings: sortie.rings.map((r) => ({
        x: r.x, z: r.z, alt: r.alt, radius: r.radius, status: mapRingStatus(r.status),
      })),
      crates: sortie.crates.map((c) => ({
        x: c.x, z: c.z, alt: c.alt, landed: c.landed, chute: c.chute,
      })),
      target,
      weather: { rain: m.rain ? 1 : 0, shake },
      timeSec: sortie.timerSec,
    },
    hud: {
      objectiveText: objText.text,
      subText: objText.sub,
      progressText: objText.progress,
      message: sortie.message,
      messageT: sortie.messageT,
      score: earnedPoints(sortie),
      timeSec: sortie.timerSec,
      windDeg,
      paletteName: m.palette,
    },
  };
}
