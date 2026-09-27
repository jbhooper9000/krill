import * as THREE from 'three';
import { World } from './World.js';
import { Terrain } from './Terrain.js';
import { Whale } from './Whale.js';
import { PlayerController } from './PlayerController.js';
import { KrillManager } from './KrillManager.js';
import { Effects } from './Effects.js';
import { Input } from './Input.js';
import { Splash } from './Splash.js';
import { Physiology } from './Physiology.js';
import { Clock } from './Clock.js';
import { SPECIES } from './species.js';
import { TUNING } from './Tuning.js';
import { TuningPanel } from '../ui/TuningPanel.js';

const _previewRight = new THREE.Vector3();

export class Game {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ui = ui;

    // Everything is rendered through Effects' composer into a 4x MSAA HDR
    // target, so default-framebuffer MSAA would be wasted work.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // AgX: rolls saturated blues/cyans off toward white gracefully (ACES skews
    // them and clips the Snell's window / sun glints harshly). Exposure is
    // driven per-frame by Effects' depth-aware auto exposure.
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // 1.5 cap: the water model is per-pixel; 2x DPR would ~double shading cost
    // on high-DPI laptops for little visible gain in soft underwater images.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 500);

    this.world = new World(this.scene, { flatFloor: false });
    // ---- Monterey terrain (streamed bathymetry + floating origin) ----
    this.terrain = new Terrain(this.scene, {
      // underwater light model hook: applied if the lighting engineer's World provides it
      patchMaterial: this.world.patchMaterial ? (m) => this.world.patchMaterial(m) : null,
    });
    this.terrain.onRebase((dx, dz) => this._onRebase(dx, dz));
    this.region = null;
    this._regionTimer = 0;
    this.splash = new Splash(this.scene, this.world.waterLevel, this.world);
    this.effects = new Effects(this.renderer, this.scene, this.camera);
    this.input = new Input(canvas);

    this.running = false;
    this.paused = false;
    this.tuningOpen = false;
    this._clock = new THREE.Clock();
    this._elapsed = 0;
    this._escDown = false;
    this._tDown = false;
    this.tuningPanel = new TuningPanel(() => this.rebuildKrill());

    this._punch = 0;

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.effects.resize(w, h);
  }

  start(speciesId) {
    this._clearPreview();
    this.speciesId = speciesId;
    this.whale = new Whale(speciesId);

    const sp = SPECIES[speciesId];
    // terrain-aware floor, no horizontal edges (the scene origin is the start point)
    const bounds = { minY: -Infinity, maxY: -sp.length * 0.08, floorAt: (x, z) => this.terrain.heightAt(x, z) };

    this.controller = new PlayerController(this.camera, this.whale, speciesId, bounds);
    const startFloor = this.terrain.heightAt(0, 0);
    if (this.controller.position.y < startFloor + sp.length) {
      this.controller.position.y = Math.min(-2, startFloor + sp.length);
    }
    this.controller.onEvent = (type, data) => this._onWhaleEvent(type, data);
    this.scene.add(this.whale.group);

    // time of day drives diel vertical migration of the krill
    this.clock = new Clock(9);
    this.phys = new Physiology(sp);
    this._dayTime = 0; // game seconds into today's session
    this.day = 1;

    this.krill = new KrillManager(this.scene, bounds, this.terrain);
    this.krill.spawnAround(this.controller.position, this._krillY());
    this.surge = 0; // 0..1 breach charge
    this.breaches = 0;
    this._bout = 0; // breaches in the current bout
    this._lastLanding = -Infinity;
    this._lungeCatch = 0;
    this.ui.setBreach(0, false, 1);

    this.running = true;
    this.paused = false;
    this.input.reset();
    this.input.lock();
    console.log('[Krill] started:', speciesId);
    this.ui.showHud();
  }

  // Krill layer depth (world y): ~55 m by day, rising to ~14 m at night.
  // (Real E. pacifica: 150-250 m by day; scaled to this arena until the
  // Monterey bathymetry lands.)
  _krillY() {
    const day = this.clock ? this.clock.daylight : 1;
    const y = -(14 + 41 * day);
    // stay above the local seafloor (patches are also clamped per site)
    const p = this.controller && this.controller.position;
    return p ? Math.min(-6, Math.max(y, this.terrain.heightAt(p.x, p.z) + 15)) : y;
  }

  // Floating origin: Terrain moved the scene by -(dx, dz); shift what we own.
  _onRebase(dx, dz) {
    const c = this.controller;
    if (c) {
      for (const v of [c.position, c._camPos, c._camLook, c._camTarget, c._witnessPos]) { v.x -= dx; v.z -= dz; }
      this.whale.group.position.copy(c.position);
    }
    this.camera.position.x -= dx;
    this.camera.position.z -= dz;
    this.camera.updateMatrixWorld();
    if (this.krill) this.krill.rebase(dx, dz);
    this.splash.rebase(dx, dz);
    if (this.world.rebase) this.world.rebase(dx, dz);
  }

  // Region / POI under the player (e.g. "Monterey Canyon"), checked twice a second.
  _updateRegion(dt) {
    this._regionTimer -= dt;
    if (this._regionTimer > 0 || !this.controller) return;
    this._regionTimer = 0.5;
    const r = this.terrain.regionAt(this.controller.position.x, this.controller.position.z);
    const name = r ? r.name : null;
    if (name !== (this.region && this.region.name)) {
      this.region = r;
      if (this.ui.setRegion) this.ui.setRegion(name);
    }
  }

  rebuildKrill() {
    if (this.krill) this.krill.rebuildKrill();
  }

  _toggleTuning() {
    this.tuningOpen = !this.tuningOpen;
    this.input.clearLook();
    if (this.tuningOpen) {
      this.paused = false;
      this.tuningPanel.show();
      if (document.exitPointerLock) document.exitPointerLock();
    } else {
      this.tuningPanel.hide();
      this.input.lock();
    }
  }

  // Surge fills from krill; a big lunge (40+ krill) fills it 1.5x faster.
  // Bout rule: a follow-up breach within 25 s of landing costs half (max 3).
  _breachCost() {
    const inBout = this._elapsed - this._lastLanding < 25 && this._bout > 0 && this._bout < 3;
    return inBout ? 0.5 : 1;
  }

  _updateSurge(eaten) {
    const c = this.controller;
    if (c.state.isLunging) this._lungeCatch += eaten;
    else this._lungeCatch = 0;
    if (eaten > 0) {
      const bonus = this._lungeCatch >= 40 ? 1.5 : 1;
      this.surge = Math.min(1, this.surge + (eaten * bonus) / (this.whale.sp.breachKrill * TUNING.breachCost));
    }
    const cost = this._breachCost();
    c.breachReady = this.surge >= cost && c.mode === 'swim' && !this.phys.blackout;
    this.ui.setBreach(this.surge, c.breachReady, cost);
  }

  _onWhaleEvent(type, data) {
    const size = this.whale.sp.length * this.whale.group.scale.x;
    if (type === 'breach') {
      const cost = this._breachCost();
      this._bout = cost < 1 ? this._bout + 1 : 1;
      this.surge = Math.max(0, this.surge - cost);
      this.breaches++;
      this.phys.breached();
      this.splash.exit(data.position, size, data.forward);
      this.splash.shedFrom(this.whale.group, this.whale.sp.length, 1.4);
      this.ui.breach(this.breaches);
    } else if (type === 'splash') {
      this._lastLanding = this._elapsed;
      this.splash.impact(data.position, size, data.speed * data.attitude);
      this._punch = 0.6;
      const flop = data.attitude < 1 ? ' · belly flop' : '';
      this.ui.toast(`Breach · ${Math.round(data.clearance * 100)}% clear · twist ${Math.round(data.twist)}°${flop}`);
    } else if (type === 'breach-denied') {
      this.ui.prompt(data.reason);
    } else if (type === 'lunge') {
      this.phys.lungeStarted();
    } else if (type === 'breach-abort') {
      this.surge *= 0.8;
      this.ui.prompt('Breach aborted');
    }
  }

  get depth() {
    return this.controller ? Math.max(0, -this.controller.position.y) : 0;
  }

  _updateView(dt) {
    // camera FOV: speed widening + breach punch
    if (this._punch > 0) this._punch = Math.max(0, this._punch - dt * 1.6);
    const fov = 58 + this.controller.fovOffset + Math.sin(this._punch * Math.PI) * 6;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.world.setDepth(this.depth);
    this.ui.setDepth(Math.round(this.depth));
  }

  // Oxygen, blows, blackout, Condition and stomach.
  // A session is a day at sea (design doc 3.3): after 24 game hours, or if the
  // whale starves, show the day card. Condition carries over to the next day.
  _checkDayEnd() {
    const phys = this.phys;
    const dayOver = this._dayTime * TUNING.timeCompression >= 24 * 3600;
    const starved = phys.condition <= 0;
    if (!dayOver && !starved) return;
    const reached = phys.condition >= phys.target;
    const outcome = starved
      ? 'Too weak to go on — the season ends here'
      : reached
        ? 'Condition reached — ready for the migration south'
        : phys.condition >= phys.target * 0.75
          ? 'A good day at sea'
          : 'Underweight — migration odds poor';
    this.paused = true;
    if (document.exitPointerLock) document.exitPointerLock();
    this.ui.showDayCard?.({
      day: this.day,
      species: this.whale.sp.name,
      condition: phys.condition,
      target: phys.target,
      stats: { ...phys.stats },
      outcome,
      final: starved,
    }, () => this._nextDay());
  }

  _nextDay() {
    this.day++;
    this._dayTime = 0;
    this.phys.stats = { kg: 0, dives: 0, lunges: 0, breaches: 0, blackouts: 0, bestLunge: 0 };
    this.paused = false;
    this.ui.setPaused(false);
    this.input.lock();
  }

  _updatePhysiology(dt, input) {
    const c = this.controller;
    const phys = this.phys;
    const ev = phys.update(dt, {
      atSurface: c.atSurface,
      airborne: c.mode === 'air',
      exertion: c.thrust,
      deepBreath: c.atSurface && input.ascend,
    });
    if (ev === 'blow') {
      this.splash.blow(c.position, c.forwardDir, this.whale.sp.length * this.whale.group.scale.x, this.whale.sp.blow);
      this.ui.blow();
    } else if (ev === 'blackout') {
      this.ui.prompt('Out of air — your body takes over');
    } else if (ev === 'recovered') {
      this.ui.prompt('Breathing again');
    }
    if (phys.takeStomachWarning()) this.ui.prompt('Stomach full — let it digest');
    this.ui.setO2(phys.o2, { blackout: phys.blackout, atSurface: c.atSurface });
    this.ui.setCondition(phys.condition, phys.target);
    this.ui.setStomach(phys.stomach);
    this.ui.setClock(this.clock.hh, this.clock.mm);
  }

  _togglePause() {
    this.paused = !this.paused;
    this.ui.setPaused(this.paused);
    if (!this.paused) this.input.lock();
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const rawDt = Math.min(0.05, this._clock.getDelta());
    // breach apex slow-motion scales the whole simulation
    const dt = rawDt * (this.controller ? this.controller.timeScale : 1);
    this._elapsed += dt;

    // Esc toggle pause
    const esc = this.input.key('Escape');
    if (esc && !this._escDown && this.running) this._togglePause();
    this._escDown = esc;

    // T toggle tuning panel
    const tKey = this.input.key('KeyT');
    if (tKey && !this._tDown && this.running) this._toggleTuning();
    this._tDown = tKey;

    if (this.running && !this.paused && !this.tuningOpen) {
      const input = this.input.frame();
      // blackout: the player loses control while the body heads for air
      this.controller.forceClimb = this.phys.blackout;
      if (this.phys.blackout) {
        input.lookX = input.lookY = 0;
        input.lunge = input.breach = input.descend = false;
        input.forward = true;
      }
      this.controller.update(dt, input);
      this.clock.update(dt);
      this._dayTime += dt;
      this.world.setTimeOfDay?.(this.clock.hours);

      const room = Math.floor((1 - this.phys.stomach) * this.whale.sp.stomachKrill);
      const eaten = this.krill.update(dt, this._elapsed, this.whale, this.controller, true, { krillY: this._krillY(), room });
      if (eaten > 0) {
        this.phys.swallow(eaten, this.controller.state.isLunging);
        this.ui.addKrill(this.krill.totalEaten);
      }
      this._updateSurge(eaten);
      this._updatePhysiology(dt, input);
      this._checkDayEnd();
      this.splash.update(dt, this.camera);

      this.world.update(dt, this.camera);
      this._updateView(dt);
      this.ui.setLunge(this.controller.state.lungeCharge, this.controller.state.isLunging);
    } else if (this.tuningOpen) {
      // whale frozen, but boids keep moving so size/spacing/speed changes are
      // visible live; feeding is disabled so tuning doesn't change score.
      this.world.update(dt, this.camera);
      this.krill.update(dt, this._elapsed, this.whale, this.controller, false, { krillY: this._krillY(), room: 0 });
      this.splash.update(dt, this.camera);
    } else {
      // still advance slow ambient when paused (snow, caustics) for a living backdrop
      if (!this.running) this._updatePreview(rawDt);
      this.world.update(dt * 0.3, this.camera);
    }

    // stream/LOD the seafloor around the camera (may rebase the floating origin)
    this.terrain.update(this.camera);
    if (this.running) this._updateRegion(rawDt);

    this.effects.render(dt);
  }

  // ---- species-select preview ------------------------------------------
  // The menu is the live scene: the selected whale idles in open water in
  // front of a slowly drifting camera. Self-contained; cleared by start().
  previewSpecies(id) {
    if (this.running || !SPECIES[id]) return;
    const old = this._preview;
    if (old && old.id === id) return;
    if (old) this._disposeWhale(old.whale);
    const whale = new Whale(id);
    whale.group.rotation.order = 'YXZ';
    this.scene.add(whale.group);
    const sp = SPECIES[id];
    this._preview = {
      id, whale, t: old ? old.t : 0,
      depth: old ? old.depth : sp.startDepth,
      state: { speed: 0.5, thrust: 0.45, turn: 0, pitchRate: 0, pitch: 0, feeding: 0, lunge: 0,
        lungeCharge: 0, time: 0, forward: 1, isLunging: false, airborne: false },
    };
  }

  _updatePreview(dt) {
    const p = this._preview;
    if (!p) return;
    const sp = SPECIES[p.id];
    const L = sp.length;
    p.t += dt;
    const t = p.t;
    // glide between habitat depths when the species changes
    p.depth += (sp.startDepth - p.depth) * (1 - Math.exp(-dt * 1.6));
    this.world.setDepth(p.depth);

    const g = p.whale.group;
    const yaw = Math.PI / 2; // nose toward -X: swims right-to-left across the view
    g.position.set(0, -p.depth + Math.sin(t * 0.35) * 0.25, 0);
    g.rotation.set(Math.sin(t * 0.3) * 0.05, yaw + Math.sin(t * 0.13) * 0.06, Math.sin(t * 0.21) * 0.06);
    p.state.time = t;
    p.state.turn = Math.sin(t * 0.13) * 0.25;
    p.state.pitchRate = Math.cos(t * 0.3) * 0.12;
    p.whale.update(dt, p.state);

    // slow orbit around a front three-quarter view, from a little above so the
    // sunlit back reads and the text on the left sits over deeper water; the
    // whale is framed right of centre
    const az = -0.35 + Math.sin(t * 0.045) * 0.3;
    const c = this.camera;
    const dist = L * Math.max(1.2, 1.2 / c.aspect); // keep the whole whale in a portrait window
    const offset = L * 0.3 * Math.min(1, c.aspect);
    c.position.set(Math.sin(az) * dist, g.position.y + L * 0.2, Math.cos(az) * dist);
    const right = _previewRight.set(Math.cos(az), 0, -Math.sin(az));
    c.lookAt(g.position.x - right.x * offset, g.position.y - L * 0.12, g.position.z - right.z * offset);
    if (Math.abs(c.fov - 58) > 0.01) { c.fov = 58; c.updateProjectionMatrix(); }
  }

  _clearPreview() {
    if (!this._preview) return;
    this._disposeWhale(this._preview.whale);
    this._preview = null;
  }

  _disposeWhale(whale) {
    this.scene.remove(whale.group);
    whale.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    });
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    this.terrain.dispose();
  }
}
