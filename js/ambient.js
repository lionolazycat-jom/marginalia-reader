// Background sounds, synthesized live with the Web Audio API: no audio files, no network,
// nothing to license. Each sound is a small generator; several can play together.

const SOUNDS = {
  rain: { label: 'Rain', note: 'Steady, soft' },
  storm: { label: 'Storm', note: 'Heavy rain, far thunder' },
  wind: { label: 'Wind', note: 'Gusts through trees' },
  ocean: { label: 'Ocean', note: 'Slow waves' },
  fire: { label: 'Fireplace', note: 'Crackling logs' },
  night: { label: 'Night', note: 'Crickets, still air' },
  lofi: { label: 'Lo-fi beat', note: '72 bpm, mellow chords' },
};
export const AMBIENT_SOUNDS = SOUNDS;

let ctx = null, master = null, duckGain = null, pendingMaster = 0.8;
const live = {};          // key -> {gain, stop()}
const buffers = {};
const listeners = new Set();
export const onAmbientChange = (fn) => listeners.add(fn);
const changed = () => listeners.forEach((f) => { try { f(); } catch {} });

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = pendingMaster;
    duckGain = ctx.createGain(); duckGain.gain.value = 1;
    master.connect(duckGain).connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function noise(kind) {
  if (buffers[kind]) return buffers[kind];
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w * 0.5;
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
  }
  buffers[kind] = buf;
  return buf;
}

function loop(kind, dest) {
  const s = ctx.createBufferSource();
  s.buffer = noise(kind); s.loop = true;
  s.loopStart = Math.random(); s.loopEnd = 4;
  s.connect(dest); s.start(0, Math.random() * 3);
  return s;
}
function filter(type, freq, q = 0.7) { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; }
function gain(v) { const g = ctx.createGain(); g.gain.value = v; return g; }
const rand = (a, b) => a + Math.random() * (b - a);

/** A one-shot burst of noise with an envelope (drops, crackles, drums). */
function burst(dest, t, { kind = 'white', dur = 0.02, peak = 0.2, attack = 0.002, type = 'bandpass', freq = 3000, q = 1 }) {
  const s = ctx.createBufferSource(); s.buffer = noise(kind);
  const f = filter(type, freq, q), g = gain(0);
  s.connect(f).connect(g).connect(dest);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
  s.start(t, Math.random() * 3); s.stop(t + attack + dur + 0.05);
}

/** Run fn(time) on a jittered schedule while the sound plays. */
function every(fn, minMs, maxMs) {
  let alive = true, timer;
  const tick = () => { if (!alive) return; fn(ctx.currentTime + 0.05); timer = setTimeout(tick, rand(minMs, maxMs)); };
  timer = setTimeout(tick, rand(0, maxMs));
  return () => { alive = false; clearTimeout(timer); };
}

const BUILD = {
  rain(out) {
    const bed = gain(0.55);
    const src = loop('pink', filter('highpass', 450));
    src.disconnect(); const hp = filter('highpass', 450), lp = filter('lowpass', 7500);
    src.connect(hp).connect(lp).connect(bed).connect(out);
    const drops = gain(0.6); drops.connect(out);
    const stopDrops = every((t) => burst(drops, t, { dur: rand(0.01, 0.04), peak: rand(0.03, 0.14), freq: rand(1800, 5200), q: rand(0.8, 2) }), 25, 90);
    return () => { src.stop(); stopDrops(); };
  },
  storm(out) {
    const stopRain = BUILD.rain(out);
    const heavy = gain(0.5); heavy.connect(out);
    const src = loop('white', filter('lowpass', 3000));
    src.disconnect(); src.connect(filter('lowpass', 2600)).connect(heavy);
    const thunder = gain(1); thunder.connect(out);
    const stopThunder = every((t) => {
      const s = ctx.createBufferSource(); s.buffer = noise('brown');
      const f = filter('lowpass', rand(90, 180), 0.5), g = gain(0);
      s.connect(f).connect(g).connect(thunder);
      const peak = rand(0.5, 1.1), att = rand(0.2, 0.8), dec = rand(3, 7);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + att);
      g.gain.setTargetAtTime(peak * 0.4, t + att, 0.6); g.gain.setTargetAtTime(0.0001, t + att + 1.2, dec / 4);
      s.start(t, rand(0, 3)); s.stop(t + att + dec + 2);
    }, 14000, 38000);
    return () => { stopRain(); src.stop(); stopThunder(); };
  },
  wind(out) {
    const bp = filter('bandpass', 500, 0.6), g = gain(0.4);
    const src = loop('pink', bp); bp.connect(g).connect(out);
    const lp = filter('lowpass', 900), hiss = gain(0.12);
    const src2 = loop('white', lp); lp.connect(hiss).connect(out);
    const stopGusts = every((t) => {
      const d = rand(2.5, 7);
      bp.frequency.cancelScheduledValues(t); bp.frequency.setValueAtTime(bp.frequency.value, t); bp.frequency.linearRampToValueAtTime(rand(260, 1100), t + d);
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(rand(0.15, 0.75), t + d);
      hiss.gain.setValueAtTime(hiss.gain.value, t); hiss.gain.linearRampToValueAtTime(rand(0.04, 0.18), t + d);
    }, 2500, 7000);
    return () => { src.stop(); src2.stop(); stopGusts(); };
  },
  ocean(out) {
    const lp = filter('lowpass', 500, 0.5), g = gain(0.1);
    const src = loop('brown', lp); lp.connect(g).connect(out);
    const foamF = filter('bandpass', 1800, 0.5), foam = gain(0);
    const src2 = loop('pink', foamF); foamF.connect(foam).connect(out);
    const wave = (t) => {
      const rise = rand(3, 4.5), fall = rand(4.5, 7), peak = rand(0.55, 0.95);
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(0.05, g.gain.value), t);
      g.gain.linearRampToValueAtTime(peak, t + rise); g.gain.linearRampToValueAtTime(0.12, t + rise + fall);
      lp.frequency.cancelScheduledValues(t); lp.frequency.setValueAtTime(lp.frequency.value, t);
      lp.frequency.linearRampToValueAtTime(rand(1100, 1600), t + rise); lp.frequency.linearRampToValueAtTime(420, t + rise + fall);
      foam.gain.cancelScheduledValues(t); foam.gain.setValueAtTime(0, t + rise * 0.7);
      foam.gain.linearRampToValueAtTime(peak * 0.22, t + rise + 0.4); foam.gain.linearRampToValueAtTime(0, t + rise + fall * 0.8);
      return (rise + fall) * 1000;
    };
    let alive = true, timer;
    const next = () => { if (!alive) return; timer = setTimeout(next, wave(ctx.currentTime + 0.05) - rand(200, 900)); };
    next();
    return () => { alive = false; clearTimeout(timer); src.stop(); src2.stop(); };
  },
  fire(out) {
    const lp = filter('lowpass', 380), roar = gain(0.5);
    const src = loop('brown', lp); lp.connect(roar).connect(out);
    const crack = gain(1); crack.connect(out);
    const stop1 = every((t) => burst(crack, t, { dur: rand(0.002, 0.012), peak: rand(0.05, 0.35), type: 'highpass', freq: rand(1500, 4000) }), 40, 260);
    const stop2 = every((t) => { for (let i = 0; i < rand(2, 6); i++) burst(crack, t + i * rand(0.01, 0.05), { dur: 0.006, peak: rand(0.2, 0.55), type: 'bandpass', freq: rand(900, 2500), q: 2 }); }, 1500, 5000);
    const stop3 = every((t) => { roar.gain.setValueAtTime(roar.gain.value, t); roar.gain.linearRampToValueAtTime(rand(0.35, 0.65), t + 1.5); }, 1200, 2600);
    return () => { src.stop(); stop1(); stop2(); stop3(); };
  },
  night(out) {
    const lp = filter('lowpass', 300), air = gain(0.18);
    const src = loop('brown', lp); lp.connect(air).connect(out);
    const crickets = [0, 1, 2].map((i) => {
      const freq = [4300, 4750, 5200][i], pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const cg = gain(0.05 + i * 0.01);
      if (pan) { pan.pan.value = [-0.6, 0.5, 0.1][i]; cg.connect(pan).connect(out); } else cg.connect(out);
      return every((t) => {
        const pulses = Math.round(rand(2, 4));
        for (let p = 0; p < pulses; p++) {
          const o = ctx.createOscillator(), g = gain(0);
          o.frequency.value = freq + rand(-40, 40); o.connect(g).connect(cg);
          const s = t + p * 0.045;
          g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(1, s + 0.006); g.gain.linearRampToValueAtTime(0, s + 0.03);
          o.start(s); o.stop(s + 0.04);
        }
      }, 420 + i * 90, 900 + i * 150);
    });
    return () => { src.stop(); crickets.forEach((s) => s()); };
  },
  lofi(out) {
    // An original, simple progression: Fmaj7 – Em7 – Dm7 – Cmaj7, kick/snare/hat at 72 bpm with swing.
    const bpm = 72, step = 60 / bpm / 4;
    const chords = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]];
    const roots = [41, 40, 38, 36];
    const hz = (m) => 440 * 2 ** ((m - 69) / 12);
    const bus = gain(0.8); bus.connect(out);
    const warm = filter('lowpass', 1400, 0.4); warm.connect(bus);
    const vinylF = filter('highpass', 2000), vinyl = gain(0.5); vinylF.connect(vinyl).connect(bus);
    const hiss = loop('pink', filter('bandpass', 5000)); hiss.disconnect(); const hg = gain(0.015); hiss.connect(filter('bandpass', 5500, 0.6)).connect(hg).connect(bus);
    let n = 0, nextT = ctx.currentTime + 0.1;
    const kick = (t) => { const o = ctx.createOscillator(), g = gain(0); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14); o.connect(g).connect(warm); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38); o.start(t); o.stop(t + 0.4); };
    const snare = (t) => { burst(warm, t, { dur: 0.16, peak: 0.28, freq: 1700, q: 0.7, attack: 0.003 }); const o = ctx.createOscillator(), g = gain(0); o.frequency.value = 185; o.connect(g).connect(warm); g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1); o.start(t); o.stop(t + 0.12); };
    const hat = (t, v) => burst(bus, t, { dur: 0.035, peak: v, type: 'highpass', freq: 7500 });
    const pad = (t, notes, dur) => {
      for (const m of notes) for (const det of [-6, 6]) {
        const o = ctx.createOscillator(), g = gain(0);
        o.type = 'triangle'; o.frequency.value = hz(m); o.detune.value = det;
        o.connect(g).connect(warm);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.028, t + 0.35); g.gain.setValueAtTime(0.028, t + dur - 0.4); g.gain.linearRampToValueAtTime(0, t + dur);
        o.start(t); o.stop(t + dur + 0.05);
      }
    };
    const bass = (t, m, dur) => { const o = ctx.createOscillator(), g = gain(0); o.type = 'sine'; o.frequency.value = hz(m); o.connect(g).connect(warm); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.32, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.start(t); o.stop(t + dur + 0.05); };
    const sched = setInterval(() => {
      while (nextT < ctx.currentTime + 0.25) {
        const s = n % 16, bar = Math.floor(n / 16) % 4;
        const t = nextT + (s % 2 ? step * 0.18 : 0);   // swing
        if (s === 0) { pad(t, chords[bar], step * 16); bass(t, roots[bar], step * 6); }
        if (s === 10) bass(t, roots[bar] + 7, step * 4);
        if (s === 0 || s === 7 || s === 10) kick(t);
        if (s === 4 || s === 12) snare(t);
        if (s % 2 === 0) hat(t, s % 4 === 0 ? 0.07 : 0.045);
        if (Math.random() < 0.25) burst(vinyl, t, { dur: 0.004, peak: rand(0.05, 0.18), type: 'highpass', freq: 3000 });
        nextT += step; n++;
      }
    }, 40);
    return () => { clearInterval(sched); hiss.stop(); };
  },
};

export function isPlaying(key) { return !!live[key]; }
export function anyPlaying() { return Object.keys(live).length > 0; }

export function start(key, volume = 0.6) {
  if (live[key] || !BUILD[key]) return;
  if (!audio()) return false;
  const g = gain(0);
  g.connect(master);
  g.gain.linearRampToValueAtTime(volume, ctx.currentTime + 1.2);
  let stopFn;
  try { stopFn = BUILD[key](g); } catch (e) { console.warn(e); g.disconnect(); return false; }
  live[key] = { gain: g, stop: stopFn };
  changed();
  return true;
}

export function stop(key) {
  const s = live[key];
  if (!s) return;
  delete live[key];
  const t = ctx.currentTime;
  s.gain.gain.cancelScheduledValues(t);
  s.gain.gain.setValueAtTime(s.gain.gain.value, t);
  s.gain.gain.linearRampToValueAtTime(0, t + 0.8);
  setTimeout(() => { try { s.stop(); } catch {} s.gain.disconnect(); }, 900);
  changed();
}
export function stopAll() { for (const k of Object.keys(live)) stop(k); }

export function setVolume(key, v) {
  const s = live[key];
  if (s) s.gain.gain.setTargetAtTime(v, ctx.currentTime, 0.1);
}
export function setMaster(v) { if (ctx) master.gain.setTargetAtTime(v, ctx.currentTime, 0.1); else pendingMaster = v; }

/** Lower the background while a voice reads aloud. */
export function duck(on) {
  if (!ctx) return;
  duckGain.gain.setTargetAtTime(on ? 0.45 : 1, ctx.currentTime, 0.4);
}
