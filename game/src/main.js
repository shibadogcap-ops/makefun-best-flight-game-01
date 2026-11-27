// main.js — boot + screen state machine for KESTREL POST.
// Screens: 'title' (animated cinematic backdrop + campaign strip),
// 'brief', 'play' (fixed-step sim, pausable), 'debrief', 'end' (campaign
// complete). Free flight is a play variant with its own minimal sortie.
// ?shot=<name>&seed=N hands off to shots.js for one deterministic frame.

import { VIEW, STEP, BEST_KEY } from './config.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { RUNWAYS } from './world.js';
import { createPlane, stepPlane } from './flight.js';
import { MISSIONS, createSortie, stepSortie, viewFor } from './missions.js';
import { valueNoise2 } from './random.js';
import { drawWorld } from './render.js';
import { drawHud, drawCockpit } from './cockpit.js';
import { renderShot } from './shots.js';

const W = VIEW.width;
const H = VIEW.height;
const DEG = Math.PI / 180;
const KT_PER_MS = 1.94384;
const MAX_FRAME = 0.25;

const params = new URLSearchParams(window.location.search);
const shotName = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : 20261126;

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext('2d');

// Canvas is fixed at VIEW resolution and CSS-scaled to fit the window,
// keeping aspect (letterboxed by the translate-centred fixed position).
function fitCanvas() {
  const s = Math.min(window.innerWidth / W, window.innerHeight / H);
  canvas.style.width = `${Math.round(W * s)}px`;
  canvas.style.height = `${Math.round(H * s)}px`;
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// --- small helpers -------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function clock(sec) {
  const t = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function rr(x, y, w, h, r = 8) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function plate(x, y, w, h, fill = 'rgba(10,12,16,0.88)', stroke = 'rgba(255,255,255,0.14)') {
  ctx.fillStyle = fill;
  rr(x, y, w, h);
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function text(str, x, y, font, color, align = 'center', baseline = 'middle') {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(str, x, y);
}

function wrapText(str, maxChars) {
  const words = String(str).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (t.length > maxChars && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

const FONT_TITLE = 'bold 68px system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_H2 = 'bold 30px system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_BODY = '15px system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_SMALL = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_MONO = 'bold 15px ui-monospace, Menlo, Consolas, monospace';
const AMBER = '#ffd76a';
const INK = '#e8edf2';
const DIM = 'rgba(232,237,242,0.55)';

// Compass point the wind is coming FROM, for the briefing wind note.
function windNote(m) {
  const w = (m && m.wind) || { x: 0, z: 0, gust: 0 };
  const spd = Math.hypot(w.x, w.z);
  if (spd < 0.5) return 'Wind: calm.';
  const toward = (Math.atan2(w.x, -w.z) / DEG + 360) % 360;
  const from = (toward + 180) % 360;
  const card = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(from / 45) % 8];
  const gust = w.gust > 2 ? ' — gusty' : '';
  return `Wind: ${Math.round(spd)} m/s from the ${card}${gust}.`;
}

function ringsDoneCount(s) {
  return s.rings.reduce((n, r) => n + (r.status === 'done' ? 1 : 0), 0);
}

function cratesLandedCount(s) {
  return s.crates.reduce((n, c) => n + (c.landed ? 1 : 0), 0);
}

function crashName(c) {
  return c === 'water' ? 'WATER' : c === 'stall' ? 'STALL' : 'TERRAIN';
}

// --- campaign progress (localStorage, tolerant of missing/corrupt data) ---------

function defaultProgress() {
  return { unlocked: 1, stars: {}, scores: {}, freeBest: 0 };
}

function loadProgress() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(BEST_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return defaultProgress();
    const p = defaultProgress();
    p.unlocked = clamp(Math.floor(Number(raw.unlocked)) || 1, 1, MISSIONS.length);
    for (const m of MISSIONS) {
      const st = Math.floor(Number(raw.stars && raw.stars[m.id]));
      if (st >= 1 && st <= 3) p.stars[m.id] = st;
      const sc = Number(raw.scores && raw.scores[m.id]);
      if (Number.isFinite(sc) && sc > 0) p.scores[m.id] = Math.floor(sc);
    }
    const fb = Number(raw.freeBest);
    if (Number.isFinite(fb) && fb > 0) p.freeBest = fb;
    return p;
  } catch {
    return defaultProgress();
  }
}

function saveProgress(p) {
  try {
    window.localStorage.setItem(BEST_KEY, JSON.stringify(p));
  } catch {
    // Storage unavailable (private mode etc.) — progress lasts this visit only.
  }
}

// --- title-screen cinematic plane ----------------------------------------------
// A scratch plane state posed directly each frame: a gentle banked circle
// over Kestrel Isle at 120 m, heading rotating slowly, throttle 0.6.

const cine = createPlane(RUNWAYS[0]);
poseCine(cine, { airborne: true, alt: 120, speed: 52, throttle: 0.6, fuel: 90 });
let cineA = 0;
let cineT = 0;

function poseCine(p, fields) {
  Object.assign(p, fields);
  return p;
}

function stepCinematic(dt) {
  cineT += dt;
  const r = 430;
  cineA += (cine.speed / r) * dt;
  cine.x = Math.sin(cineA) * r;
  cine.z = Math.cos(cineA) * r;
  const dx = Math.cos(cineA);
  const dz = -Math.sin(cineA);
  cine.headingDeg = (Math.atan2(dx, -dz) / DEG + 360) % 360;
  cine.bankDeg = -20;
  cine.pitchDeg = 2;
  cine.airborne = true;
  cine.throttle = 0.6;
  cine.speed = 52;
  cine.fuel = 90;
  cine.damage = 0;
  cine.stalled = false;
}

function cineWorld() {
  return {
    plane: cine,
    paletteName: 'noon',
    rings: [],
    crates: [],
    target: null,
    weather: {},
    timeSec: cineT,
  };
}

// --- audio + extra menu keys ----------------------------------------------------

const audio = createAudio();
const menu = { escape: false, free: false, click: false };
window.addEventListener('keydown', (e) => {
  audio.unlock();
  if (e.code === 'Escape') menu.escape = true;
  else if (e.code === 'KeyF') menu.free = true;
});
canvas.addEventListener('pointerdown', () => {
  audio.unlock();
  menu.click = true;
});

// --- the game -------------------------------------------------------------------

function runGame() {
  const input = createInput(window);
  input.attach();
  const progress = loadProgress();

  let screen = 'title';   // 'title' | 'brief' | 'play' | 'debrief' | 'end'
  let paused = false;
  let missionSel = clamp(progress.unlocked, 1, MISSIONS.length) - 1;
  let activeMission = missionSel;
  let freeFlight = false;
  let sortie = null;      // live sortie (mission) or free-flight wrapper
  let endTimer = 0;       // >0: brief banner delay before debrief
  let accumulator = 0;
  let last = performance.now();
  let menuTime = 0;
  let navCooldown = 0;
  let lastObjective = '';
  let statusAt = 0;
  let progressSaved = false;

  function announce(text, force = false) {
    const now = performance.now();
    if (force || now - statusAt > 1000) {
      statusEl.textContent = text;
      statusAt = now;
    }
  }

  // --- sortie lifecycle ---------------------------------------------------------

  function createMissionSortie(i) {
    return createSortie(i, seed + i * 7919);
  }

  function createFreeSortie() {
    const s = createSortie(0, seed);
    s.mission = {
      id: 'free-flight', name: 'FREE FLIGHT', story: '', goal: '',
      palette: 'noon', wind: { x: 1.5, z: 0.5, gust: 1.4 },
      parTimeSec: 0, startRunwayIndex: 0, targetRunwayIndex: 0,
      rings: [], objectives: [], cratesCarried: 0, cratesTotal: 0,
    };
    s.rings = [];
    s.crates = [];
    s.cratesCarried = 0;
    s.cratesTotal = 0;
    s.orbitDeg = 0;
    s.orbitDone = false;
    s.timerSec = 0;
    s.message = null;
    s.messageT = 0;
    s.env = { windX: 0, windZ: 0, gustX: 0, gustZ: 0 };
    s.results = null;
    s.status = 'flying';
    return s;
  }

  function startMission() {
    activeMission = missionSel;
    freeFlight = false;
    sortie = createMissionSortie(activeMission);
    endTimer = 0;
    paused = false;
    progressSaved = false;
    lastObjective = '';
    screen = 'play';
    accumulator = 0;
    announce(`Sortie ${activeMission + 1}: ${MISSIONS[activeMission].name}.`, true);
  }

  function startFree() {
    freeFlight = true;
    sortie = createFreeSortie();
    endTimer = 0;
    paused = false;
    progressSaved = false;
    lastObjective = '';
    screen = 'play';
    accumulator = 0;
    announce('Free flight. Land anywhere to finish.', true);
  }

  function retrySortie() {
    if (freeFlight) {
      sortie = createFreeSortie();
      announce('Free flight restarted.', true);
    } else {
      sortie = createMissionSortie(activeMission);
      announce(`${MISSIONS[activeMission].name} restarted.`, true);
    }
    endTimer = 0;
    paused = false;
    accumulator = 0;
    lastObjective = '';
  }

  function beginEnd() {
    if (endTimer > 0) return;
    endTimer = 1.9; // beat to show the touchdown/crash banner
    if (!progressSaved) {
      progressSaved = true;
      saveDebriefProgress();
    }
  }

  function saveDebriefProgress() {
    const r = sortie && sortie.results;
    if (!r) return;
    if (freeFlight) {
      if (r.success && (!progress.freeBest || r.timeSec < progress.freeBest)) {
        progress.freeBest = Math.round(r.timeSec);
        saveProgress(progress);
      }
      return;
    }
    if (!r.success) return;
    const m = sortie.mission;
    const idx = MISSIONS.indexOf(m);
    progress.unlocked = Math.max(progress.unlocked, Math.min(MISSIONS.length, idx + 2));
    progress.stars[m.id] = Math.max(progress.stars[m.id] || 0, r.stars || 0);
    progress.scores[m.id] = Math.max(progress.scores[m.id] || 0, r.score || 0);
    saveProgress(progress);
  }

  function goDebrief() {
    screen = 'debrief';
    const r = sortie.results;
    announce(freeFlight
      ? (r && r.success ? `Landed. Time ${clock(r.timeSec)}.` : 'Crashed.')
      : (r && r.success ? `${sortie.mission.name} complete. Score ${r.score}.` : 'Sortie lost.'), true);
  }

  function nextAfterDebrief() {
    if (freeFlight || activeMission >= MISSIONS.length - 1) {
      if (!freeFlight && activeMission >= MISSIONS.length - 1) {
        screen = 'end';
        announce('Campaign complete. All five sorties flown.', true);
        return;
      }
      screen = 'title';
      announce('Back to title.', true);
      return;
    }
    missionSel = activeMission + 1;
    screen = 'brief';
    announce(`Briefing: ${MISSIONS[missionSel].name}.`, true);
  }

  // --- free-flight sim + view -----------------------------------------------------

  function freeEnv(t) {
    const w = { x: 1.5, z: 0.5, gust: 1.4 };
    return {
      windX: w.x,
      windZ: w.z,
      gustX: (valueNoise2(t * 0.8, 17.3, 1, 777) - 0.5) * 2 * w.gust,
      gustZ: (valueNoise2(t * 0.63, 91.7, 1, 778) - 0.5) * 2 * w.gust,
    };
  }

  function stepFree(dt) {
    const p = sortie.plane;
    const ev = stepPlane(p, input, dt, freeEnv(sortie.timerSec));
    sortie.timerSec += dt;
    if (sortie.messageT > 0) sortie.messageT = Math.max(0, sortie.messageT - dt);
    if (ev.touchedDown) {
      sortie.message = `TOUCHDOWN — ${ev.touchedDown}`;
      sortie.messageT = 3;
      audio.thud(ev.touchedDown === 'HARD' ? 1 : ev.touchedDown === 'ROUGH' ? 0.8 : 0.5);
      sortie.results = {
        success: true, timeSec: sortie.timerSec,
        landingGrade: ev.touchedDown, fuelLeft: p.fuel,
        damage: p.damage, free: true,
      };
      sortie.status = 'complete';
      beginEnd();
    } else if (ev.crashed || p.crashed) {
      const kind = p.crashed || ev.crashed || 'terrain';
      sortie.message = `CRASHED — ${crashName(kind)}`;
      sortie.messageT = 3;
      audio.chime('bad');
      audio.thud(1);
      sortie.results = {
        success: false, timeSec: sortie.timerSec,
        landingGrade: null, fuelLeft: p.fuel,
        damage: p.damage, crash: kind, free: true,
      };
      sortie.status = 'crashed';
      beginEnd();
    }
  }

  function freeView() {
    const p = sortie.plane;
    const t = sortie.timerSec;
    const env = freeEnv(t);
    const wx = env.windX + env.gustX;
    const wz = env.windZ + env.gustZ;
    const windDeg = (Math.atan2(wx, -wz) / DEG + 360) % 360;
    const gustMag = Math.hypot(env.gustX, env.gustZ);
    return {
      world: {
        plane: p,
        paletteName: 'noon',
        rings: [],
        crates: [],
        target: null,
        weather: { rain: 0, shake: clamp(gustMag / 9, 0, 1) },
        timeSec: t,
      },
      hud: {
        objectiveText: 'FREE FLIGHT — LAND ANYWHERE',
        subText: 'No mail, no marks. Just fly.',
        progressText: clock(t),
        message: sortie.message,
        messageT: sortie.messageT,
        score: 0,
        timeSec: t,
        windDeg,
        paletteName: 'noon',
      },
    };
  }

  // --- mission sim step with audio events -----------------------------------------

  function stepMission(dt) {
    const s = sortie;
    const before = {
      rings: ringsDoneCount(s),
      landed: cratesLandedCount(s),
      carried: s.cratesCarried,
      orbit: s.orbitDone,
      status: s.status,
      air: s.plane.airborne,
    };
    stepSortie(s, input, dt);
    const p = s.plane;

    if (ringsDoneCount(s) > before.rings) audio.chime('ring');
    if (cratesLandedCount(s) > before.landed) audio.chime('good');
    if (s.cratesCarried < before.carried) audio.chime('drop');
    if (s.orbitDone && !before.orbit) audio.chime('good');
    if (before.air && !p.airborne && p.landed) {
      audio.thud(p.landed === 'HARD' ? 1 : p.landed === 'ROUGH' ? 0.8 : 0.5);
    }
    if (s.status !== before.status) {
      if (s.status === 'complete') {
        audio.chime('good');
        beginEnd();
      } else if (s.status === 'crashed') {
        if (!s.message) s.message = `CRASHED — ${crashName(p.crashed || 'terrain')}`;
        audio.chime('bad');
        audio.thud(1);
        beginEnd();
      }
    }
  }

  // --- drawing ---------------------------------------------------------------------

  function drawTitle() {
    drawWorld(ctx, cineWorld());

    text('KESTREL POST', W / 2, 96, FONT_TITLE, '#ffffff');
    text('Sky mail over the Amber Isles', W / 2, 152, 'italic 20px system-ui, sans-serif', DIM);

    // Campaign strip: five sorties with earned stars, selected highlighted.
    const px = W / 2 - 320, py = 196, pw = 640, rowH = 46;
    plate(px, py, pw, rowH * MISSIONS.length + 26, 'rgba(10,12,16,0.72)');
    for (let i = 0; i < MISSIONS.length; i += 1) {
      const m = MISSIONS[i];
      const y = py + 20 + i * rowH;
      const locked = i >= progress.unlocked;
      const sel = i === missionSel && !locked;
      if (sel) {
        ctx.fillStyle = 'rgba(255,215,106,0.14)';
        rr(px + 8, y - rowH / 2 + 4, pw - 16, rowH - 8, 6);
        ctx.fill();
      }
      const label = `${String(i + 1).padStart(2, '0')}  ${m.name}`;
      text(label, px + 30, y, 'bold 19px system-ui, sans-serif',
        locked ? 'rgba(232,237,242,0.3)' : sel ? AMBER : INK, 'left');
      const stars = progress.stars[m.id] || 0;
      const starTxt = locked ? 'LOCKED' : (stars > 0 ? '★'.repeat(stars) : '—');
      text(starTxt, px + pw - 34, y, 'bold 18px system-ui, sans-serif',
        locked ? 'rgba(232,237,242,0.3)' : AMBER, 'right');
      if (sel) text('▸', px + 14, y, 'bold 18px system-ui, sans-serif', AMBER, 'center');
    }

    text('◄ ► select sortie · ENTER fly · F free flight', W / 2, H - 46, FONT_BODY, INK);
    text('Arrows pitch & bank · W/S throttle · Space drop · P pause · R restart · M mute',
      W / 2, H - 20, FONT_SMALL, DIM);
  }

  function briefWorld() {
    const m = MISSIONS[missionSel];
    const rwy = RUNWAYS[m.startRunwayIndex];
    const p = createPlane(rwy);
    return {
      plane: p,
      paletteName: m.palette,
      rings: m.rings.map(([x, z, alt], i) => ({
        x, z, alt, radius: m.ringRadius || 26, status: i === 0 ? 'next' : 'todo',
      })),
      crates: [],
      target: null,
      weather: {},
      timeSec: menuTime,
    };
  }

  function drawBrief() {
    const m = MISSIONS[missionSel];
    drawWorld(ctx, briefWorld());
    ctx.fillStyle = 'rgba(5,7,10,0.55)';
    ctx.fillRect(0, 0, W, H);

    const pw = 780, ph = 560;
    const px = W / 2 - pw / 2, py = H / 2 - ph / 2;
    plate(px, py, pw, ph);

    let y = py + 46;
    text('SORTIE BRIEFING', px + 40, y, FONT_SMALL, AMBER, 'left');
    y += 40;
    text(m.name, px + 40, y, FONT_H2, INK, 'left');
    y += 34;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(px + 40, y);
    ctx.lineTo(px + pw - 40, y);
    ctx.stroke();
    y += 22;

    for (const line of wrapText(m.story, 92)) {
      text(line, px + 40, y, FONT_BODY, 'rgba(232,237,242,0.85)', 'left');
      y += 22;
    }
    y += 8;
    text(`GOAL — ${m.goal}`, px + 40, y, FONT_BODY, AMBER, 'left');
    y += 30;
    text(`PAR TIME — ${clock(m.parTimeSec)}    ${windNote(m).toUpperCase()}`, px + 40, y, FONT_SMALL, DIM, 'left');
    y += 26;
    text('CONTROLS — Arrows pitch & bank · W/S throttle · Space drop · P pause · R restart', px + 40, y, FONT_SMALL, DIM, 'left');
    y += 40;
    text('ENTER — FLY    ESC — BACK', px + pw / 2, y, FONT_BODY, INK);
  }

  function drawDebrief() {
    const v = freeFlight ? freeView() : viewFor(sortie);
    const p = sortie.plane;
    drawWorld(ctx, v.world);
    drawHud(ctx, p, v.hud);
    drawCockpit(ctx, p, v.hud);
    ctx.fillStyle = 'rgba(5,7,10,0.55)';
    ctx.fillRect(0, 0, W, H);

    const r = sortie.results || {};
    const pw = 640, ph = 470;
    const px = W / 2 - pw / 2, py = H / 2 - ph / 2;
    plate(px, py, pw, ph);

    let y = py + 44;
    const ok = !!r.success;
    text(freeFlight ? (ok ? 'TOUCHDOWN' : 'CRASHED')
      : (ok ? 'MAIL DELIVERED' : 'SORTIE LOST'),
      px + pw / 2, y, FONT_H2, ok ? AMBER : '#e0483a');
    y += 36;
    if (!freeFlight) text(sortie.mission.name, px + pw / 2, y, FONT_BODY, DIM);
    y += freeFlight ? 20 : 34;

    const rows = [];
    rows.push(['TIME', clock(r.timeSec)]);
    if (!freeFlight) rows.push(['FUEL LEFT', `${Math.round(r.fuelLeft || 0)}%`]);
    rows.push(['LANDING', r.landingGrade || (r.crash || p.crashed ? crashName(r.crash || p.crashed) : '—')]);
    if (!freeFlight) {
      const m = sortie.mission;
      if (m.objectives.includes('rings')) rows.push(['RINGS', `${r.ringsDone || 0}/${sortie.rings.length}`]);
      if (m.objectives.includes('drop')) rows.push(['DROPS', `+${r.dropPoints || 0}`]);
      if (m.objectives.includes('orbit')) rows.push(['ORBIT', r.success ? '360°' : `${Math.floor(sortie.orbitDeg)}°`]);
      rows.push(['DAMAGE', `${Math.round(p.damage || 0)}%`]);
    }
    for (const [k, v2] of rows) {
      text(k, px + 80, y, FONT_SMALL, DIM, 'left');
      text(String(v2), px + pw - 80, y, FONT_MONO, INK, 'right');
      y += 30;
    }
    y += 8;

    if (!freeFlight) {
      text(`SCORE  ${r.score || 0}`, px + pw / 2, y, 'bold 44px ui-monospace, Menlo, Consolas, monospace', AMBER);
      y += 58;
      const stars = r.stars || 0;
      let starLine = '';
      for (let i = 0; i < 3; i += 1) starLine += i < stars ? '★' : '☆';
      text(starLine, px + pw / 2, y, 'bold 34px system-ui, sans-serif', AMBER);
      y += 48;
    } else if (r.success && progress.freeBest) {
      text(`BEST FREE FLIGHT — ${clock(progress.freeBest)}`, px + pw / 2, y, FONT_SMALL, DIM);
      y += 40;
    }

    text('ENTER — NEXT · R — RETRY · ESC — TITLE', px + pw / 2, py + ph - 34, FONT_SMALL, DIM);
  }

  function drawEnd() {
    drawWorld(ctx, cineWorld());
    ctx.fillStyle = 'rgba(5,7,10,0.6)';
    ctx.fillRect(0, 0, W, H);

    const totalStars = MISSIONS.reduce((n, m) => n + (progress.stars[m.id] || 0), 0);
    const pw = 720, ph = 520;
    const px = W / 2 - pw / 2, py = H / 2 - ph / 2;
    plate(px, py, pw, ph);

    let y = py + 44;
    text('ALL MAIL DELIVERED', px + pw / 2, y, FONT_H2, AMBER);
    y += 34;
    text(`CAMPAIGN COMPLETE — ${totalStars} / ${MISSIONS.length * 3} STARS`, px + pw / 2, y, FONT_BODY, INK);
    y += 44;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(px + 50, y);
    ctx.lineTo(px + pw - 50, y);
    ctx.stroke();
    y += 30;

    for (const m of MISSIONS) {
      const stars = progress.stars[m.id] || 0;
      const score = progress.scores[m.id];
      const starTxt = stars > 0 ? '★'.repeat(stars) : '—';
      const right = score ? `BEST ${score.toLocaleString('en-US')}` : 'UNFLOWN';
      text(`${m.name}`, px + 60, y, FONT_SMALL, INK, 'left');
      text(starTxt, px + pw / 2 - 60, y, 'bold 16px system-ui, sans-serif', AMBER, 'right');
      text(right, px + pw - 60, y, FONT_MONO, DIM, 'right');
      y += 34;
    }
    y += 26;
    text('ENTER — TITLE', px + pw / 2, y, FONT_BODY, INK);
  }

  function drawPlay() {
    const v = freeFlight ? freeView() : viewFor(sortie);
    const p = sortie.plane;
    drawWorld(ctx, v.world);
    drawHud(ctx, p, v.hud);
    drawCockpit(ctx, p, v.hud);
    if (paused) {
      ctx.fillStyle = 'rgba(5,7,10,0.55)';
      ctx.fillRect(0, 0, W, H);
      plate(W / 2 - 160, H / 2 - 60, 320, 120);
      text('PAUSED', W / 2, H / 2 - 18, FONT_H2, INK);
      text('P / ENTER — RESUME', W / 2, H / 2 + 26, FONT_SMALL, DIM);
    }
  }

  function draw() {
    if (screen === 'title') drawTitle();
    else if (screen === 'brief') drawBrief();
    else if (screen === 'play') drawPlay();
    else if (screen === 'debrief') drawDebrief();
    else if (screen === 'end') drawEnd();
  }

  // --- input handling --------------------------------------------------------------

  function handleKeys(dt) {
    const confirm = input.pressed.has('confirm') || menu.click;
    const esc = menu.escape;
    const freeKey = menu.free;
    const pauseKey = input.pressed.has('pause');
    const restartKey = input.pressed.has('restart');
    if (input.pressed.has('mute')) audio.toggleMute();

    if (screen === 'title') {
      navCooldown -= dt;
      let dir = 0;
      if (input.pressed.has('bankLeft')) dir = -1;
      else if (input.pressed.has('bankRight')) dir = 1;
      else if (navCooldown <= 0) {
        if (input.held.has('bankLeft')) { dir = -1; navCooldown = 0.22; }
        else if (input.held.has('bankRight')) { dir = 1; navCooldown = 0.22; }
      }
      if (dir !== 0) {
        const maxSel = clamp(progress.unlocked, 1, MISSIONS.length) - 1;
        missionSel = clamp(missionSel + dir, 0, maxSel);
        navCooldown = 0.22;
      }
      if (confirm) {
        screen = 'brief';
        announce(`Briefing: ${MISSIONS[missionSel].name}.`, true);
      } else if (freeKey) {
        startFree();
      }
    } else if (screen === 'brief') {
      if (confirm) startMission();
      else if (esc) { screen = 'title'; announce('Back to title.', true); }
    } else if (screen === 'play') {
      if (pauseKey && !paused && endTimer <= 0 && sortie.status === 'flying') {
        paused = true;
        announce('Paused.', true);
      } else if ((pauseKey || confirm) && paused) {
        paused = false;
        announce('Playing.', true);
      }
      if (restartKey && !paused && endTimer <= 0) retrySortie();
      if (!paused && endTimer <= 0) {
        accumulator += dt;
        while (accumulator >= STEP && endTimer <= 0) {
          if (freeFlight) stepFree(STEP);
          else stepMission(STEP);
          accumulator -= STEP;
        }
        if (accumulator > STEP * 4) accumulator = STEP * 4;
      } else {
        accumulator = 0;
      }
      if (endTimer > 0) {
        endTimer -= dt;
        if (endTimer <= 0) goDebrief();
      }
    } else if (screen === 'debrief') {
      if (confirm) nextAfterDebrief();
      else if (restartKey) {
        screen = 'play';
        retrySortie();
      } else if (esc) { screen = 'title'; announce('Back to title.', true); }
    } else if (screen === 'end') {
      if (confirm || esc) { screen = 'title'; announce('Back to title.', true); }
    }
  }

  // --- main loop ---------------------------------------------------------------------

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, MAX_FRAME);
    last = now;

    handleKeys(dt);

    if (screen === 'play' && !paused) {
      const v = freeFlight ? freeView() : viewFor(sortie);
      const obj = v.hud.objectiveText || '';
      if (obj !== lastObjective) {
        lastObjective = obj;
        announce(obj, false);
      }
      const p = sortie.plane;
      audio.setEngine({
        throttle: p.throttle,
        speedKt: p.speed * KT_PER_MS,
        stalled: !!p.stalled,
      });
    } else if (screen === 'title') {
      audio.setEngine({ throttle: cine.throttle, speedKt: cine.speed * KT_PER_MS, stalled: false });
    } else {
      audio.setEngine({ throttle: 0, speedKt: 0, stalled: false });
    }

    if (screen === 'title') {
      stepCinematic(dt);
    } else if (screen !== 'play') {
      menuTime += dt;
    }

    draw();

    input.consumeFrame();
    menu.escape = false;
    menu.free = false;
    menu.click = false;
    if (!window.__kestrelReady) window.__kestrelReady = true;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && screen === 'play' && !paused && endTimer <= 0) {
      paused = true;
      announce('Paused.', true);
    }
  });

  announce('KESTREL POST. Select a sortie.', true);
  requestAnimationFrame(frame);
}

// --- boot ----------------------------------------------------------------------------

if (shotName !== null) {
  renderShot(ctx, shotName, seed);
  window.__kestrelReady = true;
} else {
  runGame();
}
