// Headless playtest harness: serves the game, drives it in headless Chrome via
// the DevTools protocol, samples state and saves screenshots.
//
//   node tools/playtest.mjs [species] [scenario] [--out dir] [--port n]
//
// scenarios: play (swim/turn/lunge/glide), side (side-on camera sequence),
//            feed (swim through a krill cloud), shots (static views: behind,
//            side, above-surface, looking up, deep),
//            menu (species select over the live ocean, no autostart; also a
//            narrow-window shot), hud (HUD states over bright + dark water,
//            breach ready, denial, O2 veil), pause (pause screen),
//            tune (tuning panel)
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
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
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
const scenarios = {
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
    await evaljs(`(() => { const c = krill.controller; c.position.y = c.bounds.minY + 6; c._aimPitchTarget = -0.5; return 1; })()`);
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
    await keyTap('Escape', 'Escape');
    await sleep(1200);
    console.log('paused', await evaljs('krill.paused'));
    await shot('pause');
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
    await evaljs(`krill.controller.position.y = krill.controller.bounds.minY + 4; 1`);
    await pinCamera(1.4, 0.2, 0.6); await sleep(900); await shot('shots-deep');
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
  const query = noAutostart.has(scenario) ? `?test&species=${species}` : `?autostart=${species}`;
  await send('Page.navigate', { url: `http://localhost:${port}/${query}` });
  await sleep(4000);
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
