// Procedural sound for Krill (docs/design/AUDIO.md). Everything is synthesized
// at runtime with Web Audio: filtered noise, oscillators, a generated crackle
// texture and a generated underwater impulse response. No sample files.
//
// Graph (one AudioContext, built on the first user gesture):
//
//   category nodes          medium                         post
//   amb.water  ─┐
//   whale.water ├─► waterSum ─► lowpass ─┬───────────► waterOut ─┐
//   life.water ─┘            └─ send ─► convolver ────┘ (x-fade) │
//   life.far ─► farLP ─┬─ dry ───────────────────────► waterOut  │
//                      └─ wet ─► convolver                        ├─► tunnel(LP) ─► world ─┐
//   amb.air ───┐                                                  │                         │
//   whale.air ─┼─► airSum ────────────────────────────► airOut ──┘                         ├─► limiter ─► master ─► out
//   life.air ──┘                                                                           │
//   fx (plunge) ─► tunnel;  body (heartbeat) ────────────────────────────────────────────┤
//   ui (ticks, chime) ─────────────────────────────────────────────────────────────────────┘
//
// whale.both feeds both whale.water and whale.air, so the player's own sounds
// are heard dry in air and muffled + reverberant below; the medium crossfade
// follows world.isCameraUnderwater. Category gains carry the slow-mo duck.
//
// Game integration: Game.js calls audio.event(type, data) for whale and
// physiology events and audio.update(rawDt, game) once per frame; everything
// else (strokes, speed, turns, mouth closing, feeding, O2) is read from game
// state here. Every public method is a no-op without Web Audio and never throws.

const W = typeof window !== 'undefined' ? window : {};
const AC = W.AudioContext || W.webkitAudioContext || null;
const OAC = W.OfflineAudioContext || W.webkitOfflineAudioContext || null;
const STORE = 'krill.audio';
const E = 0.0001; // "silence" for exponential ramps
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = (v) => clamp(v, 0, 1);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const dB = (v) => (v > 1e-9 ? 20 * Math.log10(v) : -180);

// ---- generated buffers --------------------------------------------------

// Stereo loopable noise (independent channels = free width). The last 30 ms
// are cross-faded into the start so the loop has no seam click.
function makeNoise(ctx, kind, secs) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * secs);
  const m = Math.floor(sr * 0.03);
  const buf = ctx.createBuffer(2, n, sr);
  const x = new Float32Array(n + m);
  for (let ch = 0; ch < 2; ch++) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n + m; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') x[i] = w;
      else if (kind === 'pink') {
        // Paul Kellet's refined pink filter
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02; // leaky integrator: brown (red) noise
        x[i] = last;
      }
    }
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = x[i];
    for (let i = 0; i < m; i++) { const a = i / m; d[i] = x[i] * a + x[n + i] * (1 - a); }
    // brown noise wanders: remove DC so the low-pass bed doesn't thump
    let mean = 0; for (let i = 0; i < n; i++) mean += d[i]; mean /= n;
    let ss = 0; for (let i = 0; i < n; i++) { d[i] -= mean; ss += d[i] * d[i]; }
    const k = 0.3 / Math.sqrt(ss / n || 1); // RMS 0.3 for every colour
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  return buf;
}

// Sparse impulsive crackle (snapping shrimp, krill fizz, droplets): Poisson
// clicks with heavy-tailed amplitudes, each a tiny damped ring.
function makeCrackle(ctx, secs, perSec) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * secs);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const count = Math.floor(secs * perSec);
    for (let c = 0; c < count; c++) {
      const p = Math.floor(Math.random() * n);
      const a = (Math.random() < 0.5 ? -1 : 1) * Math.pow(Math.random(), 3);
      const tau = rand(2, 9);
      const w = (TAU * rand(2500, 9000)) / sr;
      for (let j = 0; j < 60; j++) d[(p + j) % n] += a * Math.exp(-j / tau) * Math.cos(j * w);
    }
    let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    const k = 0.9 / (peak || 1);
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  return buf;
}

// Underwater impulse response: sparse early reflections (surface, seafloor)
// then a dense exponentially decaying tail that darkens as it decays.
function makeIR(ctx, secs, { lpStart = 7000, lpEnd = 500, predelay = 0.015 } = {}) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * secs);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let y = 0;
    const pd = Math.floor(predelay * sr);
    for (let i = pd; i < n; i++) {
      const t = i / sr;
      const fc = lpStart * Math.pow(lpEnd / lpStart, t / secs);
      y += (1 - Math.exp((-TAU * fc) / sr)) * (Math.random() * 2 - 1 - y);
      const fade = Math.min(1, (i - pd) / (0.004 * sr));
      d[i] = y * Math.exp((-6.9 * t) / secs) * fade;
    }
    for (const [dt, a] of [[0.021, 0.5], [0.034, -0.35], [0.052, 0.3], [0.077, -0.2]]) {
      const i = Math.floor((dt + (ch ? 0.003 : 0)) * sr);
      if (i < n) d[i] += a;
    }
  }
  return buf;
}

// ---- Synth: context-bound helpers and every sound recipe ----------------
// Recipes take (o, t, p): o = output routes { both, air, water, far, fx, body, ui },
// t = start time (context seconds), p = parameters. They schedule nodes and
// return their duration. The same code runs in the live context and in an
// OfflineAudioContext for the verification renders.
export class Synth {
  constructor(ctx) {
    this.ctx = ctx;
    this._ends = [];
    this.maxVoices = 48;
    this.buf = {
      white: makeNoise(ctx, 'white', 3),
      pink: makeNoise(ctx, 'pink', 3),
      brown: makeNoise(ctx, 'brown', 4),
      crackle: makeCrackle(ctx, 5, 70),
    };
  }

  get now() { return this.ctx.currentTime; }
  voices() { const t = this.now; this._ends = this._ends.filter((e) => e > t); return this._ends.length; }
  room(pri = 1) { return pri >= 2 || this.voices() < this.maxVoices; }

  // ---- node helpers
  gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  filt(type, f, Q = 0.707) {
    const b = this.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b;
  }
  osc(type, f, t, end) {
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    o.start(t); o.stop(end); return o;
  }
  noise(kind, t, end, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.buf[kind]; s.loop = true; s.playbackRate.value = rate;
    s.start(t, Math.random() * (s.buffer.duration - 0.05)); s.stop(end);
    return s;
  }
  loopSource(kind, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.buf[kind]; s.loop = true; s.playbackRate.value = rate;
    s.start(this.now, Math.random() * (s.buffer.duration - 0.05));
    return s;
  }
  pan(p) {
    if (!this.ctx.createStereoPanner) return this.gain(1);
    const n = this.ctx.createStereoPanner(); n.pan.value = clamp(p, -1, 1); return n;
  }
  chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }
  // percussive: silent -> linear attack -> exponential decay to silence at `end`
  perc(param, t, a, peak, end) {
    param.setValueAtTime(E, t);
    param.linearRampToValueAtTime(Math.max(E, peak), t + a);
    param.exponentialRampToValueAtTime(E, Math.max(t + a + 0.01, end));
  }
  // swell: attack, hold, exponential release
  swell(param, t, a, peak, holdEnd, end) {
    param.setValueAtTime(E, t);
    param.linearRampToValueAtTime(Math.max(E, peak), t + a);
    param.setValueAtTime(Math.max(E, peak), Math.max(t + a, holdEnd));
    param.exponentialRampToValueAtTime(E, Math.max(t + a + 0.01, holdEnd + 0.01, end));
  }
  sweep(param, t, f0, f1, end) { param.setValueAtTime(f0, t); param.exponentialRampToValueAtTime(f1, end); }
  // final gain of a one-shot: tracked as a voice, disconnected when done
  _out(dest, end) {
    const g = this.gain(1);
    g.connect(dest);
    this._ends.push(end);
    const tail = this.ctx.createConstantSource ? this.ctx.createConstantSource() : null;
    if (tail) {
      // a silent clock node whose onended cleans the voice up
      tail.offset.value = 0; tail.connect(g); tail.start(this.now); tail.stop(end + 0.05);
      tail.onended = () => { try { g.disconnect(); tail.disconnect(); } catch { /* already gone */ } };
    }
    return g;
  }

  // ---- the player whale ------------------------------------------------

  // One fluke stroke: a soft displacement whoosh (the flukes shove a slug of
  // water). size scales the band down for bigger animals. During the breach
  // run-up each stroke also gets a low thump.
  stroke(o, t, { k = 0.5, period = 1.5, size = 1, runup = false } = {}) {
    const dur = clamp(period * 0.6, 0.35, 1.6);
    const end = t + dur + 0.05;
    const out = this._out(o.both, end);
    const f = 260 / Math.sqrt(size);
    const n = this.noise('pink', t, end, 0.9);
    const bp = this.filt('bandpass', f * 0.6, 0.8);
    bp.frequency.setValueAtTime(f * 0.6, t);
    bp.frequency.linearRampToValueAtTime(f * (1.2 + 0.5 * k), t + dur * 0.4);
    bp.frequency.exponentialRampToValueAtTime(f * 0.5, t + dur);
    const g = this.gain(0);
    g.gain.setValueAtTime(E, t);
    g.gain.linearRampToValueAtTime(0.8 * k, t + dur * 0.38);
    g.gain.exponentialRampToValueAtTime(E, t + dur);
    this.chain(n, bp, g, out);
    if (runup) {
      const th = this.osc('sine', 62 / Math.sqrt(size), t, t + 0.5);
      th.frequency.exponentialRampToValueAtTime(30 / Math.sqrt(size), t + 0.35);
      const tg = this.gain(0); this.perc(tg.gain, t, 0.01, 0.8 * k, t + 0.45);
      this.chain(th, tg, out);
      const bn = this.noise('brown', t, t + 0.4);
      const lp = this.filt('lowpass', 140);
      const bg = this.gain(0); this.perc(bg.gain, t, 0.015, 1.2 * k, t + 0.35);
      this.chain(bn, lp, bg, out);
    }
    return dur;
  }

  // Body creak under hard turns: stick-slip groan, a slow sawtooth pulse train
  // through two tissue resonances.
  creak(o, t, { k = 1, size = 1 } = {}) {
    const dur = rand(0.5, 0.9);
    const end = t + dur + 0.05;
    const out = this._out(o.both, end);
    const f0 = rand(13, 22);
    const s = this.osc('sawtooth', f0, t, end);
    s.frequency.linearRampToValueAtTime(f0 * rand(1.3, 1.9), t + dur * 0.7);
    s.frequency.linearRampToValueAtTime(f0 * rand(0.9, 1.2), t + dur);
    const r = rand(280, 460) / Math.sqrt(size);
    const b1 = this.filt('bandpass', r, 7);
    const b2 = this.filt('bandpass', r * 2.3, 9);
    const g = this.gain(0); this.swell(g.gain, t, 0.08, 0.35 * k, t + dur * 0.6, t + dur);
    s.connect(b1); s.connect(b2); b1.connect(g); b2.connect(g); g.connect(out);
    return dur;
  }

  // Lunge: the rising rush of accelerating into the swarm with the mouth
  // opening (drag spikes, flow noise climbs in pitch and level).
  lungeRush(o, t, { p = 1, size = 1 } = {}) {
    const dur = 1.35;
    const end = t + dur;
    const out = this._out(o.both, end);
    const s = 1 / Math.sqrt(size);
    const n = this.noise('white', t, end);
    const bp = this.filt('bandpass', 180 * s, 0.6);
    this.sweep(bp.frequency, t, 180 * s, 1100 * s, t + 1.0);
    const g = this.gain(0);
    g.gain.setValueAtTime(E, t);
    g.gain.linearRampToValueAtTime(0.35 * (0.5 + 0.5 * p), t + 0.9);
    g.gain.setValueAtTime(0.35 * (0.5 + 0.5 * p), t + 1.1);
    g.gain.exponentialRampToValueAtTime(E, end);
    this.chain(n, bp, g, out);
    const r = this.noise('pink', t, end);
    const lp = this.filt('lowpass', 260 * s);
    const rg = this.gain(0); this.swell(rg.gain, t, 0.6, 0.5 * p, t + 1.05, end);
    this.chain(r, lp, rg, out);
    return dur;
  }

  // Mouth closing on ~the whale's own body mass of water: a deep engulfment
  // thump, the whomp of moving water, a bloop and escaping bubbles.
  gulp(o, t, { k = 1, size = 1 } = {}) {
    const dur = 1.4;
    const end = t + dur;
    const out = this._out(o.both, end);
    const s = 1 / Math.sqrt(size);
    const th = this.osc('sine', 80 * s, t, end);
    th.frequency.exponentialRampToValueAtTime(26 * s, t + 0.55);
    const tg = this.gain(0); this.perc(tg.gain, t, 0.012, 0.9 * k, t + 0.9);
    this.chain(th, tg, out);
    const w = this.noise('brown', t, end);
    const lp = this.filt('lowpass', 220 * s);
    const wg = this.gain(0); this.perc(wg.gain, t, 0.03, 1.1 * k, t + 1.1);
    this.chain(w, lp, wg, out);
    const bl = this.osc('sine', 220 * s, t + 0.04, t + 0.3);
    bl.frequency.exponentialRampToValueAtTime(95 * s, t + 0.2);
    const bg = this.gain(0); this.perc(bg.gain, t + 0.04, 0.008, 0.25 * k, t + 0.26);
    this.chain(bl, bg, out);
    for (let i = 0; i < 8; i++) this.bubble(o, t + rand(0.1, 1.1), rand(300, 1100), rand(0.04, 0.1) * k);
    return dur;
  }

  // A single bubble: Minnaert resonance, rising slightly as it shrinks/rises.
  bubble(o, t, f = 600, a = 0.06) {
    const d = rand(0.05, 0.12);
    const end = t + d + 0.02;
    const out = this._out(o.both, end);
    const s = this.osc('sine', f, t, end);
    s.frequency.exponentialRampToValueAtTime(f * 1.5, t + d);
    const g = this.gain(0); this.perc(g.gain, t, 0.004, a, t + d);
    this.chain(s, g, out);
    return d;
  }

  // Krill in the mouth: a dry, high crackle.
  fizz(o, t, { k = 0.5 } = {}) {
    const dur = 0.4;
    const out = this._out(o.both, t + dur);
    const n = this.noise('crackle', t, t + dur, rand(1.2, 1.6));
    const hp = this.filt('highpass', 2600, 0.7);
    const g = this.gain(0); this.swell(g.gain, t, 0.04, 0.5 * k, t + 0.15, t + dur);
    this.chain(n, hp, g, out);
    return dur;
  }

  // Species blows (design doc 4.1): humpback bushy ~2 s, blue a long deep
  // roar, sperm short, sharp and higher (single S-shaped left nostril). Each
  // exhale is turbulent broadband noise with a flutter, then an inhale.
  static BLOW = {
    humpback: { dur: 1.9, f: 750, Q: 0.55, low: 0.35, lowF: 260, att: 0.07, peak: 0.55, inh: 0.8, flutter: 22 },
    blue: { dur: 3.0, f: 420, Q: 0.6, low: 0.8, lowF: 170, att: 0.18, peak: 0.6, inh: 1.2, flutter: 12 },
    sperm: { dur: 0.95, f: 1500, Q: 0.9, low: 0.12, lowF: 420, att: 0.02, peak: 0.5, inh: 0.55, flutter: 35 },
  };
  blow(o, t, { sp = 'humpback', k = 1, inhale = true } = {}) {
    const B = Synth.BLOW[sp] || Synth.BLOW.humpback;
    const dur = B.dur * rand(0.92, 1.08);
    const inhAt = t + dur + rand(0.12, 0.3);
    const end = inhale ? inhAt + B.inh + 0.1 : t + dur + 0.1;
    const out = this._out(o.both, end);
    // exhale: broadband turbulence with a slow downward drift
    const n = this.noise('white', t, t + dur + 0.1);
    const bp = this.filt('bandpass', B.f, B.Q);
    this.sweep(bp.frequency, t, B.f * 1.15, B.f * 0.8, t + dur);
    const fl = this.gain(1); // flutter: turbulent amplitude wobble
    const lfo = this.osc('sine', B.flutter, t, t + dur + 0.1);
    const depth = this.gain(0.25); this.chain(lfo, depth, fl.gain);
    const g = this.gain(0);
    g.gain.setValueAtTime(E, t);
    g.gain.linearRampToValueAtTime(B.peak * k, t + B.att);
    g.gain.setTargetAtTime(B.peak * k * 0.55, t + B.att, dur * 0.35);
    g.gain.setValueAtTime(B.peak * k * 0.5, t + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(E, t + dur);
    this.chain(n, bp, fl, g, out);
    // chest / lung body: low roar (dominant for the blue)
    const r = this.noise('brown', t, t + dur + 0.1);
    const lp = this.filt('lowpass', B.lowF, 1.2);
    const rg = this.gain(0);
    rg.gain.setValueAtTime(E, t);
    rg.gain.linearRampToValueAtTime(B.low * k * 1.4, t + B.att * 1.5);
    rg.gain.exponentialRampToValueAtTime(E, t + dur * 1.02);
    this.chain(r, lp, rg, out);
    if (inhale) {
      // inhale: softer, higher, rising, cut off sharply as the blowhole shuts
      const i = this.noise('white', inhAt, inhAt + B.inh + 0.05);
      const ib = this.filt('bandpass', B.f * 1.35, 1.2);
      this.sweep(ib.frequency, inhAt, B.f * 1.1, B.f * 1.6, inhAt + B.inh);
      const wh = this.filt('bandpass', B.f * 2.1, 6);
      const ig = this.gain(0);
      ig.gain.setValueAtTime(E, inhAt);
      ig.gain.linearRampToValueAtTime(B.peak * k * 0.3, inhAt + B.inh * 0.85);
      ig.gain.linearRampToValueAtTime(E, inhAt + B.inh);
      i.connect(ib); i.connect(wh); ib.connect(ig); wh.connect(ig); ig.connect(out);
    }
    return end - t;
  }

  // Heartbeat (lub-dub): two low damped thumps. Routed to the body bus so the
  // blackout tunnel muffles the world but not your own pulse.
  heartbeat(o, t, { k = 1 } = {}) {
    const end = t + 0.65;
    const out = this._out(o.body, end);
    const beat = (t0, f, a) => {
      const s = this.osc('sine', f * 1.4, t0, t0 + 0.3);
      s.frequency.exponentialRampToValueAtTime(f, t0 + 0.08);
      const g = this.gain(0); this.perc(g.gain, t0, 0.012, a, t0 + 0.24);
      this.chain(s, g, out);
      const n = this.noise('brown', t0, t0 + 0.2);
      const lp = this.filt('lowpass', 95);
      const ng = this.gain(0); this.perc(ng.gain, t0, 0.008, a * 0.9, t0 + 0.15);
      this.chain(n, lp, ng, out);
    };
    beat(t, 50, 0.9 * k);
    beat(t + 0.3, 60, 0.6 * k);
    return 0.65;
  }

  // Camera crosses the surface. Down: a bubbly plunge with the air sound
  // sucked away; up: a bright drip-and-shed as the lens clears.
  plunge(o, t, { down = true } = {}) {
    const dur = down ? 0.9 : 0.7;
    const end = t + dur;
    const out = this._out(o.fx, end);
    if (down) {
      const n = this.noise('pink', t, end);
      const lp = this.filt('lowpass', 3000, 0.9);
      this.sweep(lp.frequency, t, 3200, 320, t + 0.5);
      const g = this.gain(0); this.perc(g.gain, t, 0.01, 0.55, t + 0.7);
      this.chain(n, lp, g, out);
      const th = this.osc('sine', 95, t, t + 0.35);
      th.frequency.exponentialRampToValueAtTime(40, t + 0.25);
      const tg = this.gain(0); this.perc(tg.gain, t, 0.008, 0.35, t + 0.3);
      this.chain(th, tg, out);
      for (let i = 0; i < 12; i++) this.bubble({ both: out }, t + rand(0.02, 0.7), rand(350, 1400), rand(0.03, 0.08));
    } else {
      const n = this.noise('white', t, end);
      const bp = this.filt('bandpass', 700, 0.8);
      this.sweep(bp.frequency, t, 700, 3800, t + 0.2);
      const g = this.gain(0); this.perc(g.gain, t, 0.008, 0.28, t + 0.4);
      this.chain(n, bp, g, out);
      for (let i = 0; i < 5; i++) this.bubble({ both: out }, t + rand(0.08, 0.6), rand(1300, 2600), rand(0.02, 0.05));
    }
    return dur;
  }

  // Breach exit: the body tears out of the water (broadband whoosh) and water
  // sheets and cascades off it for a couple of seconds.
  surfaceBreak(o, t, { k = 1 } = {}) {
    const dur = 2.8;
    const end = t + dur;
    const out = this._out(o.both, end);
    const n = this.noise('white', t, t + 1.1);
    const bp = this.filt('bandpass', 250, 0.7);
    this.sweep(bp.frequency, t, 250, 2200, t + 0.3);
    const g = this.gain(0); this.perc(g.gain, t, 0.05, 0.7 * k, t + 1.0);
    this.chain(n, bp, g, out);
    const r = this.noise('pink', t, t + 1.3);
    const lp = this.filt('lowpass', 600);
    const rg = this.gain(0); this.perc(rg.gain, t, 0.04, 0.6 * k, t + 1.25);
    this.chain(r, lp, rg, out);
    const c = this.noise('pink', t, end);
    const hp = this.filt('highpass', 700);
    const cg = this.gain(0); this.swell(cg.gain, t, 0.25, 0.4 * k, t + 0.9, end);
    this.chain(c, hp, cg, out);
    const d = this.noise('crackle', t, end, 1);
    const dh = this.filt('highpass', 2000);
    const dg = this.gain(0); this.swell(dg.gain, t + 0.1, 0.3, 0.35 * k, t + 1.0, end);
    this.chain(d, dh, dg, out);
    return dur;
  }

  // Re-entry. In air: a deep boom, a crack, then a long spray hiss with
  // falling droplets. Underwater listeners get a long low thud and a roar of
  // entrained air.
  impact(o, t, { k = 1, size = 1 } = {}) {
    const s = 1 / Math.sqrt(size);
    const endA = t + 3.6, endW = t + 3.6;
    const air = this._out(o.air, endA);
    const bo = this.osc('sine', 52 * s, t, t + 1.6);
    bo.frequency.exponentialRampToValueAtTime(24 * s, t + 1.2);
    const bg = this.gain(0); this.perc(bg.gain, t, 0.006, 1.0 * k, t + 1.6);
    this.chain(bo, bg, air);
    const bn = this.noise('brown', t, t + 1.5);
    const bl = this.filt('lowpass', 240 * s);
    const bng = this.gain(0); this.perc(bng.gain, t, 0.01, 1.3 * k, t + 1.4);
    this.chain(bn, bl, bng, air);
    const cr = this.noise('white', t, t + 0.3);
    const cb = this.filt('bandpass', 1100, 0.8);
    const cg = this.gain(0); this.perc(cg.gain, t, 0.003, 0.6 * k, t + 0.2);
    this.chain(cr, cb, cg, air);
    const sp = this.noise('white', t, endA);
    const sh = this.filt('highpass', 2600);
    const sg = this.gain(0); this.swell(sg.gain, t + 0.05, 0.1, 0.3 * k, t + 0.8, endA);
    this.chain(sp, sh, sg, air);
    const dr = this.noise('crackle', t + 0.4, endA, 0.8);
    const dh = this.filt('highpass', 2500);
    const dg = this.gain(0); this.swell(dg.gain, t + 0.4, 0.4, 0.3 * k, t + 1.6, endA);
    this.chain(dr, dh, dg, air);
    // underwater: long low thud + bubble roar
    const wat = this._out(o.water, endW);
    const th = this.osc('sine', 34 * s, t, endW);
    th.frequency.exponentialRampToValueAtTime(17 * s, t + 2.5);
    const tg = this.gain(0); this.perc(tg.gain, t, 0.02, 1.0 * k, t + 3.2);
    this.chain(th, tg, wat);
    const tn = this.noise('brown', t, endW);
    const tl = this.filt('lowpass', 100 * s);
    const tng = this.gain(0); this.perc(tng.gain, t, 0.03, 1.2 * k, t + 3.0);
    this.chain(tn, tl, tng, wat);
    const ro = this.noise('pink', t, endW);
    const rb = this.filt('bandpass', 380, 0.7);
    const rg = this.gain(0); this.swell(rg.gain, t + 0.05, 0.15, 0.4 * k, t + 0.6, t + 2.6);
    this.chain(ro, rb, rg, wat);
    return 3.6;
  }

  // ---- ambience one-shots ---------------------------------------------

  // Western gull "kyow" notes: a harsh pitch arch through two formants.
  gull(o, t, { n = 0 } = {}) {
    const notes = n || 1 + Math.floor(Math.random() * 4);
    const f0 = rand(620, 900);
    const gap = rand(0.28, 0.4);
    const end = t + notes * gap + 0.4;
    const out = this._out(o.air, end);
    const p = this.pan(rand(-0.8, 0.8));
    const dist = this.filt('lowpass', rand(3000, 5000));
    const a = rand(0.08, 0.14);
    this.chain(dist, p, out);
    for (let i = 0; i < notes; i++) {
      const t0 = t + i * gap * rand(0.9, 1.1);
      const f = f0 * rand(0.95, 1.05);
      const s = this.osc('sawtooth', f * 0.75, t0, t0 + 0.4);
      s.frequency.exponentialRampToValueAtTime(f, t0 + 0.05);
      s.frequency.exponentialRampToValueAtTime(f * 0.6, t0 + 0.32);
      const f1 = this.filt('bandpass', 1700, 2.5);
      const f2 = this.filt('bandpass', 2900, 3);
      const g = this.gain(0); this.perc(g.gain, t0, 0.02, a * (i === 0 ? 1 : 0.8), t0 + 0.34);
      s.connect(f1); s.connect(f2); f1.connect(g); f2.connect(g); g.connect(dist);
    }
    return end - t;
  }

  // ---- distant life ----------------------------------------------------

  // Humpback song unit, far off: a harmonic source (vocal-fold-like sawtooth
  // + triangle) shaped by two formants, pitch contour per unit type, all of it
  // mostly reverberant and low-passed by distance (routes to o.far).
  songUnit(o, t, { kind = 'moan', pan = 0, a = 0.1 } = {}) {
    let f0, f1, dur;
    if (kind === 'moan') { f0 = rand(110, 260); f1 = f0 * rand(0.8, 1.25); dur = rand(1.6, 3.2); }
    else if (kind === 'whoop') { f0 = rand(150, 250); f1 = f0 * rand(2.2, 3.2); dur = rand(0.6, 1.1); }
    else if (kind === 'cry') { f0 = rand(400, 800); f1 = f0 * 0.6; dur = rand(0.8, 1.4); }
    else { f0 = rand(60, 110); f1 = f0 * 0.95; dur = rand(0.4, 0.8); } // grunt
    const end = t + dur + 0.1;
    const out = this._out(o.far, end);
    const p = this.pan(pan);
    p.connect(out);
    const s1 = this.osc('sawtooth', f0, t, end);
    const s2 = this.osc('triangle', f0 * 1.004, t, end);
    for (const s of [s1, s2]) {
      if (kind === 'whoop') s.frequency.exponentialRampToValueAtTime(f1 * (s === s2 ? 1.004 : 1), t + dur * 0.85);
      else s.frequency.linearRampToValueAtTime(f1, t + dur);
    }
    // vibrato
    const vib = this.osc('sine', rand(4, 6.5), t, end);
    const vd = this.gain(f0 * 0.012);
    vib.connect(vd); vd.connect(s1.frequency); vd.connect(s2.frequency);
    const F1 = this.filt('bandpass', rand(350, 600), 5);
    const F2 = this.filt('bandpass', rand(900, 1400), 6);
    const body = this.filt('lowpass', 900, 0.7);
    const g = this.gain(0);
    this.swell(g.gain, t, dur * 0.2, a, t + dur * 0.7, t + dur);
    const mix = this.gain(1);
    s1.connect(F1); s1.connect(F2); s1.connect(body); s2.connect(body);
    F1.connect(mix); F2.connect(mix); body.connect(mix);
    if (kind === 'grunt') {
      // pulsed: amplitude modulated at ~15 Hz
      const am = this.gain(0.5);
      const lfo = this.osc('square', rand(12, 18), t, end);
      const ld = this.gain(0.5); lfo.connect(ld); ld.connect(am.gain);
      this.chain(mix, am, g, p);
    } else this.chain(mix, g, p);
    return dur;
  }

  // One song phrase: a short theme of 3-6 units.
  songPhrase(o, t, { a = 0.1 } = {}) {
    const themes = [['moan', 'whoop', 'moan'], ['grunt', 'grunt', 'moan', 'cry'], ['whoop', 'whoop', 'moan'], ['moan', 'cry', 'grunt', 'moan']];
    const units = pick(themes).slice();
    if (Math.random() < 0.5) units.push(pick(['moan', 'whoop', 'grunt']));
    const pan = rand(-0.7, 0.7);
    let tt = t;
    for (const kind of units) {
      const d = this.songUnit(o, tt, { kind, pan, a: a * rand(0.7, 1) });
      tt += d + rand(0.3, 1.4);
    }
    return tt - t;
  }

  _blueWave() {
    if (this._bw) return this._bw;
    // harmonic series of a ~16 Hz fundamental; the 3rd (~48 Hz) is the
    // strongest, as in NE Pacific B-calls, and upper harmonics up to ~200 Hz
    // keep it audible on laptop speakers
    const amps = [0, 0.6, 0.55, 1.0, 0.75, 0.55, 0.42, 0.32, 0.25, 0.2, 0.16, 0.12, 0.09];
    const real = new Float32Array(amps.length);
    const imag = new Float32Array(amps);
    this._bw = this.ctx.createPeriodicWave(real, imag);
    return this._bw;
  }

  // Blue whale call, far off. A: pulsed (~1.5 Hz pulses), B: long tonal
  // downsweep. Mostly felt; the harmonics carry it.
  blueCall(o, t, { type = 'B', a = 0.22 } = {}) {
    const dur = type === 'A' ? 7 : 11;
    const end = t + dur + 0.2;
    const out = this._out(o.far, end);
    const s = this.ctx.createOscillator();
    s.setPeriodicWave(this._blueWave());
    const f0 = type === 'A' ? 17.5 : 16.2;
    s.frequency.setValueAtTime(f0, t);
    s.frequency.linearRampToValueAtTime(f0 * (type === 'A' ? 0.98 : 0.94), t + dur);
    s.start(t); s.stop(end);
    const g = this.gain(0);
    this.swell(g.gain, t, type === 'A' ? 0.8 : 1.8, a, t + dur * 0.75, t + dur);
    const lp = this.filt('lowpass', 260, 0.7);
    if (type === 'A') {
      const am = this.gain(0.45);
      const lfo = this.osc('sine', 1.5, t, end);
      const ld = this.gain(0.55); lfo.connect(ld); ld.connect(am.gain);
      this.chain(s, lp, am, g, out);
    } else this.chain(s, lp, g, out);
    return dur;
  }

  // A ship passing somewhere out on the bay: diesel firing-rate drone plus
  // propeller cavitation noise beating at the blade rate; slow approach and
  // departure with a small Doppler drop at closest approach.
  ship(o, t, { dur = 70, a = 0.2 } = {}) {
    const end = t + dur;
    const out = this._out(o.far, end);
    const dry = this._out(o.water, end);
    const env = this.gain(0);
    env.gain.setValueAtTime(E, t);
    env.gain.exponentialRampToValueAtTime(a, t + dur * 0.45);
    env.gain.exponentialRampToValueAtTime(E, end);
    env.connect(out);
    const dg = this.gain(0.6); env.connect(dg); dg.connect(dry);
    const fr = rand(8.5, 11); // engine firing rate
    const e1 = this.osc('sawtooth', fr * 1.02, t, end);
    e1.frequency.setValueAtTime(fr * 1.02, t + dur * 0.4);
    e1.frequency.linearRampToValueAtTime(fr * 0.98, t + dur * 0.55);
    const el = this.filt('lowpass', 170, 1.5);
    const eg = this.gain(0.8);
    this.chain(e1, el, eg, env);
    const c = this.noise('pink', t, end);
    const cb = this.filt('bandpass', 1500, 0.5);
    const am = this.gain(0.4);
    const blade = this.osc('sine', fr * 0.66, t, end); // shaft rate x blades
    const bd = this.gain(0.6); blade.connect(bd); bd.connect(am.gain);
    const cg = this.gain(0.9);
    this.chain(c, cb, am, cg, env);
    const h = this.noise('pink', t, end);
    const hl = this.filt('lowpass', 400);
    const hg = this.gain(0.5);
    this.chain(h, hl, hg, env);
    return dur;
  }

  // ---- UI --------------------------------------------------------------

  tick(o, t, { kind = 'tick' } = {}) {
    const end = t + 0.12;
    const out = this._out(o.ui, end);
    const f = { tick: 1900, tock: 420, open: 900, close: 1200 }[kind] || 1900;
    const a = kind === 'tock' ? 0.05 : 0.035;
    const s = this.osc(kind === 'tock' ? 'triangle' : 'sine', f, t, end);
    s.frequency.exponentialRampToValueAtTime(f * (kind === 'close' ? 1.15 : 0.8), t + 0.05);
    const g = this.gain(0); this.perc(g.gain, t, 0.002, a, t + (kind === 'tock' ? 0.1 : 0.06));
    this.chain(s, g, out);
    return 0.12;
  }

  // Day card: two soft bell tones (inharmonic partials), a fifth apart.
  chime(o, t, { a = 0.07 } = {}) {
    const end = t + 3.2;
    const out = this._out(o.ui, end);
    const bell = (t0, f, amp) => {
      for (const [r, pa, d] of [[1, 1, 2.8], [2.0, 0.25, 1.6], [2.76, 0.35, 1.2], [5.4, 0.1, 0.5]]) {
        const s = this.osc('sine', f * r, t0, t0 + d + 0.05);
        const g = this.gain(0); this.perc(g.gain, t0, 0.004, amp * pa, t0 + d);
        this.chain(s, g, out);
      }
    };
    bell(t, 523.25, a);
    bell(t + 0.24, 783.99, a * 0.8);
    return 3.2;
  }
}

// ---- analysis helpers (verification) ------------------------------------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -TAU / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// peak / RMS / active duration / spectral centroid / low-band share of a render
export function analyseBuffer(buf) {
  const sr = buf.sampleRate;
  const a = buf.getChannelData(0);
  const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const n = a.length;
  const m = new Float32Array(n);
  let peak = 0, ss = 0;
  for (let i = 0; i < n; i++) { const v = (a[i] + b[i]) * 0.5; m[i] = v; peak = Math.max(peak, Math.abs(v)); ss += v * v; }
  const win = Math.floor(sr * 0.01);
  const rmsW = [];
  for (let i = 0; i + win <= n; i += win) {
    let s = 0; for (let j = 0; j < win; j++) s += m[i + j] * m[i + j];
    rmsW.push(Math.sqrt(s / win));
  }
  const maxW = Math.max(...rmsW, 1e-9);
  const on = rmsW.map((v) => dB(v) > dB(maxW) - 30);
  const first = on.indexOf(true), last = on.lastIndexOf(true);
  let sA = 0, cnt = 0;
  for (let i = first; i <= last && i >= 0; i++) { sA += rmsW[i] * rmsW[i]; cnt++; }
  const N = 4096;
  const spec = new Float64Array(N / 2);
  const re = new Float64Array(N), im = new Float64Array(N);
  const s0 = Math.max(0, first * win), s1 = Math.min(n, (last + 1) * win);
  for (let p = s0; p + N <= Math.max(s1, s0 + N) && p + N <= n; p += N) {
    for (let i = 0; i < N; i++) { re[i] = m[p + i] * (0.5 - 0.5 * Math.cos((TAU * i) / N)); im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) spec[k] += re[k] * re[k] + im[k] * im[k];
  }
  let num = 0, den = 0, low = 0;
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    num += f * spec[k]; den += spec[k];
    if (f < 120) low += spec[k];
  }
  return {
    peakDb: +dB(peak).toFixed(1),
    rmsDb: +dB(Math.sqrt(sA / Math.max(1, cnt))).toFixed(1), // RMS over the active part
    onset: first >= 0 ? +(first * 0.01).toFixed(2) : null,
    activeS: first >= 0 ? +((last - first + 1) * 0.01).toFixed(2) : 0,
    centroidHz: den > 0 ? Math.round(num / den) : 0,
    lowShare: den > 0 ? +(low / den).toFixed(2) : 0,
  };
}

// ---- the engine ----------------------------------------------------------

export class GameAudio {
  constructor({ disabled = false } = {}) {
    this.supported = !!AC;
    this.enabled = this.supported && !disabled;
    this.ctx = null;
    this.ready = false;
    this.settings = { volume: 0.8, muted: false, reducedHeart: false };
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s && typeof s === 'object') Object.assign(this.settings, s);
    } catch { /* storage blocked or bad JSON */ }
    this.settings.volume = clamp01(Number(this.settings.volume) || 0);
    this.log = []; // recent events, for debug()
    this._s = {}; // update state
  }

  // ---- lifecycle ----
  // Call from a user gesture (browser autoplay rules).
  unlock() {
    if (!this.enabled) return false;
    try {
      if (!this.ctx) this._build();
      if (this.ctx.state === 'suspended' && !this.settings.muted) this.ctx.resume().catch(() => {});
      return true;
    } catch (e) { this._fail(e); return false; }
  }

  _fail(e) {
    if (!this.enabled) return;
    this.enabled = false;
    this.ready = false;
    console.warn('[audio] disabled:', e && e.message ? e.message : e);
    try { this.ctx && this.ctx.close(); } catch { /* ignore */ }
  }

  _build() {
    this._graph(new AC({ latencyHint: 'interactive' }));
    this.ready = true;
    this.applySettings();
    // don't burn CPU in a background tab
    document.addEventListener('visibilitychange', () => {
      if (!this.ready) return;
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else if (!this.settings.muted) this.ctx.resume().catch(() => {});
    });
  }

  // The whole mix graph on any BaseAudioContext (live, or offline for the benchmark).
  _graph(ctx) {
    this.ctx = ctx;
    const S = (this.synth = new Synth(ctx));
    const g = (v) => S.gain(v);

    // post: world (tunnel LP + pause duck) and body/ui -> limiter -> master
    this.master = g(0);
    this.limiter = ctx.createDynamicsCompressor();
    const L = this.limiter;
    L.threshold.value = -8; L.knee.value = 6; L.ratio.value = 12; L.attack.value = 0.003; L.release.value = 0.25;
    this.mix = g(1);
    this.mix.connect(L); L.connect(this.master); this.master.connect(ctx.destination);
    this.tunnel = S.filt('lowpass', 20000, 0.5);
    this.world = g(1);
    this.tunnel.connect(this.world); this.world.connect(this.mix);
    this.bodyBus = g(1); this.bodyBus.connect(this.mix);
    this.uiBus = g(1); this.uiBus.connect(this.mix);
    this.fxBus = g(1); this.fxBus.connect(this.tunnel);

    // media
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeIR(ctx, 3.2);
    this.waterSum = g(1);
    this.waterLP = S.filt('lowpass', 2400, 0.5);
    this.waterOut = g(1);
    this.airSum = g(1);
    this.airOut = g(0);
    const send = g(0.35);
    this.waterSum.connect(this.waterLP); this.waterLP.connect(this.waterOut);
    this.waterSum.connect(send); send.connect(this.reverb);
    this.reverb.connect(this.waterOut);
    this.waterOut.connect(this.tunnel);
    this.airSum.connect(this.airOut); this.airOut.connect(this.tunnel);
    // distant sources: dark, mostly reverb
    this.farIn = g(1);
    const farLP = S.filt('lowpass', 1400, 0.6);
    const farDry = g(0.25), farWet = g(1.1);
    this.farIn.connect(farLP); farLP.connect(farDry); farLP.connect(farWet);
    farDry.connect(this.waterOut); farWet.connect(this.reverb);

    // category x medium nodes (their gains carry category levels + ducking)
    this.cat = {};
    for (const c of ['amb', 'whale', 'life']) {
      const w = g(1), a = g(1), far = g(1);
      w.connect(this.waterSum); a.connect(this.airSum); far.connect(this.farIn);
      const both = g(1); both.connect(w); both.connect(a);
      this.cat[c] = { water: w, air: a, far, both };
    }
    const routes = (c) => ({ ...this.cat[c], fx: this.fxBus, body: this.bodyBus, ui: this.uiBus });
    this.routes = { amb: routes('amb'), whale: routes('whale'), life: routes('life') };

    // meters (read only by debug()/the log)
    this.meters = {};
    for (const [k, node] of Object.entries({ master: this.master, water: this.waterOut, air: this.airOut, body: this.bodyBus, ui: this.uiBus })) {
      const an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.5;
      node.connect(an);
      this.meters[k] = an;
    }

    this._buildLoops();
  }

  // Continuous voices: four shared looping noise sources fanned out to
  // filtered beds whose gains/filters update() drives.
  _buildLoops() {
    const S = this.synth;
    const src = { white: S.loopSource('white'), pink: S.loopSource('pink'), brown: S.loopSource('brown'), crackle: S.loopSource('crackle', 0.9) };
    const pink2 = S.loopSource('pink', 0.97); // decorrelated copy for the air bed
    const v = (source, filters, dest) => {
      const gn = S.gain(0);
      S.chain(source, ...filters, gn, dest);
      return { g: gn, f: filters[0] };
    };
    const A = this.cat.amb, Wh = this.cat.whale;
    this.loops = {
      // underwater: distant sea rumble (shipping/seismic/surf, Wenz < 200 Hz)
      bed: v(src.brown, [S.filt('lowpass', 180, 0.7)], A.water),
      // wind-driven sea noise, 300 Hz-5 kHz (Knudsen): rises with wind, fades with depth
      sea: v(src.pink, [S.filt('bandpass', 900, 0.4)], A.water),
      // surf on the shore, heard through the water in the shallows
      surf: v(src.pink, [S.filt('lowpass', 600, 0.7)], A.water),
      // snapping shrimp on rocky/shallow bottoms
      shrimp: v(src.crackle, [S.filt('highpass', 2200, 0.7)], A.water),
      // the player's flow noise
      rush: v(src.pink, [S.filt('bandpass', 250, 0.7)], Wh.both),
      airRush: v(src.white, [S.filt('bandpass', 1000, 0.6)], Wh.air),
      // filtering: water pressed out through baleen
      gurgle: v(src.brown, [S.filt('bandpass', 260, 3)], Wh.both),
      sieve: v(src.white, [S.filt('bandpass', 3500, 1.5)], Wh.both),
      // above water
      wind: v(pink2, [S.filt('bandpass', 500, 0.9)], A.air),
      whistle: v(src.white, [S.filt('bandpass', 1600, 12)], A.air),
      waves: v(pink2, [S.filt('lowpass', 900, 0.7)], A.air),
      crest: v(src.white, [S.filt('bandpass', 2500, 0.5)], A.air),
    };
    // plainfin midshipman "hum" (~95 Hz, night, shallow): fish chorus
    const hum = this.synth.ctx.createOscillator();
    hum.type = 'sawtooth'; hum.frequency.value = 96; hum.start();
    this.loops.hum = v(hum, [S.filt('lowpass', 380, 0.7)], A.water);
    this._loopSrc = [...Object.values(src), pink2, hum];
  }

  // ---- settings ----
  applySettings() {
    try { localStorage.setItem(STORE, JSON.stringify(this.settings)); } catch { /* storage blocked */ }
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const v = this.settings.muted ? 0 : this.settings.volume * this.settings.volume; // perceptual taper
    this.master.gain.setTargetAtTime(v, t, 0.05);
    clearTimeout(this._suspendTimer);
    if (this.settings.muted) this._suspendTimer = setTimeout(() => { if (this.settings.muted) this.ctx.suspend().catch(() => {}); }, 300);
    else if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume().catch(() => {});
  }

  setVolume(v) { this.settings.volume = clamp01(v); if (v > 0) this.settings.muted = false; this.applySettings(); }
  setMuted(m) { this.settings.muted = !!m; this.applySettings(); }
  setReducedHeart(r) { this.settings.reducedHeart = !!r; this.applySettings(); }

  // ---- events from Game ----
  _note(type) {
    this.log.push({ t: this.ctx ? +this.ctx.currentTime.toFixed(2) : 0, type });
    if (this.log.length > 64) this.log.shift();
  }

  event(type, data = {}) {
    if (!this.ready || !this.enabled) return;
    try { this._event(type, data || {}); } catch (e) { this._fail(e); }
  }

  _event(type, data) {
    const S = this.synth, g = this._game;
    const t = this.ctx.currentTime + 0.01;
    const R = this.routes.whale;
    const sp = (g && g.speciesId) || 'humpback';
    const size = g && g.whale ? (g.whale.sp.length * g.whale.group.scale.x) / 14 : 1;
    switch (type) {
      case 'blow':
        S.blow(R, t, { sp, k: data.deep ? 1.1 : 1 });
        break;
      case 'lunge':
        S.lungeRush(R, t, { p: data.power ?? 1, size });
        break;
      case 'runup':
        break; // strokes pick up the run-up thumps from controller state
      case 'breach': {
        S.surfaceBreak(R, t, { k: clamp(0.6 + (data.q ?? 1) * 0.5, 0.6, 1.1) });
        // a single exhale in the air (design doc 5.7), no inhale
        S.blow(R, t + 0.45, { sp, k: 0.8, inhale: false });
        break;
      }
      case 'splash': {
        const k = clamp(((data.speed ?? 6) / 9) * (data.attitude ?? 1), 0.35, 1.2);
        S.impact(R, t, { k, size });
        break;
      }
      case 'daycard':
        S.chime(this.routes.amb, t);
        break;
      default:
        break; // filter / breach-denied / abort / blackout / recovered / dive: state-driven or UI
    }
    this._note(type);
  }

  // UI sounds: 'tick' (navigation), 'tock' (warning prompt), 'open'/'close' (pause)
  ui(kind = 'tick') {
    if (!this.ready || !this.enabled) return;
    try {
      const t = this.ctx.currentTime;
      if (this._uiAt && t - this._uiAt < 0.05) return;
      this._uiAt = t;
      this.synth.tick(this.routes.amb, t + 0.005, { kind });
      this._note('ui-' + kind);
    } catch (e) { this._fail(e); }
  }

  // ---- per-frame ----
  update(rawDt, game) {
    this._game = game;
    if (!this.ready || !this.enabled || this.ctx.state !== 'running') return;
    const t0 = performance.now();
    try { this._update(Math.max(0, Math.min(0.1, rawDt || 0)), game); } catch (e) { this._fail(e); }
    this._updMs = (this._updMs ?? 0) * 0.95 + (performance.now() - t0) * 0.05; // main-thread cost, EMA
  }

  _set(param, v, tc = 0.12) {
    // skip redundant automation events
    if (param._last !== undefined && Math.abs(param._last - v) < 1e-4 * Math.max(1, Math.abs(v))) return;
    param._last = v;
    param.setTargetAtTime(v, this.ctx.currentTime, tc);
  }

  _update(dt, game) {
    const S = this.synth, st = this._s, t = this.ctx.currentTime;
    const world = game.world, cam = game.camera;
    const c = game.running ? game.controller : null;
    const paused = !!(game.paused || game.tuningOpen);
    const uw = world ? world.isCameraUnderwater !== false : true;
    const daylight = world && Number.isFinite(world.daylight) ? world.daylight : 1;
    const night = 1 - daylight;
    const wind = world && world.wind ? world.wind.kts : 12;
    const swell = world && world.swell ? world.swell : { height: 1.5, period: 10 };
    const camDepth = Math.max(0, -cam.position.y);
    const depth = c ? Math.max(0, -c.position.y) : camDepth;

    // seafloor under us (twice a second)
    st.floorT = (st.floorT || 0) - dt;
    if (st.floorT <= 0 && game.terrain && game.terrain.heightAt) {
      st.floorT = 0.5;
      const p = c ? c.position : cam.position;
      const h = game.terrain.heightAt(p.x, p.z);
      st.water = Number.isFinite(h) ? Math.max(0, -h) : 200;
      st.above = Math.max(0, st.water - depth);
    }
    const waterDepth = st.water ?? 200;
    const shallow = smooth(90, 15, waterDepth); // 1 in <15 m of water
    const coast = smooth(160, 20, waterDepth);
    const nearFloor = smooth(40, 3, st.above ?? 50);

    // ---- medium crossfade + surface-crossing plunge
    this._set(this.waterOut.gain, uw ? 1 : 0.05, 0.05);
    this._set(this.airOut.gain, uw ? 0 : 1, 0.05);
    if (st.uw !== undefined && st.uw !== uw && t - (st.plungeAt || 0) > 0.35 && !paused) {
      st.plungeAt = t;
      S.plunge(this.routes.whale, t + 0.005, { down: uw });
      this._note(uw ? 'plunge-down' : 'plunge-up');
    }
    st.uw = uw;
    // deeper = darker (a little): the underwater low-pass closes with depth
    this._set(this.waterLP.frequency, 2600 - 1200 * smooth(0, 150, camDepth), 0.3);

    // ---- pause / blackout tunnel / slow-mo duck
    const phys = c ? game.phys : null;
    const blackout = !!(phys && phys.blackout);
    const o2 = phys ? phys.o2 : 1;
    let tunnel = 20000;
    if (paused) tunnel = 1400;
    else if (blackout) tunnel = 360;
    else if (o2 < 0.12 && uw) tunnel = 1800 + (20000 - 1800) * (o2 / 0.12) ** 2;
    this._set(this.tunnel.frequency, tunnel, blackout ? 0.6 : 0.15);
    this._set(this.world.gain, paused ? 0.4 : blackout ? 0.6 : 1, 0.2);
    const ts = c ? c.timeScale : 1;
    const duck = 0.3 + 0.7 * clamp01((ts - 0.45) / 0.55);
    this._set(this.cat.amb.water.gain, duck, 0.08);
    this._set(this.cat.amb.air.gain, duck, 0.08);
    this._set(this.cat.life.far.gain, duck, 0.08);
    this._set(this.cat.life.water.gain, duck, 0.08);

    // ---- ambience beds (updated ~20 Hz)
    st.bedT = (st.bedT || 0) - dt;
    const Lp = this.loops;
    if (st.bedT <= 0) {
      st.bedT = 0.05;
      const dk = Math.exp(-depth / 80); // surface-borne sound fades with depth
      const windK = clamp01(wind / 30);
      this._set(Lp.bed.g.gain, 0.16 * (0.7 + 0.3 * dk) * (0.7 + 0.3 * daylight)); // night is quieter
      this._set(Lp.bed.f.frequency, 90 + 110 * dk, 0.5);
      this._set(Lp.sea.g.gain, 0.045 * (0.3 + windK) * dk * (0.75 + 0.25 * daylight));
      // swell sets the surf rhythm: breakers roll in once a period
      st.swellPh = ((st.swellPh || 0) + dt / (swell.period || 10)) % 1;
      const surge = Math.pow(0.5 + 0.5 * Math.sin(st.swellPh * TAU), 3);
      this._set(Lp.surf.g.gain, 0.22 * shallow * (0.4 + 0.6 * dk) * (0.35 + 0.65 * surge) * (0.6 + windK), 0.3);
      this._set(Lp.shrimp.g.gain, 0.12 * Math.max(shallow * 0.7, nearFloor * smooth(200, 60, waterDepth)) * (1 + 0.4 * smooth(0.1, 0.6, night)));
      this._set(Lp.hum.g.gain, 0.02 * night * shallow);
      // air: wind with gusts, the swell washing past, crests breaking
      // gusts: a slow random walk, smoothed
      st.gust = clamp01((st.gust ?? 0.5) + (Math.random() - 0.5) * 0.12);
      st.gustS = (st.gustS ?? 0.5) + (st.gust - (st.gustS ?? 0.5)) * 0.06;
      const gust = st.gustS;
      this._set(Lp.wind.g.gain, (0.03 + 0.28 * Math.pow(windK, 1.4)) * (0.6 + 0.8 * gust), 0.3);
      this._set(Lp.wind.f.frequency, 300 + 500 * gust + 12 * wind, 0.4);
      this._set(Lp.whistle.g.gain, 0.02 * smooth(12, 30, wind) * gust, 0.3);
      this._set(Lp.whistle.f.frequency, 1300 + 900 * gust, 0.4);
      const sw = clamp((swell.height || 1.5) / 2, 0.3, 1.6);
      this._set(Lp.waves.g.gain, 0.16 * sw * (0.4 + 0.6 * surge), 0.25);
      const crest = Math.pow(0.5 + 0.5 * Math.sin((st.swellPh - 0.12) * TAU), 6);
      this._set(Lp.crest.g.gain, 0.06 * (0.3 + windK) * crest, 0.15);
    }

    // ---- gulls: daytime, near the coast, only worth voices above water
    if (!uw && !paused && daylight > 0.3) {
      st.gullT = (st.gullT ?? rand(2, 6)) - dt;
      if (st.gullT <= 0) {
        st.gullT = rand(5, 18) / (0.25 + coast);
        if (S.room(0)) { S.gull(this.routes.amb, t + 0.02); this._note('gull'); }
      }
    }

    // ---- distant life (real time; also in the menu)
    this._updateLife(dt, t, night, paused);

    // ---- the player's whale
    if (c && game.whale) this._updateWhale(dt, t, game, c, paused, uw);
    else this._silenceWhale();
  }

  _silenceWhale() {
    const Lp = this.loops;
    for (const k of ['rush', 'airRush', 'gurgle', 'sieve']) this._set(Lp[k].g.gain, 0, 0.2);
    this._s.heartNext = 0;
  }

  _updateLife(dt, t, night, paused) {
    const S = this.synth, st = this._s, R = this.routes.life;
    // humpback song at dusk/night (MBARI's MARS hydrophone hears it most
    // nights in autumn/winter): sparse phrases, far off
    if (night > 0.3) {
      st.songT = (st.songT ?? rand(8, 20)) - dt;
      if (st.songT <= 0) {
        const d = S.songPhrase(R, t + 0.05, { a: 0.16 * (0.6 + 0.4 * night) });
        st.songT = d + rand(15, 45) / night;
        this._note('song');
      }
    } else if (st.songT !== undefined && st.songT < 5) st.songT = 5;
    // blue whale A/B calls, any time of day
    st.blueT = (st.blueT ?? rand(30, 70)) - dt;
    if (st.blueT <= 0) {
      st.blueT = rand(70, 170);
      if (Math.random() < 0.7) {
        S.blueCall(R, t + 0.05, { type: 'A' });
        S.blueCall(R, t + 0.05 + 7 + rand(2, 5), { type: 'B' });
        this._note('blue-call');
      }
    }
    // a ship on the bay: rare
    st.shipT = (st.shipT ?? rand(150, 300)) - dt;
    if (st.shipT <= 0) {
      const dur = rand(55, 90);
      st.shipT = dur + rand(180, 420);
      if (Math.random() < 0.6) { S.ship(R, t + 0.05, { dur }); this._note('ship'); }
    }
  }

  _updateWhale(dt, t, game, c, paused, uw) {
    const S = this.synth, st = this._s, Lp = this.loops, R = this.routes.whale;
    const whale = game.whale;
    const size = (whale.sp.length * whale.group.scale.x) / 14;
    const air = c.mode === 'air';
    const phys = game.phys;

    // flow noise with speed; in the air the rush becomes wind past the body
    const v = paused ? 0 : c.speed || 0;
    const rk = clamp(v / 8, 0, 1.3);
    this._set(Lp.rush.g.gain, air ? 0 : 0.42 * Math.pow(rk, 1.5), air ? 0.05 : 0.15);
    this._set(Lp.rush.f.frequency, (170 + 520 * rk) / Math.sqrt(size), 0.2);
    this._set(Lp.airRush.g.gain, air && !paused ? 0.12 * clamp01(v / 9) : 0, 0.1);

    // fluke strokes from the whale's own beat phase (one per half cycle)
    const ph = whale._phase;
    if (Number.isFinite(ph)) {
      const hk = Math.floor(ph / Math.PI);
      if (st.hk !== undefined && hk !== st.hk && !paused && !air) {
        const dph = ph - st.ph;
        if (dph > 0 && dt > 0) st.freq = dph / (TAU * dt);
        const period = 1 / Math.max(0.05, 2 * (st.freq || 0.3));
        const runup = !!c._runup;
        const k = clamp(0.12 + 0.55 * (c.thrust || 0), 0.1, runup ? 1.4 : 1.1);
        if (S.room(1)) S.stroke(R, t + 0.01, { k, period, size, runup });
        this._note(runup ? 'runup-stroke' : 'stroke');
      }
      st.hk = hk; st.ph = ph;
    }

    // creaks under hard, fast turns
    const turn = Math.abs(c.state.turn || 0);
    if (!paused && !air && turn > 0.65 && v > 1 && t > (st.creakAt || 0)) {
      st.creakAt = t + rand(2.5, 6);
      S.creak(R, t + 0.01, { k: clamp01(turn), size });
      this._note('creak');
    }

    // mouth closing at the end of a lunge: the engulfment gulp
    const lt = c.lungeTimer || 0;
    if ((st.lt || 0) > 0 && lt <= 0) {
      S.gulp(R, t + 0.01, { k: 0.55 + 0.45 * (c.lungePower || 0.5), size });
      this._note('gulp');
    }
    st.lt = lt;

    // krill fizz while feeding
    const eaten = game.krill ? game.krill.totalEaten || 0 : 0;
    if (st.eaten !== undefined && eaten > st.eaten && t > (st.fizzAt || 0)) {
      st.fizzAt = t + 0.18;
      S.fizz(R, t + 0.01, { k: clamp(0.25 + (eaten - st.eaten) / 12, 0.25, 1) });
      if (!st.fizzNoted || t - st.fizzNoted > 1) { st.fizzNoted = t; this._note('fizz'); }
    }
    st.eaten = eaten;

    // filtering after a lunge: gurgle + sieve hiss + bubbles
    const filtering = (c._filter || 0) > 0 && !paused;
    if (filtering && !st.filtering) this._note('filter');
    st.filtering = filtering;
    st.gurg = clamp01((st.gurg ?? 0.5) + (Math.random() - 0.5) * 0.6);
    this._set(Lp.gurgle.g.gain, filtering ? 0.18 * (0.4 + 0.6 * st.gurg) : 0, filtering ? 0.06 : 0.4);
    this._set(Lp.gurgle.f.frequency, 200 + 160 * st.gurg, 0.05);
    this._set(Lp.sieve.g.gain, filtering ? 0.025 : 0, 0.3);
    if (filtering && Math.random() < dt * 5 && S.room(0)) S.bubble(R, t + 0.01, rand(250, 750), rand(0.03, 0.07));

    // heartbeat: below 30 % O2 it slows as air runs out (diving bradycardia,
    // matching the HUD's --beat); in blackout it slows further and fades.
    if (phys && !paused && (o2Low(phys) || phys.blackout)) {
      st.blackT = phys.blackout ? (st.blackT || 0) + dt : 0;
      const period = phys.blackout
        ? Math.min(3.6, 2.2 + st.blackT * 0.15)
        : 1.1 + (0.3 - Math.min(0.3, phys.o2)) * 2.5;
      const soft = this.settings.reducedHeart ? 0.3 : 1;
      const k = (phys.blackout ? 0.65 : 0.38 + (0.3 - Math.min(0.3, phys.o2)) * 1.4) * soft;
      if (!st.heartNext || st.heartNext < t) st.heartNext = t + 0.05;
      if (st.heartNext - t < 0.12) {
        S.heartbeat(R, st.heartNext, { k });
        st.heartNext += period;
        this._note('heartbeat');
      }
    } else st.heartNext = 0;
  }

  // ---- debug / verification ----

  _level(an) {
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  _centroid(an) {
    const bins = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(bins);
    const sr = this.ctx.sampleRate;
    let num = 0, den = 0;
    for (let k = 1; k < bins.length; k++) {
      const m = Math.pow(10, bins[k] / 20);
      num += ((k * sr) / an.fftSize) * m; den += m;
    }
    return den > 0 ? Math.round(num / den) : 0;
  }

  debug() {
    if (!this.ready) return { supported: this.supported, enabled: this.enabled, ready: false, state: this.ctx ? this.ctx.state : 'none' };
    const lv = {};
    for (const [k, an] of Object.entries(this.meters)) lv[k] = +dB(this._level(an)).toFixed(1);
    const loops = {};
    for (const [k, l] of Object.entries(this.loops)) loops[k] = +l.g.gain.value.toFixed(3);
    return {
      supported: this.supported, enabled: this.enabled, ready: true, state: this.ctx.state,
      sampleRate: this.ctx.sampleRate, time: +this.ctx.currentTime.toFixed(2),
      oneShots: this.synth.voices(), loopSources: this._loopSrc.length, loopVoices: Object.keys(this.loops).length, settings: { ...this.settings },
      underwater: this._s.uw, levelsDb: lv, centroidHz: this._centroid(this.meters.master),
      tunnelHz: Math.round(this.tunnel.frequency.value), loopGains: loops, updateMs: +(this._updMs ?? 0).toFixed(3),
      events: this.log.slice(-12),
    };
  }

  // Sample master/medium levels + centroid every `ms` until stopLog().
  startLog(ms = 100) {
    if (!this.ready) return false;
    this.stopLog();
    this._rec = [];
    let seen = this.log.length ? this.log[this.log.length - 1] : null;
    this._recTimer = setInterval(() => {
      try {
        const ev = [];
        for (let i = this.log.length - 1; i >= 0 && this.log[i] !== seen; i--) ev.unshift(this.log[i].type);
        seen = this.log[this.log.length - 1] || seen;
        this._rec.push({
          t: +this.ctx.currentTime.toFixed(2),
          rms: +dB(this._level(this.meters.master)).toFixed(1),
          water: +dB(this._level(this.meters.water)).toFixed(1),
          air: +dB(this._level(this.meters.air)).toFixed(1),
          body: +dB(this._level(this.meters.body)).toFixed(1),
          cen: this._centroid(this.meters.master),
          v: this.synth.voices(),
          ev,
        });
      } catch { /* keep logging */ }
    }, ms);
    return true;
  }

  stopLog() {
    clearInterval(this._recTimer);
    const r = this._rec || [];
    this._rec = null;
    return r;
  }

  // Render one recipe in an OfflineAudioContext and measure it.
  // name: stroke | runup | creak | lunge | gulp | fizz | blow-humpback | blow-blue |
  //       blow-sperm | heartbeat | plunge-down | plunge-up | breach-exit |
  //       impact-air | impact-water | gull | song | blue-A | blue-B | ship | chime | tick
  static RECIPES = {
    stroke: [2, (S, o) => S.stroke(o, 0.05, { k: 0.7, period: 1.6 })],
    runup: [1.5, (S, o) => S.stroke(o, 0.05, { k: 1.3, period: 0.9, runup: true })],
    creak: [1.5, (S, o) => S.creak(o, 0.05, { k: 1 })],
    lunge: [1.6, (S, o) => S.lungeRush(o, 0.05, { p: 1 })],
    gulp: [1.8, (S, o) => S.gulp(o, 0.05, { k: 1 })],
    fizz: [0.8, (S, o) => S.fizz(o, 0.05, { k: 0.8 })],
    'blow-humpback': [4, (S, o) => S.blow(o, 0.05, { sp: 'humpback' })],
    'blow-blue': [6, (S, o) => S.blow(o, 0.05, { sp: 'blue' })],
    'blow-sperm': [3, (S, o) => S.blow(o, 0.05, { sp: 'sperm' })],
    heartbeat: [1, (S, o) => S.heartbeat(o, 0.05, { k: 0.9 })],
    'plunge-down': [1.2, (S, o) => S.plunge(o, 0.05, { down: true })],
    'plunge-up': [1, (S, o) => S.plunge(o, 0.05, { down: false })],
    'breach-exit': [3.2, (S, o) => S.surfaceBreak(o, 0.05, { k: 1 })],
    'impact-air': [4, (S, o) => S.impact({ ...o, water: S.gain(0) }, 0.05, { k: 1 })],
    'impact-water': [4, (S, o) => S.impact({ ...o, air: S.gain(0) }, 0.05, { k: 1 })],
    gull: [2, (S, o) => S.gull(o, 0.05, { n: 3 })],
    song: [14, (S, o) => S.songPhrase(o, 0.05, { a: 0.1 })],
    'blue-A': [8, (S, o) => S.blueCall(o, 0.05, { type: 'A' })],
    'blue-B': [12, (S, o) => S.blueCall(o, 0.05, { type: 'B' })],
    ship: [20, (S, o) => S.ship(o, 0.05, { dur: 20 })],
    chime: [3.5, (S, o) => S.chime(o, 0.05)],
    tick: [0.3, (S, o) => S.tick(o, 0.05, { kind: 'tick' })],
  };

  static async renderOffline(name, { sampleRate = 44100 } = {}) {
    const R = GameAudio.RECIPES[name];
    if (!R || !OAC) return null;
    const [secs, fn] = R;
    const oc = new OAC(2, Math.ceil(sampleRate * secs), sampleRate);
    const S = new Synth(oc);
    const out = oc.createGain();
    out.connect(oc.destination);
    const o = { both: out, air: out, water: out, far: out, fx: out, body: out, ui: out };
    fn(S, o);
    const buf = await oc.startRendering();
    return { name, ...analyseBuffer(buf) };
  }

  // Audio-thread cost: render the full live graph (all beds running, a busy
  // moment of one-shots) offline and compare wall time with audio time.
  static async benchmark(secs = 10, sampleRate = 48000) {
    if (!OAC) return null;
    const oc = new OAC(2, Math.ceil(secs * sampleRate), sampleRate);
    const a = new GameAudio({});
    a._graph(oc);
    a.master.gain.value = 0.64;
    a.airOut.gain.value = 0.5; // both media audible: worst case
    for (const [k, v] of Object.entries({ bed: 0.15, sea: 0.03, surf: 0.1, shrimp: 0.08, rush: 0.2, gurgle: 0.1, sieve: 0.02, wind: 0.1, whistle: 0.01, waves: 0.1, crest: 0.03, hum: 0.01 })) a.loops[k].g.gain.value = v;
    const S = a.synth, W = a.routes.whale, L = a.routes.life;
    for (let t = 0.1; t < secs; t += 0.8) S.stroke(W, t, { k: 0.8, period: 1.6 });
    S.songPhrase(L, 0.2); S.blueCall(L, 0.5, { type: 'B' }); S.ship(L, 0.1, { dur: secs });
    S.lungeRush(W, 1); S.gulp(W, 2.2); S.blow(W, 3, { sp: 'blue' }); S.surfaceBreak(W, 5); S.impact(W, 7);
    for (let t = 0.3; t < secs; t += 1.3) S.heartbeat(W, t);
    const t0 = performance.now();
    await oc.startRendering();
    const ms = performance.now() - t0;
    return { audioSeconds: secs, renderMs: Math.round(ms), realtimeFactor: +((secs * 1000) / ms).toFixed(1), cpuPct: +((ms / (secs * 1000)) * 100).toFixed(1) };
  }

  async renderAll() {
    const out = [];
    for (const name of Object.keys(GameAudio.RECIPES)) {
      try { out.push(await GameAudio.renderOffline(name)); } catch (e) { out.push({ name, error: e.message }); }
    }
    return out;
  }
}

function o2Low(phys) { return phys.o2 < 0.3; }
