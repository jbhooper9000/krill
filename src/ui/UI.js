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

import { SPECIES } from '../game/species.js';
import { PauseMap } from './PauseMap.js';

const $ = (id) => document.getElementById(id);
const IDLE_MS = 4000;
const TOAST_MS = 2500;
const PROMPT_MS = 1800;
const DEPTH_PX = 3; // px per metre on the depth tape
const DEPTH_MAX = 600;

// Real facts in place of 1–5 ratings (§6.4). Length is read from SPECIES so
// the menu always matches the model; mass and dive times are real figures.
export const SPECIES_INFO = {
  humpback: {
    name: 'Humpback',
    latin: 'Megaptera novaeangliae',
    mass: '30 t',
    dives: '3–8 min',
    desc: 'Bubble-nets krill and anchovy. Breaches often, rolling onto its back.',
  },
  blue: {
    name: 'Blue',
    latin: 'Balaenoptera musculus',
    mass: '100 t',
    dives: '10–20 min',
    desc: 'The largest animal that has ever lived. Lunges through krill; breaches rarely, and only partly.',
  },
  sperm: {
    name: 'Sperm',
    latin: 'Physeter macrocephalus',
    mass: '45 t',
    dives: '45–60 min',
    desc: 'Hunts squid in the dark of the canyon by echolocation, down to 1,200 m.',
  },
};
export const speciesFacts = (id) => {
  const s = SPECIES_INFO[id];
  const len = SPECIES[id] ? Math.round(SPECIES[id].length) : '';
  return `${len} m · ${s.mass} · dives ${s.dives}`;
};
const SPECIES_ORDER = ['humpback', 'blue', 'sperm'];
// Species you can watch in the menu but not play yet. The sperm whale hunts
// squid in the deep canyon; until that loop exists it isn't honest to let it
// eat krill (playtest review 3).
export const LOCKED_SPECIES = { sperm: 'Coming soon · deep-canyon squid hunting with echolocation' };

// First-time control hints: each verb is explained once per session.
const HINTS = {
  swim: '<b>W</b> or hold <b>left mouse</b> to swim<span class="sep"></span><b>Mouse</b> to steer<span class="sep"></span><b>Space</b> / <b>Shift</b> rise and dive',
  lunge: 'Hold <b>right mouse</b> to charge a lunge, release to burst through the swarm',
  breach: 'Surge is full · breach from one to four body lengths deep',
  air: 'Air running low — surface to breathe <b>↑</b>',
  breathe: 'Each blow refills your air<span class="sep"></span>hold <b>Space</b> at the surface for a deeper breath',
};
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const CUE_KEY = 'krill.preyCue';

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
    this._hintQueue = [];
    this._swimTime = 0;
    this._runTime = 0;
    this._dayCardNext = null;
    this._v = null; // scratch vectors (cloned from the camera once attached)

    // prey cue: a faint edge shimmer toward the nearest krill patch when
    // hungry. On by default; toggled on the pause screen, remembered per viewer.
    this.preyCue = true;
    try { this.preyCue = localStorage.getItem(CUE_KEY) !== '0'; } catch { /* storage blocked */ }
    this._renderCueBtn();
    $('cue-btn').addEventListener('click', () => this.setPreyCue(!this.preyCue));
    this.map = new PauseMap($('pause-map'));

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
    if (changed && !instant) this.audio?.ui('tick'); // [audio]
    this.tabs.forEach((t) => {
      t.classList.toggle('locked', !!LOCKED_SPECIES[t.dataset.species]);
      const on = t.dataset.species === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    const info = document.querySelector('.species-info');
    const fill = () => {
      const s = SPECIES_INFO[this.species];
      $('sp-name').textContent = s.name;
      $('sp-latin').textContent = s.latin;
      $('sp-facts').textContent = speciesFacts(this.species);
      $('sp-desc').textContent = s.desc;
      info.classList.remove('out');
      const locked = LOCKED_SPECIES[this.species];
      const btn = $('start-btn');
      btn.disabled = !!locked;
      btn.classList.toggle('locked', !!locked);
      const label = btn.querySelector('.btn-label');
      if (label) label.textContent = locked ? 'Coming soon' : 'Dive in';
      $('sp-locked').textContent = locked || '';
      $('sp-locked').hidden = !locked;
    };
    clearTimeout(this._swapTimer);
    if (instant || !changed) fill();
    else {
      info.classList.add('out');
      this._swapTimer = setTimeout(fill, 400);
    }
    if (this.onSelect) this.onSelect(id);
  }

  isLocked(id = this.species) {
    return !!LOCKED_SPECIES[id];
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
    this._showHint('swim');
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

  // Region under the whale (from the Monterey terrain): shown on change.
  setRegion(name) {
    if (!name || name === this._region) return;
    this._region = name;
    this._renderPlace();
    if (!$('hud').classList.contains('hidden')) this._show($('hud-place'));
  }

  _renderPlace() {
    const place = this._region || 'Monterey Bay';
    $('hud-place').textContent = this._clock ? `${place} · ${this._clock}` : place;
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
    // blackout: the "Out of air" line stays up (above the veil) until air returns
    if (blackout !== !!this._blackout) {
      this._blackout = blackout;
      const pr = $('hud-prompt');
      if (blackout) {
        pr.textContent = 'Out of air — your body takes over';
        pr.classList.add('warn');
        this._promptUntil = Infinity;
        this._show(pr, Infinity);
      } else {
        this._promptUntil = 0;
        if (pr.textContent.startsWith('Out of air')) this._hide(pr);
      }
    }
    const key = `${pct}|${blackout}`;
    if (key === this._o2Key) return;
    this._o2Key = key;

    const el = $('hud-o2');
    $('o2-arc').style.strokeDasharray = `${Math.max(0.5, pct)} 100`;
    $('o2-val').textContent = `${pct}%`;
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
    this._showHint('breathe', HINTS.breathe, 7000);
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
    if (text !== this._lastPromptText || performance.now() > this._promptUntil) this.audio?.ui('tock'); // [audio]
    this._lastPromptText = text;
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

  // End-of-day card (design doc 3.3): the pause screen in .daycard mode.
  // summary: { day, species, condition, target, stats, outcome, final }
  showDayCard(summary, onNext) {
    this._condition = { value: summary.condition, target: summary.target };
    this._dayCardNext = summary.final ? () => window.location.reload() : onNext;
    $('pause-screen').classList.add('daycard');
    this.setPaused(true);
    $('pause-title').textContent = `Day ${summary.day} at sea`;

    const outcome = $('day-outcome');
    outcome.textContent = summary.outcome;
    outcome.classList.toggle('warn', !!summary.final || summary.condition < summary.target * 0.75);

    const s = summary.stats || {};
    const sp = SPECIES[this.species];
    const kgPer = sp && sp.krillKg ? sp.krillKg : 0;
    const cells = [
      ['Krill eaten', Math.round(s.kg || 0), 'kg'],
      ['Dives', s.dives || 0],
      ['Lunges', s.lunges || 0],
      ['Best lunge', kgPer ? Math.round((s.bestLunge || 0) * kgPer) : s.bestLunge || 0, kgPer ? 'kg' : 'krill'],
      ['Breaches', s.breaches || 0],
      ['Blackouts', s.blackouts || 0],
    ];
    $('day-stats').innerHTML = cells
      .map(([label, v, unit]) => `<div class="${v ? '' : 'zero'}"><dd>${v.toLocaleString()}${unit ? `<small>${unit}</small>` : ''}</dd><dt>${label}</dt></div>`)
      .join('');

    const resume = $('resume-btn');
    resume.hidden = !!summary.final;
    resume.querySelector('.btn-label').textContent = 'Next day';
    $('restart-btn').querySelector('.btn-label').textContent = 'Start again';
    (summary.final ? $('restart-btn') : resume).focus({ preventScroll: true });
  }

  // Called by the resume action: true if it closed a day card.
  consumeDayCard() {
    const next = this._dayCardNext;
    if (!next) return false;
    this._dayCardNext = null;
    $('pause-screen').classList.remove('daycard');
    $('pause-title').textContent = 'Paused';
    $('resume-btn').hidden = false;
    $('resume-btn').querySelector('.btn-label').textContent = 'Resume';
    $('restart-btn').querySelector('.btn-label').textContent = 'Restart';
    next();
    return true;
  }

  setPaused(paused) {
    if (paused !== !$('pause-screen').classList.contains('hidden')) this.audio?.ui(paused ? 'open' : 'close'); // [audio]
    $('pause-screen').classList.toggle('hidden', !paused);
    $('hud').classList.toggle('paused', paused);
    if (!paused) return;
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
    if (this._dayCardNext) return; // the day card fills the rest

    // Today: always kg, dives and breaches, so a zero reads as "not yet"
    const st = this.game && this.game.phys ? this.game.phys.stats : null;
    const n = (v) => `<b>${Math.round(v).toLocaleString()}</b>`;
    const plural = (v, one, many) => `${n(v)} ${v === 1 ? one : many}`;
    let line;
    if (st) {
      line = st.kg || st.dives || st.breaches || st.lunges
        ? `${n(st.kg)} kg of krill · ${plural(st.dives, 'dive', 'dives')} · ${plural(st.breaches, 'breach', 'breaches')}`
        : 'Nothing eaten yet — the day has just begun';
    } else {
      line = `${n(this._krill)} krill · ${plural(this._breaches, 'breach', 'breaches')}`;
    }
    $('pause-stats').innerHTML = `Today · ${line}`;
    $('resume-btn').focus({ preventScroll: true });
    if (this.game) this.map.show(this.game);
  }

  setPreyCue(on) {
    this.preyCue = !!on;
    try { localStorage.setItem(CUE_KEY, on ? '1' : '0'); } catch { /* storage blocked */ }
    this._renderCueBtn();
    if (!on) $('prey-cue').classList.remove('on');
  }

  _renderCueBtn() {
    const b = $('cue-btn');
    b.setAttribute('aria-pressed', String(this.preyCue));
    b.querySelector('.cue-state').textContent = this.preyCue ? 'on' : 'off';
  }

  // Sound settings on the pause screen (src/game/Audio.js keeps them in localStorage).
  attachAudio(audio) {
    this.audio = audio;
    const btn = $('sound-btn'), vol = $('sound-vol'), heart = $('heart-btn');
    if (!btn || !vol || !heart) return;
    const render = () => {
      const s = audio.settings;
      const on = audio.enabled && !s.muted;
      btn.setAttribute('aria-pressed', String(on));
      btn.querySelector('.sound-state').textContent = !audio.enabled ? 'unavailable' : on ? 'on' : 'off';
      btn.disabled = vol.disabled = heart.disabled = !audio.enabled;
      vol.value = String(Math.round(s.volume * 100));
      heart.setAttribute('aria-pressed', String(!!s.reducedHeart));
      heart.querySelector('.heart-state').textContent = s.reducedHeart ? 'soft' : 'full';
    };
    btn.addEventListener('click', () => { audio.unlock(); audio.setMuted(!audio.settings.muted); render(); });
    vol.addEventListener('input', () => { audio.unlock(); audio.setVolume(Number(vol.value) / 100); render(); });
    vol.addEventListener('change', () => audio.ui('tick'));
    heart.addEventListener('click', () => { audio.setReducedHeart(!audio.settings.reducedHeart); render(); });
    // arrow keys adjust the slider; don't let Enter on it resume by accident
    vol.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.stopPropagation(); });
    render();
  }

  // Kept for API compatibility: dismisses whatever control hint is showing.
  fadeControlsHint() {
    if (this._hint) this._doneHint(this._hint);
  }

  // ---- first-time hints ---------------------------------------------------
  // One line at a time, each shown once per session. Later hints queue behind
  // the current one; `urgent` ones (air) replace it. `valid` re-checks a
  // queued hint when its turn comes, so stale advice is dropped.
  _showHint(id, html = HINTS[id], ms, { urgent = false, valid = null } = {}) {
    if (this._hintsDone.has(id) || !this.game || !this.game.running) return;
    if (this._hint && this._hint !== id) {
      if (!urgent) {
        if (!this._hintQueue.some((q) => q.id === id)) this._hintQueue.push({ id, html, ms, valid });
        return;
      }
      this._endHint(this._hint, false);
    }
    this._hintsDone.add(id); // never again this session
    this._hint = id;
    this._hintShownAt = performance.now();
    const el = $('hud-hint');
    el.innerHTML = html;
    this._show(el, Infinity);
    clearTimeout(this._hintTimer);
    const dur = ms !== undefined ? ms : id === 'swim' ? Infinity : 8000;
    if (dur !== Infinity) this._hintTimer = setTimeout(() => this._endHint(id), dur);
  }

  _endHint(id, next = true) {
    if (this._hint !== id) return;
    this._hint = null;
    clearTimeout(this._hintTimer);
    this._hide($('hud-hint'));
    if (!next) return;
    // let the fade finish before the next line appears
    setTimeout(() => {
      while (!this._hint && this._hintQueue.length) {
        const q = this._hintQueue.shift();
        if (this._hintsDone.has(q.id) || (q.valid && !q.valid())) continue;
        this._showHint(q.id, q.html, q.ms);
      }
    }, 900);
  }

  _doneHint(id) {
    this._hintsDone.add(id);
    this._hintQueue = this._hintQueue.filter((q) => q.id !== id);
    this._endHint(id);
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

    if (!game.paused) {
      this._runTime += dt;
      this._syncOnboarding(game, c);
    }
    this._syncPreyCue(game, c);
    this._syncBreach(c);
  }

  // Contextual first-time lessons: air is a resource, where the food is.
  _syncOnboarding(game, c) {
    const phys = game.phys;
    const underwater = !c.atSurface && c.mode === 'swim';
    // (a) air: the first time O2 runs below 60 % underwater
    if (phys && underwater && phys.o2 < 0.6 && !phys.blackout) {
      this._showHint('air', HINTS.air, 9000, { urgent: true });
    }
    if (this._hint === 'air' && c.atSurface) this._doneHint('air');
    // the breathing lesson belongs to the surface
    if (this._hint === 'breathe' && !c.atSurface) this._doneHint('breathe');
    // everything else waits until the player has learned to swim
    if (!this._hintsDone.has('swim') || this._hint === 'swim') return;

    // the depth lesson is learned once you're in the layer (or leave the water)
    if (this._hint === 'food' && game._krillY
      && (c.mode === 'air' || Math.abs(game.depth + game._krillY()) < 10)) this._doneHint('food');

    // (b) food: on the first dive, where the krill layer is right now
    if (!this._hintsDone.has('food') && (game.depth > 10 || this._runTime > 25) && game._krillY) {
      const layer = Math.round(-game._krillY() / 5) * 5;
      const night = game.clock && game.clock.daylight < 0.5;
      const html = night
        ? `At night the krill rise toward the surface · look near <b>${layer} m</b>`
        : `By day the krill hold deep · dive to about <b>${layer} m</b> to find the swarm`;
      this._showHint('food', html, 9000);
    }

    // first time a patch is within ~80 m: which way, how far
    const near = this._nearestPatch(game, c);
    if (near && near.dist < 80 && !this._hintsDone.has('patch')) {
      const html = `Krill <b>${this._direction(game.camera, near.center)}</b> · ${Math.round(near.dist)} m`;
      this._showHint('patch', html, 5000, {
        valid: () => { const n = this._nearestPatch(game, c); return !!n && n.dist < 120; },
      });
    }
  }

  _nearestPatch(game, c) {
    const clouds = game.krill && game.krill.krillClouds;
    if (!clouds || !clouds.length) return null;
    let best = null;
    for (const cl of clouds) {
      const h = cl.homeCenter;
      const d = Math.hypot(h.x - c.position.x, h.y - c.position.y, h.z - c.position.z);
      if (!best || d < best.dist) best = { dist: d, center: h };
    }
    return best;
  }

  // Direction to a world point relative to the view, as a word or an arrow.
  _direction(cam, p) {
    const v = this._scratch(cam).copy(p).sub(cam.position).transformDirection(cam.matrixWorldInverse);
    if (v.z > 0.3) return 'behind you';
    if (Math.hypot(v.x, v.y) < -v.z * 0.35) return 'ahead';
    const a = Math.atan2(v.x, v.y); // 0 = up, clockwise
    return ARROWS[(Math.round(a / (Math.PI / 4)) + 8) % 8];
  }

  _scratch(cam) {
    if (!this._v) this._v = cam.position.clone();
    return this._v;
  }

  // Prey cue: when hungry and the nearest patch is out of reach, a faint
  // curved hairline shimmers at the screen edge toward it (or under it, if
  // it is in view but too far to see). Never while airborne or blacked out.
  _syncPreyCue(game, c) {
    const el = $('prey-cue');
    const phys = game.phys;
    const near = this.preyCue && !game.paused && phys && !phys.blackout && c.mode === 'swim'
      && !$('hud').classList.contains('hidden')
      && phys.stomach < 0.35 && this._nearestPatch(game, c);
    if (!near || near.dist < 35 || near.dist > 900) {
      el.classList.remove('on');
      return;
    }
    const cam = game.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const v = this._scratch(cam).copy(near.center).project(cam);
    const behind = v.z > 1;
    let x = behind ? -v.x : v.x, y = behind ? -v.y : v.y;
    let px, py, rot;
    if (!behind && Math.abs(x) < 0.85 && Math.abs(y) < 0.8) {
      px = ((x + 1) / 2) * W;
      py = ((1 - y) / 2) * H + 26;
      rot = 0;
    } else {
      // clamp the direction onto an inset ellipse around the screen edge
      if (Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3) y = -1;
      const ax = W / 2 - 48, ay = H / 2 - 48;
      const k = 1 / Math.hypot(x / 1, y / 1);
      const dx = x * k, dy = -y * k;
      px = W / 2 + dx * ax;
      py = H / 2 + dy * ay;
      rot = Math.atan2(dx, -dy);
    }
    el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${rot.toFixed(3)}rad)`;
    el.classList.add('on');
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
    // only the useful state is announced unprompted; the reasons F won't work
    // come from Game.prompt() when the player actually presses F
    if (win !== 'ok') return;
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
