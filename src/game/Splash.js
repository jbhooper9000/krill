import * as THREE from 'three';
import { makeWaterAware } from './WaterMedium.js';
import { makeMistAtlas } from './textures.js';

// =============================================================================
// Water interaction effects: breach exit / re-entry and blows.
//
// Layers (design §5.5; scaled by body length L and impact speed v):
//   streaks  — spray droplets and water sheets as camera-facing quads stretched
//              along their screen-space velocity (a ~1/25 s "shutter"), with a
//              bright head and fading tail. Sub-pixel drops widen and fade
//              (coverage) instead of aliasing into popcorn.
//   mist     — large, irregular, slowly growing puffs (atlas of ragged
//              clusters, random rotation) that drift downwind (World.wind) and
//              glow when backlit (forward scattering toward the sun).
//   crown    — re-entry: an open curtain mesh around the impact whose lobed
//              rim rises ballistically to ~0.5 H and collapses, tearing into
//              ligaments that shed droplets. Radius R = 0.45 L.
//   plume    — re-entry: central column, H = 0.55 L (v / 9), streaks + mist.
//   foam     — surface decal per event: dense whitewater at the entry that
//              breaks into lace and lingers as a slick "footprint" for 60 s,
//              plus an outward ring wave (3 m/s for 6 s).
//   sheeting — while airborne, water pours off the body (along the spine,
//              flanks and flukes) and a skirt is dragged up at the contact
//              ring as the body leaves the water.
//   bubbles  — underwater: entrained air (a rising bubble plume) and a white
//              bubble-cloud wash around the entry cavity.
// Particle counts ∝ L² (humpback ≈ 1,500 impact streaks).
//
// Media: air-side layers only render with the camera above the water, water-
// side layers only below it (the surface is opaque from below, and blending
// order across it would be wrong); the foam decal is seen from both sides.
// Everything is water-aware (makeWaterAware + fog chunks).
//
// All pooled: nothing is allocated per frame.
// =============================================================================

const GRAVITY = 9.81;

// ---- viewport uniforms (sub-pixel coverage) ------------------------------------
const viewU = { uPixelScale: { value: 600 } };
const _vp = new THREE.Vector4();
function updateViewport(renderer, scene, camera) {
  const rt = renderer.getRenderTarget();
  let h;
  if (rt) h = rt.height;
  else { renderer.getCurrentViewport(_vp); h = _vp.w; }
  viewU.uPixelScale.value = h * 0.5 * camera.projectionMatrix.elements[5];
}

// ---- sprite pool ------------------------------------------------------------------
const spriteVert = /* glsl */ `
attribute vec2 corner;
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iP; // size (m), alpha, stretch (s), seed
uniform float uPixelScale;
uniform float uTime;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
	float size = iP.x;
	float alpha = iP.y;
	float stretch = iP.z;
	float seed = iP.w;
	vec4 mvPosition = viewMatrix * vec4( iPos, 1.0 );
	float z = max( - mvPosition.z, 0.05 );
	float hw = 0.5 * size;
	// keep >= ~1 px wide; trade size for alpha (coverage)
	float px = hw * uPixelScale / z;
	float g = max( 1.0, 0.7 / max( px, 1e-4 ) );
	hw *= g;
	alpha /= g * g;
	vec2 axis;
	float hl = hw;
	if ( stretch > 0.0 ) {
		vec2 sv = ( viewMatrix * vec4( iVel, 0.0 ) ).xy;
		float sl = length( sv );
		axis = sl > 1e-4 ? sv / sl : vec2( 0.0, 1.0 );
		// drops are never round: at least ~2.5:1 along the motion (a droplet in
		// flight smears over the exposure; round white discs read as cotton)
		hl = max( hw + 0.5 * sl * stretch, hw * 2.5 );
		alpha *= mix( 1.0, hw / hl, 0.5 ); // the same water smeared along the path
		mvPosition.xy -= axis * ( hl - hw ); // head at the particle, tail behind
	} else {
		float a = seed * 6.2831 + uTime * ( fract( seed * 7.13 ) - 0.5 ) * 0.3;
		axis = vec2( cos( a ), sin( a ) );
	}
	// (axis.y, -axis.x) keeps the quad's winding counter-clockwise (front-facing)
	mvPosition.xy += axis * corner.y * hl + vec2( axis.y, - axis.x ) * corner.x * hw;
	gl_Position = projectionMatrix * mvPosition;
	if ( alpha < 0.002 || size <= 0.0 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
	vUv = corner;
	vAlpha = min( alpha, 1.0 );
	vSeed = seed;
	#include <fog_vertex>
}
`;

const spriteFrag = /* glsl */ `
uniform vec3 uColor;
uniform sampler2D uAtlas;
uniform float uAmb;
uniform float uSun;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
#include <fog_pars_fragment>
#define SP_SKY ( 0.5 * ( KW_ZENITH + KW_HORIZ ) )
void main() {
	float a;
	#if defined( SP_STREAK )
		// soft capsule: bright head (+y), fading tail
		// tapered streak: full width at the head, thinning to the tail
		float w = mix( 0.25, 1.0, smoothstep( - 1.0, 0.6, vUv.y ) );
		float d = length( vec2( vUv.x / w, vUv.y ) );
		a = ( 1.0 - smoothstep( 0.3, 1.0, d ) ) * ( 0.35 + 0.65 * smoothstep( - 1.0, 0.7, vUv.y ) );
	#elif defined( SP_BUBBLE )
		// small bubbles: bright rim, clearer core
		float r = length( vUv );
		a = ( 1.0 - smoothstep( 0.8, 1.0, r ) ) * ( 0.35 + 0.65 * smoothstep( 0.4, 0.85, r ) );
	#else
		float cell = floor( fract( vSeed * 3.7 ) * 4.0 );
		vec2 uv = ( vUv * 0.5 + 0.5 ) * 0.5 + vec2( mod( cell, 2.0 ), floor( cell / 2.0 ) ) * 0.5;
		a = texture2D( uAtlas, uv ).a;
		// erode with a second, rotated cell: ragged wisps, not cotton balls
		vec2 r2 = vec2( vUv.y, - vUv.x ) * 0.8;
		float cell2 = mod( cell + 1.0, 4.0 );
		vec2 uv2 = ( r2 * 0.5 + 0.5 ) * 0.5 + vec2( mod( cell2, 2.0 ), floor( cell2 / 2.0 ) ) * 0.5;
		a *= smoothstep( 0.05, 0.6, texture2D( uAtlas, uv2 ).a * 1.6 );
	#endif
	a *= vAlpha;
	if ( a < 0.003 ) discard;
	vec3 V = normalize( vKwWorld - cameraPosition );
	vec3 col;
	#ifdef SP_UNDERWATER
		// lit by the underwater light field; bubbles mirror the bright surface
		col = uColor * ( kwAmbientTransmit( vKwWorld ) * KW_W0 * uAmb + kwSunTransmit( vKwWorld ) * KW_SUNCOL * uSun * 0.1 );
	#else
		// water in air: diffuse sky + sun, strong forward scattering when backlit
		float fwd = kwPhase( dot( V, KW_SUNA ), 0.65 ) * 12.566;
		col = uColor * ( SP_SKY * uAmb * 1.2 + KW_SUNCOL * uSun * ( 0.3 + 0.1 * fwd ) );
	#endif
	gl_FragColor = vec4( col, a );
	#include <fog_fragment>
}
`;

class SpritePool {
  // opts: { kind: 'streak'|'puff'|'bubble', underwater, color, amb, sun, atlas, renderOrder }
  constructor(scene, count, opts) {
    this.count = count;
    this.opts = opts;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count).fill(1);
    this.size0 = new Float32Array(count);
    this.grow = new Float32Array(count);
    this.alpha0 = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.windK = new Float32Array(count);
    this.stretch = new Float32Array(count);
    /** current alpha per particle (0 = dead); read by tools/playtest.mjs */
    this.alpha = new Float32Array(count);
    this.params = new Float32Array(count * 4); // size, alpha, stretch, seed
    this._next = 0;
    this.live = 0;
    this._mediumVisible = true;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this._posAttr = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this._velAttr = new THREE.InstancedBufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage);
    this._pAttr = new THREE.InstancedBufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this._posAttr);
    geo.setAttribute('iVel', this._velAttr);
    geo.setAttribute('iP', this._pAttr);
    geo.instanceCount = count;

    const defines = {};
    if (opts.kind === 'streak') defines.SP_STREAK = '';
    if (opts.kind === 'bubble') defines.SP_BUBBLE = '';
    if (opts.underwater) defines.SP_UNDERWATER = '';
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...viewU,
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(opts.color ?? 0xffffff) },
        uAtlas: { value: opts.atlas || null },
        uAmb: { value: opts.amb ?? 1 },
        uSun: { value: opts.sun ?? 1 },
      },
      defines,
      vertexShader: spriteVert,
      fragmentShader: spriteFrag,
      transparent: true,
      depthWrite: false,
    });
    makeWaterAware(mat);
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 20;
    this.mesh.onBeforeRender = updateViewport;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // o: { grav=1, drag=0.4, alpha=0.7, grow=0, stretch=0, windK=0 }
  spawn(x, y, z, vx, vy, vz, life, size, o = {}) {
    const i = this._next;
    this._next = (i + 1) % this.count;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.size0[i] = size;
    this.grow[i] = o.grow ?? 0;
    this.alpha0[i] = o.alpha ?? 0.7;
    this.grav[i] = o.grav ?? 1;
    this.drag[i] = o.drag ?? 0.4;
    this.stretch[i] = o.stretch ?? 0;
    this.windK[i] = o.windK ?? 0;
    this.params[i * 4 + 3] = Math.random();
  }

  step(dt, wl, wind, buoyant = false) {
    let live = 0;
    const air = !this.opts.underwater;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) { this.alpha[i] = 0; this.params[i * 4 + 1] = 0; this.params[i * 4] = 0; }
        continue;
      }
      live++;
      const i3 = i * 3;
      const d = Math.exp(-dt * this.drag[i]);
      const wx = wind.x * this.windK[i], wz = wind.z * this.windK[i];
      this.vel[i3] = wx + (this.vel[i3] - wx) * d;
      this.vel[i3 + 2] = wz + (this.vel[i3 + 2] - wz) * d;
      if (buoyant) {
        // bubbles: terminal rise speed grows with size, with a wobble
        const vt = 0.4 + this.size0[i] * 4;
        this.vel[i3 + 1] += (vt - this.vel[i3 + 1]) * Math.min(1, dt * 2);
        this.pos[i3] += Math.sin(this.life[i] * 9 + i) * 0.35 * dt;
        this.pos[i3 + 2] += Math.cos(this.life[i] * 7 + i) * 0.35 * dt;
      } else {
        this.vel[i3 + 1] = this.vel[i3 + 1] * (this.drag[i] > 1 ? d : 1) - GRAVITY * this.grav[i] * dt;
      }
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.life[i] -= dt;
      if (this.opts.kind === 'puff' && air) {
        // big puffs must not intersect the surface (its depth would cut them
        // with a straight edge): ride above it
        const minY = wl + 0.4 * this.size0[i] * (1 + this.grow[i] * (1 - this.life[i] / this.maxLife[i]));
        if (this.pos[i3 + 1] < minY) { this.pos[i3 + 1] = minY; if (this.vel[i3 + 1] < 0) this.vel[i3 + 1] = 0; }
      } else if (air && this.pos[i3 + 1] < wl && this.vel[i3 + 1] < 0) this.life[i] = 0;
      if (!air && this.pos[i3 + 1] > wl - 0.08) this.life[i] = 0;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const fade = this.life[i] > 0 ? Math.min(1, (1 - t) * 2.5) * Math.min(1, t * 14 + 0.25) : 0;
      this.alpha[i] = this.alpha0[i] * fade;
      this.params[i * 4] = this.size0[i] * (1 + this.grow[i] * t);
      this.params[i * 4 + 1] = this.alpha[i];
      this.params[i * 4 + 2] = this.stretch[i];
    }
    this.live = live;
    this.mesh.visible = live > 0 && this._mediumVisible;
    if (live > 0) {
      this._posAttr.needsUpdate = true;
      this._velAttr.needsUpdate = true;
      this._pAttr.needsUpdate = true;
    }
  }

  setMediumVisible(v) {
    this._mediumVisible = v;
    this.mesh.visible = v && this.live > 0;
  }

  rebase(dx, dz) {
    for (let i = 0; i < this.count; i++) { this.pos[i * 3] -= dx; this.pos[i * 3 + 2] -= dz; }
    this._posAttr.needsUpdate = true;
  }
}

// ---- crown curtain -------------------------------------------------------------------
const crownVert = /* glsl */ `
uniform float uAge;
uniform float uR;
uniform float uH;
uniform float uSeed;
varying vec2 vC; // angle (rad), height 0..1
varying float vRim;
#include <fog_pars_vertex>
void main() {
	float ang = atan( position.z, position.x );
	float h01 = position.y + 0.5;
	float vUp = sqrt( 2.0 * 9.81 * uH );
	float t = uAge;
	// lobed rim: the curtain is taller in a few places (fingers)
	float lobe = 0.72 + 0.2 * sin( ang * 7.0 + uSeed ) + 0.12 * sin( ang * 17.0 + uSeed * 3.1 ) + 0.06 * sin( ang * 31.0 + uSeed * 1.7 );
	float hr = max( 0.0, vUp * t - 4.9 * t * t ) * lobe;
	// the sheet leans outward as it rises and the ring spreads
	float r = uR * ( 0.75 + 0.35 * min( t * 1.2, 1.0 ) ) * ( 1.0 + 0.05 * sin( ang * 5.0 + uSeed ) ) + h01 * hr * 0.45;
	vec3 p = vec3( cos( ang ) * r, h01 * hr, sin( ang ) * r );
	vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	vC = vec2( ang, h01 );
	vRim = hr;
	#include <fog_vertex>
}
`;
const crownFrag = /* glsl */ `
uniform float uAge;
uniform float uDur;
uniform float uSeed;
varying vec2 vC;
varying float vRim;
#include <fog_pars_fragment>
#define SP_SKY ( 0.5 * ( KW_ZENITH + KW_HORIZ ) )
float cHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float cNoise( vec2 x ) {
	vec2 i = floor( x ); vec2 f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( cHash( i ), cHash( i + vec2( 1, 0 ) ), f.x ), mix( cHash( i + vec2( 0, 1 ) ), cHash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
void main() {
	if ( vRim < 0.05 ) discard;
	float k = uAge / uDur;
	// periodic in angle: sample noise on a circle
	vec2 ring = vec2( cos( vC.x ), sin( vC.x ) );
	vec2 q = ring * 6.0 + vec2( uSeed, vC.y * 3.0 - uAge * 1.5 );
	float n = cNoise( q ) * 0.6 + cNoise( q * 2.7 + 3.1 ) * 0.3 + cNoise( q * 7.0 ) * 0.1;
	// vertical ligaments (the sheet thins into streams), torn upper edge
	float lig = cNoise( ring * 30.0 + vec2( uSeed, vC.y * 1.5 ) );
	float tear = smoothstep( 0.55 + 0.35 * ( 1.0 - k ), 0.2, vC.y + ( n - 0.5 ) * 0.5 );
	float a = tear * ( 0.3 + 0.5 * lig ) * ( 0.6 + 0.4 * n );
	// the sheet breaks up as it falls
	a *= 1.0 - smoothstep( 0.45, 1.0, k ) * smoothstep( 0.35, 0.8, n + ( 1.0 - vC.y ) * 0.2 );
	a *= 1.0 - smoothstep( 0.8, 1.0, k );
	a *= smoothstep( 0.0, 0.08, vC.y + 0.02 );
	if ( a < 0.01 ) discard;
	vec3 V = normalize( vKwWorld - cameraPosition );
	float fwd = kwPhase( dot( V, KW_SUNA ), 0.6 ) * 12.566;
	vec3 white = SP_SKY * 1.3 + KW_SUNCOL * ( 0.3 + 0.1 * fwd );
	// thin sheets near the base transmit the green-blue of the sea
	vec3 sea = KW_W0 * 2.5 + KW_SUNCOL * 0.04;
	vec3 col = mix( sea, white, 0.45 + 0.55 * smoothstep( 0.05, 0.5, vC.y ) );
	gl_FragColor = vec4( col, a );
	#include <fog_fragment>
}
`;

// ---- foam slick decal ------------------------------------------------------------------
const foamVert = /* glsl */ `
varying vec2 vQ;
#include <fog_pars_vertex>
void main() {
	vQ = position.xy; // plane is -0.5..0.5, scaled by the mesh
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <fog_vertex>
}
`;
const foamFrag = /* glsl */ `
uniform float uAge;
uniform float uLife;
uniform float uR;
uniform float uSpan;
uniform float uSeed;
uniform float uStrength;
varying vec2 vQ;
#include <fog_pars_fragment>
#define SP_SKY ( 0.5 * ( KW_ZENITH + KW_HORIZ ) )
float fHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float fNoise( vec2 x ) {
	vec2 i = floor( x ); vec2 f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( fHash( i ), fHash( i + vec2( 1, 0 ) ), f.x ), mix( fHash( i + vec2( 0, 1 ) ), fHash( i + vec2( 1, 1 ) ), f.x ), f.y );
}
float fbm( vec2 p ) { float s = 0.0, a = 0.5; for ( int i = 0; i < 5; i ++ ) { s += a * fNoise( p ); p = p * 2.03 + 1.7; a *= 0.5; } return s; }
void main() {
	vec2 q = vQ * uSpan;              // metres from the centre
	float r = length( q );
	float age = uAge;
	float k = age / uLife;
	vec2 sq = q * 0.45 + uSeed;
	float w = fbm( sq * 0.35 ) - 0.5;
	// whitewater: dense churned foam at the entry, early
	float Rw = uR * ( 0.85 + 0.25 * min( age, 3.0 ) );
	float core = ( 1.0 - smoothstep( Rw * 0.55, Rw, r * ( 1.0 + 0.6 * w ) ) ) * exp( - age / 4.0 );
	core *= 0.75 + 0.5 * fbm( sq * 1.3 + age * 0.3 );
	// lingering slick: foam lace, thinning into streaks and cells with age
	float Rs = uR * ( 1.15 + 0.012 * age );
	float env = 1.0 - smoothstep( Rs * 0.55, Rs, r * ( 1.0 + 0.8 * w ) );
	float f = fbm( sq * 1.1 + vec2( 0.0, age * 0.01 ) );
	float ridge = 1.0 - abs( 2.0 * f - 1.0 );
	float th = mix( 0.62, 0.9, sqrt( k ) );
	float lace = smoothstep( th, th + 0.08, ridge ) * env * ( 1.0 - smoothstep( 0.6, 1.0, k ) );
	// ring wave: outward at 3 m/s for 6 s
	float rr = uR * 0.6 + 3.0 * age;
	vec2 dirq = q / max( r, 1e-3 );
	float ring = exp( - pow( ( r - rr ) / ( 0.5 + 0.1 * age ), 2.0 ) ) * ( 1.0 - smoothstep( 2.0, 6.0, age ) )
		* smoothstep( 0.35, 0.65, fbm( dirq * 5.0 + vec2( r * 0.2, uSeed ) ) );
	float a = clamp( max( core, lace * 0.8 ) + ring * 0.45, 0.0, 1.0 ) * uStrength;
	if ( a < 0.004 ) discard;
	vec3 col = SP_SKY * 1.05 + KW_SUNCOL * max( KW_SUNA.y, 0.0 ) * 0.28;
	gl_FragColor = vec4( col, a );
	#include <fog_fragment>
}
`;

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Splash {
  constructor(scene, waterLevel = 0, world = null) {
    this.scene = scene;
    this.waterLevel = waterLevel;
    this.world = world;
    this.wind = { x: 0.8, z: 0.3 }; // m/s drift for mist (synced from World.wind when present)
    this._time = 0;
    const atlas = makeMistAtlas();

    // air side
    this.spray = new SpritePool(scene, 6000, { kind: 'streak', color: 0xf2f8fb, amb: 1.0, sun: 1.0, renderOrder: 21 });
    this.mist = new SpritePool(scene, 700, { kind: 'puff', atlas, color: 0xf4f8fa, amb: 1.0, sun: 1.0, renderOrder: 20 });
    // water side
    this.bubbles = new SpritePool(scene, 3500, { kind: 'bubble', underwater: true, color: 0xe8fbff, amb: 3.0, sun: 1.0, renderOrder: 20 });
    this.wash = new SpritePool(scene, 400, { kind: 'puff', atlas, underwater: true, color: 0xeefcff, amb: 2.2, sun: 0.6, renderOrder: 19 });
    this._pools = [this.spray, this.mist, this.bubbles, this.wash];

    this._shed = null; // { group, length, time, duration, prev, vel }
    this._blows = []; // active exhalation jets

    // crowns (pooled curtain meshes)
    const crownGeo = new THREE.CylinderGeometry(1, 1, 1, 96, 10, true);
    this._crowns = [];
    for (let i = 0; i < 3; i++) {
      const mat = makeWaterAware(new THREE.ShaderMaterial({
        uniforms: { uAge: { value: 0 }, uR: { value: 6 }, uH: { value: 4 }, uDur: { value: 2 }, uSeed: { value: 0 } },
        vertexShader: crownVert,
        fragmentShader: crownFrag,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      const mesh = new THREE.Mesh(crownGeo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 19;
      scene.add(mesh);
      this._crowns.push({ mesh, mat, age: 0, dur: 0, active: false, R: 1, Hc: 1 });
    }
    this._crownNext = 0;

    // foam slicks (pooled decals lying on the surface)
    this._foam = [];
    for (let i = 0; i < 6; i++) {
      const mat = makeWaterAware(new THREE.ShaderMaterial({
        uniforms: { uAge: { value: 0 }, uLife: { value: 60 }, uR: { value: 6 }, uSpan: { value: 40 }, uSeed: { value: 0 }, uStrength: { value: 1 } },
        vertexShader: foamVert,
        fragmentShader: foamFrag,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = waterLevel + 0.04;
      mesh.visible = false;
      mesh.renderOrder = 11;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this._foam.push({ mesh, mat, life: 0, maxLife: 60 });
    }
    this._foamNext = 0;
  }

  // ---- events ----------------------------------------------------------------

  // Whale bursting out of the water. size ~ whale length (m).
  exit(pos, size, dir) {
    const y = this.waterLevel;
    const k = (size / 14) ** 2;
    const n = Math.round(700 * k);
    // water dragged up around the rising body: a skirt of drops and sheets
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = size * (0.06 + Math.random() * 0.1);
      const up = 3 + Math.random() * 8;
      const out = 0.6 + Math.random() * 2.8;
      const sheet = Math.random() < 0.3;
      this.spray.spawn(
        pos.x + Math.cos(a) * r, y + Math.random() * 0.3, pos.z + Math.sin(a) * r,
        Math.cos(a) * out + dir.x * 2.5, up, Math.sin(a) * out + dir.z * 2.5,
        1.0 + Math.random() * 1.3, sheet ? 0.2 + Math.random() * 0.25 : 0.05 + Math.random() * 0.09,
        { stretch: sheet ? 0.1 : 0.06, alpha: sheet ? 0.35 : 0.85, drag: 0.25, grow: sheet ? 0.5 : 0 },
      );
    }
    for (let i = 0; i < Math.round(30 * k); i++) {
      const a = Math.random() * Math.PI * 2;
      const r = size * 0.12 * Math.random();
      this.mist.spawn(pos.x + Math.cos(a) * r, y + 0.5 + Math.random() * 2, pos.z + Math.sin(a) * r,
        Math.cos(a) * 1.2, 1 + Math.random() * 2, Math.sin(a) * 1.2,
        2.5 + Math.random() * 2, size * (0.14 + Math.random() * 0.12),
        { grav: 0.05, drag: 1.2, alpha: 0.14, grow: 1.8, windK: 0.7 });
    }
    this._bubbleBurst(pos, size * 0.5, Math.round(700 * k), 0.6);
    this._addFoam(pos, size * 0.35, 0.7);
  }

  // Whale crashing back in. speed = downward speed at impact (m/s).
  impact(pos, size, speed) {
    const y = this.waterLevel;
    const e = THREE.MathUtils.clamp(speed / 9, 0.4, 1.5);
    const k = (size / 14) ** 2;
    const H = 0.55 * size * (speed / 9); // plume height
    const R = 0.45 * size; // crown radius
    const Hc = Math.max(1.2, 0.5 * H); // crown rim height
    const plumeV = Math.sqrt(2 * GRAVITY * Math.max(H, 1));
    const crownV = Math.sqrt(2 * GRAVITY * Hc);

    // crown curtain + droplets thrown from it
    this._addCrown(pos, R, Hc);
    const nc = Math.round(900 * k * e);
    for (let i = 0; i < nc; i++) {
      const a = Math.random() * Math.PI * 2;
      const ring = R * (0.8 + Math.random() * 0.35);
      const up = crownV * (0.55 + Math.random() * 0.6);
      const out = (1.5 + Math.random() * 4.5) * e;
      const sheet = Math.random() < 0.18;
      this.spray.spawn(
        pos.x + Math.cos(a) * ring, y + Math.random() * 0.4, pos.z + Math.sin(a) * ring,
        Math.cos(a) * out, up, Math.sin(a) * out,
        1.4 + Math.random() * 1.6, sheet ? 0.25 + Math.random() * 0.4 : 0.06 + Math.random() * 0.12,
        { stretch: sheet ? 0.09 : 0.055, alpha: sheet ? 0.4 : 0.9, drag: 0.2, grow: sheet ? 0.8 : 0.2 },
      );
    }
    // central plume: a tall column of heavy spray
    const np = Math.round(420 * k * e);
    for (let i = 0; i < np; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * size * 0.12;
      const v = plumeV * (0.45 + Math.random() * 0.55);
      this.spray.spawn(
        pos.x + Math.cos(a) * r, y, pos.z + Math.sin(a) * r,
        Math.cos(a) * 1.5 * Math.random(), v, Math.sin(a) * 1.5 * Math.random(),
        2 + Math.random() * 1.4, 0.12 + Math.random() * 0.35,
        { stretch: 0.04, alpha: 0.85, drag: 0.15, grow: 0.6 },
      );
    }
    // mist: the plume and crown atomise into drifting spindrift
    const nm = Math.round(160 * k * e);
    for (let i = 0; i < nm; i++) {
      const a = Math.random() * Math.PI * 2;
      const plume = i < nm * 0.55;
      const r = plume ? Math.random() * size * 0.15 : R * (0.7 + Math.random() * 0.4);
      const h = plume ? Math.random() * H * 0.9 : Math.random() * Hc;
      this.mist.spawn(pos.x + Math.cos(a) * r, y + 0.3 + h, pos.z + Math.sin(a) * r,
        Math.cos(a) * (plume ? 0.8 : 2.2), plume ? plumeV * 0.25 * Math.random() : 1.5 * Math.random(), Math.sin(a) * (plume ? 0.8 : 2.2),
        4 + Math.random() * 4, size * (0.12 + Math.random() * 0.16),
        { grav: 0.04, drag: 0.9, alpha: plume ? 0.45 : 0.3, grow: 2.2, windK: 0.8 });
    }
    // underwater: entrained air and the cavity's bubble cloud (white-out wash)
    this._bubbleBurst(pos, size, Math.round(1600 * k * e), 1);
    for (let i = 0; i < Math.round(80 * k); i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * size * 0.45;
      this.wash.spawn(pos.x + Math.cos(a) * r, y - 0.5 - Math.random() * size * 0.4, pos.z + Math.sin(a) * r,
        Math.cos(a) * 0.8, 0.4 + Math.random() * 0.6, Math.sin(a) * 0.8,
        3 + Math.random() * 3, size * (0.12 + Math.random() * 0.12),
        { grav: 0, drag: 1.5, alpha: 0.45, grow: 1.2 });
    }
    this._addFoam(pos, R, 1);
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
      const vx = (b.dx + Math.cos(a) * s) * v + this.wind.x, vy = b.up * v, vz = (b.dz + Math.sin(a) * s) * v + this.wind.z;
      const x = b.x + (Math.random() - 0.5) * 0.25, z = b.z + (Math.random() - 0.5) * 0.25;
      if (Math.random() < 0.45) {
        // vapour: faint, spreads as it thins, drifts downwind
        this.mist.spawn(x, b.y, z, vx, vy, vz, 2.5 + Math.random() * 2, 0.35 + Math.random() * 0.45,
          { grav: 0.12, drag: 1.6, alpha: 0.3, grow: 3.2, windK: 1 });
      } else {
        // entrained seawater droplets
        this.spray.spawn(x, b.y, z, vx, vy, vz, 1.2 + Math.random(), 0.05 + Math.random() * 0.08,
          { grav: 0.6, drag: 1.0, alpha: 0.75, grow: 0.3, stretch: 0.035, windK: 0.5 });
      }
    }
  }

  // Floating origin: the scene shifted by -(dx, dz) (see Terrain.onRebase).
  rebase(dx, dz) {
    for (const pool of this._pools) pool.rebase(dx, dz);
    for (const f of this._foam) { f.mesh.position.x -= dx; f.mesh.position.z -= dz; }
    for (const c of this._crowns) { c.mesh.position.x -= dx; c.mesh.position.z -= dz; }
    for (const b of this._blows) { b.x -= dx; b.z -= dz; }
    if (this._shed) { this._shed.prev.x -= dx; this._shed.prev.z -= dz; }
  }

  // Water streaming off the whale's body while it is airborne.
  shedFrom(group, length, duration = 1.2) {
    group.updateMatrixWorld();
    this._shed = { group, length, time: 0, duration: duration * 1.8, prev: group.position.clone(), vel: new THREE.Vector3() };
  }

  _bubbleBurst(pos, size, n, depthK) {
    const y = this.waterLevel;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * size * 0.4;
      const d = Math.pow(Math.random(), 0.7) * size * 0.55 * depthK; // entrained air is driven down
      this.bubbles.spawn(
        pos.x + Math.cos(a) * r, y - 0.3 - d, pos.z + Math.sin(a) * r,
        Math.cos(a) * 0.6, 0.3 + Math.random(), Math.sin(a) * 0.6,
        4 + Math.random() * 6, 0.02 + Math.pow(Math.random(), 3) * 0.2,
        { alpha: 0.65, drag: 1.2 },
      );
    }
  }

  _addCrown(pos, R, Hc) {
    const c = this._crowns[this._crownNext];
    this._crownNext = (this._crownNext + 1) % this._crowns.length;
    c.mesh.position.set(pos.x, this.waterLevel, pos.z);
    c.age = 0;
    c.dur = 2 * Math.sqrt((2 * Hc) / GRAVITY) + 0.6;
    c.active = true;
    c.R = R;
    c.Hc = Hc;
    const u = c.mat.uniforms;
    u.uR.value = R; u.uH.value = Hc; u.uDur.value = c.dur; u.uSeed.value = Math.random() * 100; u.uAge.value = 0;
  }

  _addFoam(pos, R, strength) {
    const f = this._foam[this._foamNext];
    this._foamNext = (this._foamNext + 1) % this._foam.length;
    const span = 2 * (R * 1.6 + 3 * 6 + 2);
    f.mesh.position.x = pos.x;
    f.mesh.position.z = pos.z;
    f.mesh.scale.set(span, span, 1);
    f.mesh.visible = true;
    f.life = f.maxLife = 60;
    const u = f.mat.uniforms;
    u.uAge.value = 0; u.uLife.value = 60; u.uR.value = R; u.uSpan.value = span;
    u.uSeed.value = Math.random() * 50; u.uStrength.value = strength;
  }

  _updateShed(dt) {
    const s = this._shed;
    s.time += dt;
    const g = s.group;
    g.updateMatrixWorld();
    if (dt > 0) {
      s.vel.subVectors(g.position, s.prev).divideScalar(dt);
      s.prev.copy(g.position);
    }
    const wl = this.waterLevel;
    const L = s.length;
    const drain = Math.exp(-s.time / (s.duration * 0.45)); // water runs off
    const n = Math.round(1100 * dt * drain * (L / 14) ** 2);
    const vel = s.vel;
    for (let i = 0; i < n; i++) {
      const u = Math.random() - 0.5; // along the body, + = head
      const th = Math.random() * Math.PI * 2;
      const prof = Math.sqrt(Math.max(0.04, 1 - (2 * u) ** 2));
      const rr = 0.1 * L * prof;
      _n.set(Math.cos(th), Math.sin(th), 0);
      _v.set(_n.x * rr, _n.y * rr, -u * L);
      g.localToWorld(_v);
      _n.transformDirection(g.matrixWorld);
      const y = _v.y;
      if (y < wl - 0.2) continue;
      if (y < wl + 0.8) {
        // contact ring: a skirt of water dragged up with the body
        const f = 0.55 + Math.random() * 0.4;
        this.spray.spawn(_v.x, Math.max(y, wl + 0.05), _v.z,
          vel.x * f + _n.x * 2, Math.max(1, vel.y * f) + Math.random(), vel.z * f + _n.z * 2,
          0.8 + Math.random() * 0.8, 0.1 + Math.random() * 0.22,
          { stretch: 0.1, alpha: 0.45, drag: 0.3, grow: 0.4 });
      } else {
        // sheets pouring off the back, flanks and flukes, lagging the body
        const f = 0.2 + Math.random() * 0.25;
        const sheet = Math.random() < 0.5;
        this.spray.spawn(_v.x + _n.x * 0.1, y, _v.z + _n.z * 0.1,
          vel.x * f + _n.x * 0.6, vel.y * f + _n.y * 0.4, vel.z * f + _n.z * 0.6,
          0.9 + Math.random() * 0.8, sheet ? 0.12 + Math.random() * 0.18 : 0.04 + Math.random() * 0.06,
          { stretch: 0.12, alpha: sheet ? 0.35 : 0.85, drag: 0.3, grow: sheet ? 0.3 : 0 });
      }
    }
    if (s.time >= s.duration) this._shed = null;
  }

  update(dt, camera) {
    const wl = this.waterLevel;
    this._time += dt;
    // wind from the World's weather; near-surface drift ~0.6 U
    const ww = this.world && this.world.wind;
    if (ww && Number.isFinite(ww.kts)) {
      const U = ww.kts * 0.5144 * 0.6, d = (ww.dirDeg * Math.PI) / 180;
      this.wind.x = -Math.sin(d) * U;
      this.wind.z = Math.cos(d) * U;
    }
    // the surface hides each medium from the other
    if (camera) {
      const under = camera.position.y < wl;
      this.spray.setMediumVisible(!under);
      this.mist.setMediumVisible(!under);
      this.bubbles.setMediumVisible(under);
      this.wash.setMediumVisible(under);
      this._under = under;
    }

    for (let i = this._blows.length - 1; i >= 0; i--) {
      const b = this._blows[i];
      this._emitBlow(b, dt);
      b.t += dt;
      if (b.t >= b.duration) this._blows.splice(i, 1);
    }
    if (this._shed) this._updateShed(dt);

    // crowns: rise and collapse; the rim tears into fingers that shed drops
    for (const c of this._crowns) {
      if (!c.active) continue;
      c.age += dt;
      c.mat.uniforms.uAge.value = c.age;
      const vUp = Math.sqrt(2 * GRAVITY * c.Hc);
      const rim = Math.max(0, vUp * c.age - 4.9 * c.age * c.age);
      if (rim > 0.3 && c.age < c.dur * 0.8) {
        const n = Math.round(600 * dt * (c.R / 6.3) ** 2);
        const r0 = c.R * (0.75 + 0.35 * Math.min(c.age * 1.2, 1));
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const h = rim * (0.6 + Math.random() * 0.45);
          const r = r0 + h * 0.45;
          const out = 1 + Math.random() * 2.5;
          this.spray.spawn(c.mesh.position.x + Math.cos(a) * r, wl + h, c.mesh.position.z + Math.sin(a) * r,
            Math.cos(a) * out, Math.max(0, vUp - GRAVITY * c.age) * 0.6 + Math.random(), Math.sin(a) * out,
            0.8 + Math.random() * 0.8, 0.05 + Math.random() * 0.1,
            { stretch: 0.045, alpha: 0.8, drag: 0.2 });
        }
      }
      if (c.age >= c.dur) c.active = false;
      c.mesh.visible = c.active && !this._under;
    }

    this.spray.step(dt, wl, this.wind);
    this.mist.step(dt, wl, this.wind);
    this.bubbles.step(dt, wl, { x: 0, z: 0 }, true);
    this.wash.step(dt, wl, { x: 0, z: 0 });
    for (const p of this._pools) p.material.uniforms.uTime.value = this._time;

    // foam: whitewater -> lace -> slick footprint (60 s), drifting slightly downwind
    for (const f of this._foam) {
      if (f.life <= 0) continue;
      f.life -= dt;
      f.mat.uniforms.uAge.value = f.maxLife - f.life;
      f.mesh.position.x += this.wind.x * 0.05 * dt;
      f.mesh.position.z += this.wind.z * 0.05 * dt;
      if (f.life <= 0) f.mesh.visible = false;
    }
  }
}
