import * as THREE from 'three';
import { WATER_GLSL, makeWaterAware } from './WaterMedium.js';

// =============================================================================
// Swarm rendering: krill patches and anchovy bait balls.
//
// The boids (Boids.js) are the *flock* level: 1,500 agents that give a patch
// its shape, drift, and escape response. A real Euphausia pacifica patch holds
// thousands of animals per cubic metre, which no mesh can show, so each patch
// is drawn as three layers that all read the boid state from one float texture
// (no per-instance CPU matrices):
//
//   volume  (all distances) — a density field splatted from the boids into a
//           small 3D texture, drawn as ~40 camera-facing slices. Per sample:
//           Beer–Lambert extinction from the krill optical density
//           (sigma ~ n·area, ≈0.1/m at the core), sunlight shadowed by the
//           krill above, reddish-brown single scattering, and the water model
//           along the view ray. Reads as a dark rust-brown cloud from 100 m
//           and as a silhouette against the surface from below.
//   specks  (1.5–70 m) — GL points, 24 per boid, jittered around it: each is a
//           single krill drawn as a velocity-aligned ellipse, with sub-pixel
//           sizes turned into coverage (alpha), so density converges to the
//           volume. Glints (sunlit carapaces twisting) and bioluminescent
//           photophore flashes when the whale disturbs the patch.
//   near    (< ~6 m) — 2-triangle velocity-aligned impostors with a procedural
//           krill silhouette (carapace, eye, gut, chromatophores, see-through
//           shell), 8 per nearby boid, selected on the CPU each frame.
//
// Anchovy schools use the near impostor with a fish silhouette and a mirror
// flank (view-dependent reflection of the underwater light field → flashes as
// they turn), 24 fish per boid, visually compressed toward the school centre
// so a 70-boid school reads as a ~1,700-fish bait ball.
//
// Every material goes through the water model (makeWaterAware + the fog
// chunks, or WATER_GLSL in the vertex stage for the points), so everything
// darkens and blues with distance and depth consistently with the rest of the
// scene.
// =============================================================================

// ---- shared per-frame uniforms ----------------------------------------------
export const swarmUniforms = {
  uTime: { value: 0 },
  uPixelScale: { value: 600 }, // px per metre at 1 m distance (viewport h / (2 tan(fov/2)))
  uViewport: { value: new THREE.Vector2(1280, 720) },
  uWhalePos: { value: new THREE.Vector3(0, -1000, 0) },
  uWhaleFwd: { value: new THREE.Vector3(0, 0, -1) },
  uWhaleLen: { value: 14 },
  uMouth: { value: new THREE.Vector3(0, -1000, 0) },
  uLunge: { value: 0 }, // 0..1, eased
  // readability gain on the krill skin radiance (documented compromise, see
  // swKrillPatch): lets a day patch read at 30-60 m in Monterey-green water
  uPatchGain: { value: 3.0 },
};

// Viewport-dependent uniforms, refreshed from onBeforeRender (the only place
// that knows the actual render target size).
const _vp = new THREE.Vector4();
function updateSwarmViewport(renderer, scene, camera) {
  const rt = renderer.getRenderTarget();
  if (rt) swarmUniforms.uViewport.value.set(rt.width, rt.height);
  else { renderer.getCurrentViewport(_vp); swarmUniforms.uViewport.value.set(_vp.z, _vp.w); }
  swarmUniforms.uPixelScale.value = swarmUniforms.uViewport.value.y * 0.5 * camera.projectionMatrix.elements[5];
}

// deterministic RNG for static per-instance attributes
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5), ((s ^ (s >>> 14)) >>> 0) / 4294967296);
}
function inBall(r, rand, out, i) {
  let x, y, z;
  do { x = rand() * 2 - 1; y = rand() * 2 - 1; z = rand() * 2 - 1; } while (x * x + y * y + z * z > 1);
  out[i] = x * r; out[i + 1] = y * r; out[i + 2] = z * r;
}


// Tileable 3D value-noise texture (32^3 RGBA8, 8 lattice cells per tile):
// rgb = three independent smooth noises (domain warp), a = a fourth (density
// detail). Replaces per-fragment procedural noise in the volume (3 fetches
// instead of ~40 hashes per slice fragment).
let _noise3D = null;
function getNoise3D() {
  if (_noise3D) return _noise3D;
  const N = 32, L = 8, rand = rng(4242);
  const lat = new Float32Array(L * L * L * 4);
  for (let i = 0; i < lat.length; i++) lat[i] = rand();
  const data = new Uint8Array(N * N * N * 4);
  const sm = (t) => t * t * (3 - 2 * t);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const fx = (x / N) * L, fy = (y / N) * L, fz = (z / N) * L;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = sm(fx - ix), ty = sm(fy - iy), tz = sm(fz - iz);
    for (let c = 0; c < 4; c++) {
      const g = (a, b, d) => lat[((((a % L) + ((b % L) * L) + ((d % L) * L * L)) * 4) + c)];
      const v00 = g(ix, iy, iz) + (g(ix + 1, iy, iz) - g(ix, iy, iz)) * tx;
      const v10 = g(ix, iy + 1, iz) + (g(ix + 1, iy + 1, iz) - g(ix, iy + 1, iz)) * tx;
      const v01 = g(ix, iy, iz + 1) + (g(ix + 1, iy, iz + 1) - g(ix, iy, iz + 1)) * tx;
      const v11 = g(ix, iy + 1, iz + 1) + (g(ix + 1, iy + 1, iz + 1) - g(ix, iy + 1, iz + 1)) * tx;
      const v0 = v00 + (v10 - v00) * ty, v1 = v01 + (v11 - v01) * ty;
      data[(x + y * N + z * N * N) * 4 + c] = Math.round((v0 + (v1 - v0) * tz) * 255);
    }
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  _noise3D = t;
  return t;
}

// ---- GLSL ----------------------------------------------------------------------
const BOID_GLSL = /* glsl */ `
uniform sampler2D uBoids;       // row 0: pos.xyz, alive ; row 1: vel.xyz, phase
uniform float uTime;
uniform float uPixelScale;
uniform vec2 uViewport;
uniform vec3 uWhalePos;
uniform vec3 uWhaleFwd;
uniform float uWhaleLen;
uniform vec3 uMouth;
uniform float uLunge;
vec4 boidPos( float i ) { return texelFetch( uBoids, ivec2( int( i ), 0 ), 0 ); }
vec4 boidVel( float i ) { return texelFetch( uBoids, ivec2( int( i ), 1 ), 0 ); }

// How disturbed the water around p is by the whale (0..1): the bow wave and,
// during a lunge, the engulfment. Drives the visual parting and the flashes.
float swDisturb( vec3 p ) {
	vec3 rel = p - uWhalePos;
	float along = dot( rel, uWhaleFwd );
	float rad = length( rel - uWhaleFwd * along );
	float L = uWhaleLen;
	float zone = smoothstep( - 0.8 * L, - 0.3 * L, along ) * ( 1.0 - smoothstep( 0.6 * L, 1.1 * L, along ) );
	float r0 = L * ( 0.35 + 0.35 * uLunge );
	return zone * ( 1.0 - smoothstep( r0 * 0.4, r0, rad ) );
}

// Visual parting: push a sub-particle away from the whale's body axis, more
// strongly ahead of the mouth during a lunge (bow wave).
vec3 swPart( vec3 p ) {
	vec3 rel = p - uWhalePos;
	float along = dot( rel, uWhaleFwd );
	vec3 radial = rel - uWhaleFwd * along;
	float rad = max( length( radial ), 1e-3 );
	float L = uWhaleLen;
	float zone = smoothstep( - 0.7 * L, - 0.3 * L, along ) * ( 1.0 - smoothstep( 0.5 * L, 1.0 * L, along ) );
	float body = L * ( 0.13 + 0.12 * uLunge );
	float reach = body * 2.2;
	float push = zone * ( 1.0 - smoothstep( body * 0.3, reach, rad ) ) * body * 0.8;
	return p + radial / rad * push;
}

float swHash( float n ) { return fract( sin( n ) * 43758.5453123 ); }
`;

// Light arriving at a krill: sun (slant path + a little caustic flicker near
// the surface) and the diffuse field. No caustic Voronoi here: it is costly
// and invisible at swarm depths; the near-surface flicker comes from glints.
const LIGHT_GLSL = /* glsl */ `
uniform float uPatchGain;
vec3 swSunAt( vec3 p ) {
	return exp( - kwTauDown( p.y - KW_LEVEL ) / max( KW_SUNW.y, 0.3 ) ) * KW_KEYT;
}
vec3 swAmbAt( vec3 p ) { return kwLightAt( p.y - KW_LEVEL ); }
// radiance scattered toward the eye by a small krill-coloured scatterer
// (albedo) lit by the sun (with shadow) and the ambient field. wo = toward eye.
vec3 swScatter( vec3 p, vec3 wo, vec3 albedo, float shadow ) {
	float cosT = dot( - wo, KW_SUNW );                   // forward scatter when looking toward the sun
	float g = 0.45;
	float ph = ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * cosT, 1e-3 ), 1.5 );
	// krill absorb most of what they intercept: a swarm is a dark mass with a
	// faint forward-scattered rim when backlit, never as bright as the water
	vec3 sun = swSunAt( p ) * shadow * KW_SUNCOL * ( 0.03 + 0.03 * ph );
	vec3 amb = swAmbAt( p ) * ( KW_W0 * 0.7 + vec3( 0.006 ) );
	return albedo * ( sun + amb );
}
// A dense krill patch seen by day (PLAYTEST_2 N3). Krill are cm-sized,
// reflective scatterers: unlike the water's particulates (whose phase function
// is sharply forward-peaked, ~0.005/sr at 90 deg) they send a large share of
// the down-welling light sideways and back (~0.08/sr, near-Lambertian). So a
// patch's sunlit top glows copper against the water while its self-shadowed
// core and underside stay dark. Documented compromise: the effective albedo is
// ~2x a single krill's (population-integrated carapace glints + multiple
// scattering in the lit skin), so the patch reads at 30-60 m in turbid water.
vec3 swKrillPatch( vec3 p, vec3 wo, float shadow ) {
	float cosT = dot( - wo, KW_SUNW );
	float g = 0.55;
	float fwd = ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * cosT, 1e-3 ), 1.5 );
	vec3 albedo = vec3( 0.62, 0.34, 0.2 ) * 2.0;
	// the forward (diffraction) lobe only for the directly lit top skin: side-
	// lit and self-shadowed krill don't see the sun's direction, so from below
	// the patch stays a dark silhouette against the surface
	float topLit = smoothstep( 0.72, 0.95, shadow );
	vec3 key = swSunAt( p ) * KW_SUNCOL * shadow * ( 0.08 + 0.035 * fwd * topLit );
	// diffuse field: mostly from above too, so it is also shadowed (less so)
	vec3 amb = swAmbAt( p ) * KW_W0 * 1.2 * mix( 0.25, 1.0, shadow );
	return albedo * ( key + amb ) * uPatchGain;
}
`;

// ---- boid texture ----------------------------------------------------------------
class BoidTexture {
  constructor(count) {
    this.count = count;
    this.data = new Float32Array(count * 2 * 4);
    this.texture = new THREE.DataTexture(this.data, count, 2, THREE.RGBAFormat, THREE.FloatType);
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }
  // scale about (cx, cy, cz) (visual compression of fish schools)
  write(sys, cx = 0, cy = 0, cz = 0, k = 1) {
    const { pos, vel, alive, phase, count } = sys;
    const d = this.data;
    const o = count * 4;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3, i4 = i * 4;
      d[i4] = cx + (pos[i3] - cx) * k;
      d[i4 + 1] = cy + (pos[i3 + 1] - cy) * k;
      d[i4 + 2] = cz + (pos[i3 + 2] - cz) * k;
      d[i4 + 3] = alive[i];
      d[o + i4] = vel[i3];
      d[o + i4 + 1] = vel[i3 + 1];
      d[o + i4 + 2] = vel[i3 + 2];
      d[o + i4 + 3] = phase[i];
    }
    this.texture.needsUpdate = true;
  }
  dispose() { this.texture.dispose(); }
}

// ---- volume --------------------------------------------------------------------
const GRID = 20;
const DENS_MAX = 1.0; // boids/m^3 mapped to 1.0 in the grid
// krill optical cross-section per boid (each boid stands for ~thousands of
// animals): the core holds ~0.5 boids/m^3 -> sigma ~0.1/m (≈ 3,000 krill/m^3
// × 0.3 cm² each), so light through a 25 m patch is cut to ~10%
const SIGMA_PER_BOID = 0.3;
const SLICES = 32;
const INFLATE = 1.45;
const SHADOW_DEPTH = 26; // m of shaded water drawn under a patch
const SHADOW_GAIN = 1.0;

const volumeVert = /* glsl */ `
attribute vec2 corner;
attribute float aSlice;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uSlices;
varying float vThick;
varying vec3 vRayDir;
#include <fog_pars_vertex>
void main() {
	vec3 cv = ( viewMatrix * vec4( uCenter, 1.0 ) ).xyz;
	float d0 = - cv.z;
	float nearD = 0.25;
	float d1 = d0 + uRadius;
	float dS = max( d0 - uRadius, nearD );
	float thick = ( d1 - dS ) / uSlices;
	// slice 0 is the farthest: primitives draw in index order, so the single
	// draw call composites back to front
	float depth = d1 - ( aSlice + 0.5 ) * thick;
	float t = depth - d0;
	float r = sqrt( max( uRadius * uRadius - t * t, 0.0 ) ) * 1.02;
	vec4 mvPosition = vec4( cv.xy + corner * r, - depth, 1.0 );
	if ( d1 < nearD || r <= 0.0 || aSlice >= uSlices ) mvPosition = vec4( 0.0, 0.0, 1.0, 1.0 ); // behind / unused: collapse
	vThick = thick;
	gl_Position = projectionMatrix * mvPosition;
	vRayDir = ( vec4( normalize( mvPosition.xyz ), 0.0 ) * viewMatrix ).xyz;
	#include <fog_vertex>
}
`;

const volumeFrag = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uGrid;
uniform vec3 uBoxMin;
uniform vec3 uBoxSize;
uniform float uDensMax;
uniform float uSigma;
uniform float uTime;
uniform vec3 uWhalePos;
uniform vec3 uWhaleFwd;
uniform float uWhaleLen;
uniform float uLunge;
uniform float uInflate;
varying float vThick;
varying vec3 vRayDir;
#include <fog_pars_fragment>
${LIGHT_GLSL}
uniform sampler3D uNoise; // tileable, 8 lattice cells per unit
void main() {
	vec3 dir = normalize( vRayDir );
	// dither along the ray inside this slab (hides slicing)
	float h = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
	vec3 camFwd = - vec3( viewMatrix[ 0 ][ 2 ], viewMatrix[ 1 ][ 2 ], viewMatrix[ 2 ][ 2 ] );
	float ds = vThick / max( dot( dir, camFwd ), 0.2 );
	vec3 p = vKwWorld + dir * ( h - 0.5 ) * ds;
	// domain warp: the boids live in a box-bounded flock, real patches are
	// ragged, sheet- and plume-like. Low-frequency warping of the lookup turns
	// the flock's faces into billows without moving the mass.
	vec3 wq = p * 0.07 + vec3( 0.0, uTime * 0.012, 0.0 );
	vec3 warp = texture( uNoise, wq * 0.125 ).rgb - 0.5;
	vec3 uvw0 = ( p - uBoxMin - 0.5 * uBoxSize ) / ( uBoxSize * uInflate ) + 0.5;
	// below the patch: the column of water it shades (see sigmaS)
	float below = clamp( - uvw0.y * uBoxSize.y * uInflate / SW_SHADOW_DEPTH, 0.0, 1.0 );
	if ( any( lessThan( uvw0.xz, vec2( 0.0 ) ) ) || any( greaterThan( uvw0, vec3( 1.0 ) ) ) || below >= 1.0 ) discard;
	// the density field is drawn ~1.3x the flock's extent: the boids are the
	// dense core the whale feeds in, the halo the diffuse edge of a real patch
	vec3 boxC = uBoxMin + 0.5 * uBoxSize;
	vec3 guv = ( boxC + ( p - boxC ) / uInflate + warp * 6.0 - uBoxMin ) / uBoxSize;
	vec2 g = texture( uGrid, vec3( guv.x, max( guv.y, 0.5 / float( SW_GRID ) ), guv.z ) ).rg;
	if ( uvw0.y < 0.0 ) g.r = 0.0; // under the box: shadow only
	vec3 edge = min( uvw0, 1.0 - uvw0 );
	float edgeF = smoothstep( 0.02, 0.3, min( edge.x, min( max( edge.y, uvw0.y < 0.0 ? 1.0 : 0.0 ), edge.z ) ) );
	// a crisp boundary: real patches have sharp (often flat) edges, the blurred
	// splat is thresholded like an isosurface, with the interior kept
	float n = g.r * smoothstep( 0.07, 0.16, g.r ) * ( uDensMax / 0.95 ) * edgeF; // boids / m^3
	// patchiness: krill aggregate in sheets and knots that slowly churn
	// sheets are flattened vertically (krill layer), knots and grain churn slowly
	vec3 sp = p * vec3( 1.0, 2.2, 1.0 );
	float nz = texture( uNoise, ( sp * 0.2 + vec3( 0.0, uTime * 0.04, uTime * 0.03 ) ) * 0.125 ).a * 0.55
		+ texture( uNoise, ( sp * 0.7 - vec3( uTime * 0.07, 0.0, 0.0 ) ) * 0.125 + 0.37 ).a * 0.3
		+ texture( uNoise, ( p * 2.3 + vec3( 0.0, 0.0, uTime * 0.1 ) ) * 0.125 + 0.71 ).a * 0.15;
	float knots = smoothstep( 0.2, 0.8, nz );
	n *= knots * knots * 2.6;
	// the whale's body (and its bow wave during a lunge) pushes krill aside
	vec3 rel = p - uWhalePos;
	float along = clamp( dot( rel, uWhaleFwd ), - 0.5 * uWhaleLen, 0.55 * uWhaleLen );
	float rad = length( rel - uWhaleFwd * along );
	float body = uWhaleLen * ( 0.11 + 0.14 * uLunge );
	n *= smoothstep( body * 0.8, body * 1.9, rad );
	// gameplay readability: thin the swarm near the lens and along the line of
	// sight to the whale (the follow camera sits 1-2 body lengths behind it)
	vec3 cw = uWhalePos - cameraPosition;
	float cwl = max( length( cw ), 1e-3 );
	float ts = clamp( dot( p - cameraPosition, cw ) / ( cwl * cwl ), 0.0, 1.0 );
	float los = length( p - cameraPosition - cw * ts );
	float tunnel = ts < 0.999 ? smoothstep( uWhaleLen * 0.15, uWhaleLen * 0.45, los ) : 1.0;
	n *= mix( 0.15, 1.0, tunnel );
	n *= smoothstep( 1.5, 7.0, length( p - cameraPosition ) );
	float sigma = n * uSigma;
	// the patch shades the water under it: in that column the water in-scatters
	// less down-welling light, a darker "hole" hanging below the swarm. Modelled
	// as missing in-scatter (black, weighted by the water's scattering ~0.6 c),
	// fading with depth as side light fills it in.
	float shadowK = ( 1.0 - g.g ) * edgeF * ( 1.0 - below ) * ( 1.0 - below );
	float sigmaS = shadowK * 0.6 * kwExtAt( p.y - KW_LEVEL ).g * SW_SHADOW_GAIN;
	float a = 1.0 - exp( - ( sigma + sigmaS ) * ds );
	if ( a < 0.002 ) discard;
	vec3 col = swKrillPatch( p, - dir, g.g ) * ( 0.6 + 0.6 * knots ) * ( sigma / max( sigma + sigmaS, 1e-6 ) );
	gl_FragColor = vec4( col, a );
	// water model along the view ray. Readability compromise (like KW_FLOOR):
	// beyond ~10 m the patch is fogged as if up to ~2.2x closer (0.45 by 60 m),
	// so the prey reads by eye at 30-60 m in Monterey-green water (N3).
	float dCam = length( vKwWorld - cameraPosition );
	vec3 pFog = cameraPosition + ( vKwWorld - cameraPosition ) * mix( 1.0, 0.45, smoothstep( 10.0, 60.0, dCam ) );
	gl_FragColor.rgb = kwWater( gl_FragColor.rgb, cameraPosition, pFog );
}
`;

class SwarmVolume {
  constructor(scene) {
    this.dens = new Float32Array(GRID * GRID * GRID);
    this.tmp = new Float32Array(GRID * GRID * GRID);
    this.bytes = new Uint8Array(GRID * GRID * GRID * 2);
    this.tex = new THREE.Data3DTexture(this.bytes, GRID, GRID, GRID);
    this.tex.format = THREE.RGFormat;
    this.tex.type = THREE.UnsignedByteType;
    this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = this.tex.wrapR = THREE.ClampToEdgeWrapping;
    this.tex.unpackAlignment = 1;
    this.tex.needsUpdate = true;

    const geo = new THREE.BufferGeometry();
    const corners = new Float32Array(SLICES * 4 * 2);
    const slice = new Float32Array(SLICES * 4);
    const index = [];
    for (let s = 0; s < SLICES; s++) {
      corners.set([-1, -1, 1, -1, 1, 1, -1, 1], s * 8);
      slice.fill(s, s * 4, s * 4 + 4);
      const b = s * 4;
      index.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    geo.setAttribute('corner', new THREE.BufferAttribute(corners, 2));
    geo.setAttribute('aSlice', new THREE.BufferAttribute(slice, 1));
    // three needs a 'position' attribute to compute draw ranges
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SLICES * 4 * 3), 3));
    geo.setIndex(index);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...swarmUniforms,
        uGrid: { value: this.tex },
        uNoise: { value: getNoise3D() },
        uBoxMin: { value: new THREE.Vector3() },
        uBoxSize: { value: new THREE.Vector3(1, 1, 1) },
        uCenter: { value: new THREE.Vector3() },
        uRadius: { value: 1 },
        uSlices: { value: SLICES },
        uDensMax: { value: DENS_MAX },
        uSigma: { value: SIGMA_PER_BOID },
        uInflate: { value: INFLATE },
      },
      defines: { SW_GRID: GRID, SW_SHADOW_DEPTH: SHADOW_DEPTH.toFixed(1), SW_SHADOW_GAIN: SHADOW_GAIN.toFixed(2) },
      vertexShader: volumeVert,
      fragmentShader: volumeFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    makeWaterAware(this.material);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.onBeforeRender = updateSwarmViewport;
    scene.add(this.mesh);
    this.center = new THREE.Vector3();
    this.radius = 1;
  }

  // Splat the boids into the density grid (trilinear), blur, and precompute
  // how much sunlight survives the krill above each voxel.
  build(sys) {
    const { pos, alive, count } = sys;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, n = 0;
    for (let i = 0; i < count; i++) {
      if (!alive[i]) continue;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
      n++;
    }
    if (n < 4) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const m = 11; // margin so the blurred edge fades to zero inside the box
    x0 -= m; y0 -= m; z0 -= m; x1 += m; y1 += m; z1 += m;
    const G = GRID, sx = (x1 - x0) / G, sy = (y1 - y0) / G, sz = (z1 - z0) / G;
    const d = this.dens;
    d.fill(0);
    const w = 1 / (sx * sy * sz); // boids -> boids per m^3
    for (let i = 0; i < count; i++) {
      if (!alive[i]) continue;
      let fx = (pos[i * 3] - x0) / sx - 0.5, fy = (pos[i * 3 + 1] - y0) / sy - 0.5, fz = (pos[i * 3 + 2] - z0) / sz - 0.5;
      const ix = Math.max(0, Math.min(G - 2, Math.floor(fx)));
      const iy = Math.max(0, Math.min(G - 2, Math.floor(fy)));
      const iz = Math.max(0, Math.min(G - 2, Math.floor(fz)));
      fx = Math.min(1, Math.max(0, fx - ix)); fy = Math.min(1, Math.max(0, fy - iy)); fz = Math.min(1, Math.max(0, fz - iz));
      const b = ix + iy * G + iz * G * G;
      const gx = 1 - fx, gy = 1 - fy, gz = 1 - fz;
      d[b] += gx * gy * gz * w; d[b + 1] += fx * gy * gz * w;
      d[b + G] += gx * fy * gz * w; d[b + G + 1] += fx * fy * gz * w;
      const c = b + G * G;
      d[c] += gx * gy * fz * w; d[c + 1] += fx * gy * fz * w;
      d[c + G] += gx * fy * fz * w; d[c + G + 1] += fx * fy * fz * w;
    }
    // five [1 2 1] blur passes per axis (gaussian ~1.6 voxels): soft falloff
    for (let pass = 0; pass < 5; pass++) {
      this._blur(1); this._blur(G); this._blur(G * G);
    }
    // encode density and the skylight transmittance: at depth the down-welling
    // field is diffuse (horizontal radiance ~1/3 of vertical), so a point is lit
    // through the krill above it AND through the thinnest horizontal path out
    // of the patch: T = 0.65 T_down + 0.35 max(T_+x, T_-x, T_+z, T_-z)
    const out = this.bytes;
    const sig = SIGMA_PER_BOID;
    const td = this._tDown || (this._tDown = new Float32Array(G * G * G));
    const ts = this._tSide || (this._tSide = new Float32Array(G * G * G));
    ts.fill(0);
    for (let iz = 0; iz < G; iz++) {
      for (let ix = 0; ix < G; ix++) {
        let od = 0;
        for (let iy = G - 1; iy >= 0; iy--) {
          const k = ix + iy * G + iz * G * G;
          od += d[k] * sig * sy * 0.5;
          td[k] = Math.exp(-od);
          od += d[k] * sig * sy * 0.5;
        }
      }
    }
    // horizontal sweeps along +-x and +-z
    const sweep = (stride, span, step, lines) => {
      for (const base of lines) {
        let od = 0;
        for (let a = 0; a < G; a++) {
          const k = base + (step > 0 ? a : G - 1 - a) * stride;
          od += d[k] * sig * span * 0.5;
          const t = Math.exp(-od);
          if (t > ts[k]) ts[k] = t;
          od += d[k] * sig * span * 0.5;
        }
      }
    };
    const xl = this._xl || (this._xl = []), zl = this._zl || (this._zl = []);
    if (!xl.length) {
      for (let iz = 0; iz < G; iz++) for (let iy = 0; iy < G; iy++) xl.push(iy * G + iz * G * G);
      for (let iy = 0; iy < G; iy++) for (let ix = 0; ix < G; ix++) zl.push(ix + iy * G);
    }
    sweep(1, sx, 1, xl); sweep(1, sx, -1, xl);
    sweep(G * G, sz, 1, zl); sweep(G * G, sz, -1, zl);
    for (let k = 0; k < G * G * G; k++) {
      out[k * 2] = Math.min(255, Math.round((d[k] / DENS_MAX) * 255));
      out[k * 2 + 1] = Math.round((0.65 * td[k] + 0.35 * ts[k]) * 255);
    }
    this.tex.needsUpdate = true;
    const u = this.material.uniforms;
    u.uBoxMin.value.set(x0, y0, z0);
    u.uBoxSize.value.set(x1 - x0, y1 - y0, z1 - z0);
    this.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    this.radius = 0.5 * INFLATE * Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    // slices also cover the shaded column below
    const hy = 0.5 * INFLATE * (y1 - y0);
    u.uCenter.value.set(this.center.x, this.center.y - SHADOW_DEPTH / 2, this.center.z);
    u.uRadius.value = 0.5 * Math.hypot(INFLATE * (x1 - x0), 2 * hy + SHADOW_DEPTH, INFLATE * (z1 - z0));
  }

  _blur(stride) {
    const G = GRID, d = this.dens, t = this.tmp;
    const n = G * G * G;
    for (let k = 0; k < n; k++) {
      // index along this axis
      const a = Math.floor(k / stride) % G;
      const l = a > 0 ? d[k - stride] : 0;
      const r = a < G - 1 ? d[k + stride] : 0;
      t[k] = 0.25 * l + 0.5 * d[k] + 0.25 * r;
    }
    d.set(t);
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.tex.dispose();
  }
}

// ---- specks (mid field) --------------------------------------------------------
const SPECKS_PER_BOID = 24;

const speckVert = /* glsl */ `
attribute float aBoid;
attribute vec3 aOff;
attribute float aSeed;
uniform float uSpread;
uniform float uLen;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vAxis;
varying vec2 vHalf; // half length / half width in px
varying float vSize;
${WATER_GLSL}
${BOID_GLSL}
${LIGHT_GLSL}
void main() {
	vec4 bp = boidPos( aBoid );
	vec4 bv = boidVel( aBoid );
	float s1 = swHash( aSeed * 91.7 );
	// each speck wanders around its boid on its own slow orbit
	vec3 wob = vec3( sin( uTime * ( 0.4 + s1 * 0.5 ) + aSeed * 30.0 ), sin( uTime * ( 0.3 + s1 * 0.4 ) + aSeed * 17.0 ), cos( uTime * ( 0.35 + s1 * 0.5 ) + aSeed * 23.0 ) ) * 0.35;
	vec3 p = bp.xyz + aOff * uSpread + wob;
	float dist0 = swDisturb( p );
	p = swPart( p );
	vec3 vel = bv.xyz + vec3( sin( aSeed * 13.0 ), sin( aSeed * 7.0 ) * 0.3, cos( aSeed * 11.0 ) ) * ( 0.35 + 1.5 * dist0 );
	vec3 ax = normalize( vel + vec3( 1e-4 ) );
	vec4 mv = viewMatrix * vec4( p, 1.0 );
	gl_Position = projectionMatrix * mv;
	float z = - mv.z;
	// screen-space body axis
	vec4 c2 = projectionMatrix * ( viewMatrix * vec4( p + ax * uLen * 0.5, 1.0 ) );
	vec2 sp = ( c2.xy / c2.w - gl_Position.xy / gl_Position.w ) * 0.5 * uViewport;
	float halfLen = length( sp );
	float halfWid = uLen * 0.11 * uPixelScale / max( z, 0.1 );
	vAxis = halfLen > 1e-4 ? sp / halfLen : vec2( 1.0, 0.0 );
	halfLen = max( halfLen, halfWid );
	// sub-pixel krill become coverage: the swarm converges to the volume's haze
	float cov = min( 1.0, halfWid / 0.5 ) * min( 1.0, halfLen / 0.75 );
	vHalf = max( vec2( halfLen, halfWid ), vec2( 0.75, 0.5 ) );
	vSize = 2.0 * vHalf.x + 2.0;
	gl_PointSize = vSize;
	float fade = smoothstep( 1.2, 2.2, z ) * ( 1.0 - smoothstep( 80.0, 110.0, z ) );
	vAlpha = bp.w * cov * fade * ( 0.55 + 0.45 * s1 );
	if ( bp.w < 0.5 || vAlpha < 0.003 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );

	// lighting: body colour varies from pale translucent to deep red
	vec3 wo = normalize( cameraPosition - p );
	vec3 col = swKrillPatch( p, wo, 0.55 ) * mix( 0.6, 0.35, s1 );
	// carapace glints: a krill twisting past the specular angle
	float tw = sin( uTime * ( 1.3 + 5.0 * s1 ) + aSeed * 57.0 + dist0 * uTime * 9.0 );
	float glint = pow( max( tw, 0.0 ), mix( 90.0, 14.0, dist0 ) );
	col += glint * ( swSunAt( p ) * KW_SUNCOL + swAmbAt( p ) * KW_W0 * 4.0 * dist0 ) * ( 1.2 + 4.0 * dist0 ) * vec3( 1.0, 0.92, 0.85 );
	// photophores: blue-green bioluminescent flashes when disturbed (constant
	// absolute radiance: invisible by day, sparks at night)
	float bl = pow( max( sin( uTime * ( 5.0 + 9.0 * s1 ) + aSeed * 31.0 ), 0.0 ), 40.0 ) * dist0 * step( 0.6, fract( aSeed * 3.3 ) );
	// readability: the camera's night exposure is capped, so photophores are
	// boosted as the surface light level (KW_LIGHT) falls
	float blGain = 1.0 + 3.0 * ( 1.0 - clamp( KW_LIGHT, 0.0, 1.0 ) );
	// peak kept under the bloom threshold at night exposure (1-px HDR spikes
	// turn into blocky bloom squares); visibility comes from size + alpha
	col += bl * vec3( 0.03, 0.34, 0.5 ) * 0.09 * blGain;
	vAlpha = min( 1.0, max( vAlpha * ( 1.0 + 2.0 * glint * dist0 ), bl * fade * bp.w ) );
	// a flashing krill is a point light: at least ~2 px
	if ( bl > 0.05 ) { vHalf = max( vHalf, vec2( 1.4 ) ); vSize = max( vSize, 5.0 ); gl_PointSize = vSize; }
	vColor = kwWater( col, cameraPosition, p );
}
`;
const speckFrag = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying vec2 vAxis;
varying vec2 vHalf;
varying float vSize;
void main() {
	vec2 q = ( gl_PointCoord - 0.5 ) * vSize;
	q.y = - q.y;
	float a = dot( q, vAxis ) / vHalf.x;
	float b = dot( q, vec2( - vAxis.y, vAxis.x ) ) / vHalf.y;
	float d = length( vec2( a, b ) );
	float m = 1.0 - smoothstep( 0.55, 1.0, d );
	float alpha = m * vAlpha;
	if ( alpha < 0.004 ) discard;
	gl_FragColor = vec4( vColor, alpha );
}
`;

// ---- impostors (near krill / fish) -------------------------------------------------
// A 2-triangle quad per animal, spanned by the body axis projected on the
// screen plane and the perpendicular; the silhouette is drawn procedurally.
const IMPOSTOR_VERT = /* glsl */ `
attribute vec2 corner;
attribute float aBoid;
attribute vec3 aOff;
attribute float aSeed;
uniform float uSpread;
uniform float uLen;      // body length (m)
uniform float uWidth;    // body width / length
uniform float uFadeNear;
uniform float uFadeFar;
varying vec2 vUv;
varying vec2 vCorner;
varying float vAlpha;
varying float vBlur;
varying float vSeed;
varying vec3 vAxisW;
varying vec3 vSideW;
varying float vDist;
#include <fog_pars_vertex>
${BOID_GLSL}
void main() {
	vec4 bp = boidPos( aBoid );
	vec4 bv = boidVel( aBoid );
	float s1 = swHash( aSeed * 91.7 );
	vec3 wob = vec3( sin( uTime * ( 0.4 + s1 * 0.5 ) + aSeed * 30.0 ), sin( uTime * ( 0.3 + s1 * 0.4 ) + aSeed * 17.0 ), cos( uTime * ( 0.35 + s1 * 0.5 ) + aSeed * 23.0 ) ) * 0.25;
	vec3 p = bp.xyz + aOff * uSpread + wob;
	float dist0 = swDisturb( p );
	p = swPart( p );
	vec3 vel = bv.xyz + vec3( sin( aSeed * 13.0 ), sin( aSeed * 7.0 ) * 0.3, cos( aSeed * 11.0 ) ) * ( SW_HEADING_JITTER + 1.5 * dist0 );
	vec3 a = normalize( vel + vec3( 1e-4 ) );
	vec3 e = normalize( cameraPosition - p );
	float dist = length( cameraPosition - p );
	vec3 side = cross( a, e );
	float sl = length( side );
	side = sl > 1e-3 ? side / sl : normalize( cross( vec3( 0.0, 1.0, 0.0 ), e ) + vec3( 1e-4, 0.0, 0.0 ) );
	vec3 ap = a - e * dot( a, e );
	float apl = length( ap );
	ap = apl > 1e-3 ? ap / apl : cross( e, side );
	float halfLen = uLen * 0.5;
	float halfWid = uLen * uWidth * 0.5;
	// never thinner than ~1 px: sub-pixel animals widen and fade (coverage)
	float px = halfWid * uPixelScale / max( dist, 0.1 );
	float grow = max( 1.0, 0.6 / max( px, 1e-4 ) );
	float gx = max( 1.0, grow * 0.5 );
	float along = max( halfLen * apl, halfWid ) * gx;
	vec3 wp = p + ap * corner.x * along * 1.05 + side * corner.y * halfWid * grow * 1.6;
	// u: -1 tail .. +1 head ; v: across, in body half-widths
	vUv = vec2( corner.x * 1.05 * gx, corner.y * 1.6 * grow );
	vCorner = corner;
	vBlur = grow;
	vAlpha = bp.w / ( grow * gx ) * smoothstep( uFadeNear * 0.6, uFadeNear, dist ) * ( 1.0 - smoothstep( uFadeFar * 0.7, uFadeFar, dist ) );
	vSeed = aSeed;
	vAxisW = a;
	vSideW = side;
	vDist = dist0;
	vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	if ( bp.w < 0.5 || vAlpha < 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
	#include <fog_vertex>
}
`;

const KRILL_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec2 vCorner;
varying float vAlpha;
varying float vBlur;
varying float vSeed;
varying vec3 vAxisW;
varying vec3 vSideW;
varying float vDist;
#include <fog_pars_fragment>
${LIGHT_GLSL}
void main() {
	float u = vUv.x;            // -1 tail .. +1 head
	float v = vUv.y;            // across, in half widths
	// body: carapace (front) + abdomen tapering to the tail fan
	float w = u > 0.1 ? mix( 1.0, 0.55, smoothstep( 0.55, 1.0, u ) ) : mix( 0.3, 1.0, smoothstep( - 0.95, 0.1, u ) );
	w = mix( w, 0.75, smoothstep( - 0.8, - 1.0, u ) ); // tail fan flare
	float edge = abs( v ) - w;
	float cov = 1.0 - smoothstep( - 0.15, 0.1 * vBlur, edge );
	cov *= 1.0 - smoothstep( 0.95, 1.05, abs( u ) );
	// blurred (sub-pixel) krill: plain soft ellipse
	float soft = exp( - 3.5 * dot( vCorner, vCorner ) );
	cov = mix( cov, soft, clamp( ( vBlur - 1.0 ) * 0.5, 0.0, 1.0 ) );
	float alpha = cov * vAlpha;
	if ( alpha < 0.01 ) discard;
	float vn = clamp( v / max( w, 0.2 ), - 1.0, 1.0 );
	vec3 e = normalize( cameraPosition - vKwWorld );
	vec3 n = normalize( vSideW * vn + e * sqrt( 1.0 - vn * vn ) );
	// colour: translucent shell, chromatophore spots, dark gut, black eye
	float chroma = step( 0.55, fract( sin( floor( u * 7.0 ) * 12.9 + floor( vn * 2.0 + 2.0 ) * 78.2 + vSeed * 3.1 ) * 43758.5 ) );
	vec3 shell = vec3( 0.85, 0.5, 0.34 );
	vec3 c = mix( shell, vec3( 0.7, 0.12, 0.05 ), 0.35 + 0.5 * chroma );
	float gut = ( 1.0 - smoothstep( 0.0, 0.35, abs( u - 0.2 ) ) ) * ( 1.0 - smoothstep( 0.2, 0.6, abs( vn ) ) );
	c = mix( c, vec3( 0.2, 0.18, 0.07 ), 0.55 * gut );
	float eye = ( 1.0 - smoothstep( 0.06, 0.1, length( vec2( ( u - 0.83 ) * 2.4, abs( vn ) - 0.45 ) ) ) );
	c = mix( c, vec3( 0.01 ), eye );
	vec3 sunT = swSunAt( vKwWorld );
	float ndl = max( dot( n, KW_SUNW ), 0.0 );
	float back = pow( max( dot( - e, KW_SUNW ), 0.0 ), 3.0 );
	vec3 lit = c * ( sunT * KW_SUNCOL * ( ndl * 0.25 + back * 0.35 + 0.05 ) + swAmbAt( vKwWorld ) * ( KW_W0 * 2.0 + vec3( 0.02 ) ) );
	// wet carapace specular
	vec3 h = normalize( KW_SUNW + e );
	lit += sunT * KW_SUNCOL * pow( max( dot( n, h ), 0.0 ), 60.0 ) * 1.5 * ( 1.0 - eye );
	// see-through body: water radiance behind, tinted by the shell
	vec3 bg = kwWaterRadiance( - e ) * kwLightAt( vKwWorld.y - KW_LEVEL ) * 1.1;
	lit = mix( lit, bg * mix( vec3( 1.0 ), c * 1.3, 0.6 ), 0.45 * ( 1.0 - eye ) * ( 1.0 - 0.6 * gut ) );
	// photophores (disturbed)
	float bl = pow( max( sin( uTime * 7.0 + vSeed * 31.0 ), 0.0 ), 16.0 ) * vDist;
	lit += bl * vec3( 0.03, 0.34, 0.5 ) * ( 1.0 - smoothstep( 0.0, 0.12, length( vec2( u + 0.1, vn * 0.3 ) ) ) ) * 0.3 * ( 1.0 + 3.0 * ( 1.0 - clamp( KW_LIGHT, 0.0, 1.0 ) ) );
	gl_FragColor = vec4( lit, alpha );
	#include <fog_fragment>
}
`;

const FISH_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec2 vCorner;
varying float vAlpha;
varying float vBlur;
varying float vSeed;
varying vec3 vAxisW;
varying vec3 vSideW;
varying float vDist;
#include <fog_pars_fragment>
${LIGHT_GLSL}
void main() {
	float u = vUv.x;            // -1 tail .. +1 head
	float v = vUv.y;
	// tail beat: the rear body sways across the silhouette
	float beat = sin( uTime * 14.0 + vSeed * 40.0 ) * 0.25 * smoothstep( 0.2, - 1.0, u );
	float vv = v - beat;
	// spindle body, narrow peduncle, forked caudal fin
	float w = u > - 0.8 ? 0.95 * sqrt( max( 0.0, 1.0 - pow( ( u - 0.1 ) / 0.9, 2.0 ) ) ) : 0.0;
	float t = clamp( ( - 0.68 - u ) / 0.32, 0.0, 1.0 );
	float fin = u < - 0.66 ? mix( 0.14, 1.0, t ) : 0.0;
	float edge = abs( vv ) - max( w, fin );
	float cov = 1.0 - smoothstep( - 0.1, 0.1 * vBlur, edge );
	float notch = ( t * 0.85 - 0.3 ) - abs( vv );
	cov *= 1.0 - smoothstep( - 0.05, 0.08, notch );
	cov *= 1.0 - smoothstep( 0.97, 1.03, abs( u ) );
	float soft = exp( - 3.5 * dot( vCorner, vCorner ) );
	cov = mix( cov, soft, clamp( ( vBlur - 1.0 ) * 0.5, 0.0, 1.0 ) );
	float alpha = cov * vAlpha;
	if ( alpha < 0.01 ) discard;
	float vn = clamp( vv / max( w, 0.25 ), - 1.0, 1.0 );
	vec3 e = normalize( cameraPosition - vKwWorld );
	// body roll wobble: flanks flash as each fish rocks and turns
	float roll = sin( uTime * ( 2.0 + fract( sin( vSeed * 91.7 ) * 43758.5 ) * 3.0 ) + vSeed * 20.0 ) * 0.35;
	vec3 sideR = normalize( vSideW * cos( roll ) + cross( vAxisW, vSideW ) * sin( roll ) );
	vec3 n = normalize( sideR * vn + e * sqrt( 1.0 - vn * vn ) );
	vec3 upF = normalize( vec3( 0.0, 1.0, 0.0 ) - vAxisW * vAxisW.y + vec3( 0.0, 1e-3, 0.0 ) );
	float dorsal = smoothstep( 0.25, 0.7, dot( n, upF ) );
	float belly = smoothstep( - 0.2, - 0.7, dot( n, upF ) );
	vec3 sunT = swSunAt( vKwWorld );
	vec3 ambT = swAmbAt( vKwWorld );
	// mirror flank: reflect the underwater light field (bright above, dark below)
	vec3 r = reflect( - e, n );
	vec3 env = kwWaterRadiance( r ) * kwLightAt( vKwWorld.y - KW_LEVEL ) * 2.2;
	env += sunT * KW_SUNCOL * pow( max( dot( r, KW_SUNW ), 0.0 ), 180.0 ) * 12.0;
	vec3 silver = vec3( 0.86, 0.9, 0.93 );
	float fres = 0.75 + 0.25 * pow( 1.0 - max( dot( n, e ), 0.0 ), 3.0 );
	vec3 col = env * silver * fres;
	// dark blue-green back, matte
	vec3 backC = vec3( 0.05, 0.12, 0.15 ) * ( sunT * KW_SUNCOL * max( dot( n, KW_SUNW ), 0.0 ) * 0.3 + ambT * ( KW_W0 * 2.0 + vec3( 0.02 ) ) );
	col = mix( col, backC, dorsal );
	col = mix( col, col * 0.7 + ambT * KW_W0 * 0.9, belly * 0.5 );
	// eye
	float eye = 1.0 - smoothstep( 0.05, 0.09, length( vec2( ( u - 0.72 ) * 2.0, vn * 0.35 ) ) );
	col = mix( col, vec3( 0.01 ), eye * 0.9 );
	gl_FragColor = vec4( col, alpha );
	#include <fog_fragment>
}
`;

function makeQuadInstancedGeometry(maxInstances, offRadius, seed) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  geo.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const rand = rng(seed);
  const boid = new Float32Array(maxInstances);
  const off = new Float32Array(maxInstances * 3);
  const sd = new Float32Array(maxInstances);
  for (let i = 0; i < maxInstances; i++) { inBall(offRadius, rand, off, i * 3); sd[i] = rand() * 100; }
  const aBoid = new THREE.InstancedBufferAttribute(boid, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aBoid', aBoid);
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 3));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sd, 1));
  geo.instanceCount = 0;
  return geo;
}

function makeImpostorMaterial(boidTex, frag, uniforms, defines) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...swarmUniforms, uBoids: { value: boidTex }, ...uniforms },
    defines,
    vertexShader: IMPOSTOR_VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  return makeWaterAware(mat);
}

// ---- krill patch view ------------------------------------------------------------
const NEAR_PER_BOID = 8;
const NEAR_RADIUS = 7;
const NEAR_MAX_BOIDS = 320;

export class KrillSwarmView {
  constructor(scene, count, seed = 1) {
    this.scene = scene;
    this.count = count;
    this.boids = new BoidTexture(count);
    this.volume = new SwarmVolume(scene);

    // specks: static attributes, every boid × SPECKS_PER_BOID
    const n = count * SPECKS_PER_BOID;
    const rand = rng(seed * 7919);
    const aBoid = new Float32Array(n), aOff = new Float32Array(n * 3), aSeed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      aBoid[i] = i % count;
      inBall(1, rand, aOff, i * 3);
      aSeed[i] = rand() * 100;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    sg.setAttribute('aBoid', new THREE.BufferAttribute(aBoid, 1));
    sg.setAttribute('aOff', new THREE.BufferAttribute(aOff, 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
    this.speckMat = makeWaterAware(new THREE.ShaderMaterial({
      uniforms: { ...swarmUniforms, uBoids: { value: this.boids.texture }, uSpread: { value: 2.4 }, uLen: { value: 0.045 } },
      vertexShader: speckVert,
      fragmentShader: speckFrag,
      transparent: true,
      depthWrite: false,
    }));
    this.specks = new THREE.Points(sg, this.speckMat);
    this.specks.frustumCulled = false;
    this.specks.renderOrder = 6;
    this.specks.onBeforeRender = updateSwarmViewport;
    scene.add(this.specks);

    // near impostors: filled per frame with the boids around the camera
    this.nearGeo = makeQuadInstancedGeometry(NEAR_MAX_BOIDS * NEAR_PER_BOID, 1, seed * 104729);
    this.nearMat = makeImpostorMaterial(this.boids.texture, KRILL_FRAG, {
      uSpread: { value: 1.3 }, uLen: { value: 0.045 }, uWidth: { value: 0.2 },
      uFadeNear: { value: 0.35 }, uFadeFar: { value: NEAR_RADIUS },
    }, { SW_HEADING_JITTER: '0.3' });
    this.near = new THREE.Mesh(this.nearGeo, this.nearMat);
    this.near.frustumCulled = false;
    this.near.renderOrder = 7;
    this.near.onBeforeRender = updateSwarmViewport;
    scene.add(this.near);
  }

  // Per frame: upload the boids, rebuild the density field, pick LODs.
  update(sys, camera, lenScale = 1) {
    this.boids.write(sys);
    this.volume.build(sys);
    const cam = camera.position;
    const dc = cam.distanceTo(this.volume.center) - this.volume.radius;
    // underwater the surface's underside is opaque (Snell's window) and drawn
    // at renderOrder 10: swarms must come after it; from the air, before it
    const under = cam.y < 0;
    this.volume.mesh.renderOrder = under ? 12 : 5;
    this.specks.renderOrder = under ? 13 : 6;
    this.near.renderOrder = under ? 14 : 7;
    const len = 0.045 * lenScale;
    this.speckMat.uniforms.uLen.value = len;
    this.nearMat.uniforms.uLen.value = len;
    this.specks.visible = this.volume.mesh.visible && dc < 110;
    // distant patches are small on screen: half the slices
    this.volume.material.uniforms.uSlices.value = dc > this.volume.radius * 1.5 ? SLICES / 2 : SLICES;
    // near field
    let k = 0;
    if (this.volume.mesh.visible && dc < NEAR_RADIUS + 2) {
      const { pos, alive, count } = sys;
      const arr = this.nearGeo.attributes.aBoid.array;
      const r2 = (NEAR_RADIUS + 1.5) ** 2;
      for (let i = 0; i < count && k < NEAR_MAX_BOIDS; i++) {
        if (!alive[i]) continue;
        const dx = pos[i * 3] - cam.x, dy = pos[i * 3 + 1] - cam.y, dz = pos[i * 3 + 2] - cam.z;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        for (let s = 0; s < NEAR_PER_BOID; s++) arr[k * NEAR_PER_BOID + s] = i;
        k++;
      }
      this.nearGeo.attributes.aBoid.needsUpdate = true;
    }
    this.nearGeo.instanceCount = k * NEAR_PER_BOID;
    this.near.visible = k > 0;
  }

  dispose() {
    const s = this.scene;
    this.volume.dispose(s);
    s.remove(this.specks); this.specks.geometry.dispose(); this.speckMat.dispose();
    s.remove(this.near); this.nearGeo.dispose(); this.nearMat.dispose();
    this.boids.dispose();
  }
}

// ---- anchovy school view -----------------------------------------------------------
const FISH_PER_BOID = 24;
const FISH_COMPRESS = 0.6; // visual: pack the school into a tight bait ball

export class FishSchoolView {
  constructor(scene, count, seed = 1) {
    this.scene = scene;
    this.count = count;
    this.boids = new BoidTexture(count);
    const n = count * FISH_PER_BOID;
    this.geo = makeQuadInstancedGeometry(n, 1, seed * 15485863);
    const arr = this.geo.attributes.aBoid.array;
    for (let i = 0; i < n; i++) arr[i] = i % count;
    this.geo.attributes.aBoid.setUsage(THREE.StaticDrawUsage);
    this.geo.instanceCount = n;
    this.mat = makeImpostorMaterial(this.boids.texture, FISH_FRAG, {
      uSpread: { value: 1.1 }, uLen: { value: 0.15 }, uWidth: { value: 0.2 },
      uFadeNear: { value: 0.3 }, uFadeFar: { value: 110 },
    }, { SW_HEADING_JITTER: '0.12' });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    this.mesh.onBeforeRender = updateSwarmViewport;
    scene.add(this.mesh);
    this.center = new THREE.Vector3();
  }

  update(sys, camera) {
    const { pos, alive, count } = sys;
    let x = 0, y = 0, z = 0, n = 0;
    for (let i = 0; i < count; i++) {
      if (!alive[i]) continue;
      x += pos[i * 3]; y += pos[i * 3 + 1]; z += pos[i * 3 + 2]; n++;
    }
    if (n) this.center.set(x / n, y / n, z / n);
    this.boids.write(sys, this.center.x, this.center.y, this.center.z, FISH_COMPRESS);
    this.mesh.visible = n > 0 && camera.position.distanceTo(this.center) < 120;
    this.mesh.renderOrder = camera.position.y < 0 ? 14 : 7;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
    this.boids.dispose();
  }
}
