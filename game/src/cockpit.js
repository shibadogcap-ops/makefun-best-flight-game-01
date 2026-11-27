// cockpit.js — the lit instrument panel + HUD for KESTREL POST.
// drawCockpit paints the panel strip y=524..720 (artificial horizon,
// altimeter, airspeed, VSI, compass ribbon, fuel, throttle, warning lamps,
// mission clock/score plate). drawHud paints the floating readouts over the
// 3D view. All displayed numbers come from hudValues(plane) in flight.js.

import { VIEW, PALETTES, PLANE } from './config.js';
import { hudValues } from './flight.js';

const DEG = Math.PI / 180;
const W = VIEW.width;
const PANEL_Y = 524;
const PANEL_H = VIEW.height - PANEL_Y; // 196

const FONT = 'bold 13px system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_SM = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
const FONT_MONO = 'bold 14px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
const FONT_BIG = 'bold 40px system-ui, -apple-system, "Segoe UI", sans-serif';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const TAU = Math.PI * 2;

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const c = rgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function mixHex(a, b, t) {
  const A = rgb(a), B = rgb(b);
  const g = (i) => Math.round(A[i] + (B[i] - A[i]) * t);
  return `rgb(${g(0)},${g(1)},${g(2)})`;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pad3 = (n) => String(((Math.round(n) % 360) + 360) % 360).padStart(3, '0');
function clock(sec) {
  const t = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// angleDeg measured clockwise from 12 o'clock -> canvas point on a dial.
function polar(cx, cy, r, angDeg) {
  const a = angDeg * DEG;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

// --- panel chrome -------------------------------------------------------------

function drawPanel(ctx, pal) {
  const P = pal.panel;
  const g = ctx.createLinearGradient(0, PANEL_Y, 0, VIEW.height);
  g.addColorStop(0, mixHex(P, '#000000', 0.12));
  g.addColorStop(0.12, P);
  g.addColorStop(1, mixHex(P, '#000000', 0.3));
  ctx.fillStyle = g;
  ctx.fillRect(0, PANEL_Y, W, PANEL_H);
  // Top edge highlight + bottom shadow.
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(0, PANEL_Y, W, 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, VIEW.height - 3, W, 3);
  // Corner screws.
  ctx.fillStyle = '#4a473f';
  for (const [sx, sy] of [[16, PANEL_Y + 14], [W - 16, PANEL_Y + 14], [16, VIEW.height - 14], [W - 16, VIEW.height - 14]]) {
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx - 2.4, sy);
    ctx.lineTo(sx + 2.4, sy);
    ctx.stroke();
  }
}

// Generic round gauge bezel + face.
function dial(ctx, cx, cy, r, pal) {
  ctx.fillStyle = '#3a372f';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#10141a';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.stroke();
}

// Tick ring helper: ticks every `step` deg of sweep, labels optional.
function ticks(ctx, cx, cy, r0, r1, count, startDeg, sweepDeg, labelFn) {
  ctx.strokeStyle = '#c9d2da';
  ctx.fillStyle = '#c9d2da';
  ctx.font = FONT_SM;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= count; i++) {
    const a = startDeg + (i / count) * sweepDeg;
    const major = labelFn ? labelFn(i) !== null : i % 5 === 0;
    const [x0, y0] = polar(cx, cy, r0, a);
    const [x1, y1] = polar(cx, cy, major ? r1 : r1 + 4, a);
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    if (major && labelFn) {
      const lbl = labelFn(i);
      if (lbl !== null) {
        const [lx, ly] = polar(cx, cy, r0 - 13, a);
        ctx.fillText(lbl, lx, ly);
      }
    }
  }
}

function needle(ctx, cx, cy, angDeg, len, color, w = 3) {
  const [x, y] = polar(cx, cy, len, angDeg);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - Math.sin(angDeg * DEG) * 8, cy + Math.cos(angDeg * DEG) * 8);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, 4.5, 0, TAU);
  ctx.fill();
}

// --- instruments ---------------------------------------------------------------

// 1. Artificial horizon.
function drawAttitude(ctx, cx, cy, plane, pal) {
  const r = 62;
  dial(ctx, cx, cy, r + 4, pal);
  const faceR = r;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, faceR, 0, TAU);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-(plane.bankDeg || 0) * DEG);
  const PPD = 2.4; // px per degree of pitch
  ctx.translate(0, clamp(plane.pitchDeg || 0, -30, 30) * PPD);

  // Sky / ground halves (world-fixed, so they move with pitch + bank).
  ctx.fillStyle = pal.skyTop;
  ctx.fillRect(-90, -90, 180, 180);
  ctx.fillStyle = mixHex(pal.sand, '#000000', 0.15);
  ctx.fillRect(-90, 0, 180, 90);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(-90, -1.5, 180, 3);

  // Pitch ladder at +-10 / +-20 deg.
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 2;
  for (const a of [20, 10, -10, -20]) {
    const y = -a * PPD;
    ctx.beginPath();
    ctx.moveTo(-24, y);
    ctx.lineTo(-10, y);
    ctx.moveTo(10, y);
    ctx.lineTo(24, y);
    ctx.stroke();
  }
  ctx.restore();

  // Fixed aircraft symbol.
  ctx.strokeStyle = '#f2f5f7';
  ctx.fillStyle = '#f2f5f7';
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - 22, cy);
  ctx.lineTo(cx - 8, cy);
  ctx.moveTo(cx + 8, cy);
  ctx.lineTo(cx + 22, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 3.4, 0, TAU);
  ctx.fill();

  // Outer bank ring ticks.
  ctx.strokeStyle = '#c9d2da';
  for (let i = 0; i < 12; i++) {
    const a = i * 30 - 90;
    const [x0, y0] = polar(cx, cy, faceR - 2, a);
    const [x1, y1] = polar(cx, cy, faceR - (i % 3 === 0 ? 9 : 5), a);
    ctx.lineWidth = i % 3 === 0 ? 2.4 : 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
}

// 2. Altimeter: needle over 0..3000 ft + digital readout.
function drawAltimeter(ctx, cx, cy, plane, pal, hv) {
  const r = 46;
  dial(ctx, cx, cy, r + 4, pal);
  ticks(ctx, cx, cy, r - 4, r - 14, 12, -135, 270,
    (i) => (i % 2 === 0 ? String((i / 2) * 5) : null));
  const frac = clamp((hv.altFt % 3000) / 3000, 0, 1);
  needle(ctx, cx, cy, -135 + frac * 270, r - 16, pal.ringNext, 3);
  ctx.fillStyle = '#10141a';
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, TAU);
  ctx.fill();
  // Digital readout under the dial.
  ctx.fillStyle = pal.ring;
  ctx.font = FONT_MONO;
  ctx.textAlign = 'center';
  ctx.fillText(`${fmt(hv.altFt)} FT`, cx, cy + r + 22);
}

// 3. Airspeed: 0..160 kt, green arc, red line at stall.
function drawAirspeed(ctx, cx, cy, plane, pal, hv) {
  const r = 46;
  dial(ctx, cx, cy, r + 4, pal);
  const SW = 270, Z = -135;
  const toAng = (kt) => Z + (kt / 160) * SW;
  // Green arc 55..120 kt.
  ctx.strokeStyle = '#58b368';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 9, toAng(55) * DEG - Math.PI / 2, toAng(120) * DEG - Math.PI / 2);
  ctx.stroke();
  // Red line at stall speed.
  const stallKt = PLANE.stallSpeed * 1.94384;
  const [rx0, ry0] = polar(cx, cy, r - 16, toAng(stallKt));
  const [rx1, ry1] = polar(cx, cy, r - 4, toAng(stallKt));
  ctx.strokeStyle = '#e0483a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(rx0, ry0);
  ctx.lineTo(rx1, ry1);
  ctx.stroke();
  ticks(ctx, cx, cy, r - 4, r - 13, 8, Z, SW,
    (i) => (i % 2 === 0 ? String(i * 20) : null));
  const frac = clamp(hv.spdKt / 160, 0, 1);
  needle(ctx, cx, cy, Z + frac * SW, r - 17, '#f2f5f7', 3);
  ctx.fillStyle = '#10141a';
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, TAU);
  ctx.fill();
  ctx.fillStyle = pal.ring;
  ctx.font = FONT_MONO;
  ctx.textAlign = 'center';
  ctx.fillText(`${fmt(hv.spdKt)} KT`, cx, cy + r + 22);
}

// 4. Vertical speed: slim arc gauge, -2000..+2000 fpm.
function drawVsi(ctx, cx, cy, plane, pal, hv) {
  const r = 42;
  dial(ctx, cx, cy + 8, r + 4, pal);
  // Pivot below the dial; needle sweeps a 140 deg fan.
  const px = cx, py = cy + 34;
  const A0 = 200, A1 = 340; // canvas arc degrees (0 = +x, clockwise)
  const frac = clamp((hv.vsFpm + 2000) / 4000, 0, 1);
  const ang = (A0 + frac * (A1 - A0)) * DEG;
  // Arc ticks.
  ctx.strokeStyle = '#c9d2da';
  ctx.fillStyle = '#c9d2da';
  ctx.font = FONT_SM;
  ctx.textAlign = 'center';
  for (const v of [-2000, -1000, 0, 1000, 2000]) {
    const f = (v + 2000) / 4000;
    const a = (A0 + f * (A1 - A0)) * DEG;
    const [x0, y0] = [px + Math.cos(a) * (r - 8), py + Math.sin(a) * (r - 8)];
    const [x1, y1] = [px + Math.cos(a) * (r - 14), py + Math.sin(a) * (r - 14)];
    ctx.lineWidth = v === 0 ? 2.4 : 1.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    if (v !== 0) {
      ctx.fillText(v > 0 ? `${v / 1000}k` : `${v / 1000}k`,
        px + Math.cos(a) * (r - 24), py + Math.sin(a) * (r - 24));
    }
  }
  // Needle.
  const nx = px + Math.cos(ang) * (r - 10), ny = py + Math.sin(ang) * (r - 10);
  ctx.strokeStyle = pal.ring;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(nx, ny);
  ctx.stroke();
  ctx.fillStyle = pal.ring;
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#c9d2da';
  ctx.font = FONT_SM;
  ctx.fillText('V/S', cx, cy - r - 2);
}

// 5. Compass ribbon across the panel centre-top.
function drawCompass(ctx, plane, pal, info) {
  const x0 = 390, x1 = 890, y0 = PANEL_Y + 12, y1 = PANEL_Y + 48;
  const cx = W / 2;
  const hdg = (plane.headingDeg || 0) % 360;
  const span = 120; // degrees visible

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, x1 - x0, y1 - y0);
  ctx.clip();
  ctx.fillStyle = 'rgba(10,12,15,0.85)';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

  // Ticks + labels for every 10 deg in view, cardinals spelled out.
  const CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  const start = Math.floor((hdg - span / 2) / 10) * 10;
  for (let m = start; m <= hdg + span / 2; m += 10) {
    const rel = ((m - hdg + 540) % 360) - 180;
    if (Math.abs(rel) > span / 2 + 5) continue;
    const sx = cx + (rel / span) * (x1 - x0);
    const norm = ((m % 360) + 360) % 360;
    const cardinal = CARD[norm];
    const isCard = cardinal !== undefined;
    ctx.strokeStyle = isCard ? pal.ring : '#8b95a1';
    ctx.lineWidth = isCard ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(sx, y1);
    ctx.lineTo(sx, y1 - (isCard ? 14 : m % 30 === 0 ? 10 : 6));
    ctx.stroke();
    ctx.fillStyle = isCard ? pal.ring : '#aeb8c2';
    ctx.font = isCard ? 'bold 15px system-ui, sans-serif' : FONT_SM;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lbl = cardinal || (m % 30 === 0 ? pad3(norm) : '');
    if (lbl) ctx.fillText(lbl, sx, y0 + 9);
  }
  ctx.restore();

  // Ribbon frame.
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

  // Current heading box at centre.
  const bw = 74, bh = 26;
  const bx = cx - bw / 2, by = y0 + 5;
  ctx.fillStyle = '#0c0e11';
  ctx.strokeStyle = pal.ringNext;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 4); else ctx.rect(bx, by, bw, bh);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = pal.ring;
  ctx.font = FONT_MONO;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(pad3(hdg), cx, by + bh / 2 + 1);
}

// 6. Fuel: vertical bar E..F.
function drawFuel(ctx, plane, pal, hv, timeSec) {
  const x = 872, y0 = 582, y1 = 690, w = 24;
  const pct = clamp(hv.fuelPct, 0, 100);
  // Bezel + tube.
  ctx.fillStyle = '#3a372f';
  ctx.fillRect(x - 6, y0 - 8, w + 12, y1 - y0 + 16);
  ctx.fillStyle = '#0c0e11';
  ctx.fillRect(x, y0, w, y1 - y0);
  const levelH = ((y1 - y0) * pct) / 100;
  let col = '#58b368';
  let alpha = 1;
  if (pct < 25) col = '#e8a83c';
  if (pct < 12) {
    col = '#e0483a';
    alpha = 0.55 + 0.45 * Math.sin(timeSec * 9);
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = col;
  ctx.fillRect(x + 2, y1 - levelH - 2, w - 4, Math.max(0, levelH));
  ctx.globalAlpha = 1;
  // Level ticks.
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) {
    const ty = y1 - (y1 - y0) * f;
    ctx.beginPath();
    ctx.moveTo(x - 4, ty);
    ctx.lineTo(x, ty);
    ctx.stroke();
  }
  ctx.fillStyle = '#aeb8c2';
  ctx.font = FONT_SM;
  ctx.textAlign = 'center';
  ctx.fillText('F', x + w / 2, y0 - 12);
  ctx.fillText('E', x + w / 2, y1 + 14);
}

// 7. Throttle: vertical quadrant slot with lever knob.
function drawThrottle(ctx, plane, pal) {
  const x = 948, y0 = 596, y1 = 686, w = 30;
  const thr = clamp(plane.throttle || 0, 0, 1);
  ctx.fillStyle = '#3a372f';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - 4, y0 - 10, w + 8, y1 - y0 + 26, 8); else ctx.rect(x - 4, y0 - 10, w + 8, y1 - y0 + 26);
  ctx.fill();
  ctx.fillStyle = '#0c0e11';
  ctx.fillRect(x + 4, y0, w - 8, y1 - y0);
  // Detent ticks.
  ctx.strokeStyle = '#8b95a1';
  ctx.lineWidth = 1.5;
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const ty = y1 - f * (y1 - y0);
    ctx.beginPath();
    ctx.moveTo(x + w - 2, ty);
    ctx.lineTo(x + w + 6, ty);
    ctx.stroke();
  }
  // Lever knob.
  const ky = y1 - thr * (y1 - y0);
  ctx.fillStyle = '#d8d2c4';
  ctx.beginPath();
  ctx.arc(x + w / 2, ky, 9, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#2a2620';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#aeb8c2';
  ctx.font = FONT_SM;
  ctx.textAlign = 'center';
  ctx.fillText('THR', x + w / 2, y0 - 16);
}

// 8. Warning lamps.
function drawLamps(ctx, plane, pal, hv, timeSec) {
  const lamps = [
    { label: 'STALL', cx: 1026, lit: !!plane.stalled, col: '#e0483a', flash: true },
    { label: 'LOW FUEL', cx: 1126, lit: hv.fuelPct < 25, col: '#e8a83c', flash: false },
    { label: 'DAMAGE', cx: 1226, lit: (plane.damage || 0) >= 50, col: '#e0483a', flash: false },
  ];
  for (const l of lamps) {
    const w = 92, h = 44, x = l.cx - w / 2, y = 600;
    let alpha = 1;
    if (l.flash && l.lit) alpha = 0.5 + 0.5 * Math.sin(timeSec * 11);
    ctx.fillStyle = '#3a372f';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - 2, y - 2, w + 4, h + 4, 5); else ctx.rect(x - 2, y - 2, w + 4, h + 4);
    ctx.fill();
    ctx.fillStyle = l.lit ? l.col : '#191712';
    ctx.globalAlpha = l.lit ? alpha : 0.8;
    if (l.lit) { ctx.shadowColor = l.col; ctx.shadowBlur = 14; }
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 4); else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = l.lit ? '#1a140c' : '#5c564a';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(l.label, l.cx, y + h / 2 + 1);
  }
}

// 9. Centre digital plate: mission clock + score. Sits in the gap between
// the VSI dial (right edge ~533) and the fuel gauge (left edge ~866).
function drawClockPlate(ctx, plane, info, pal) {
  const w = 210, h = 60, x = 700 - w / 2, y = 594;
  ctx.fillStyle = '#0c0e11';
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 6); else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#7d8791';
  ctx.font = FONT_SM;
  ctx.fillText('TIME', x + 16, y + 21);
  ctx.fillText('SCORE', x + 16, y + 43);
  ctx.fillStyle = pal.ring;
  ctx.font = FONT_MONO;
  ctx.textAlign = 'right';
  ctx.fillText(clock(info.timeSec), x + w - 16, y + 21);
  ctx.fillText(fmt(info.score || 0), x + w - 16, y + 43);
}

// --- public API ----------------------------------------------------------------

export function drawCockpit(ctx, plane, info = {}) {
  const paletteName = info.paletteName || 'noon';
  const pal = PALETTES[paletteName] || PALETTES.noon;
  const hv = hudValues(plane);
  const timeSec = info.timeSec || 0;

  drawPanel(ctx, pal);

  const ahX = 112, ahY = PANEL_Y + 122;
  drawAttitude(ctx, ahX, ahY, plane, pal);
  drawAltimeter(ctx, 248, ahY, plane, pal, hv);
  drawAirspeed(ctx, 378, ahY, plane, pal, hv);
  drawVsi(ctx, 486, ahY, plane, pal, hv);

  drawCompass(ctx, plane, pal, info);
  drawFuel(ctx, plane, pal, hv, timeSec);
  drawThrottle(ctx, plane, pal);
  drawLamps(ctx, plane, pal, hv, timeSec);
  drawClockPlate(ctx, plane, info, pal);
}

// --- HUD -----------------------------------------------------------------------

function hudPlate(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(10,12,15,0.72)';
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, 5); else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.stroke();
}

export function drawHud(ctx, plane, info = {}) {
  const hv = hudValues(plane);
  const paletteName = info.paletteName || 'noon';
  const pal = PALETTES[paletteName] || PALETTES.noon;

  // Top-left: altitude.
  hudPlate(ctx, 14, 14, 168, 36);
  ctx.fillStyle = '#e8edf2';
  ctx.font = FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`ALT ${fmt(hv.altFt)} FT`, 26, 33);

  // Top-right: speed + heading.
  hudPlate(ctx, W - 196, 14, 182, 64);
  ctx.fillStyle = '#e8edf2';
  ctx.font = FONT;
  ctx.textAlign = 'left';
  ctx.fillText(`SPD ${fmt(hv.spdKt)} KT`, W - 184, 33);
  ctx.fillText(`HDG ${pad3(hv.hdgDeg)}°`, W - 184, 55);

  // Top-centre: three stacked lines — objective, subtext, progress.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 6;
  ctx.font = 'bold 21px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillStyle = '#ffffff';
  if (info.objectiveText) ctx.fillText(info.objectiveText, W / 2, 22);
  ctx.font = FONT_SM;
  ctx.fillStyle = 'rgba(230,236,242,0.85)';
  if (info.subText) ctx.fillText(info.subText, W / 2, 44);
  if (info.progressText) {
    ctx.fillStyle = pal.ringNext;
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillText(info.progressText, W / 2, 66);
  }
  ctx.shadowBlur = 0;

  // Centre-screen transient message, alpha by messageT (seconds remaining).
  if (info.message && (info.messageT === undefined || info.messageT > 0)) {
    const a = clamp(info.messageT === undefined ? 1 : info.messageT, 0, 1);
    ctx.globalAlpha = a;
    ctx.font = FONT_BIG;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(10,10,12,0.8)';
    ctx.strokeText(info.message, W / 2, 292);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(info.message, W / 2, 292);
    ctx.globalAlpha = 1;
  }

  // Wind indicator: arrow shows wind direction relative to the nose.
  if (info.windDeg !== undefined && info.windDeg !== null && plane) {
    const rel = ((info.windDeg - (plane.headingDeg || 0)) % 360 + 360) % 360;
    const wx = W / 2, wy = 96;
    ctx.fillStyle = 'rgba(10,12,15,0.72)';
    ctx.beginPath();
    ctx.arc(wx, wy, 17, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.save();
    ctx.translate(wx, wy);
    ctx.rotate(rel * DEG);
    ctx.fillStyle = '#9fd0e8';
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 5);
    ctx.lineTo(0, 2);
    ctx.lineTo(-6, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(230,236,242,0.8)';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('WIND', wx, wy + 30);
  }
}
