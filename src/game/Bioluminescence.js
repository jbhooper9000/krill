import * as THREE from 'three';
import { WATER_GLSL, waterUniform } from './WaterMedium.js';

// =============================================================================
// Plankton bioluminescence wake (dinoflagellates, ~475 nm).
//
// Mechanically-stimulated plankton flash for ~0.1 s and glow out over about a
// second where the water is sheared: along a moving whale's body and, most of
// all, in the fluke's wake. At night in Monterey this outlines swimming
// animals in blue-green sparks — which is also what lets a player read the
// whale at 55 m on a moonless-dark screen.
//
// Emission is ABSOLUTE (a fixed small radiance), so it is invisible in
// daylight and only shows once the auto exposure opens up at night; it is
// attenuated (not in-scattered) by the water between spark and camera.
//
// The whale is found by name ('whale', Whale.js) in the scene; its body axis
// is the group's -Z and its length comes from the bounding box once. No API is
// needed from other systems. Krill photophores are separate (SwarmRender.js).
// =============================================================================

const POOL = 2400;
const _up = new THREE.Vector3();
const _p = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();

const vert = /* glsl */ `
  ${WATER_GLSL}
  attribute float aBirth;
  attribute float aSeed;
  uniform float uTime;
  uniform float uPixelScale;
  uniform float uGain;
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vec4 mv = viewMatrix * wp;
    gl_Position = projectionMatrix * mv;
    float age = uTime - aBirth;
    // flash (~0.08 s rise) then a glow that fades over ~1 s, with flicker
    float env = smoothstep( 0.0, 0.08, age ) * exp( - age / ( 0.5 + 0.7 * aSeed ) );
    env *= 0.75 + 0.25 * sin( age * ( 23.0 + 17.0 * aSeed ) );
    if ( age < 0.0 || age > 4.0 ) env = 0.0;
    float size = ( 0.05 + 0.07 * aSeed ) * uPixelScale / max( - mv.z, 0.1 );
    float s = clamp( size, 1.5, 10.0 );
    gl_PointSize = s;
    // keep energy when the sprite is clamped up to 1.5 px
    vA = env * min( 1.0, ( size * size ) / ( s * s ) + 0.15 );
    vec3 T;
    kwWaterT( vec3( 0.0 ), cameraPosition, wp.xyz, T );
    vCol = vec3( 0.12, 0.55, 1.0 ) * T * uGain;
  }
`;
const frag = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main() {
    float r = length( gl_PointCoord - 0.5 ) * 2.0;
    float a = exp( - r * r * 3.5 ) * ( 1.0 - smoothstep( 0.8, 1.0, r ) );
    gl_FragColor = vec4( vCol * vA * a, 1.0 );
  }
`;

export class Bioluminescence {
  constructor(scene) {
    this.scene = scene;
    this.intensity = 0; // set from the world's darkness each frame
    this._time = 0;
    this._next = 0;
    this._whale = null;
    this._whaleLen = 10;
    this._searchT = 0;
    this._prev = new THREE.Vector3();
    this._hasPrev = false;
    this._carry = 0;
    this._lastEmit = -100;

    const geo = new THREE.BufferGeometry();
    this._pos = new Float32Array(POOL * 3).fill(-1e5);
    this._birth = new Float32Array(POOL).fill(-100);
    this._seed = new Float32Array(POOL);
    for (let i = 0; i < POOL; i++) this._seed[i] = Math.random();
    this._aPos = new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._aBirth = new THREE.BufferAttribute(this._birth, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._aPos);
    geo.setAttribute('aBirth', this._aBirth);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this._seed, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        krillWater: waterUniform,
        uTime: { value: 0 },
        uPixelScale: { value: 600 },
        uGain: { value: 0 },
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'bioluminescence';
    scene.add(this.points);
  }

  _findWhale(dt) {
    const w = this._whale;
    if (w && w.parent) return w;
    this._whale = null;
    this._hasPrev = false;
    this._searchT -= dt;
    if (this._searchT > 0) return null;
    this._searchT = 0.5;
    const found = this.scene.getObjectByName('whale');
    if (found) {
      found.updateMatrixWorld(true);
      _box.setFromObject(found);
      _box.getSize(_size);
      const s = found.scale.x || 1;
      this._whaleLen = Math.max(_size.x, _size.y, _size.z) / s;
      // skin meshes to emit from; the fluke (wake) and flippers shear most
      this._meshes = [];
      let total = 0;
      found.traverse((o) => {
        const pa = o.isMesh && o.geometry && o.geometry.attributes.position;
        if (!pa || pa.count < 60 || /eye|teeth|mouth/i.test(o.name)) return;
        const w = pa.count * (/fluke/i.test(o.name) ? 4 : /flipper/i.test(o.name) ? 2 : 1);
        total += w;
        this._meshes.push({ mesh: o, w, cum: total });
      });
      this._meshTotal = total;
      this._whale = found;
    }
    return this._whale;
  }

  _emit(p) {
    const i = this._next;
    this._next = (i + 1) % POOL;
    this._pos[i * 3] = p.x;
    this._pos[i * 3 + 1] = p.y;
    this._pos[i * 3 + 2] = p.z;
    this._birth[i] = this._time;
    return i;
  }

  /**
   * @param {number} dt
   * @param {number} darkness 0 (day) .. 1 (night); scales emission
   * @param {number} waterLevel
   * @param {number} pixelScale projection scale in px (see World snow)
   */
  update(dt, darkness, waterLevel, pixelScale) {
    this._time += dt;
    this.material.uniforms.uTime.value = this._time;
    this.material.uniforms.uPixelScale.value = pixelScale;
    // absolute emission: a small radiance that only shows at night exposure
    this.material.uniforms.uGain.value = 0.006;
    this.points.visible = darkness > 0.01 || this._time - this._lastEmit < 4;
    if (darkness <= 0.01 || dt <= 0) return;

    const whale = this._findWhale(dt);
    if (!whale) return;
    const gp = whale.position;
    if (!this._hasPrev) { this._prev.copy(gp); this._hasPrev = true; return; }
    const speed = gp.distanceTo(this._prev) / dt;
    this._prev.copy(gp);
    if (speed > 60) return; // teleport / rebase

    const L = this._whaleLen * (whale.scale.x || 1);
    // sparks per second: shear grows with speed; always a little from the tail beat
    const rate = darkness * (220 + Math.min(speed, 12) * 130) * (L / 14);
    this._carry += rate * dt;
    let n = Math.floor(this._carry);
    if (n <= 0) return;
    this._carry -= n;
    n = Math.min(n, 200);

    const start = this._next;
    const meshes = this._meshes;
    if (!meshes || !meshes.length) return;
    for (let k = 0; k < n; k++) {
      // a random point on the skin: the sheared boundary layer lights up,
      // outlining the body; sparks stay in the water, trailing behind
      const r = Math.random() * this._meshTotal;
      let m = meshes[0];
      for (let j = 0; j < meshes.length; j++) { if (r <= meshes[j].cum) { m = meshes[j]; break; } }
      const pa = m.mesh.geometry.attributes.position;
      const na = m.mesh.geometry.attributes.normal;
      const vi = Math.floor(Math.random() * pa.count);
      _p.fromBufferAttribute(pa, vi);
      if (na) _p.addScaledVector(_up.fromBufferAttribute(na, vi), 0.04 + Math.random() * 0.12);
      _p.applyMatrix4(m.mesh.matrixWorld);
      if (_p.y > waterLevel - 0.2) continue;
      this._emit(_p);
    }
    this._lastEmit = this._time;
    // upload only what changed (handles ring wrap)
    const end = this._next;
    this._aPos.clearUpdateRanges();
    this._aBirth.clearUpdateRanges();
    if (end > start) {
      this._aPos.addUpdateRange(start * 3, (end - start) * 3);
      this._aBirth.addUpdateRange(start, end - start);
    } else if (end !== start) {
      this._aPos.addUpdateRange(start * 3, (POOL - start) * 3);
      this._aPos.addUpdateRange(0, end * 3);
      this._aBirth.addUpdateRange(start, POOL - start);
      this._aBirth.addUpdateRange(0, end);
    }
    this._aPos.needsUpdate = true;
    this._aBirth.needsUpdate = true;
  }

  // floating origin: the scene shifted by -(dx, dz)
  rebase(dx, dz) {
    for (let i = 0; i < POOL; i++) { this._pos[i * 3] -= dx; this._pos[i * 3 + 2] -= dz; }
    this._prev.x -= dx;
    this._prev.z -= dz;
    this._aPos.clearUpdateRanges();
    this._aPos.needsUpdate = true;
  }
}
