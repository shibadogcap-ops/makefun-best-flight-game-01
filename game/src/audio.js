// audio.js — generated WebAudio for KESTREL POST. No samples, no network:
// the engine hum, wind rush, prop pulse, chimes, thuds and stall alarm are
// all oscillators and filtered noise built at unlock() time.
//
// Everything no-ops safely before unlock() (or when AudioContext is
// unavailable, e.g. a headless import), so callers never need to guard.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createAudio() {
  const AC = typeof AudioContext !== 'undefined' ? AudioContext
    : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);

  let ctx = null;
  let master = null;
  let engineOsc = null, engineFilter = null, engineGain = null, propLfo = null;
  let windSrc = null, windFilter = null, windGain = null;
  let alarmOsc = null, alarmGain = null, alarmLfo = null, alarmDepth = null;
  let noiseBuf = null;
  let muted = false;
  let unlocked = false;

  function makeNoiseBuffer() {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let s = 1234567;
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    return buf;
  }

  // unlock() — call from a user gesture. Builds the whole graph once.
  function unlock() {
    if (unlocked || !AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);

      noiseBuf = makeNoiseBuffer();

      // Engine: sawtooth -> lowpass -> gain. Quiet by default.
      engineOsc = ctx.createOscillator();
      engineOsc.type = 'sawtooth';
      engineOsc.frequency.value = 60;
      engineFilter = ctx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 500;
      engineFilter.Q.value = 1.2;
      engineGain = ctx.createGain();
      engineGain.gain.value = 0.04;
      engineOsc.connect(engineFilter);
      engineFilter.connect(engineGain);
      engineGain.connect(master);
      engineOsc.start();

      // Prop pulse: square LFO wobbling the engine gain.
      propLfo = ctx.createOscillator();
      propLfo.type = 'square';
      propLfo.frequency.value = 14;
      const propDepth = ctx.createGain();
      propDepth.gain.value = 0.012;
      propLfo.connect(propDepth);
      propDepth.connect(engineGain.gain);
      propLfo.start();

      // Wind: looped noise -> bandpass -> gain by airspeed.
      windSrc = ctx.createBufferSource();
      windSrc.buffer = noiseBuf;
      windSrc.loop = true;
      windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 600;
      windFilter.Q.value = 0.6;
      windGain = ctx.createGain();
      windGain.gain.value = 0;
      windSrc.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);
      windSrc.start();

      // Stall alarm: gated square beep.
      alarmOsc = ctx.createOscillator();
      alarmOsc.type = 'square';
      alarmOsc.frequency.value = 880;
      alarmGain = ctx.createGain();
      alarmGain.gain.value = 0;
      alarmLfo = ctx.createOscillator();
      alarmLfo.type = 'square';
      alarmLfo.frequency.value = 3.2; // ~3 beeps per second
      alarmDepth = ctx.createGain();
      alarmDepth.gain.value = 0.03;
      alarmLfo.connect(alarmDepth);
      alarmDepth.connect(alarmGain.gain);
      alarmOsc.connect(alarmGain);
      alarmGain.connect(master);
      alarmOsc.start();
      alarmLfo.start();

      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      unlocked = true;
    } catch (e) {
      ctx = null;
      master = null;
      unlocked = false;
    }
  }

  function now() {
    return ctx ? ctx.currentTime : 0;
  }

  // setEngine({ throttle, speedKt, stalled }) — smooth param updates.
  function setEngine({ throttle = 0, speedKt = 0, stalled = false } = {}) {
    if (!ctx) return;
    const t = clamp(throttle, 0, 1);
    const t0 = now();
    engineOsc.frequency.setTargetAtTime(55 + t * 75, t0, 0.12);
    engineFilter.frequency.setTargetAtTime(400 + t * 900, t0, 0.15);
    engineGain.gain.setTargetAtTime(0.02 + t * 0.05, t0, 0.15);
    const propRate = 11 + t * 14; // prop buzz rises with throttle
    if (propLfo) propLfo.frequency.setTargetAtTime(propRate, t0, 0.2);
    windGain.gain.setTargetAtTime(clamp(speedKt / 220, 0, 0.09), t0, 0.2);
    windFilter.frequency.setTargetAtTime(350 + speedKt * 5, t0, 0.2);
    setAlarm(!!stalled);
  }

  // One enveloped oscillator note.
  function tone(freq, when, dur, type, vol, dest) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    o.connect(g);
    g.connect(dest || master);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  // chime(kind): 'ring' | 'drop' | 'good' | 'bad'.
  function chime(kind) {
    if (!ctx) return;
    const t0 = now() + 0.02;
    if (kind === 'ring') {
      tone(1318.5, t0, 0.5, 'sine', 0.16);        // E6
      tone(1760.0, t0 + 0.09, 0.6, 'sine', 0.14); // A6
    } else if (kind === 'drop') {
      tone(659.3, t0, 0.4, 'sine', 0.15);         // E5
      tone(987.8, t0 + 0.08, 0.5, 'sine', 0.12);  // B5
    } else if (kind === 'good') {
      // Rising triad.
      tone(1046.5, t0, 0.35, 'sine', 0.14);       // C6
      tone(1318.5, t0 + 0.09, 0.35, 'sine', 0.14);// E6
      tone(1568.0, t0 + 0.18, 0.55, 'sine', 0.15);// G6
    } else {
      // 'bad' — low buzzer.
      tone(146.8, t0, 0.5, 'sawtooth', 0.12);     // D3
      tone(110.0, t0 + 0.05, 0.6, 'sawtooth', 0.1);
    }
  }

  // thud(strength) — filtered noise burst for landings/crashes.
  let thudCount = 0;
  function thud(strength = 1) {
    if (!ctx || !noiseBuf) return;
    const s = clamp(strength, 0, 1);
    const t0 = now();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 180 + s * 220;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4 * s, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t0, (thudCount++ * 0.37) % 1.5, 0.35);
  }

  function setAlarm(on) {
    if (!ctx || !alarmGain) return;
    alarmGain.gain.setTargetAtTime(on ? 0.035 : 0, now(), 0.05);
  }

  function toggleMute() {
    muted = !muted;
    if (ctx && master) {
      master.gain.setTargetAtTime(muted ? 0 : 0.9, now(), 0.03);
    }
    return muted;
  }

  function isMuted() {
    return muted;
  }

  return { unlock, setEngine, chime, thud, setAlarm, toggleMute, isMuted };
}
