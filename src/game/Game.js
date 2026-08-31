import * as THREE from 'three';
import { World } from './World.js';
import { Whale } from './Whale.js';
import { PlayerController } from './PlayerController.js';
import { KrillManager } from './KrillManager.js';
import { Effects } from './Effects.js';
import { Input } from './Input.js';
import { SPECIES, ZONES } from './species.js';
import { TUNING } from './Tuning.js';
import { TuningPanel } from '../ui/TuningPanel.js';

export class Game {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ui = ui;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 500);

    this.world = new World(this.scene);
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

    this.level = 1;
    this.totalEaten = 0;
    this.krillThisLevel = 0;
    this.targetScale = 1;
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
    this.speciesId = speciesId;
    this.whale = new Whale(speciesId);

    const sp = SPECIES[speciesId];
    const bounds = { minY: this.world.floorY + sp.length * 0.4, maxY: -sp.length * 0.35, radius: 170 };

    this.controller = new PlayerController(this.camera, this.whale, speciesId, bounds);
    this.scene.add(this.whale.group);

    this.krill = new KrillManager(this.scene, bounds);
    this.krill.spawnAround(this.controller.position);

    this.level = 1;
    this.totalEaten = 0;
    this.krillThisLevel = 0;
    this.targetScale = 1;
    this.whale.group.scale.setScalar(1);

    this.running = true;
    this.paused = false;
    this.input.reset();
    this.input.lock();
    console.log('[Krill] started:', speciesId);
    this.ui.showHud();
    this.ui.setZone(ZONES[0].name, 1);
  }

  threshold(level) {
    return Math.round(TUNING.krillPerLevel * Math.pow(1.5, level - 1));
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

  _levelUp() {
    this.level++;
    this.krillThisLevel = 0;
    this.targetScale = Math.min(2.2, Math.pow(1.06, this.level - 1));
    this._punch = 1;
    const zone = this.world.setDepth(this.depth).zone;
    this.ui.levelUp(this.level, zone.name);
    this.ui.setZone(zone.name, this.level);
  }

  get depth() {
    return this.controller ? Math.max(0, -this.controller.position.y) : 0;
  }

  _updateGrowth(dt) {
    // whale scale animation
    const cur = this.whale.group.scale.x;
    const next = THREE.MathUtils.lerp(cur, this.targetScale, Math.min(1, dt * 3));
    this.whale.group.scale.setScalar(next);

    // camera punch decay
    if (this._punch > 0) {
      this._punch = Math.max(0, this._punch - dt * 1.6);
      const base = 58;
      this.camera.fov = base + Math.sin(this._punch * Math.PI) * 6;
      this.camera.updateProjectionMatrix();
    }

    const thresh = this.threshold(this.level);
    const zone = this.world.setDepth(this.depth);
    this.ui.setGrowth(Math.min(1, this.krillThisLevel / thresh), this.level);
    this.ui.setDepth(Math.round(this.depth));
    if (zone.changed) this.ui.setZone(zone.zone.name, this.level);

    // level-up check
    if (this.krillThisLevel >= thresh) this._levelUp();
  }

  _togglePause() {
    this.paused = !this.paused;
    this.ui.setPaused(this.paused);
    if (!this.paused) this.input.lock();
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const dt = Math.min(0.05, this._clock.getDelta());
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
      this.controller.update(dt, input);

      const eaten = this.krill.update(dt, this._elapsed, this.whale, this.controller);
      if (eaten > 0) {
        this.krillThisLevel += eaten;
        this.ui.addKrill(this.krill.totalEaten);
      }

      this.world.update(dt, this.camera);
      this._updateGrowth(dt);
      this.ui.setLunge(this.controller.state.lungeCharge, this.controller.state.isLunging);
    } else if (this.tuningOpen) {
      // whale frozen, but boids keep moving so size/spacing/speed changes are
      // visible live; feeding is disabled so tuning doesn't change score.
      this.world.update(dt, this.camera);
      this.krill.update(dt, this._elapsed, this.whale, this.controller, false);
    } else {
      // still advance slow ambient when paused (snow, caustics) for a living backdrop
      this.world.update(dt * 0.3, this.camera);
    }

    this.effects.render(dt);
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
  }
}
