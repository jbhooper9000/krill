// HUD + menus in the "ink on glass" style (docs/design/GAME_DESIGN.md §6).
//
// Rules this file enforces:
// - Every HUD element is idle-hidden (opacity 0). It fades in when its value
//   changes and back out after IDLE_MS without change. Only actionable state
//   (a charging lunge, a ready Surge) stays up.
// - Fades only (CSS, 400 ms). No slides, no pops.
// - Game.js pushes values through the setters below; `attach(game)` adds a
//   light per-frame read of controller state for the things the setters
//   cannot know (surface proximity, airborne, run-up quality, breach window).

const $ = (id) => document.getElementById(id);
const IDLE_MS = 4000;
const TOAST_MS = 2500;
const PROMPT_MS = 1800;
const DEPTH_PX = 3; // px per metre on the depth tape
const DEPTH_MAX = 600;

// Real facts in place of 1–5 ratings (§6.4).
export const SPECIES_INFO = {
  humpback: {
    name: 'Humpback',
    latin: 'Megaptera novaeangliae',
    facts: '14 m · 30 t · dives 3–8 min',
    desc: 'Bubble-nets krill and anchovy. Breaches often, rolling onto its back.',
  },
  blue: {
    name: 'Blue',
    latin: 'Balaenoptera musculus',
    facts: '24 m · 100 t · dives 10–20 min',
    desc: 'The largest animal that has ever lived. Lunges through krill; breaches rarely, and only partly.',
  },
  sperm: {
    name: 'Sperm',
    latin: 'Physeter macrocephalus',
    facts: '16 m · 45 t · dives 45–60 min',
    desc: 'Hunts squid in the dark of the canyon by echolocation, down to 1,200 m.',
  },
};
const SPECIES_ORDER = ['humpback', 'blue', 'sperm'];

// First-time control hints: each verb is explained once per session.
const HINTS = {
  swim: '<b>W</b> or hold <b>left mouse</b> to swim<span class="sep"></span><b>Mouse</b> to steer<span class="sep"></span><b>Space</b> / <b>Shift</b> rise and dive',
  lunge: 'Hold <b>right mouse</b> to charge a lunge, release to burst through the swarm',
  breach: 'Surge is full · breach from one to four body lengths deep',
};

export class UI {
  constructor() {
    this.species = 'blue';
    this.onSelect = null; // (speciesId) => void, set by main.js
    // Nothing idle-hidden shows on the pause screen, so keep what it reports.
    this.game = null;

    this._timers = new Map();
    this._krill = 0;
    this._breaches = 0;
    this._level = 1;
    this._clock = '';
    this._hour = -1;
    this._o2 = 1;
    this._o2Key = '';
    this._stomachPct = -1;
    this._condition = null;
    this._depth = -1;
    this._lunge = { charge: 0, active: false };
    this._surgeKey = '';
    this._ready = false;
    this._window = '';
    this._promptUntil = 0;
    this._hintsDone = new Set();
    this._hint = null;
    this._hintShownAt = 0;
    this._swimTime = 0;

    this._buildDepthTape();
    this._buildTabs();
    this.selectSpecies('blue', true);
  }

  // ---- visibility helpers -------------------------------------------------
  _show(el, ms = IDLE_MS) {
    el.classList.add('on');
    clearTimeout(this._timers.get(el));
    if (ms !== Infinity) this._timers.set(el, setTimeout(() => el.classList.remove('on'), ms));
  }

  _hide(el) {
    clearTimeout(this._timers.get(el));
    el.classList.remove('on');
  }

  // ---- species select -----------------------------------------------------
  _buildTabs() {
    this.tabs = [...document.querySelectorAll('#species-tabs .tab')];
    this.tabs.forEach((tab) => tab.addEventListener('click', () => this.selectSpecies(tab.dataset.species)));
  }

  selectSpecies(id, instant = false) {
    if (!SPECIES_INFO[id]) return;
    const changed = id !== this.species;
    this.species = id;
    this.tabs.forEach((t) => {
      const on = t.dataset.species === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    const info = document.querySelector('.species-info');
    const fill = () => {
      const s = SPECIES_INFO[this.species];
      $('sp-name').textContent = s.name;
      $('sp-latin').textContent = s.latin;
      $('sp-facts').textContent = s.facts;
      $('sp-desc').textContent = s.desc;
      info.classList.remove('out');
    };
    clearTimeout(this._swapTimer);
    if (instant || !changed) fill();
    else {
      info.classList.add('out');
      this._swapTimer = setTimeout(fill, 400);
    }
    if (this.onSelect) this.onSelect(id);
  }

  // step through species with the arrow keys; returns the new id
  cycleSpecies(dir) {
    const i = SPECIES_ORDER.indexOf(this.species);
    const id = SPECIES_ORDER[(i + dir + SPECIES_ORDER.length) % SPECIES_ORDER.length];
    this.selectSpecies(id);
    const tab = this.tabs.find((t) => t.dataset.species === id);
    if (tab && document.activeElement && document.activeElement.classList.contains('tab')) tab.focus();
    return id;
  }

  // ---- HUD ----------------------------------------------------------------
  showHud() {
    $('hud').classList.remove('hidden');
    this._renderPlace();
    this._show($('hud-place'));
    setTimeout(() => this._showHint('swim'), 900);
  }

  hideHud() {
    $('hud').classList.add('hidden');
  }

  // The krill counter left the HUD (§6.2). Kept only for the pause summary
  // while the current Game still reports it.
  setKrill(n) {
    this._krill = n;
  }

  addKrill(n) {
    const first = this._krill === 0 && n > 0;
    this.setKrill(n);
    // the lunge becomes relevant once the whale is feeding
    if (first) setTimeout(() => this._showHint('lunge'), 1500);
  }

  // Growth levels and zones are cut (§4.9, replaced by Condition). These stay
  // as harmless no-ops so either version of Game.js works during the merge.
  setGrowth(pct, level) {
    this._level = level;
  }

  setZone(name, level) {
    this._level = level;
  }

  levelUp(level) {
    this._level = level;
  }

  // Context line, top-left: "MONTEREY BAY · 14:32", α .35, idle-fades.
  // Shown when the HUD appears and again on each new hour.
  setClock(hh, mm) {
    const text = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (text === this._clock) return;
    this._clock = text;
    this._renderPlace();
    if (hh !== this._hour) {
      const first = this._hour < 0;
      this._hour = hh;
      if (!first && !$('hud').classList.contains('hidden')) this._show($('hud-place'));
    }
  }

  _renderPlace() {
    $('hud-place').textContent = this._clock ? `Monterey Bay · ${this._clock}` : 'Monterey Bay';
  }

  // Breath (§4.1): arc only below 50 %, amber below 25 %, heartbeat below 30 %.
  // The veil is the diegetic layer: vignette + desaturation creep in below
  // 30 %; blackout tunnels hard.
  setO2(o2, opts = {}) {
    const v = Math.max(0, Math.min(1, o2));
    const blackout = !!opts.blackout;
    this._o2 = v;
    this._atSurface = !!opts.atSurface;
    const pct = Math.round(v * 100);
    const key = `${pct}|${blackout}`;
    if (key === this._o2Key) return;
    this._o2Key = key;

    const el = $('hud-o2');
    $('o2-arc').style.strokeDasharray = `${pct} 100`;
    el.classList.toggle('low', v < 0.25);
    const heart = v < 0.3 && !blackout;
    // diving bradycardia: the beat slows as oxygen runs out
    const beat = `${(1.1 + (0.3 - Math.min(0.3, v)) * 2.5).toFixed(2)}s`;
    el.classList.toggle('heart', heart);
    el.style.setProperty('--beat', beat);
    if (v < 0.5 && !blackout) this._show(el, Infinity);
    else if (!this._blowShow) this._hide(el);

    const veil = $('o2-veil');
    const k = blackout ? 1 : v < 0.3 ? (0.3 - v) / 0.3 : 0; // 0..1
    $('hud').classList.toggle('blackout', blackout);
    veil.style.setProperty('--veil-in', `${blackout ? 2 : Math.round(55 - 30 * k)}%`);
    veil.style.setProperty('--veil-dark', blackout ? '0.97' : (0.65 + 0.3 * k).toFixed(2));
    veil.style.setProperty('--sat', (blackout ? 0.1 : 1 - 0.6 * k).toFixed(2));
    veil.style.setProperty('--beat', beat);
    veil.classList.toggle('on', k > 0);
    veil.classList.toggle('heart', heart && k > 0);
  }

  // A spout at the surface: briefly show the breath arc refilling.
  blow() {
    const el = $('hud-o2');
    this._blowShow = true;
    this._show(el, 2500);
    clearTimeout(this._blowTimer);
    this._blowTimer = setTimeout(() => {
      this._blowShow = false;
      if (this._o2 < 0.5) this._show(el, Infinity);
    }, 2500);
  }

  // Condition is hidden during play (§4.2); the pause screen shows it.
  setCondition(value, target) {
    this._condition = { value, target };
  }

  // Stomach: quiet, surfaces only when above 85 % and changing.
  setStomach(fill) {
    const p = Math.round(Math.max(0, Math.min(1, fill)) * 100);
    if (p === this._stomachPct) return;
    this._stomachPct = p;
    $('stomach-fill').style.width = `${p}%`;
    $('stomach-pct').textContent = `${p}%`;
    if (p > 85) this._show($('hud-stomach'));
    else this._hide($('hud-stomach'));
  }

  _buildDepthTape() {
    const ladder = document.createElement('div');
    ladder.className = 'ladder';
    this._ticks = [];
    for (let m = 0; m <= DEPTH_MAX; m += 10) {
      const t = document.createElement('div');
      const major = m % 20 === 0;
      t.className = major ? 'tick' : 'tick minor';
      t.style.top = `${m * DEPTH_PX}px`;
      const s = document.createElement('span');
      s.textContent = major ? String(m) : '';
      t.appendChild(s);
      ladder.appendChild(t);
      this._ticks.push({ m, el: t });
    }
    $('depth-ticks').appendChild(ladder);
    this._ladder = ladder;
  }

  // Depth tape appears only while depth changes.
  setDepth(d) {
    if (d === this._depth) return;
    const first = this._depth < 0;
    this._depth = d;
    $('depth-value').textContent = d;
    const h = $('depth-ticks').clientHeight || 208;
    this._ladder.style.transform = `translateY(${h / 2 - d * DEPTH_PX}px)`;
    for (const t of this._ticks) t.el.classList.toggle('near', Math.abs(t.m - d) < 6);
    if (!first) this._show($('hud-depth'));
  }

  // Lunge charge: hairline ring near centre, fills clockwise, α .6.
  setLunge(charge, active) {
    const L = this._lunge;
    const ring = $('lunge-ring');
    if (active && !L.active) {
      ring.classList.add('burst');
      $('lunge-arc').style.strokeDasharray = '100 100';
      this._show(ring, 700);
      this._doneHint('lunge');
    } else if (charge > 0) {
      if (Math.abs(charge - L.charge) > 0.004 || !ring.classList.contains('on')) {
        ring.classList.remove('burst');
        $('lunge-arc').style.strokeDasharray = `${(charge * 100).toFixed(1)} 100`;
        this._show(ring, Infinity);
      }
    } else if (L.charge > 0 && !active) {
      // released without enough charge
      this._hide(ring);
    }
    L.charge = charge;
    L.active = active;
  }

  // SURGE: 1 px hairline along the bottom; bio-cyan and breathing when ready.
  setBreach(charge, ready, cost = 1) {
    const c = Math.max(0, Math.min(1, charge));
    const pct = Math.round(c * 100);
    const key = `${pct}|${ready}|${cost}`;
    if (key === this._surgeKey) return;
    const first = this._surgeKey === '';
    this._surgeKey = key;

    const el = $('hud-surge');
    $('surge-fill').style.width = `${ready ? 100 : pct}%`;
    $('surge-pct').textContent = `${pct}%`;
    el.classList.toggle('bout', cost < 1 && !ready);
    $('surge-tick').style.left = `${cost * 100}%`;
    el.classList.toggle('ready', ready);

    if (pct === 0 && !ready) this._hide(el);
    else if (ready) this._show(el, Infinity);
    else if (!first) this._show(el);

    if (ready && !this._ready) {
      this._window = ''; // force the ring to re-announce
      this._showHint('breach');
    }
    if (!ready && this._ready) {
      this._hide($('breach-ring'));
      this._hide($('breach-word'));
      if (performance.now() > this._promptUntil) this._hide($('hud-prompt'));
    }
    this._ready = ready;
  }

  // One-line prompt under the rings (e.g. why F did nothing). Amber: it's a warning.
  prompt(text) {
    const el = $('hud-prompt');
    el.textContent = text;
    el.classList.add('warn');
    this._promptUntil = performance.now() + PROMPT_MS;
    this._show(el, PROMPT_MS);
  }

  // Post-breach toast: top-centre, 2.5 s.
  toast(text) {
    const el = $('toast');
    el.textContent = text;
    this._show(el, TOAST_MS);
  }

  breach(count) {
    this._breaches = count;
    this._doneHint('breach');
    this._hide($('breach-ring'));
    this._hide($('breach-word'));
    this._hide($('hud-prompt'));
  }

  setPaused(paused) {
    $('pause-screen').classList.toggle('hidden', !paused);
    $('hud').classList.toggle('paused', paused);
    if (paused) {
      const s = SPECIES_INFO[this.species];
      const clock = this._clock ? ` · ${this._clock}` : '';
      $('pause-species').innerHTML = `${s.name} · <i>${s.latin}</i>${clock}`;

      const cond = this._condition;
      $('pause-condition').hidden = !cond;
      if (cond) {
        const v = Math.max(0, Math.min(100, cond.value));
        const t = Math.max(0, Math.min(100, cond.target));
        $('cond-fill').style.width = `${v}%`;
        $('cond-dot').style.left = `${v}%`;
        $('cond-target').style.left = `${t}%`;
        $('cond-val').innerHTML = `<b>${Math.round(v)}</b> → target ${Math.round(t)}`;
      }

      const n = (v) => `<b>${v.toLocaleString()}</b>`;
      const parts = [];
      if (this._krill > 0) parts.push(`${n(this._krill)} krill eaten`);
      parts.push(`${n(this._breaches)} ${this._breaches === 1 ? 'breach' : 'breaches'}`);
      if (!cond && this._level > 1) parts.push(`growth stage ${n(this._level)}`);
      $('pause-stats').innerHTML = `Today: ${parts.join(' · ')}`;
      $('resume-btn').focus({ preventScroll: true });
    }
  }

  // Kept for API compatibility: dismisses whatever control hint is showing.
  fadeControlsHint() {
    if (this._hint) this._doneHint(this._hint);
  }

  // ---- first-time hints ---------------------------------------------------
  _showHint(id) {
    if (this._hintsDone.has(id) || !this.game || !this.game.running) return;
    this._hint = id;
    this._hintShownAt = performance.now();
    const el = $('hud-hint');
    el.innerHTML = HINTS[id];
    this._show(el, id === 'swim' ? Infinity : 9000);
    this._hintsDone.add(id); // never again this session
  }

  _doneHint(id) {
    this._hintsDone.add(id);
    if (this._hint === id) {
      this._hint = null;
      this._hide($('hud-hint'));
    }
  }

  // ---- per-frame read of game state ----------------------------------------
  attach(game) {
    this.game = game;
    let last = performance.now();
    const tick = (now) => {
      requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (game.running) this._sync(game, dt);
    };
    requestAnimationFrame(tick);
  }

  _sync(game, dt) {
    const c = game.controller;
    if (!c) return;
    const hud = $('hud');

    // +0.1 alpha when the camera is within 3 m of the surface or above it —
    // and, beyond the doc's rule, when a shallow camera looks up into the
    // sunlit surface (the brightest backdrop the HUD ever sits on)
    const cam = game.camera;
    if (!this._fwd) this._fwd = cam.position.clone();
    const up = cam.getWorldDirection(this._fwd).y;
    const y = cam.position.y;
    const bright = y > -3 || (y > -24 && up > 0.12 + (-y / 24) * 0.25);
    document.body.classList.toggle('near-surface', bright);
    hud.classList.toggle('airborne', c.mode === 'air');

    // swim hint stays until the player has swum for a moment (min 3 s on screen)
    if (this._hint === 'swim' && !game.paused) {
      if (c.state.forward) this._swimTime += dt;
      if (this._swimTime > 1.2 && performance.now() - this._hintShownAt > 3000) this._doneHint('swim');
    }
    if (this._hint === 'lunge' && c.state.lungeCharge > 0.3) this._doneHint('lunge');

    this._syncBreach(c);
  }

  _syncBreach(c) {
    const ring = $('breach-ring');
    const word = $('breach-word');
    const prompt = $('hud-prompt');
    const promptBusy = performance.now() < this._promptUntil;

    // run-up: the ring becomes a launch-quality arc (speed × angle)
    if (c._runup) {
      const deg = (c.pitch * 180) / Math.PI;
      const angle = deg >= 70 ? 1 : Math.min(1, Math.max(0.6, 0.6 + (0.4 * (deg - 45)) / 25));
      const q = Math.min(1, c.speed / c.sp.vExitMax) * angle;
      $('breach-arc').style.strokeDasharray = `${(q * 100).toFixed(1)} 100`;
      ring.classList.remove('ready');
      word.classList.remove('ready');
      word.textContent = `${Math.round(q * 100)}%`;
      if (this._window !== 'runup') {
        this._window = 'runup';
        this._show(ring, Infinity);
        this._show(word, Infinity);
        if (!promptBusy) {
          prompt.classList.remove('warn');
          prompt.textContent = 'launch quality';
          this._show(prompt, Infinity);
        }
        this._doneHint('breach');
      }
      return;
    }
    if (!this._ready || c.mode !== 'swim') {
      if (this._window === 'runup') {
        this._hide(ring);
        this._hide(word);
        if (!promptBusy) this._hide(prompt);
      }
      this._window = '';
      return;
    }

    // ready: announce the breach window, re-announce whenever it changes
    const L = c.sp.length * c.scale;
    const depth = -c.position.y;
    const win = c._cooldown > 0 ? 'cooldown' : depth < 0.8 * L ? 'shallow' : depth > 4 * L ? 'deep' : 'ok';
    if (win === this._window) return;
    this._window = win;
    $('breach-arc').style.strokeDasharray = '100 100';
    ring.classList.add('ready');
    word.classList.add('ready');
    word.textContent = 'Breach';
    this._show(ring, 6000);
    this._show(word, 6000);
    if (promptBusy) return;
    if (win === 'ok') {
      prompt.classList.remove('warn');
      prompt.innerHTML = 'hold <b>F</b> · climb steep';
    } else {
      prompt.classList.add('warn');
      prompt.textContent = {
        shallow: 'too shallow · dive deeper first',
        deep: 'too deep · rise toward the surface',
        cooldown: 'catching your breath',
      }[win];
    }
    this._show(prompt, 6000);
  }
}
