import * as THREE from 'three';
import { makeSoftSprite } from './textures.js';

// Water interaction effects for breaches: ballistic spray droplets above the
// surface, a rising bubble plume below it, and a fading foam slick on the
// surface. All pooled — nothing is allocated per frame.

const GRAVITY = 9.8;

const particleVert = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  varying float vAlpha;
  #include <fog_pars_vertex>
  void main() {
    vAlpha = aAlpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const particleFrag = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  varying float vAlpha;
  #include <fog_pars_fragment>
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(uColor, tex.a * vAlpha);
    if (gl_FragColor.a < 0.01) discard;
    #include <fog_fragment>
  }
`;

class ParticlePool {
  constructor(scene, count, color, { additive = false, world = null } = {}) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count); // remaining seconds
    this.maxLife = new Float32Array(count).fill(1);
    this.baseSize = new Float32Array(count);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.grav = new Float32Array(count).fill(1); // per-particle gravity scale
    this.drag = new Float32Array(count); // per-particle air drag (1/s)
    this.alphaScale = new Float32Array(count).fill(0.7);
    this.grow = new Float32Array(count).fill(1.5); // size growth over life
    this._next = 0;
    this.active = 0;

    const geo = new THREE.BufferGeometry();
    this._posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this._alphaAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._posAttr);
    geo.setAttribute('aSize', this._sizeAttr);
    geo.setAttribute('aAlpha', this._alphaAttr);

    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uMap: { value: null }, uColor: { value: new THREE.Color(color) } },
      ]),
      vertexShader: particleVert,
      fragmentShader: particleFrag,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    mat.uniforms.uMap.value = makeSoftSprite();
    // water-aware: absorbed along the underwater part of the view ray only
    if (world) world.patchMaterial(mat, { additive });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, life, size, grav = 1, drag = 0.4, alpha = 0.7, grow = 1.5) {
    const i = this._next;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.alphaScale[i] = alpha;
    this.grow[i] = grow;
    this._next = (i + 1) % this.count;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
  }

  flush() {
    this._posAttr.needsUpdate = true;
    this._sizeAttr.needsUpdate = true;
    this._alphaAttr.needsUpdate = true;
  }
}

export class Splash {
  constructor(scene, waterLevel = 0, world = null) {
    this.scene = scene;
    this.waterLevel = waterLevel;
    this.spray = new ParticlePool(scene, 6000, 0xf4fbff, { world });
    this.bubbles = new ParticlePool(scene, 4000, 0xdff6ff, { additive: true, world });
    this._shed = null; // { group, length, time, duration }
    this._blows = []; // active exhalation jets
    this.wind = { x: 0.8, z: 0.3 }; // m/s drift for mist (weather feed later)

    // foam slicks: a few pooled discs lying on the surface
    const foamTex = makeFoamTexture();
    this._foam = [];
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: foamTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = waterLevel + 0.03;
      mesh.visible = false;
      mesh.renderOrder = 11;
      scene.add(mesh);
      this._foam.push({ mesh, life: 0, maxLife: 1, size: 1 });
    }
    this._foamNext = 0;
  }

  // Whale bursting out of the water. size ~ whale length (m).
  exit(pos, size, dir) {
    const y = this.waterLevel;
    const n = Math.round(260 * (size / 14));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * size * 0.12;
      const up = 3 + Math.random() * 7;
      const out = 0.5 + Math.random() * 2.5;
      this.spray.spawn(
        pos.x + Math.cos(a) * r, y, pos.z + Math.sin(a) * r,
        Math.cos(a) * out + dir.x * 2, up, Math.sin(a) * out + dir.z * 2,
        1.2 + Math.random() * 1.2, 0.25 + Math.random() * 0.45,
      );
    }
    this._bubbleBurst(pos, size * 0.5, Math.round(n * 0.6));
    this._addFoam(pos, size * 0.7);
  }

  // Whale crashing back in. speed = downward speed at impact (m/s).
  impact(pos, size, speed) {
    const y = this.waterLevel;
    // particle count ~ L^2; plume height H = 0.55 L (v/9); crown radius 0.45 L
    const energy = THREE.MathUtils.clamp(speed / 9, 0.4, 1.5);
    const n = Math.round(1100 * (size / 14) ** 2 * energy);
    const plumeV = Math.sqrt(2 * GRAVITY * 0.55 * size * (speed / 9));
    for (let k = 0; k < n; k++) {
      // crown: droplets thrown up and out from a ring roughly the body's size
      const a = Math.random() * Math.PI * 2;
      const ring = size * 0.45 * (0.35 + Math.random() * 0.65);
      const up = (5 + Math.random() * 11) * energy;
      const out = (2 + Math.random() * 6) * energy;
      this.spray.spawn(
        pos.x + Math.cos(a) * ring, y + Math.random() * 0.5, pos.z + Math.sin(a) * ring,
        Math.cos(a) * out, up, Math.sin(a) * out,
        1.6 + Math.random() * 1.8, 0.3 + Math.random() * 0.9,
      );
    }
    // tall central column
    for (let k = 0; k < n * 0.25; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * size * 0.1;
      this.spray.spawn(
        pos.x + Math.cos(a) * r, y, pos.z + Math.sin(a) * r,
        Math.cos(a) * 1.2, plumeV * (0.6 + Math.random() * 0.4), Math.sin(a) * 1.2,
        2.2 + Math.random() * 1.2, 0.5 + Math.random() * 1.0,
      );
    }
    this._bubbleBurst(pos, size, Math.round(n * 1.4));
    this._addFoam(pos, size * 1.6);
  }

  // A blow at the surface: exhaled vapour + entrained seawater. Shape per
  // species (design doc s4.1): humpback bushy ~3 m, blue a tall ~9 m column,
  // sperm angled forward-left from its offset blowhole.
  blow(pos, forward, size, shape) {
    const hl = Math.hypot(forward.x, forward.z) || 1;
    const fx = forward.x / hl, fz = forward.z / hl;
    const lx = fz, lz = -fx; // left of the heading
    const lean = shape.lean;
    this._blows.push({
      // blowhole sits ~35% of the body length ahead of centre
      x: pos.x + fx * size * 0.35,
      y: Math.max(this.waterLevel + 0.2, pos.y + size * 0.1),
      z: pos.z + fz * size * 0.35,
      dx: (fx * 0.7 + lx * 0.7) * Math.sin(lean),
      dz: (fz * 0.7 + lz * 0.7) * Math.sin(lean),
      up: Math.cos(lean),
      shape,
      t: 0,
      duration: 0.9, // an exhalation is a jet, not a pop
    });
  }

  _emitBlow(b, dt) {
    const { shape } = b;
    // mist rises against heavy drag: launch fast enough to reach the height
    const v0 = Math.sqrt(2 * GRAVITY * 0.35 * shape.height) * 2.2;
    const k = 1 - b.t / b.duration; // jet weakens as the breath runs out
    const n = Math.round((260 + shape.height * 30) * dt / b.duration * 1.6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = shape.spread * (0.2 + Math.random());
      const v = v0 * (0.5 + 0.5 * k) * (0.6 + Math.random() * 0.4);
      const mist = Math.random() < 0.45;
      this.spray.spawn(
        b.x + (Math.random() - 0.5) * 0.25, b.y, b.z + (Math.random() - 0.5) * 0.25,
        (b.dx + Math.cos(a) * s) * v + this.wind.x, b.up * v, (b.dz + Math.sin(a) * s) * v + this.wind.z,
        mist ? 2.5 + Math.random() * 2 : 1.2 + Math.random(),
        mist ? 0.7 + Math.random() * 0.9 : 0.12 + Math.random() * 0.2,
        mist ? 0.12 : 0.6, mist ? 1.6 : 1.0,
        mist ? 0.28 : 0.75, // vapour is faint; droplets bright
        mist ? 2.2 : 0.8, // vapour spreads as it thins
      );
    }
  }

  // Floating origin: the scene shifted by -(dx, dz) (see Terrain.onRebase).
  rebase(dx, dz) {
    for (const pool of [this.spray, this.bubbles]) {
      for (let i = 0; i < pool.count; i++) { pool.pos[i * 3] -= dx; pool.pos[i * 3 + 2] -= dz; }
      pool.flush();
    }
    for (const f of this._foam) { f.mesh.position.x -= dx; f.mesh.position.z -= dz; }
  }

  // Water streaming off the whale's body while it is airborne.
  shedFrom(group, length, duration = 1.2) {
    this._shed = { group, length, time: 0, duration };
  }

  _bubbleBurst(pos, size, n) {
    const y = this.waterLevel;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * size * 0.4;
      const d = Math.random() * size * 0.5; // entrained air is driven down
      this.bubbles.spawn(
        pos.x + Math.cos(a) * r, y - 0.3 - d, pos.z + Math.sin(a) * r,
        Math.cos(a) * 0.6, 0.5 + Math.random() * 1.5, Math.sin(a) * 0.6,
        3 + Math.random() * 5, 0.12 + Math.random() * 0.35,
      );
    }
  }

  _addFoam(pos, size) {
    const f = this._foam[this._foamNext];
    this._foamNext = (this._foamNext + 1) % this._foam.length;
    f.mesh.position.x = pos.x;
    f.mesh.position.z = pos.z;
    f.mesh.rotation.z = Math.random() * Math.PI * 2;
    f.mesh.visible = true;
    f.life = f.maxLife = 9;
    f.size = size;
  }

  update(dt, camera) {
    const wl = this.waterLevel;
    // the surface hides each medium from the other: spray is only seen from
    // the air, the bubble plume only from below
    if (camera) {
      const under = camera.position.y < wl;
      this.spray.points.visible = !under;
      this.bubbles.points.visible = under;
    }

    for (let i = this._blows.length - 1; i >= 0; i--) {
      const b = this._blows[i];
      this._emitBlow(b, dt);
      b.t += dt;
      if (b.t >= b.duration) this._blows.splice(i, 1);
    }

    // shedding: drip from random points along the airborne body
    if (this._shed) {
      const s = this._shed;
      s.time += dt;
      const g = s.group;
      const fwdX = -Math.sin(g.rotation.y), fwdZ = -Math.cos(g.rotation.y);
      const k = 1 - s.time / s.duration;
      const n = Math.round(90 * dt * 60 * Math.max(0, k) * (s.length / 14));
      for (let i = 0; i < n; i++) {
        const t = (Math.random() - 0.5) * s.length * g.scale.x;
        const x = g.position.x + fwdX * t, z = g.position.z + fwdZ * t;
        // approximate body line: pitch lifts the front
        const y = g.position.y + Math.sin(g.rotation.x) * t;
        if (y < wl) continue;
        this.spray.spawn(x, y, z, (Math.random() - 0.5) * 1.5, Math.random() * 1.5, (Math.random() - 0.5) * 1.5,
          0.8 + Math.random() * 0.8, 0.15 + Math.random() * 0.3);
      }
      if (s.time >= s.duration) this._shed = null;
    }

    // spray: ballistic, dies on hitting the water
    const sp = this.spray;
    for (let i = 0; i < sp.count; i++) {
      if (sp.life[i] <= 0) { sp.alpha[i] = 0; continue; }
      const i3 = i * 3;
      const drag = Math.exp(-dt * sp.drag[i]);
      sp.vel[i3] *= drag; sp.vel[i3 + 2] *= drag;
      sp.vel[i3 + 1] = sp.vel[i3 + 1] * (sp.drag[i] > 1 ? drag : 1) - GRAVITY * sp.grav[i] * dt;
      sp.pos[i3] += sp.vel[i3] * dt;
      sp.pos[i3 + 1] += sp.vel[i3 + 1] * dt;
      sp.pos[i3 + 2] += sp.vel[i3 + 2] * dt;
      sp.life[i] -= dt;
      if (sp.pos[i3 + 1] < wl && sp.vel[i3 + 1] < 0) sp.life[i] = 0;
      const t = sp.life[i] / sp.maxLife[i];
      sp.alpha[i] = sp.life[i] > 0 ? Math.min(1, t * 3) * sp.alphaScale[i] : 0;
      // droplets break into mist as they age
      sp.size[i] = sp.baseSize[i] * 0.6 * (1 + (1 - t) * sp.grow[i]);
    }
    sp.flush();

    // bubbles: rise with buoyancy, wobble, pop at the surface
    const bb = this.bubbles;
    for (let i = 0; i < bb.count; i++) {
      if (bb.life[i] <= 0) { bb.alpha[i] = 0; continue; }
      const i3 = i * 3;
      bb.vel[i3 + 1] += (2.2 - bb.vel[i3 + 1]) * Math.min(1, dt * 1.5);
      bb.vel[i3] *= Math.exp(-dt * 1.2);
      bb.vel[i3 + 2] *= Math.exp(-dt * 1.2);
      bb.life[i] -= dt;
      const wob = Math.sin(bb.life[i] * 9 + i) * 0.4;
      bb.pos[i3] += (bb.vel[i3] + wob) * dt;
      bb.pos[i3 + 1] += bb.vel[i3 + 1] * dt;
      bb.pos[i3 + 2] += (bb.vel[i3 + 2] + Math.cos(bb.life[i] * 7 + i) * 0.4) * dt;
      if (bb.pos[i3 + 1] > wl - 0.1) bb.life[i] = 0;
      const t = bb.life[i] / bb.maxLife[i];
      bb.alpha[i] = bb.life[i] > 0 ? Math.min(1, t * 4) * 0.55 : 0;
      bb.size[i] = bb.baseSize[i];
    }
    bb.flush();

    // foam slicks spread and fade
    for (const f of this._foam) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const t = 1 - f.life / f.maxLife;
      const s = f.size * (1 + t * 1.2);
      f.mesh.scale.set(s, s, 1);
      f.mesh.material.opacity = Math.max(0, 1 - t) * 0.8;
      if (f.life <= 0) f.mesh.visible = false;
    }
  }
}

// Lacy, broken-up foam patch (white on transparent).
function makeFoamTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  let r = 7;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.pow(rand(), 0.6) * size * 0.46;
    const x = size / 2 + Math.cos(a) * d;
    const y = size / 2 + Math.sin(a) * d;
    const rad = 2 + rand() * 9 * (1 - d / (size * 0.5));
    const alpha = 0.08 + rand() * 0.25;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
