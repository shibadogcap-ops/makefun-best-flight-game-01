// flight.js — the Kestrel's flight model.
// Pure simulation: no DOM, no rendering, no Math.random/Date.now.
// stepPlane(state, input, dt, env) advances one fixed step and returns an
// events object { tookOff, touchedDown, crashed, stallWarning }.
//
// Conventions (see DESIGN.md): metres, x east / z south, heading deg with
// 0 = north (-z) clockwise, direction vector = (sin h, -cos h).

import { PLANE, LANDING, STEP } from './config.js';
import { groundHeight, groundType, runwayAt, islandAt } from './world.js';

const DEG = Math.PI / 180;
const FT_PER_M = 3.28084;
const KT_PER_MS = 1.94384;
const FPM_PER_MS = FT_PER_M * 60;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerpAngle = (a, b, t) => a + (b - a) * t;

// Smallest absolute angular difference a-b in degrees, in [-180, 180].
function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// --- state ------------------------------------------------------------------

// createPlane(runway) — parked on the runway threshold, aligned to heading.
export function createPlane(runway) {
  return {
    x: runway.threshold.x,
    z: runway.threshold.z,
    alt: runway.plateau,          // metres above sea level
    headingDeg: runway.headingDeg,
    pitchDeg: 0,
    bankDeg: 0,
    throttle: 0,                  // 0..1
    speed: 0,                     // m/s airspeed
    verticalSpeed: 0,             // m/s, +up
    fuel: PLANE.fuelCapacity,
    damage: 0,                    // 0..100
    stalled: false,
    airborne: false,
    crashed: null,                // null | 'terrain' | 'water' | 'stall'
    landed: null,                 // null | landing grade string
    gearDown: PLANE.gearDown,     // fixed gear — always true
    runway,                       // home strip, for respawn/UI
  };
}

// --- helpers ----------------------------------------------------------------

function held(input, name) {
  return !!input && input.held && input.held.has(name);
}

// Commanded control surface targets from the input set.
function controls(input) {
  let bank = 0, pitch = 0, thr = 0;
  if (held(input, 'bankLeft')) bank -= 1;
  if (held(input, 'bankRight')) bank += 1;
  if (held(input, 'pitchUp')) pitch += 1;
  if (held(input, 'pitchDown')) pitch -= 1;
  if (held(input, 'throttleUp')) thr += 1;
  if (held(input, 'throttleDown')) thr -= 1;
  return { bank, pitch, thr };
}

// Engine/drag acceleration along the flight path (m/s^2).
// Thrust interpolates between an idle value (which cancels drag at
// idleSpeedTarget) and full power; quadratic drag sets the top speed.
function propAccel(state, throttle) {
  const idle = state.fuel > 0 ? PLANE.idleSpeedTarget : 15; // dry tank = glide
  const idleThrust = PLANE.dragCoeff * idle * idle;
  const thrust = idleThrust + throttle * (PLANE.engineAccel - idleThrust);
  return thrust - PLANE.dragCoeff * state.speed * state.speed;
}

// Vertical speed from pitch, speed and bank. Positive = climbing.
function computeVS(state) {
  const pitchRad = state.pitchDeg * DEG;
  // Kinematic climb fraction of airspeed, less a small parasitic sink.
  let vs = Math.sin(pitchRad) * state.speed * 0.55 - 1.0;
  // Steep banks bleed lift: the plane sags in hard turns.
  const bankFrac = Math.abs(state.bankDeg) / PLANE.maxBankDeg;
  vs *= 1 - PLANE.liftBleedBank * bankFrac * bankFrac;
  return vs;
}

// Touchdown grading: descent rate, bank, alignment and speed at contact.
function gradeLanding(sinkRate, bankDeg, headingErrDeg, speed) {
  if (sinkRate <= LANDING.perfectVs && Math.abs(bankDeg) <= LANDING.maxBankSmooth &&
      Math.abs(headingErrDeg) <= LANDING.maxHeadingErr) return 'PERFECT';
  if (sinkRate <= LANDING.smoothVs && Math.abs(bankDeg) <= LANDING.maxBankRough &&
      Math.abs(headingErrDeg) <= LANDING.maxHeadingErr + 8) return 'SMOOTH';
  if (sinkRate <= LANDING.roughVs && Math.abs(bankDeg) <= 22 &&
      Math.abs(headingErrDeg) <= LANDING.maxHeadingErr + 18) return 'ROUGH';
  return 'HARD';
}

// --- main step ---------------------------------------------------------------

// env = { windX, windZ, gustX, gustZ } in m/s (already seeded by caller).
// input = { held:Set, pressed:Set } from input.js.
export function stepPlane(state, input, dt = STEP, env = {}) {
  const ev = { tookOff: false, touchedDown: null, crashed: null, stallWarning: false };
  if (state.crashed) return ev;

  const windX = (env.windX || 0) + (env.gustX || 0);
  const windZ = (env.windZ || 0) + (env.gustZ || 0);
  const ctl = controls(input);

  // Throttle lever moves at a fixed rate; W/S or Shift/Ctrl nudge it.
  const THR_RATE = 0.55; // full throw in ~1.8 s
  state.throttle = clamp(state.throttle + ctl.thr * THR_RATE * dt, 0, 1);

  // --- surface dynamics: bank and pitch chase their commanded targets ------
  const bankTarget = ctl.bank * PLANE.maxBankDeg;
  const rate = (cur, target, maxRate) =>
    lerpAngle(cur, target, clamp(maxRate * dt / Math.max(1, Math.abs(target - cur)), 0, 1));

  // --- ground roll ----------------------------------------------------------
  if (!state.airborne) {
    // Nosewheel steering: bank keys yaw the aircraft, authority grows with speed.
    const steer = ctl.bank * 14 * clamp(state.speed / 30, 0, 1);
    state.headingDeg = (state.headingDeg + steer * dt + 360) % 360;
    state.bankDeg = 0;
    state.pitchDeg = lerpAngle(state.pitchDeg, 0, clamp(4 * dt, 0, 1));

    const accel = state.speed > 0.2 ? propAccel(state, state.throttle) : PLANE.idleSpeedTarget * 0.2;
    state.speed += accel * dt;
    // Brakes: idle throttle on the roll decelerates firmly.
    if (state.throttle <= 0.02) state.speed -= 7.5 * dt;
    state.speed = Math.max(0, state.speed);

    const hRad = state.headingDeg * DEG;
    state.x += Math.sin(hRad) * state.speed * dt;
    state.z += -Math.cos(hRad) * state.speed * dt;

    state.alt = groundHeight(state.x, state.z);
    state.verticalSpeed = 0;
    state.stalled = false;

    // Rotation: fast enough and the pilot pulls back -> fly.
    if (state.speed >= PLANE.rotateSpeed && ctl.pitch > 0) {
      state.airborne = true;
      state.pitchDeg = 9;
      state.landed = null;
      ev.tookOff = true;
    }
  } else {
    // --- airborne ----------------------------------------------------------
    state.bankDeg = rate(state.bankDeg, bankTarget, PLANE.bankRate);
    state.pitchDeg = clamp(state.pitchDeg + ctl.pitch * PLANE.pitchRate * dt,
      -PLANE.maxPitchDeg, PLANE.maxPitchDeg);

    // Speed: engine + drag, then energy exchange with the climb/descent.
    let accel = propAccel(state, state.throttle);
    let vs = computeVS(state);

    // Stall: slow and not in a deliberate dive -> nose drops, sink until
    // airspeed recovers above the stall margin.
    if (state.speed < PLANE.stallSpeed && state.pitchDeg > -4) {
      state.stalled = true;
    }
    if (state.stalled) {
      ev.stallWarning = true;
      // Nose drops toward a recovery attitude; sink is bounded and heavy.
      state.pitchDeg = lerpAngle(state.pitchDeg, -11, clamp(PLANE.stallNoseDrop * 4 * dt, 0, 1));
      vs = -PLANE.stallSink;
      if (state.speed > PLANE.stallSpeed + 3) state.stalled = false;
    }

    state.speed += accel * dt;
    // Potential <-> kinetic exchange: climbing bleeds speed, diving gains it.
    state.speed += (-9.8 * vs / Math.max(state.speed, 12)) * dt;
    state.speed = Math.max(8, state.speed);

    // Turn: rate scales with bank angle and (roughly) airspeed.
    const bankFrac = state.bankDeg / PLANE.maxBankDeg;
    const speedFactor = clamp(state.speed / 55, 0.25, 1.15);
    const turnDeg = PLANE.turnRateFullBank * bankFrac * speedFactor *
      (state.stalled ? 0.5 : 1);
    state.headingDeg = (state.headingDeg + turnDeg * dt + 360) % 360;

    state.verticalSpeed = vs;

    // Ground track = air velocity + wind/gust drift.
    const hRad = state.headingDeg * DEG;
    const gvx = state.speed * Math.sin(hRad) + windX;
    const gvz = -state.speed * Math.cos(hRad) + windZ;
    state.x += gvx * dt;
    state.z += gvz * dt;
    state.alt += vs * dt;

    // Fuel burn ~ throttle; dry tank leaves glide power only.
    state.fuel = Math.max(0, state.fuel - dt *
      (PLANE.fuelBurnIdle + state.throttle * (PLANE.fuelBurnFull - PLANE.fuelBurnIdle)));

    // Overspeed dive stress.
    if (state.speed > PLANE.overspeedDamageAt) {
      state.damage += PLANE.damage.overspeedPerSec * (state.speed - PLANE.overspeedDamageAt) * dt;
    }

    // --- ground contact -----------------------------------------------------
    const gh = groundHeight(state.x, state.z);
    if (state.alt <= gh) {
      const rwy = runwayAt(state.x, state.z);
      const sinkRate = Math.max(0, -vs);
      const onSea = !islandAt(state.x, state.z) || gh <= WORLD_SEA_EPS;

      if (rwy) {
        const alignErr = Math.abs(angleDiff(state.headingDeg, rwy.headingDeg));
        const tooFast = state.speed > 65;
        const tooSteep = Math.abs(state.bankDeg) > 30 || sinkRate > 8;
        if (tooFast || tooSteep) {
          state.crashed = 'terrain';
          ev.crashed = 'terrain';
          state.damage = Math.min(100, state.damage + PLANE.damage.terrainStrike);
          return ev;
        }
        // Touchdown on the strip: grade it, then roll out.
        const grade = gradeLanding(sinkRate, state.bankDeg, alignErr, state.speed);
        state.landed = grade;
        state.airborne = false;
        state.alt = gh;
        state.verticalSpeed = 0;
        state.pitchDeg = 0;
        ev.touchedDown = grade;
        if (grade === 'HARD') state.damage += PLANE.damage.hardLanding;
        if (grade === 'ROUGH') state.damage += PLANE.damage.roughLanding;
      } else {
        // Off-strip contact: landable grass is still a crash in this game —
        // gear is fixed and the fields are bumpy. Sea = water ditching.
        state.crashed = onSea ? 'water' : 'terrain';
        ev.crashed = state.crashed;
        state.damage = Math.min(100, state.damage +
          (onSea ? PLANE.damage.waterDitch : PLANE.damage.terrainStrike));
        state.alt = gh;
        state.verticalSpeed = 0;
      }
    }
  }

  state.damage = clamp(state.damage, 0, 100);
  state.headingDeg = (state.headingDeg + 360) % 360;
  return ev;
}

const WORLD_SEA_EPS = 0.01;

// --- HUD ---------------------------------------------------------------------

// hudValues(state) -> display units for the cockpit: ft, kt, deg, fpm, %.
export function hudValues(state) {
  return {
    altFt: state.alt * FT_PER_M,
    spdKt: state.speed * KT_PER_MS,
    hdgDeg: state.headingDeg,
    vsFpm: state.verticalSpeed * FPM_PER_MS,
    fuelPct: (state.fuel / PLANE.fuelCapacity) * 100,
  };
}

// Re-export for convenience (renderer/tests may want the surface type too).
export { groundType };
