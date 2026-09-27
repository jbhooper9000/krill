// Headless playtest harness: serves the game, drives it in headless Chrome via
// the DevTools protocol, samples state and saves screenshots.
//
//   node tools/playtest.mjs [species] [scenario] [--out dir] [--port n]
//
// scenarios: play (swim/turn/lunge/glide), side (side-on camera sequence),
//            feed (swim through a krill cloud), shots (static views: behind,
//            side, above-surface, looking up, deep), above (camera above the
//            surface: breach views, horizon, straddling the waterline),
//            breach, breathe (blackout -> recovery), blow (spouts),
//            menu (species select over the live ocean, no autostart; also a
//            narrow-window shot), hud (HUD states over bright + dark water,
//            breach ready, denial, O2 veil), pause (pause screen),
//            tune (tuning panel), onboard (first-time hints + prey cue),
//            daycard (end-of-day card), audio (unlock the procedural sound,
//            offline-render every recipe, then log live levels/spectra through
//            swim, lunge, low O2, blackout, blows, breach, night life, mute),
//            noaudio (no AudioContext at all: must run without errors)
// Headless Chrome renders with SwiftShader (software), so expect ~5-10 fps —
// game time (dt clamped to 0.05) runs slower than wall time.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : def;
};
const out = path.resolve(opt('out', path.join(root, '.playtest')));
const port = Number(opt('port', 5300 + Math.floor(Math.random() * 500)));
const [species = 'humpback', scenario = 'play'] = args;
fs.mkdirSync(out, { recursive: true });

const chromePaths = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const chrome = chromePaths.find((p) => fs.existsSync(p));
const cdpPort = port + 1000;

const server = spawn(process.execPath, [path.join(root, 'serve.js')], {
  env: { ...process.env, PORT: String(port) },
  stdio: 'ignore',
});
const browser = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${cdpPort}`, '--window-size=1280,720',
  // PT_GPU=1 renders on the real GPU (for perf numbers) instead of SwiftShader
  ...(process.env.PT_GPU ? ['--use-angle=d3d11', '--enable-gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  '--ignore-gpu-blocklist',
  `--user-data-dir=${path.join(out, '.chrome-profile')}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const logs = [];
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
async function evaljs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
// like evaljs, but counts as a user gesture (browser autoplay rules)
async function evalGesture(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, `${species}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('screenshot', file);
}
const key = (type, code, k) =>
  send('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 });
const mouse = (type, x, y, button = 'left') =>
  send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1 });
const drag = async (dx, dy, steps = 20) => {
  await mouse('mousePressed', 640, 360);
  for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', 640 + (dx * i) / steps, 360 + (dy * i) / steps); await sleep(30); }
  await mouse('mouseReleased', 640 + dx, 360 + dy);
};
const sample = () => evaljs(`(() => { const c = krill.controller; const w = krill.whale;
  return { pos: c.position.toArray().map(v=>+v.toFixed(2)), speed: +c.speed.toFixed(2), yaw: +c.yaw.toFixed(3),
    pitch: +c.pitch.toFixed(3), roll: +c.roll.toFixed(3), thrust: +c.thrust.toFixed(2), eaten: krill.krill.totalEaten,
    err: document.getElementById('error-screen').classList.contains('hidden') ? null : document.getElementById('error-message').textContent }; })()`);
const fps = () => evaljs(`new Promise(r => { let n=0; const t0=performance.now(); function f(){ n++; if (performance.now()-t0<2000) requestAnimationFrame(f); else r(+(n/((performance.now()-t0)/1000)).toFixed(1)); } requestAnimationFrame(f); })`);
// Pin the camera relative to the whale: offsets are in whale lengths.
const pinCamera = (ox, oy, oz, lookUp = 0) => evaljs(`krill.controller._updateCamera = function(){ const p=this.position; const L=this.sp.length;
  this.camera.position.set(p.x + L*${ox}, p.y + L*${oy}, p.z + L*${oz}); this.camera.lookAt(p.x, p.y + L*${lookUp}, p.z); }; 1`);
const keyTap = async (code, k, ms = 120) => { await key('keyDown', code, k); await sleep(ms); await key('keyUp', code, k); };
const viewport = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
// HUD element opacities, to check the idle/visible logic without eyeballing
const hudState = () => evaljs(`(() => { const o = {}; for (const el of document.querySelectorAll('.hud-el'))
  o[el.id] = +getComputedStyle(el).opacity; o.body = document.body.className; o.hud = document.getElementById('hud').className;
  o.prompt = document.getElementById('hud-prompt').textContent; o.hint = document.getElementById('hud-hint').textContent; o.camY = +krill.camera.position.y.toFixed(2); return o; })()`);
const hideHud = () => evaljs(`document.getElementById('hud').style.display='none'; 1`);

const noAutostart = new Set(['menu']);
// scripts injected before the page loads, per scenario
const preload = {
  noaudio: 'delete window.AudioContext; delete window.webkitAudioContext; delete window.OfflineAudioContext; delete window.webkitOfflineAudioContext;',
};
const errorsOnPage = () => evaljs(`document.getElementById('error-screen').classList.contains('hidden') ? null : document.getElementById('error-message').textContent`);
const scenarios = {
  // The harness can't hear: prove the sound layer structurally. (1) every
  // recipe rendered offline has a sensible level, length and spectrum; (2) the
  // live mix reacts to each game event (master RMS / spectral centroid log).
  async audio() {
    const A = 'krill.audio';
    console.log('unlock', await evalGesture(`${A}.unlock() && (${A}.setMuted(false), ${A}.setVolume(0.8), true)`));
    await sleep(800);
    console.log('debug', JSON.stringify(await evaljs(`${A}.debug()`)));
    const renders = await evaljs(`${A}.renderAll()`);
    console.log('--- offline renders (peak/RMS dBFS, onset s, active s = within 30 dB of max, centroid Hz, share < 120 Hz) ---');
    for (const r of renders) console.log('render', JSON.stringify(r));
    console.log('benchmark (full graph offline)', JSON.stringify(await evaljs(`${A}.constructor.benchmark()`)));
    await evaljs(`${A}.startLog(100)`);
    const mark = (label) => evaljs(`${A}._note('@' + ${JSON.stringify(label)}); 1`);
    const phase = async (label, ms) => { await mark(label); await sleep(ms); };
    await phase('idle', 2500);
    await key('keyDown', 'KeyW', 'w');
    await phase('swim', 4000);
    await mark('turn');
    await drag(-320, 0, 25);
    await sleep(1500);
    await mark('lunge');
    await mouse('mousePressed', 640, 360, 'right'); await sleep(1000); await mouse('mouseReleased', 640, 360, 'right');
    await sleep(5000);
    await key('keyUp', 'KeyW', 'w');
    // low O2 at depth: heartbeat, then blackout -> forced ascent -> blows at the surface
    await evaljs(`(() => { const c = krill.controller; c.position.set(0, -20, 0); krill.phys.o2 = 0.2; return 1; })()`);
    await phase('lowO2', 5000);
    await evaljs(`krill.phys.o2 = 0.01; 1`);
    await mark('blackout');
    for (let n = 0; n < 50; n++) {
      await sleep(500);
      const s = await evaljs(`({ y: +krill.controller.position.y.toFixed(1), o2: +krill.phys.o2.toFixed(2), blackout: krill.phys.blackout, uw: krill.world.isCameraUnderwater })`);
      if (n % 4 === 0) console.log('breathe', JSON.stringify(s));
      if (!s.blackout && s.o2 > 0.5) break;
    }
    await phase('surface', 3000);
    // breach (surge full, 1.9 L deep)
    await evaljs(`(() => { krill.surge = 1; const c = krill.controller; c.position.set(0, -1.9 * c.sp.length, 0); krill.phys.o2 = 1; return 1; })()`);
    await key('keyDown', 'KeyW', 'w');
    await sleep(500);
    await mark('breach');
    await key('keyDown', 'KeyF', 'f');
    let landed = false, air = false;
    for (let n = 0; n < 80 && !landed; n++) {
      await sleep(300);
      const m = await evaljs(`krill.controller.mode`);
      if (m === 'air') air = true;
      if (air && m === 'swim') landed = true;
    }
    await key('keyUp', 'KeyF', 'f');
    await key('keyUp', 'KeyW', 'w');
    await phase('landed', 4000);
    // night: song, blue-whale calls and a ship forced now instead of waiting minutes
    await evaljs(`(() => { const c = krill.controller; c.position.set(0, -25, 0); krill.clock.hours = 23; krill.world.setTimeOfDay(23); return 1; })()`);
    await sleep(600);
    await evaljs(`${A}._s.songT = 0; 1`);
    await phase('night-song', 7000);
    await evaljs(`${A}._s.blueT = 0; ${A}._s.songT = 99; 1`);
    await phase('blue-call', 8000);
    await evaljs(`${A}._s.shipT = 0; 1`);
    await phase('ship', 8000);
    // shallow reef at night: surf, snapping shrimp and the midshipman hum come up
    await evaljs(`(() => { krill._hAt = krill.terrain.heightAt; krill.terrain.heightAt = () => -12;
      const c = krill.controller; c.position.set(0, -8, 0); return 1; })()`);
    await sleep(2500);
    console.log('shallow-night loops', JSON.stringify((await evaljs(`${A}.debug()`)).loopGains));
    await evaljs(`krill.terrain.heightAt = krill._hAt; 1`);
    // pause (world ducks + muffles), then mute (context suspends)
    await keyTap('Escape', 'Escape');
    await phase('paused', 1500);
    await evalGesture(`${A}.setMuted(true); 1`);
    await sleep(800);
    const muted = await evaljs(`${A}.debug()`);
    await evalGesture(`${A}.setMuted(false); 1`);
    await sleep(800);
    const unmuted = await evaljs(`${A}.debug()`);
    console.log('mute', JSON.stringify({ muted: muted.state, unmuted: unmuted.state, gain: await evaljs(`+${A}.master.gain.value.toFixed(3)`) }));
    const log = await evaljs(`${A}.stopLog()`);
    fs.writeFileSync(path.join(out, `${species}-audio-log.json`), JSON.stringify(log));
    // summary: per marked phase, the master level and centroid and the events that fired
    console.log('--- live log (samples every 100 ms), per phase ---');
    let phaseName = 'start';
    const rows = {};
    for (const s of log) {
      for (const e of s.ev) if (e.startsWith('@')) phaseName = e.slice(1);
      const r = (rows[phaseName] ||= { n: 0, rms: [], cen: [], water: [], air: [], body: [], v: 0, ev: {} });
      r.n++; r.rms.push(s.rms); r.cen.push(s.cen); r.water.push(s.water); r.air.push(s.air); r.body.push(s.body);
      r.v = Math.max(r.v, s.v);
      for (const e of s.ev) if (!e.startsWith('@')) r.ev[e] = (r.ev[e] || 0) + 1;
    }
    const med = (a) => { const b = a.filter((v) => v > -150).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : -180; };
    const max = (a) => Math.max(...a);
    for (const [k, r] of Object.entries(rows)) {
      console.log('phase', k.padEnd(11), JSON.stringify({ samples: r.n, rmsMed: med(r.rms), rmsMax: max(r.rms), centroidMed: med(r.cen),
        waterMax: max(r.water), airMax: max(r.air), bodyMax: max(r.body), maxOneShots: r.v, events: r.ev }));
    }
    console.log('debug', JSON.stringify(await evaljs(`${A}.debug()`)));
    console.log('errors on page', await errorsOnPage());
  },
  // No Web Audio at all (e.g. a locked-down browser): the game must run silently.
  async noaudio() {
    console.log('supported', await evaljs(`JSON.stringify(krill.audio.debug())`));
    console.log('unlock', await evalGesture(`krill.audio.unlock()`));
    await key('keyDown', 'KeyW', 'w');
    await sleep(2000);
    await mouse('mousePressed', 640, 360, 'right'); await sleep(900); await mouse('mouseReleased', 640, 360, 'right');
    await sleep(1500);
    await evaljs(`(() => { krill.audio.event('blow', {}); krill.audio.event('splash', { speed: 8, attitude: 1 }); krill.audio.ui('tick');
      krill.audio.setVolume(0.5); krill.audio.setMuted(true); return 1; })()`);
    await keyTap('Escape', 'Escape');
    await sleep(600);
    console.log('pause audio controls', await evaljs(`document.getElementById('sound-btn').textContent + ' | disabled=' + document.getElementById('sound-vol').disabled`));
    console.log('errors on page', await errorsOnPage());
  },
  async menu() {
    await shot('menu');
    await keyTap('ArrowRight', 'ArrowRight');
    await sleep(2500);
    await shot('menu-next');
    await keyTap('ArrowLeft', 'ArrowLeft');
    await sleep(1500);
    await viewport(480, 820);
    await sleep(1500);
    await shot('menu-narrow');
    await viewport(1280, 720);
    await keyTap('Enter', 'Enter');
    await sleep(2500);
    console.log('after enter', JSON.stringify({ running: await evaljs('krill.running'), hud: await hudState() }));
    await shot('menu-dived');
  },
  async hud() {
    await sleep(600);
    console.log('start', JSON.stringify(await hudState()));
    await shot('hud-0-start');
    await key('keyDown', 'KeyW', 'w');
    await sleep(2500);
    // bright water near the surface, part-charged surge, lunge charging, depth moving
    await evaljs(`(() => { krill.surge = 0.62; const c = krill.controller; c.position.y = -3; c._aimPitchTarget = 0.35; return 1; })()`);
    await sleep(1200);
    await mouse('mousePressed', 640, 360, 'right'); await sleep(700);
    console.log('bright', JSON.stringify(await hudState()));
    await shot('hud-1-bright');
    await mouse('mouseReleased', 640, 360, 'right');
    await sleep(300);
    await shot('hud-1b-lunge-burst');
    // dark water near the floor, diving
    await evaljs(`(() => { const c = krill.controller; c.position.y = c.bounds.floorAt(c.position.x, c.position.z) + c.sp.length * 0.4 + 6; c._aimPitchTarget = -0.5; return 1; })()`);
    await sleep(1500);
    console.log('dark', JSON.stringify(await hudState()));
    await shot('hud-2-dark');
    // breach ready inside the window
    await evaljs(`(() => { const c = krill.controller; c._aimPitchTarget = 0; c.position.y = -2 * c.sp.length; krill.surge = 1; return 1; })()`);
    await sleep(1500);
    console.log('ready', JSON.stringify(await hudState()));
    await shot('hud-3-breach-ready');
    // denial: too shallow
    await evaljs(`(() => { const c = krill.controller; c.position.y = -0.4 * c.sp.length; return 1; })()`);
    await sleep(900);
    await keyTap('KeyF', 'f');
    await sleep(500);
    console.log('denied', JSON.stringify(await hudState()));
    await shot('hud-4-denied');
    // post-breach toast (text as Game.js formats it)
    await evaljs(`krill.ui.toast('Breach · 82% clear · twist 150°'); 1`);
    await sleep(600);
    await shot('hud-5-toast');
    // O2: low (veil + amber arc), then blackout
    await evaljs(`krill.ui.setO2(0.2, { atSurface: false }); 1`);
    await sleep(900);
    await shot('hud-6-o2-low');
    await evaljs(`krill.ui.setO2(0.02, { blackout: true }); 1`);
    await sleep(900);
    await shot('hud-7-blackout');
    await evaljs(`krill.ui.setO2(1, {}); 1`);
    await key('keyUp', 'KeyW', 'w');
    await viewport(480, 820);
    await evaljs(`(() => { const c = krill.controller; c.position.y = -2 * c.sp.length; krill.ui.toast('Breach · 82% clear · twist 150°'); return 1; })()`);
    await sleep(1200);
    await shot('hud-8-narrow');
    await viewport(1280, 720);
  },
  // First-time onboarding: swim hint, first dive (krill layer), low air,
  // nearest-patch hint, prey cue at the screen edge.
  async onboard() {
    await sleep(1500);
    await shot('onboard-0-swim');
    await key('keyDown', 'KeyW', 'w');
    await sleep(4000);
    await evaljs(`(() => { const c = krill.controller; c.position.y = -16; c._aimPitchTarget = -0.4; return 1; })()`);
    await sleep(3000);
    console.log('food', JSON.stringify(await hudState()));
    await shot('onboard-1-food');
    await evaljs(`krill.phys.o2 = 0.5; 1`);
    await sleep(2500);
    console.log('air', JSON.stringify(await hudState()));
    await shot('onboard-2-air');
    await evaljs(`krill.phys.o2 = 1; 1`);
    await key('keyUp', 'KeyW', 'w');
    // prey cue: hungry, nearest patch out of view
    await evaljs(`(() => { const c = krill.controller; c._aimYawTarget += Math.PI; return 1; })()`);
    await sleep(3000);
    console.log('cue', await evaljs(`(() => { const e = document.getElementById('prey-cue'); return e.className + ' ' + e.style.transform; })()`));
    await shot('onboard-3-cue');
    // within 80 m of a patch
    await evaljs(`(() => { const c = krill.controller; const h = krill.krill.krillClouds[0].homeCenter;
      c.position.set(h.x + 40, h.y + 10, h.z + 50); c.velocity.set(0, 0, 0); c.speed = 0; return 1; })()`);
    await sleep(3500);
    console.log('patch', JSON.stringify(await hudState()));
    await shot('onboard-4-patch');
    // O2 below 25 %: amber arc; then out of air: blackout prompt above the veil
    await evaljs(`(() => { krill.controller.position.y = -30; krill.phys.o2 = 0.2; return 1; })()`);
    await sleep(2500);
    await shot('onboard-5-o2-amber');
    await evaljs(`krill.phys.o2 = 0.001; 1`);
    await sleep(2500);
    console.log('blackout', JSON.stringify(await hudState()));
    await shot('onboard-6-blackout');
  },
  // End-of-day card: jump the day clock to midnight and let the game end the day.
  async daycard() {
    // the day now ends at the next breath: put the whale at the surface first
    await evaljs(`(() => { const c = krill.controller; c.position.y = c.bounds.maxY; c.velocity.set(0, 0, 0); return 1; })()`);
    await sleep(1000);
    await evaljs(`(() => { krill.phys.stats = { kg: 1240, dives: 14, lunges: 23, breaches: 3, blackouts: 0, bestLunge: 61 };
      krill._dayTime = 24 * 3600 / 36; return 1; })()`);
    await sleep(3500);
    console.log('card', await evaljs(`document.getElementById('pause-title').textContent + ' | ' + document.getElementById('day-outcome').textContent`));
    await shot('daycard');
    await viewport(480, 820);
    await sleep(1200);
    await shot('daycard-narrow');
    await viewport(1280, 720);
    await keyTap('Enter', 'Enter');
    await sleep(1500);
    console.log('next day', await evaljs('krill.day'), 'paused', await evaljs('krill.paused'));
  },
  async tune() {
    await sleep(800);
    await keyTap('KeyT', 't');
    await sleep(1200);
    await shot('tune');
    await keyTap('KeyT', 't');
  },
  async pause() {
    await key('keyDown', 'KeyW', 'w');
    await sleep(1500);
    await key('keyUp', 'KeyW', 'w');
    await evaljs(`krill.ui.setCondition(58, 75); krill.ui.setClock(14, 32); 1`);
    await keyTap('Escape', 'Escape', 900);
    await sleep(2500);
    console.log('paused', await evaljs('krill.paused'), await evaljs(`document.getElementById('pause-stats').textContent`));
    await shot('pause');
    await evaljs(`document.querySelector('[data-map-level=region]').click(); 1`);
    await sleep(2500);
    await shot('pause-region');
    await evaljs(`document.querySelector('[data-map-level=bay]').click(); 1`);
    await viewport(480, 820);
    await sleep(800);
    await shot('pause-narrow');
    await viewport(1280, 720);
    await keyTap('Enter', 'Enter');
    await sleep(600);
    console.log('resumed', !(await evaljs('krill.paused')));
  },
  async play() {
    console.log('t0', JSON.stringify(await sample()));
    await shot('play-0-idle');
    await key('keyDown', 'KeyW', 'w');
    await sleep(3000);
    console.log('swim', JSON.stringify(await sample()));
    await shot('play-1-swim');
    await drag(-240, 0);
    console.log('turn', JSON.stringify(await sample()));
    await shot('play-2-turn');
    await sleep(2000);
    await mouse('mousePressed', 640, 360, 'right'); await sleep(1000); await mouse('mouseReleased', 640, 360, 'right');
    await sleep(400);
    console.log('lunge', JSON.stringify(await sample()));
    await shot('play-3-lunge');
    await key('keyUp', 'KeyW', 'w');
    await sleep(2000);
    console.log('glide', JSON.stringify(await sample()));
    await shot('play-4-glide');
  },
  async side() {
    await hideHud();
    await pinCamera(1.6, 0.15, 0.1);
    await key('keyDown', 'KeyW', 'w');
    await sleep(2500);
    for (let n = 0; n < 4; n++) { await shot(`side-${n}`); await sleep(350); }
    await drag(-280, 0);
    await shot('side-turn');
    await mouse('mousePressed', 640, 360, 'right'); await sleep(1000); await mouse('mouseReleased', 640, 360, 'right');
    await sleep(600);
    await shot('side-lunge');
  },
  async feed() {
    await evaljs(`(() => { const c = krill.controller; const h = krill.krill.krillClouds[0].homeCenter;
      c.position.set(h.x, h.y, h.z + 12); c.velocity.set(0,0,0); c.speed = 0; return 1; })()`);
    await key('keyDown', 'KeyW', 'w');
    for (let n = 0; n < 6; n++) { await sleep(1500); console.log('feed', JSON.stringify(await sample())); }
    await shot('feed');
  },
  // Charge the surge, start deep, hold F: logs the arc + screenshots.
  // Pass --view side to pin a side-on camera just above the waterline.
  async breach() {
    const view = opt('view', 'follow');
    await evaljs(`(() => { krill.surge = 1; const c = krill.controller;
      c.position.set(0, -1.9 * c.sp.length, 0); return 1; })()`);
    if (view === 'side') { await hideHud(); await pinCamera(2.2, 0, 0.3); }
    await key('keyDown', 'KeyW', 'w');
    await sleep(600);
    await key('keyDown', 'KeyF', 'f');
    let shots = 0, lastMode = 'swim', splashed = false;
    for (let n = 0; n < 70; n++) {
      await sleep(350);
      const s = await evaljs(`(() => { const c = krill.controller; return { mode: c.mode, y: +c.position.y.toFixed(2),
        vy: +c.velocity.y.toFixed(2), pitch: +c.pitch.toFixed(2), roll: +c.roll.toFixed(2), speed: +c.speed.toFixed(1),
        runup: c._runup, ts: +c.timeScale.toFixed(2), surge: +krill.surge.toFixed(2), breaches: krill.breaches,
        toast: document.getElementById('toast').textContent, prompt: document.getElementById('hud-prompt').textContent, hud: document.getElementById('hud').className, body: document.body.className, camY: +krill.camera.position.y.toFixed(1),
        spray: krill.splash.spray.alpha.reduce((a, v) => a + (v > 0), 0),
        bubbles: krill.splash.bubbles.alpha.reduce((a, v) => a + (v > 0), 0) }; })()`);
      console.log('breach', JSON.stringify(s));
      if (s.mode === 'air' && shots < 3 && n % 2 === 0) await shot(`breach-air-${shots++}`);
      if (lastMode === 'air' && s.mode === 'swim') splashed = true;
      if (splashed && shots < 6) { await shot(`breach-splash-${shots++}`); }
      lastMode = s.mode;
      if (shots >= 6) break;
    }
  },
  // Nearly out of air at depth: expect blackout -> forced ascent -> blows -> recovery.
  async breathe() {
    await evaljs(`(() => { const c = krill.controller; c.position.set(0, -9, 0); krill.phys.o2 = 0.01; return 1; })()`);
    for (let n = 0; n < 60; n++) {
      await sleep(400);
      const s = await evaljs(`(() => { const c = krill.controller, p = krill.phys; return { y: +c.position.y.toFixed(1),
        pitch: +c.pitch.toFixed(2), o2: +p.o2.toFixed(2), blackout: p.blackout, atSurface: c.atSurface,
        cond: +p.condition.toFixed(1), dives: p.stats.dives, veil: document.getElementById('o2-veil')?.className,
        prompt: document.getElementById('hud-prompt').textContent }; })()`);
      console.log('breathe', JSON.stringify(s));
      if (n === 30) await shot('breathe-surface');
    }
  },
  // Whale at the surface with low O2, camera just above water: photograph the blows.
  async blow() {
    await hideHud();
    await evaljs(`(() => { const c = krill.controller; c.position.set(0, c.bounds.maxY, 0); krill.phys.o2 = 0.3; return 1; })()`);
    await pinCamera(0.5, 0.15, 0.9, 0.35);
    for (let n = 0; n < 12; n++) {
      await sleep(300);
      const s = await evaljs(`({ o2: +krill.phys.o2.toFixed(2), atSurface: krill.controller.atSurface, spray: krill.splash.spray.alpha.reduce((a, v) => a + (v > 0), 0) })`);
      console.log('blow', JSON.stringify(s));
      if (s.spray > 100) await shot(`blow-${n}`);
    }
  },
  async shots() {
    await hideHud();
    await key('keyDown', 'KeyW', 'w');
    await sleep(1500);
    await key('keyUp', 'KeyW', 'w');
    await shot('shots-behind');
    await pinCamera(1.4, 0.1, 0.4); await sleep(600); await shot('shots-side');
    await pinCamera(0.8, -0.6, 0.8, 3); await sleep(600); await shot('shots-looking-up');
    await evaljs(`krill.controller.position.y = -2; 1`);
    await pinCamera(1.2, 0.6, 1.2); await sleep(600); await shot('shots-near-surface');
    await evaljs(`(() => { const p = krill.controller.position; p.y = krill.terrain.heightAt(p.x, p.z) + krill.controller.sp.length * 0.6; return 1; })()`);
    await pinCamera(1.4, 0.2, 0.6); await sleep(900); await shot('shots-deep');
  },
  // Monterey terrain: canyon wall, canyon view, shelf, far overview, a 5 km
  // floating-origin round trip, heightAt sanity vs the chart, and perf counters.
  async terrain() {
    await evaljs(`krill.terrain.ready.then(() => 1)`);
    // software rendering runs at ~2 fps: give chunk building a bigger per-frame budget
    await evaljs(`krill.terrain.options.buildBudgetMs = 40; 1`);
    await sleep(1500);
    const info = (label) => evaljs(`(() => { const t = krill.terrain, c = krill.controller, p = c.position;
      const r = t.regionAt(p.x, p.z); const ll = t.unproject(p.x + t.origin.x, p.z + t.origin.y);
      return { label: ${JSON.stringify(label)}, scene: p.toArray().map(v => +v.toFixed(1)), origin: [t.origin.x, t.origin.y],
        latlon: [+ll.lat.toFixed(4), +ll.lon.toFixed(4)], floor: +t.heightAt(p.x, p.z).toFixed(1), region: r && r.name,
        chunks: t.stats.chunks, pending: t.stats.pending, tiles: t.stats.tiles, terrainTris: t.stats.triangles,
        drawTris: krill.renderer.info.render.triangles, calls: krill.renderer.info.render.calls, rebases: t.stats.rebases }; })()`);
    // teleport the whale to lat/lon (or scene x/z) at `above` metres over the floor, heading yaw
    const teleport = (lat, lon, above, yaw = 0) => evaljs(`(() => { const t = krill.terrain, c = krill.controller;
      const [X, Z] = t.project(${lat}, ${lon}); const x = X - t.origin.x, z = Z - t.origin.y;
      c.position.set(x, Math.min(-4, t.heightAt(x, z) + ${above}), z); c.velocity.set(0, 0, 0); c.speed = 0;
      c.yaw = c.aimYaw = c._aimYawTarget = ${yaw}; c.pitch = 0; c._updateCamera(0, true); return 1; })()`);
    // clear-water debug view: freeze depth fog so macro shape is visible
    // (the water model ignores fog density: scale its beam extinction and light
    // attenuation down by `k` and raise the light floor instead)
    const clearWater = (density, far, near = 0.1) => evaljs(`(() => { const w = krill.world; w.setDepth = () => ({}); krill.scene.fog.density = ${density};
      const k = ${density} === 0 ? 0.004 : Math.min(1, ${density} / 0.016) * 0.35;
      if (!w._opticsBackup) w._opticsBackup = JSON.parse(JSON.stringify(w.optics));
      const b = w._opticsBackup; w.optics.ext = b.ext.map((v) => v * k); w.optics.kd = b.kd.map((v) => v * Math.max(k, 0.05));
      w.optics.floor = Math.max(b.floor, 0.35); w._extScale = 1; w._writeOptics();
      krill.camera.far = ${far}; krill.camera.near = ${near}; krill.camera.updateProjectionMatrix(); return 1; })()`);

    console.log('sanity', JSON.stringify(await evaljs(`(() => { const t = krill.terrain; const pts = {
      'canyon head 36.8025N 121.808W': [36.8025, -121.808], 'Monterey Canyon axis 36.7806N 121.955W': [36.7806, -121.9549],
      'canyon axis 36.6939N 122.054W': [36.6939, -122.0537], 'southern shelf 36.70N 121.88W': [36.70, -121.88],
      'Santa Cruz shelf 36.90N 122.05W': [36.90, -122.05], 'Soquel Canyon 36.826N 121.977W': [36.8259, -121.9767],
      'Carmel Canyon 36.547N 122.006W': [36.5466, -122.0061], 'MARS 36.713N 122.187W (891 m)': [36.7128, -122.1868],
      'Santa Cruz wharf end': [36.9563, -122.0171], 'Point Pinos lighthouse': [36.6335, -121.9335] };
      const o = {}; for (const [k, [la, lo]] of Object.entries(pts)) { const [X, Z] = t.project(la, lo);
        const x = X - t.origin.x, z = Z - t.origin.y; const r = t.regionAt(x, z); o[k] = [+t.heightAt(x, z).toFixed(0), r && r.name]; }
      return o; })()`)));
    console.log(JSON.stringify(await info('start')));
    await hideHud();

    // perf: whole-frame triangles/draw calls, and fps with vs without the terrain
    const frameInfo = () => evaljs(`new Promise(r => { const i = krill.renderer.info; i.autoReset = false;
      requestAnimationFrame(() => { i.reset(); requestAnimationFrame(() => { const o = { tris: i.render.triangles, calls: i.render.calls };
      i.autoReset = true; r(o); }); }); })`);
    console.log('perf with terrain', JSON.stringify({ ...(await frameInfo()), fps: await fps(), stats: await evaljs(`krill.terrain.stats`) }));
    await evaljs(`krill.terrain.setVisible(false); 1`);
    console.log('perf without terrain', JSON.stringify({ ...(await frameInfo()), fps: await fps() }));
    await evaljs(`krill.terrain.setVisible(true); 1`);

    // 0. as the game currently lights it (depth fog + dim light are the lighting pass's job)
    await key('keyDown', 'KeyW', 'w'); await sleep(2000); await key('keyUp', 'KeyW', 'w');
    await shot('terrain-0-start-as-lit');

    // floor detail in normal play lighting (no debug fog): shelf, reef, kelp
    const floraInfo = () => evaljs(`JSON.stringify(krill.terrain.stats.flora)`);
    await teleport(36.70, -121.88, 9, 0.6);
    await evaljs(`(() => { const c = krill.controller; c._aimPitchTarget = -0.35; return 1; })()`);
    await sleep(6000);
    console.log(JSON.stringify(await info('floor-shelf-76m')), await floraInfo());
    await shot('terrain-f1-shelf-76m');
    await teleport(36.925, -122.04, 7, 2.2);
    await evaljs(`(() => { const c = krill.controller; c._aimPitchTarget = -0.3; return 1; })()`);
    await sleep(6000);
    console.log(JSON.stringify(await info('floor-santa-cruz-shelf')), await floraInfo());
    await shot('terrain-f2-santa-cruz-shelf');
    await teleport(36.6395, -121.9395, 7, 1.2);
    await evaljs(`(() => { const c = krill.controller; c._aimPitchTarget = -0.3; return 1; })()`);
    await sleep(6000);
    console.log(JSON.stringify(await info('floor-point-pinos-reef')), await floraInfo());
    await shot('terrain-f3-point-pinos-reef');
    await teleport(36.6185, -121.8985, 1000, 2.6);
    await evaljs(`(() => { const c = krill.controller; c.position.y = -5; c._aimPitchTarget = -0.15; return 1; })()`);
    await sleep(7000);
    console.log(JSON.stringify(await info('kelp-cannery-row')), await floraInfo());
    await shot('terrain-f4-kelp-cannery-row');
    console.log('perf in kelp', JSON.stringify({ ...(await frameInfo()), fps: await fps(), stats: await evaljs(`krill.terrain.stats`) }));
    await teleport(36.5195, -121.9600, 1000, -Math.PI / 2);
    await evaljs(`(() => { const c = krill.controller; c.position.y = -9; c._aimPitchTarget = 0.1; return 1; })()`);
    await sleep(7000);
    console.log(JSON.stringify(await info('kelp-point-lobos')), await floraInfo());
    await shot('terrain-f5-kelp-point-lobos');

    // 1. behind the whale on the canyon's upper wall (light held at a 30 m zone, fog thinned)
    await evaljs(`krill.world.setDepth(30); 1`);
    await clearWater(0.009, 500);
    // low in the upper canyon, facing south up the wall toward the rim
    await teleport(36.7968, -121.868, 22, Math.PI);
    await sleep(2500);
    console.log(JSON.stringify(await info('canyon-wall')));
    await shot('terrain-1-canyon-wall');

    // 2. looking down into the canyon from the rim (fog thinned for the shot)
    await clearWater(0.0022, 6000);
    // whale hangs at 60 m over the upper canyon axis, camera behind, looking west down-canyon
    await teleport(36.7980, -121.872, 1000, Math.PI * 0.5);
    await evaljs(`(() => { const c = krill.controller; c.position.y = -60; c._updateCamera = function () { const p = this.position;
      this.camera.position.set(p.x + 50, p.y + 12, p.z); this.camera.lookAt(p.x - 500, p.y - 260, p.z); }; return 1; })()`);
    await sleep(4000);
    console.log(JSON.stringify(await info('canyon-down')));
    await shot('terrain-2-canyon-down');

    // 3. a shelf area (southern bay shelf, ~80 m)
    await evaljs(`delete krill.controller._updateCamera; krill.scene.fog.density = 0.006; 1`);
    await teleport(36.70, -121.88, 10, 0.6);
    await key('keyDown', 'KeyW', 'w'); await sleep(2500); await key('keyUp', 'KeyW', 'w');
    await sleep(1500);
    console.log(JSON.stringify(await info('shelf')));
    await shot('terrain-3-shelf');

    // 4. rebase round trip: teleport 5 km east and back, check nothing drifts
    const before = await evaljs(`(() => { const t = krill.terrain, p = krill.controller.position;
      return { abs: [p.x + t.origin.x, p.z + t.origin.y], h: t.heightAt(p.x, p.z), origin: [t.origin.x, t.origin.y], k: krill.krill.krillClouds[0].homeCenter.x + t.origin.x }; })()`);
    await evaljs(`(() => { const c = krill.controller; c.position.x += 5000; c._updateCamera(0, true); return 1; })()`);
    await sleep(2500);
    const away = await info('after +5 km');
    console.log(JSON.stringify(away));
    await evaljs(`(() => { const c = krill.controller; c.position.x -= 5000; c._updateCamera(0, true); return 1; })()`);
    await sleep(3000);
    const after = await evaljs(`(() => { const t = krill.terrain, p = krill.controller.position;
      return { abs: [p.x + t.origin.x, p.z + t.origin.y], h: t.heightAt(p.x, p.z), origin: [t.origin.x, t.origin.y], scene: [p.x, p.z],
        k: krill.krill.krillClouds[0].homeCenter.x + t.origin.x, rebases: t.stats.rebases }; })()`);
    console.log('rebase', JSON.stringify({ before, after,
      absDrift: Math.hypot(after.abs[0] - before.abs[0], after.abs[1] - before.abs[1]).toFixed(3),
      heightDiff: (after.h - before.h).toFixed(3) }));
    await shot('terrain-4-after-rebase');

    // 5. far overview: camera high over the bay looking across the canyon
    await clearWater(0, 200000, 20);
    await evaljs(`(() => { krill.world.surface.visible = false; krill.world.snow.visible = false; const t = krill.terrain, c = krill.controller;
      const [X, Z] = t.project(36.66, -121.86); const [TX, TZ] = t.project(36.76, -122.06);
      c.position.set(X - t.origin.x, -30, Z - t.origin.y); c._updateCamera = function () {
        this.camera.position.set(this.position.x, 9000, this.position.z);
        this.camera.lookAt(TX - t.origin.x, -900, TZ - t.origin.y); }; return 1; })()`);
    await sleep(9000);
    console.log(JSON.stringify(await info('overview')));
    await shot('terrain-5-overview');
    await evaljs(`(() => { const t = krill.terrain, c = krill.controller; const [X, Z] = t.project(36.75, -122.0);
      c._updateCamera = function () { this.camera.position.set(X - t.origin.x, 40000, Z - t.origin.y + 1);
        this.camera.lookAt(X - t.origin.x, 0, Z - t.origin.y); }; return 1; })()`);
    await sleep(9000);
    console.log(JSON.stringify(await info('top-down')));
    await shot('terrain-6-topdown');
  },
  // Coast + kelp pass (PLAYTEST_2 N5/N6). Absolute lat/lon views: the camera
  // and target are re-projected through terrain.origin every frame, so the
  // floating origin can rebase freely. Run with PT_GPU=1.
  async coast() {
    await hideHud();
    await evaljs(`(() => { krill.clock.hours = 13; krill.world.setTimeOfDay && krill.world.setTimeOfDay(13); krill.clock.update = () => {}; return 1; })()`);
    const view = async (name, cam, tgt, whale, wait = 6000) => {
      await evaljs(`(() => { const t = krill.terrain, c = krill.controller;
        const P = (ll) => { const [X, Z] = t.project(ll[0], ll[1]); return [X, ll[2], Z]; };
        const C = P(${JSON.stringify(cam)}), T = P(${JSON.stringify(tgt)}), W = P(${JSON.stringify(whale)});
        c.position.set(W[0] - t.origin.x, W[1], W[2] - t.origin.y); c.velocity.set(0, 0, 0); c.speed = 0;
        const dx = T[0] - W[0], dz = T[2] - W[2]; c.yaw = c.aimYaw = c._aimYawTarget = Math.atan2(-dx, -dz); c.pitch = 0;
        c._updateCamera = function () { this.camera.position.set(C[0] - t.origin.x, C[1], C[2] - t.origin.y);
          this.camera.lookAt(T[0] - t.origin.x, T[1], T[2] - t.origin.y); };
        krill.phys.o2 = 1; krill.effects.resetExposure && krill.effects.resetExposure(); return 1; })()`);
      await sleep(wait);
      const st = await evaljs(`(() => { const i = krill.renderer.info; return JSON.stringify({ terrain: krill.terrain.stats.triangles,
        flora: krill.terrain.stats.flora, chunks: krill.terrain.stats.chunks }); })()`);
      console.log(name, st);
      await shot(`coast-${name}`);
    };
    // Walk from `from` toward `to` until the floor rises above stopH; put the
    // camera there at camY, looking `ahead` metres further on at height tgtY.
    const shoreView = async (name, from, to, stopH, camY, ahead, tgtY) => {
      const p = await evaljs(`(() => { const t = krill.terrain; const [ax, az] = t.project(${from[0]}, ${from[1]}); const [bx, bz] = t.project(${to[0]}, ${to[1]});
        const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L; let d = 0;
        while (d < L && t.heightAtAbs(ax + ux * d, az + uz * d) < ${stopH}) d += 2;
        const c = t.unproject(ax + ux * d, az + uz * d), g = t.unproject(ax + ux * (d + ${ahead}), az + uz * (d + ${ahead}));
        return [c.lat, c.lon, g.lat, g.lon, d]; })()`);
      console.log(name, 'camera at', p[4], 'm along the line');
      await view(name, [p[0], p[1], camY], [p[2], p[3], tgtY], [p[0], p[1], camY > 0 ? -8 : camY - 3]);
    };
    // kelp forest off Lovers Point / Point Pinos (~16 m of water)
    await view('kelp-inside', [36.64190, -121.93830, -9], [36.64230, -121.93760, -9], [36.64215, -121.93790, -9], 9000);
    const frameInfo = () => evaljs(`new Promise(r => { const i = krill.renderer.info; i.autoReset = false;
      requestAnimationFrame(() => { i.reset(); requestAnimationFrame(() => { const o = { tris: i.render.triangles, calls: i.render.calls };
      i.autoReset = true; r(o); }); }); })`);
    const ms = (f) => +(1000 / f).toFixed(1);
    const f1 = await fps(); const i1 = await frameInfo();
    await evaljs(`krill.terrain.flora.setVisible(false); 1`); const f2 = await fps(); const i2 = await frameInfo();
    await evaljs(`krill.terrain.setVisible(false); 1`); const f3 = await fps(); const i3 = await frameInfo();
    await evaljs(`krill.terrain.setVisible(true); krill.terrain.flora.setVisible(true); 1`);
    console.log('perf kelp-inside', JSON.stringify({ all: { ms: ms(f1), ...i1 }, noFlora: { ms: ms(f2), ...i2 }, noTerrain: { ms: ms(f3), ...i3 } }));
    await view('kelp-below', [36.64205, -121.93802, -14], [36.64240, -121.93770, 0], [36.64225, -121.93780, -11]);
    await view('kelp-above', [36.64120, -121.93900, 7], [36.64230, -121.93760, -1], [36.64205, -121.93802, -4]);
    // in-forest at 12 m (16 m of water), noon and golden hour
    const setT = (h) => evaljs(`(() => { krill.clock.hours = ${h}; krill.world.setTimeOfDay && krill.world.setTimeOfDay(${h}); return 1; })()`);
    await view('forest-noon', [36.64190, -121.93850, -12], [36.64240, -121.93760, -10], [36.64150, -121.93900, -12], 8000);
    await setT(19.2);
    await view('forest-golden', [36.64190, -121.93850, -12], [36.64240, -121.93760, -10], [36.64150, -121.93900, -12], 8000);
    await setT(13);
    await view('kelp-lobos-inside', [36.52470, -121.94930, -8], [36.52510, -121.94860, -8], [36.52486, -121.94899, -8]);
    // Point Pinos rocky shore
    await shoreView('pinos-above', [36.6450, -121.9450], [36.6335, -121.9335], -6, 4, 220, 2);
    await shoreView('pinos-under', [36.6450, -121.9450], [36.6335, -121.9335], -7, -4, 22, -2);
    // Santa Cruz Main Beach
    await shoreView('beach-above', [36.9520, -122.0195], [36.9650, -122.0190], -3, 4, 120, 1);
    await shoreView('beach-under', [36.9520, -122.0195], [36.9650, -122.0190], -6, -3, 20, -1.5);
    // reef at ~25 m off Point Pinos
    await view('reef-25m', [36.64400, -121.93230, -21], [36.64430, -121.93185, -26], [36.64421, -121.93196, -22]);
    const frame = await evaljs(`new Promise(r => { const i = krill.renderer.info; i.autoReset = false;
      requestAnimationFrame(() => { i.reset(); requestAnimationFrame(() => { const o = { tris: i.render.triangles, calls: i.render.calls };
      i.autoReset = true; r(o); }); }); })`);
    console.log('frame (reef view)', JSON.stringify(frame));
  },
  // Scripted steps for debugging: PT_STEPS='[["js expr", "shotName"], ...]'
  // (shotName may be null; each step waits 900 ms before the shot).
  async steps() {
    await hideHud();
    for (const [js, name] of JSON.parse(process.env.PT_STEPS || '[]')) {
      if (js) console.log('eval', JSON.stringify(await evaljs(js)));
      await sleep(900);
      if (name) await shot(name);
    }
  },
  // Playtest 3 lighting checks: caustics on shallow sand (noon, ~12 m of water
  // off Santa Cruz) and on the whale's back at 10 m; night at 20 / 55 m, follow
  // cam and looking up (moonlit silhouette + bioluminescent wake). PT_GPU=1.
  async lighting4() {
    await hideHud();
    const setT = (h) => evaljs(`(() => { krill.clock.hours = ${h}; krill.clock.update = () => {}; krill.world.setTimeOfDay(${h}); return 1; })()`);
    // night first, over the deep canyon at the spawn point (before the origin moves)
    await setT(23.5);
    for (const y of [-20, -55]) {
      for (const kind of ['follow', 'up']) {
        await evaljs(`(() => { const c = krill.controller; c.position.y = ${y}; const L = c.sp.length;
          c._updateCamera = function () { const p = this.position; const f = this.forwardVector();
            if ('${kind}' === 'follow') { this.camera.position.set(p.x - f.x * L * 1.1, p.y + L * 0.12, p.z - f.z * L * 1.1); this.camera.lookAt(p.x + f.x * L, p.y, p.z + f.z * L); }
            else { this.camera.position.set(p.x + L * 0.5, p.y - L * 0.9, p.z + L * 0.5); this.camera.lookAt(p.x, p.y + L * 2, p.z); } };
          krill.effects.resetExposure(); return 1; })()`);
        await key('keyDown', 'KeyW', 'w');
        await sleep(2500);
        await key('keyUp', 'KeyW', 'w');
        await shot(`l4-night-${-y}m-${kind}`);
      }
    }
    await setT(13);
    // shallow sand: walk from the bay toward the Santa Cruz wharf until the floor is at -12 m
    const d = await evaljs(`(() => { const t = krill.terrain, c = krill.controller;
      const [ax, az] = t.project(36.90, -122.00), [bx, bz] = t.project(36.957, -122.017);
      const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L; let d = 0;
      while (d < L && t.heightAtAbs(ax + ux * d, az + uz * d) < -12) d += 4;
      const X = ax + ux * d - t.origin.x, Z = az + uz * d - t.origin.y;
      c.position.set(X, -6, Z); c.velocity.set(0, 0, 0); c.speed = 0; krill.phys.o2 = 1;
      c._updateCamera = function () { const p = this.position; this.camera.position.set(p.x + 6, -4, p.z + 10); this.camera.lookAt(p.x - 4, -12, p.z - 6); };
      return d; })()`);
    console.log('sand site', d, 'm along the line');
    await sleep(6000); // terrain tiles stream in
    await evaljs(`krill.effects.resetExposure(); 1`); await sleep(900);
    await shot('l4-sand-noon');
    await evaljs(`(() => { const c = krill.controller; c.position.y = -10; const L = c.sp.length;
      c._updateCamera = function () { const p = this.position; this.camera.position.set(p.x + L * 0.45, p.y + L * 0.35, p.z + L * 0.2); this.camera.lookAt(p.x, p.y, p.z); };
      krill.effects.resetExposure(); return 1; })()`);
    await sleep(900); await shot('l4-back-10m');
  },
  // Whale readability in Monterey water (playtest 2 N2/N4/#19): default
  // follow distance (1.1 L) and side views at 20 / 55 m, fins at 50 m.
  // Best with PT_GPU=1. Cameras are relative to the whale (floating origin).
  async readability() {
    await hideHud();
    const pin = (y, dist, side) => evaljs(`(() => { const c = krill.controller; c.position.y = ${y}; const L = c.sp.length;
      c._updateCamera = function(){ const p = this.position; ${side
        ? `this.camera.position.set(p.x + L*${dist}, p.y + L*0.1, p.z + L*0.25); this.camera.lookAt(p.x, p.y, p.z);`
        : `const f = this.forwardVector(); this.camera.position.set(p.x - f.x*L*${dist}, p.y + L*0.12, p.z - f.z*L*${dist}); this.camera.lookAt(p.x + f.x*L, p.y, p.z + f.z*L);`} };
      krill.effects.resetExposure && krill.effects.resetExposure(); return 1; })()`);
    for (const [y, d, side, name] of [[-20, 1.1, false, 'follow-20m'], [-20, 1.1, true, 'side-20m'], [-55, 1.1, false, 'follow-55m'],
      [-55, 1.1, true, 'side-55m'], [-50, 0.6, true, 'fins-50m']]) {
      await pin(y, d, side);
      await sleep(900);
      await shot(`read-${name}`);
    }
  },
  // Time of day (World.setTimeOfDay): underwater follow cam, looking up, and
  // above the surface, at dawn / morning / noon / golden hour / dusk / night.
  async daynight() {
    await hideHud();
    await evaljs(`krill.controller.position.y = -12; 1`);
    const setT = (h) => evaljs(`(() => { if (krill.clock) krill.clock.hours = ${h}; krill.world.setTimeOfDay(${h}); krill.effects.resetExposure && krill.effects.resetExposure(); return krill.world.lightLevel.toFixed(4); })()`);
    // cameras relative to the whale: safe with the floating origin
    const view = (kind) => evaljs(`(() => { const c = krill.controller; const L = c.sp.length; c._updateCamera = function(){ const p = this.position;
      if ('${kind}' === 'under') { this.camera.position.set(p.x + L*0.9, p.y + L*0.2, p.z + L*1.3); this.camera.lookAt(p.x, p.y, p.z); }
      else if ('${kind}' === 'up') { this.camera.position.set(p.x + L*0.8, p.y - L*0.6, p.z + L*0.8); this.camera.lookAt(p.x, p.y + L*3, p.z); }
      else { this.camera.position.set(p.x + L*0.9, 3, p.z + L*1.6); this.camera.lookAt(p.x, 1.2, p.z - L*3); } }; return 1; })()`);
    for (const [h, tag] of [[6.1, 'dawn'], [9, 'morning'], [13, 'noon'], [19.2, 'golden'], [20.3, 'dusk'], [23.5, 'night']]) {
      console.log('time', tag, await setT(h));
      for (const kind of ['under', 'up', 'above']) {
        await view(kind);
        await evaljs(`krill.effects.resetExposure && krill.effects.resetExposure(); 1`);
        await sleep(900);
        await shot(`tod-${tag}-${kind}`);
      }
    }
  },
  // Sea state from above: calm / moderate / strong wind (World.setWind).
  async sea() {
    await hideHud();
    await evaljs(`krill.controller.position.y = -12; if (krill.clock) krill.clock.hours = 16; krill.world.setTimeOfDay(16); 1`);
    await evaljs(`(() => { const c = krill.controller; const L = c.sp.length; c._updateCamera = function(){ const p = this.position;
      this.camera.position.set(p.x, 6, p.z + L); this.camera.lookAt(p.x - 40, 0, p.z - 120); }; return 1; })()`);
    for (const kts of [4, 14, 26]) {
      await evaljs(`krill.world.setWind(${kts}, 300); 1`);
      await sleep(900);
      await shot(`sea-${kts}kts`);
    }
    // looking into the sun: glitter path
    await evaljs(`(() => { const s = krill.world.sunDirection; const c = krill.controller; c._updateCamera = function(){ const p = this.position;
      this.camera.position.set(p.x, 5, p.z); this.camera.lookAt(p.x + s.x * 100, -25, p.z + s.z * 100); }; krill.world.setWind(14, 300); return 1; })()`);
    await sleep(900);
    await shot('sea-glitter');
  },
  // Camera above the water (breach views): pinned at an absolute height.
  async above() {
    await hideHud();
    await evaljs(`krill.controller.position.y = -3; 1`); // clamped to bounds.maxY
    const pinAbs = (ox, y, oz, lookY, lookFwd = 0) => evaljs(`krill.controller._updateCamera = function(){ const p=this.position; const L=this.sp.length;
      this.camera.position.set(p.x + L*${ox}, ${y}, p.z + L*${oz}); this.camera.lookAt(p.x, ${lookY === null ? 'p.y' : lookY}, p.z - L*${lookFwd}); }; 1`);
    await pinAbs(0.9, 3, 0.9, null); await sleep(900); await shot('above');
    await pinAbs(0.2, 3, 1.6, 1.5, 3); await sleep(900); await shot('above-horizon');
    await pinAbs(0.3, 0.04, 1.4, 0.0, 2); await sleep(900); await shot('above-waterline');
    await pinAbs(0.3, -0.5, 1.4, 1.0, 2); await sleep(900); await shot('above-just-below');
  },
};

try {
  if (!chrome) throw new Error('No Chrome/Edge found');
  let target;
  for (let t = 0; t < 50 && !target; t++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
      target = list.find((x) => x.type === 'page');
    } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  if (preload[scenario]) await send('Page.addScriptToEvaluateOnNewDocument', { source: preload[scenario] });
  const query = noAutostart.has(scenario) ? `?test&species=${species}` : `?autostart=${species}`;
  await send('Page.navigate', { url: `http://localhost:${port}/${query}` });
  await sleep(4000);
  // Game.start awaits the bathymetry; give it up to 20 s more before driving it
  if (!noAutostart.has(scenario)) {
    for (let t = 0; t < 40; t++) {
      if (await evaljs('!!(window.krill && krill.running && krill.controller)').catch(() => false)) break;
      await sleep(500);
    }
  }
  if (!scenarios[scenario]) throw new Error(`unknown scenario ${scenario}`);
  await scenarios[scenario]();
  console.log('fps (software render)', await fps());
  if (await evaljs('krill.running')) console.log('final', JSON.stringify(await sample()));
} catch (e) {
  console.error('PLAYTEST ERROR', e.message);
  process.exitCode = 1;
} finally {
  console.log('--- page logs ---\n' + logs.join('\n'));
  ws?.close();
  browser.kill();
  server.kill();
}
