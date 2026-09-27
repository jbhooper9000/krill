import * as THREE from 'three';
import { Flora } from './Flora.js';

// Streamed, edgeless Monterey Bay seafloor.
//
// Data: assets/bathymetry/ (see tools/bathymetry/README.md). Three height
// levels are blended, finest first: 30 m tiles streamed around the camera,
// a 120 m whole-bay grid and a 500 m regional grid (both loaded up front).
// Outside the regional grid the edge values extend forever, so there is no
// edge to swim off.
//
// On top of the real macro shape, deterministic detail noise (sand waves on
// gentle ground, ridged rock on steep canyon walls) is added so the floor
// reads at whale scale; heightAt() includes that detail, so collision matches
// what is drawn.
//
// Coordinates
//   absolute ("bay") metres: x east, z south, origin at the bay centre
//     (manifest.projection); y is height, sea level 0.
//   scene metres: what every other system uses (controller.position etc).
//     scene = absolute - terrain.origin. The origin is rebased (floating
//     origin) whenever the camera drifts more than `rebaseDistance` from the
//     scene origin; listeners added with onRebase(fn) receive (dx, dz) and
//     must subtract it from any scene-space position they own.
//
// Rendering: a quadtree of square chunks (32x32 quads each, with skirts to
// hide LOD cracks) is chosen every frame around the camera: nodes closer
// than splitFactor * size split, down to minChunkSize. Chunks are built on the
// main thread under a per-frame time budget, and old chunks are kept until
// their replacements exist so no holes appear while streaming.

const N = 32; // quads per chunk side
const WRAP = 4096; // detail-texture coordinates are periodic with this (m)
const DATA_URL = new URL('../../assets/bathymetry/', import.meta.url);

// ---- small math helpers ------------------------------------------------------
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return h ^ (h >>> 16);
}

const GX = [1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071];
const GZ = [0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071];

// 2D gradient noise in ~[-1, 1]
function gnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const g = (a, b, dx, dz) => {
    const h = hash2(a, b, seed) & 7; // one of 8 gradient directions
    return GX[h] * dx + GZ[h] * dz;
  };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = g(ix, iz, fx, fz), b = g(ix + 1, iz, fx - 1, fz);
  const c = g(ix, iz + 1, fx, fz - 1), d = g(ix + 1, iz + 1, fx - 1, fz - 1);
  return 1.6 * ((a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v);
}

// Catmull-Rom weights and derivative weights
function crw(t, out, dout) {
  const t2 = t * t, t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
  dout[0] = 0.5 * (-3 * t2 + 4 * t - 1);
  dout[1] = 0.5 * (9 * t2 - 10 * t);
  dout[2] = 0.5 * (-9 * t2 + 8 * t + 1);
  dout[3] = 0.5 * (3 * t2 - 2 * t);
}
const _wx = new Float64Array(4), _dwx = new Float64Array(4), _wz = new Float64Array(4), _dwz = new Float64Array(4);

// A single regular grid of Int16 samples.
class Grid {
  constructor(data, n, res, xMin, zMin, scale) {
    this.data = data; this.n = n; this.res = res; this.xMin = xMin; this.zMin = zMin; this.scale = scale;
    this.size = (n - 1) * res;
  }
  at(i, j) {
    const n = this.n;
    i = i < 0 ? 0 : i >= n ? n - 1 : i;
    j = j < 0 ? 0 : j >= n ? n - 1 : j;
    return this.data[j * n + i] * this.scale;
  }
  // bicubic height + gradient (dh/dx, dh/dz) at absolute (x, z); clamps outside
  sample(x, z, out) {
    const u = (x - this.xMin) / this.res, v = (z - this.zMin) / this.res;
    const i = Math.floor(u), j = Math.floor(v);
    crw(u - i, _wx, _dwx); crw(v - j, _wz, _dwz);
    let h = 0, hx = 0, hz = 0;
    for (let b = 0; b < 4; b++) {
      let row = 0, drow = 0;
      for (let a = 0; a < 4; a++) {
        const s = this.at(i - 1 + a, j - 1 + b);
        row += _wx[a] * s; drow += _dwx[a] * s;
      }
      h += _wz[b] * row; hx += _wz[b] * drow; hz += _dwz[b] * row;
    }
    out.h = h; out.dx = hx / this.res; out.dz = hz / this.res;
    return out;
  }
  // 0 at/beyond the edge, 1 deeper than `band` metres inside
  inside(x, z, band) {
    const d = Math.min(x - this.xMin, this.xMin + this.size - x, z - this.zMin, this.zMin + this.size - z);
    return smoothstep(0, band, d);
  }
}

async function fetchInt16(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  let buf = await r.arrayBuffer();
  const b = new Uint8Array(buf);
  // gzip magic: decompress unless the server already did (Content-Encoding)
  if (b[0] === 0x1f && b[1] === 0x8b) {
    const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = await new Response(stream).arrayBuffer();
  }
  return new Int16Array(buf);
}

// ---- detail texture (tileable, generated once) ---------------------------------
function makeDetailTexture() {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  // tileable value-noise fbm: lattice wraps at `per`
  const vnoise = (x, y, per, seed) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const r = (a, b) => ((hash2(((a % per) + per) % per, ((b % per) + per) % per, seed) >>> 0) / 4294967296);
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    return (r(ix, iy) * (1 - u) + r(ix + 1, iy) * u) * (1 - v) + (r(ix, iy + 1) * (1 - u) + r(ix + 1, iy + 1) * u) * v;
  };
  const fbm = (x, y, base, seed, oct) => {
    let s = 0, a = 0.5, n = 0;
    for (let o = 0; o < oct; o++) {
      const per = base << o;
      s += a * vnoise((x / S) * per, (y / S) * per, per, seed + o);
      n += a; a *= 0.5;
    }
    return s / n;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = (y * S + x) * 4;
    data[o] = fbm(x, y, 4, 11, 5) * 255;
    data[o + 1] = fbm(x, y, 8, 23, 4) * 255;
    // cellular-ish pebbles: sharpened high-frequency noise
    const p = fbm(x, y, 16, 37, 3);
    data[o + 2] = Math.pow(p, 1.6) * 255 * 1.3;
    data[o + 3] = fbm(x, y, 2, 51, 6) * 255;
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ---- material --------------------------------------------------------------
// MeshStandardMaterial with an onBeforeCompile patch: sand / silt / mud / rock /
// land colouring by slope, depth and sediment patches, and a procedural bump.
// Underwater light is mostly diffuse, so the whale-scale cues are carried by
// *albedo* as much as by normals: megaripple and ripple banding (troughs
// collect darker shell hash and detritus), speckles, silt-vs-sand patches.
// Per-vertex aTerrain = (rockiness 0..1, depth m, wrapped x, wrapped z) and
// aSed = (silt 0..1, reef 0..1, rocky shore 0..1).
// Above the waterline: tan beaches with a wet band and a moving swash/foam
// line, dark wet granite headlands with algae and barnacle bands, grey cliff
// faces, and cypress / coastal-scrub green with dry-grass patches on the bluffs.
function makeTerrainMaterial() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0 });
  const uniforms = { uDetail: { value: makeDetailTexture() }, uTime: { value: 0 } };
  mat.userData.terrainUniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aTerrain;\nattribute vec3 aSed;\nvarying vec4 vTerrain;\nvarying vec3 vSed;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrain = aTerrain;\nvSed = aSed;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
varying vec4 vTerrain;
varying vec3 vSed;
uniform sampler2D uDetail;
uniform float uTime;
float tRockMask;
// Everything sampled from P is periodic in ${WRAP}.0 m, so the per-chunk wrap
// offsets are seamless: textures repeat at divisors of it and the wave
// vectors below are integer multiples of 1/${WRAP}.
// megaripples: ~6 m wavelength, asymmetric (steep lee face), 0..1 crest=1
float tMega(vec2 P) {
  float bend = texture2D(uDetail, P / 128.0).r * 5.0;
  float ph = 6.2831853 * (P.x * (620.0 / ${WRAP}.0) - P.y * (260.0 / ${WRAP}.0)) + bend;
  float f = fract(ph / 6.2831853);
  return smoothstep(0.0, 0.75, f) * (1.0 - smoothstep(0.75, 1.0, f));
}
// current ripples: ~1.5 m wavelength
float tRipple(vec2 P) {
  float bend = texture2D(uDetail, P / 64.0).r * 6.0;
  float ph = 6.2831853 * (P.x * (2600.0 / ${WRAP}.0) + P.y * (900.0 / ${WRAP}.0)) + bend;
  return 0.5 + 0.5 * sin(ph + 1.3 * sin(ph * 0.5));
}
// sandy-bedform weight: less on silt, rock and deep mud
float tBedform(float rock, float silt, float depth) {
  return (1.0 - rock) * (1.0 - 0.75 * silt) * (1.0 - 0.8 * smoothstep(50.0, 250.0, depth));
}
float tBump(vec2 P, float rock, float depth, float fw) {
  vec4 a = texture2D(uDetail, P / 16.0);
  vec4 b = texture2D(uDetail, P / 4.0);
  vec4 c = texture2D(uDetail, P / 1.0);
  float bed = tBedform(rock, vSed.x, depth);
  float patchy = smoothstep(0.35, 0.6, texture2D(uDetail, P / 128.0).a);
  float ripple = tRipple(P) * 0.035 * patchy * (1.0 - smoothstep(0.05, 0.25, fw));
  float mega = tMega(P) * 0.28 * (1.0 - smoothstep(0.5, 2.5, fw));
  float grain = (a.g * 0.6 + b.b * 0.35) * (1.0 - smoothstep(1.0, 4.0, fw))
              + c.b * 0.08 * (1.0 - smoothstep(0.1, 0.4, fw));
  float rockH = a.r * 0.9 + b.g * 0.45 * (1.0 - smoothstep(0.6, 2.0, fw));
  // bump only where it can be resolved; far away the geometry carries the shape
  return mix((ripple + mega) * bed + grain * 0.05, rockH, rock) * (1.0 - smoothstep(1.5, 6.0, fw));
}
vec3 tPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = dFdx(surf_pos);
  vec3 vSigmaY = dFdy(surf_pos);
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}`)
      .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
#ifdef USE_FOG
  // From the air the water surface mesh only covers ~300 m around the camera;
  // past it the sky/horizon shader draws the sea. Don't let the seafloor show
  // through as a dark band there (the land above the waterline stays).
  if (cameraPosition.y > 0.2 && vKwWorld.y < -0.4 && length(vKwWorld.xz - cameraPosition.xz) > 285.0) discard;
#endif
{
  vec2 P = vTerrain.zw;
  float depth = vTerrain.y;
  float silt = vSed.x, reef = vSed.y;
  // texture variation fades out with pixel footprint so its tiling never shows
  // from afar (large-scale variation is per-vertex: rockiness, silt, reef)
  float fwc = length(fwidth(P));
  float near = 1.0 - smoothstep(1.0, 6.0, fwc);
  float big = mix(0.5, texture2D(uDetail, P / 256.0).a, near);
  float mid = mix(0.5, texture2D(uDetail, P / 32.0).r, near);
  float fine = mix(0.5, texture2D(uDetail, P / 6.0).g, near);
  tRockMask = smoothstep(0.35, 0.7, vTerrain.x + (big - 0.5) * 0.4 + (mid - 0.5) * 0.25);
  // sediments: pale shelf sand, olive-grey silt patches, grey-green canyon mud
  vec3 sandShallow = vec3(0.64, 0.57, 0.44);
  vec3 siltCol = vec3(0.43, 0.42, 0.34);
  vec3 mud = vec3(0.40, 0.40, 0.34);
  vec3 sand = mix(sandShallow, siltCol, smoothstep(0.2, 0.8, silt + (mid - 0.5) * 0.3));
  sand = mix(sand, mud, smoothstep(80.0, 600.0, depth));
  sand *= 0.85 + 0.25 * mid + 0.12 * (fine - 0.5);
  // bedform banding: troughs collect darker shell hash / detritus
  float bed = tBedform(0.0, silt, depth);
  float nearM = 1.0 - smoothstep(0.4, 2.5, fwc);
  float nearR = 1.0 - smoothstep(0.06, 0.3, fwc);
  float patchy = smoothstep(0.35, 0.6, texture2D(uDetail, P / 128.0).a);
  sand *= 1.0 + ((tMega(P) - 0.5) * 0.30 * nearM + (tRipple(P) - 0.5) * 0.16 * nearR * patchy) * bed;
  // speckles: shell fragments, pebbles, burrow mouths
  float spk = texture2D(uDetail, P / 3.0).b;
  sand *= 1.0 - smoothstep(0.72, 0.95, spk) * 0.35 * (1.0 - smoothstep(0.08, 0.5, fwc));
  vec3 rock = mix(vec3(0.24, 0.22, 0.20), vec3(0.14, 0.15, 0.15), big);
  rock *= 0.55 + 0.8 * fine;
  // encrusting life on shallow rock (coralline pinks, sponges), strongest on reefs
  float crust = smoothstep(0.5, 0.9, mid) * (1.0 - smoothstep(30.0, 200.0, depth)) * (0.5 + 0.5 * reef);
  rock = mix(rock, rock * vec3(1.45, 0.9, 0.95), crust);
  vec3 col = mix(sand, rock, tRockMask);
  // ---- the coast: height above sea level h ----
  float h = -depth;
  if (h > -3.0) {
    float shore = vSed.z;
    float spk2 = texture2D(uDetail, P / 1.5).b;
    // beach: tan quartz/feldspar sand, darker where wet, fine grain speckle
    vec3 beach = mix(vec3(0.30, 0.26, 0.19), vec3(0.50, 0.43, 0.31), smoothstep(0.2, 1.6, h));
    beach *= 0.9 + 0.2 * mid - 0.12 * smoothstep(0.7, 0.95, spk2) * (1.0 - smoothstep(0.1, 0.5, fwc));
    // granite / sandstone headland: dark when wet, bands at the waterline
    vec3 granite = mix(vec3(0.20, 0.19, 0.18), vec3(0.34, 0.31, 0.28), fine) * (0.8 + 0.3 * big);
    granite = mix(granite * 0.45, granite, smoothstep(1.0, 3.5, h)); // wet from spray up to ~2 m
    float algae = smoothstep(-1.6, -0.9, h) * (1.0 - smoothstep(0.1, 0.5, h));
    granite = mix(granite, vec3(0.16, 0.17, 0.09) * (0.8 + 0.4 * mid), algae * 0.85);
    float barn = smoothstep(0.2, 0.45, h) * (1.0 - smoothstep(0.7, 1.0, h));
    granite = mix(granite, vec3(0.40, 0.38, 0.34) * (0.5 + 0.8 * spk2), barn * 0.45);
    // orange lichen on dry rock
    granite = mix(granite, vec3(0.62, 0.42, 0.20), smoothstep(0.72, 0.9, mid) * smoothstep(3.0, 6.0, h) * 0.6);
    // bluffs: Monterey cypress / coastal scrub greens with dry-grass patches
    float grass = smoothstep(0.4, 0.62, big + (mid - 0.5) * 0.6);
    vec3 scrub = mix(vec3(0.13, 0.19, 0.10), vec3(0.50, 0.44, 0.27), grass) * (0.85 + 0.3 * fine);
    float cliff = smoothstep(0.45, 0.8, vTerrain.x);
    vec3 land = mix(beach, scrub, smoothstep(2.0, 5.0, h + (mid - 0.5) * 2.5));
    land = mix(land, mix(granite, granite * 0.8 + 0.06, smoothstep(6.0, 14.0, h)), max(shore, cliff * smoothstep(2.0, 6.0, h)));
    // swash / foam line on the beach (weaker against rock): moves with the surge
    float swash = 0.35 * sin(uTime * 0.7 + P.x * 0.021 + P.y * 0.017) + 0.15 * sin(uTime * 1.9 + P.y * 0.05);
    // (only on a sloping shore: on dead-flat tidal ground the band would smear
    // into big white sheets)
    float shoreSlope = smoothstep(0.02, 0.08, length(vec2(dFdx(h), dFdy(h))) / max(1e-3, fwc));
    float band = 1.0 - smoothstep(0.0, 0.25, abs(h - 0.1 - swash));
    float lace = smoothstep(0.45, 0.8, texture2D(uDetail, P / 6.0 + vec2(uTime * 0.02, 0.0)).g + band * 0.3);
    land = mix(land, vec3(0.85, 0.87, 0.84), band * lace * mix(0.7, 0.35, shore) * shoreSlope);
    col = mix(col, land, smoothstep(-2.0, 0.3, h));
  }
  diffuseColor.rgb *= col;
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.96, 0.82, tRockMask);')
      .replace('#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
{
  vec2 P = vTerrain.zw;
  float fw = length(fwidth(P));
  float B = tBump(P, tRockMask, vTerrain.y, fw);
  vec2 dB = vec2(dFdx(B), dFdy(B));
  normal = tPerturb(-vViewPosition, normal, dB, faceDirection);
}`);
  };
  mat.customProgramCacheKey = () => 'krill-terrain-v3';
  return mat;
}

// ---- index buffer shared by all chunks: grid + skirt ---------------------------
function makeChunkIndex() {
  const idx = [];
  const V = (i, j) => j * (N + 1) + i;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = V(i, j), b = V(i + 1, j), c = V(i, j + 1), d = V(i + 1, j + 1);
    idx.push(a, c, b, b, c, d);
  }
  // skirt: ring of edge vertices (clockwise when viewed from above), each
  // duplicated below at base + k
  const ring = [];
  for (let i = 0; i < N; i++) ring.push(V(i, 0));
  for (let j = 0; j < N; j++) ring.push(V(N, j));
  for (let i = N; i > 0; i--) ring.push(V(i, N));
  for (let j = N; j > 0; j--) ring.push(V(0, j));
  const base = (N + 1) * (N + 1);
  for (let k = 0; k < ring.length; k++) {
    const k2 = (k + 1) % ring.length;
    const a = ring[k], b = ring[k2], a2 = base + k, b2 = base + k2;
    // outward-facing quad
    idx.push(a, b, a2, b, b2, a2);
  }
  return { index: new THREE.BufferAttribute(new Uint32Array(idx), 1), ring };
}

export class Terrain {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.options = Object.assign({
      minChunkSize: 128, // m, finest chunk (4 m vertex spacing at N=32)
      rootSize: 16384, // m
      splitFactor: 1.6,
      maxViewDistance: 60000, // m; the camera far plane usually limits it first
      rebaseDistance: 2000, // m, floating origin
      tileRadius: 4500, // m, stream 30 m tiles within this of the camera
      buildBudgetMs: 5,
      patchMaterial: null, // (material) => void, e.g. world.patchMaterial
      lightLevel: null, // () => 0..1 daylight, drives light transmitted through kelp
    }, options);

    this.origin = new THREE.Vector2(0, 0); // absolute bay metres of scene (0, 0)
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);

    this.material = makeTerrainMaterial();
    // ---- underwater light model hook -------------------------------------------
    // The lighting engineer's world.patchMaterial(material) patches standard
    // materials for the underwater light model; Game passes it in here.
    if (this.options.patchMaterial) this.options.patchMaterial(this.material);
    // -------------------------------------------------------------------------------

    // boulders / reef rock and kelp forests, streamed with the terrain
    this.flora = new Flora(this, { patchMaterial: this.options.patchMaterial, lightLevel: this.options.lightLevel });

    const { index, ring } = makeChunkIndex();
    this._index = index;
    this._ring = ring;

    this._chunks = new Map(); // key -> chunk
    this._tiles = new Map(); // "ix_iz" -> Grid | 'loading' | 'failed'
    this._tileLoads = 0;
    this._rebaseListeners = [];
    this._frame = 0;
    this._s = { h: 0, dx: 0, dz: 0 };
    this._s2 = { h: 0, dx: 0, dz: 0 };
    this.stats = { chunks: 0, triangles: 0, pending: 0, tiles: 0, builtThisFrame: 0, buildMs: 0, rebases: 0 };

    this.loaded = false;
    this.ready = this._load().catch((e) => {
      console.error('[Terrain] failed to load bathymetry', e);
      this.loadError = e;
    });
  }

  // ---- loading -----------------------------------------------------------------
  async _load() {
    const man = await (await fetch(new URL('manifest.json', DATA_URL))).json();
    this.manifest = man;
    const sc = man.sample.heightScale;
    const [bay, region, regions] = await Promise.all([
      fetchInt16(new URL(man.levels.bay.path, DATA_URL)),
      fetchInt16(new URL(man.levels.region.path, DATA_URL)),
      fetch(new URL(man.regions, DATA_URL)).then((r) => r.json()),
    ]);
    const B = man.levels.bay, Rg = man.levels.region;
    this.bay = new Grid(bay, B.samples, B.res, B.xMin, B.zMin, sc);
    this.region = new Grid(region, Rg.samples, Rg.res, Rg.xMin, Rg.zMin, sc);
    this.L0 = man.levels.L0;
    this._scale = sc;
    this._prepareRegions(regions);

    // default start: rebase so the start point is the scene origin
    const st = regions.start && regions.start.default;
    if (st) {
      const [x, z] = this.project(st.lat, st.lon);
      this.start = { name: st.name, x, z };
      this._setOrigin(Math.round(x), Math.round(z), false);
    } else {
      this.start = { name: 'Bay centre', x: 0, z: 0 };
    }
    // pull in the start tiles before declaring ready
    const cx = this.origin.x, cz = this.origin.y;
    await Promise.all(this._tilesNear(cx, cz, 2500).map((k) => this._loadTile(k)));
    this.loaded = true;
    // anything built from the fallback grids must be rebuilt now
    for (const c of this._chunks.values()) c.dirty = true;
  }

  _tilesNear(x, z, r) {
    const L = this.L0;
    if (!L) return [];
    const ts = L.tileCells * L.res;
    const out = [];
    const i0 = Math.max(0, Math.floor((x - r - L.xMin) / ts)), i1 = Math.min(L.tilesX - 1, Math.floor((x + r - L.xMin) / ts));
    const j0 = Math.max(0, Math.floor((z - r - L.zMin) / ts)), j1 = Math.min(L.tilesZ - 1, Math.floor((z + r - L.zMin) / ts));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push(`${i}_${j}`);
    return out;
  }

  async _loadTile(key) {
    if (this._tiles.has(key)) return;
    this._tiles.set(key, 'loading');
    this._tileLoads++;
    const [ix, iz] = key.split('_').map(Number);
    const L = this.L0;
    try {
      const data = await fetchInt16(new URL(L.path.replace('{ix}', ix).replace('{iz}', iz), DATA_URL));
      const ts = L.tileCells * L.res;
      this._tiles.set(key, new Grid(data, L.tileSamples, L.res, L.xMin + ix * ts, L.zMin + iz * ts, this._scale));
      // chunks overlapping this tile that were built without it get rebuilt
      const x0 = L.xMin + ix * ts, z0 = L.zMin + iz * ts;
      for (const c of this._chunks.values()) {
        if (c.usesL0 && !c.complete && c.x < x0 + ts && c.x + c.size > x0 && c.z < z0 + ts && c.z + c.size > z0) c.dirty = true;
      }
    } catch (e) {
      console.warn('[Terrain] tile failed', key, e);
      this._tiles.set(key, 'failed');
    } finally {
      this._tileLoads--;
    }
  }

  // ---- projection / regions ------------------------------------------------------
  project(lat, lon) {
    const p = this.manifest.projection;
    return [(lon - p.lon0) * p.metresPerDegLon, -(lat - p.lat0) * p.metresPerDegLat];
  }

  unproject(x, z) {
    const p = this.manifest.projection;
    return { lat: p.lat0 - z / p.metresPerDegLat, lon: p.lon0 + x / p.metresPerDegLon };
  }

  _prepareRegions(json) {
    this._reefZones = (json.reefs || []).map((r) => {
      const [x, z] = this.project(r.center[0], r.center[1]);
      return { name: r.name, x, z, r: r.radius, kelp: !!r.kelp };
    });
    this.regions = json.regions.map((r) => {
      const o = { id: r.id, name: r.name, kind: r.kind, type: r.type, minDepth: r.minDepth, maxDepth: r.maxDepth };
      if (r.type === 'circle') { [o.cx, o.cz] = this.project(r.center[0], r.center[1]); o.r = r.radius; }
      else if (r.type === 'corridor') { o.pts = r.path.map((p) => this.project(p[0], p[1])); o.hw = r.halfWidth; }
      else if (r.type === 'polygon') o.pts = r.ring.map((p) => this.project(p[0], p[1]));
      return o;
    });
  }

  // Region / POI at scene (x, z): { id, name, kind } (null before data loads).
  regionAt(x, z) {
    if (!this.regions) return null;
    const X = x + this.origin.x, Z = z + this.origin.y;
    let depth = null;
    for (const r of this.regions) {
      let hit = false;
      if (r.type === 'all') hit = true;
      else if (r.type === 'circle') hit = (X - r.cx) ** 2 + (Z - r.cz) ** 2 < r.r * r.r;
      else if (r.type === 'corridor') hit = distToPolyline(X, Z, r.pts) < r.hw;
      else if (r.type === 'polygon') hit = pointInPolygon(X, Z, r.pts);
      if (!hit) continue;
      if (r.minDepth !== undefined || r.maxDepth !== undefined) {
        if (depth === null) depth = -this.heightAtAbs(X, Z);
        if (r.minDepth !== undefined && depth < r.minDepth) continue;
        if (r.maxDepth !== undefined && depth > r.maxDepth) continue;
      }
      return { id: r.id, name: r.name, kind: r.kind };
    }
    return null;
  }

  // ---- heights -------------------------------------------------------------------
  // Real macro height + gradient at absolute (X, Z), from the finest data
  // allowed by `spacing` (vertex spacing of the caller; 0 = finest available).
  // Sets this._l0Missing when L0 data would have been used but isn't loaded.
  _macro(X, Z, spacing, out) {
    if (!this.region) { out.h = -200; out.dx = out.dz = 0; return out; }
    const s = this._s2;
    this.region.sample(X, Z, out);
    const wb = spacing < 400 ? this.bay.inside(X, Z, 2000) : 0;
    if (wb > 0) {
      this.bay.sample(X, Z, s);
      out.h += (s.h - out.h) * wb; out.dx += (s.dx - out.dx) * wb; out.dz += (s.dz - out.dz) * wb;
    }
    if (spacing < 100 && wb > 0) {
      const L = this.L0;
      const u = (X - L.xMin) / L.res, v = (Z - L.zMin) / L.res;
      const nAll = L.tilesX * L.tileCells;
      if (u >= 1 && v >= 1 && u < nAll - 2 && v < L.tilesZ * L.tileCells - 2) {
        if (this._l0Sample(u, v, s)) {
          const w = smoothstep(1, 40, Math.min(u, v, nAll - 2 - u, L.tilesZ * L.tileCells - 2 - v));
          out.h += (s.h - out.h) * w; out.dx += (s.dx - out.dx) * w; out.dz += (s.dz - out.dz) * w;
        } else this._l0Missing = true;
      }
    }
    return out;
  }

  // bicubic over the tiled 30 m level; false if a needed tile isn't loaded
  _l0Sample(u, v, out) {
    const L = this.L0, T = L.tileCells, n = T + 1;
    const i = Math.floor(u), j = Math.floor(v);
    crw(u - i, _wx, _dwx); crw(v - j, _wz, _dwz);
    let h = 0, hx = 0, hz = 0;
    let lastKey = '', grid = null;
    for (let b = 0; b < 4; b++) {
      const gj = j - 1 + b;
      let row = 0, drow = 0;
      for (let a = 0; a < 4; a++) {
        const gi = i - 1 + a;
        const ti = Math.min(L.tilesX - 1, Math.floor(gi / T)), tj = Math.min(L.tilesZ - 1, Math.floor(gj / T));
        const key = ti + '_' + tj;
        if (key !== lastKey) {
          grid = this._tiles.get(key);
          lastKey = key;
          if (!(grid instanceof Grid)) return false;
        }
        const s = grid.data[(gj - tj * T) * n + (gi - ti * T)] * grid.scale;
        row += _wx[a] * s; drow += _dwx[a] * s;
      }
      h += _wz[b] * row; hx += _wz[b] * drow; hz += _dwz[b] * row;
    }
    out.h = h; out.dx = hx / L.res; out.dz = hz / L.res;
    return true;
  }

  // Procedural detail at absolute (X, Z) given the macro sample. Octaves with
  // wavelength below ~2 vertex spacings are faded out for coarse chunks.
  _detail(X, Z, m, spacing) {
    const slope = Math.hypot(m.dx, m.dz);
    // rock on steep walls, and on reef patches (known rocky coasts + rare shelf outcrops)
    const rock = Math.max(smoothstep(0.2, 0.55, slope), 0.85 * this.reefAt(X, Z, -m.h, spacing), 0.9 * this.shoreRockAt(X, Z, m.h));
    const lim = spacing * 2;
    const oct = (lambda) => (spacing <= 0 ? 1 : smoothstep(lim, lim * 2, lambda));
    let d = 0;
    // sand: long low sand waves + hummocks
    const sandW = 1 - rock;
    if (sandW > 0) {
      let s = 0;
      let w = oct(90); if (w > 0) s += 0.9 * w * gnoise(X / 90, Z / 90, 3);
      w = oct(24); if (w > 0) s += 0.35 * w * gnoise(X / 24, Z / 24, 5);
      d += s * sandW * (m.h < 0 ? 1 : 3);
    }
    if (rock > 0) {
      const amp = 0.5 + Math.min(slope, 1.2);
      let r = 0;
      let w = oct(46); if (w > 0) r += 5.0 * w * (1 - Math.abs(gnoise(X / 46, Z / 46, 7)));
      w = oct(17); if (w > 0) r += 2.2 * w * (1 - Math.abs(gnoise(X / 17, Z / 17, 9)));
      w = oct(9); if (w > 0) r += 0.9 * w * gnoise(X / 9, Z / 9, 13);
      d += (r - 3.0) * amp * rock;
      // ledges: soft terraces in the wall (mudstone beds), jittered so they wander
      w = oct(24);
      if (w > 0) {
        const step = 10;
        const hh = m.h + 3 * gnoise(X / 70, Z / 70, 17);
        const t = hh / step, i = Math.floor(t);
        d += ((i + smoothstep(0.3, 0.7, t - i)) * step - hh) * 0.9 * rock * w;
      }
    }
    return d;
  }

  // Rocky reef weight 0..1 at absolute (X, Z) for water depth `depth`: patchy
  // reef inside the hand-authored reef zones (Point Pinos, Point Lobos, Santa
  // Cruz points ... in regions.json) shallower than ~60 m, plus rare low
  // outcrops scattered on the open shelf.
  reefAt(X, Z, depth, spacing = 0) {
    if (depth < -1) return 0;
    let r = 0;
    const zw = this._zoneWeight(X, Z, false);
    if (zw > 0) r = zw * smoothstep(-0.5, 0.05, gnoise(X / 90, Z / 90, 41)) * (1 - smoothstep(35, 65, depth));
    if (depth > 12 && depth < 160 && spacing < 64) {
      // two rotated octaves so the outcrops don't line up on the noise lattice
      const n = gnoise(X / 230, Z / 230, 43) + 0.6 * gnoise((X * 0.8 + Z * 0.6) / 97, (Z * 0.8 - X * 0.6) / 97, 47);
      r = Math.max(r, 0.8 * smoothstep(0.75, 0.95, n) * (1 - smoothstep(110, 160, depth)));
    }
    return r;
  }

  // Rocky-shore weight 0..1 near and above the waterline (headlands inside
  // the reef zones, broken up into outcrops with sandy pocket coves).
  shoreRockAt(X, Z, h) {
    if (h < -4 || h > 40) return 0;
    const zw = this._zoneWeight(X, Z, false);
    if (zw <= 0) return 0;
    return zw * smoothstep(-0.45, 0.1, gnoise(X / 70, Z / 70, 53)) * (1 - smoothstep(25, 40, h));
  }

  // Silt (vs clean sand) 0..1: large patches, more of it in deeper, quieter water.
  siltAt(X, Z, depth, spacing = 0) {
    // patches fade to their mean on coarse chunks (they'd alias into blocks)
    const k = 1 - smoothstep(60, 130, spacing);
    const p = 0.4 + (smoothstep(-0.35, 0.45, gnoise(X / 260, Z / 260, 45)) - 0.4) * k;
    return Math.min(1, p * 0.8 + smoothstep(50, 140, depth) * 0.45);
  }

  // 0..1 inside the reef / kelp zones (soft edge over the outer half radius)
  _zoneWeight(X, Z, kelpOnly) {
    let w = 0;
    for (const z of this._reefZones || []) {
      if (kelpOnly && !z.kelp) continue;
      const d = Math.hypot(X - z.x, Z - z.z);
      if (d < z.r) w = Math.max(w, smoothstep(z.r, z.r * 0.5, d));
    }
    return w;
  }

  _heightAbs(X, Z, spacing) {
    const m = this._macro(X, Z, spacing, this._s);
    return m.h + this._detail(X, Z, m, spacing);
  }

  // Seafloor height (world y, negative underwater) at scene (x, z).
  heightAt(x, z) {
    return this._heightAbs(x + this.origin.x, z + this.origin.y, 0);
  }

  heightAtAbs(X, Z) {
    return this._heightAbs(X, Z, 0);
  }

  // Water depth (m, >= 0) at scene (x, z).
  depthAt(x, z) {
    return Math.max(0, -this.heightAt(x, z));
  }

  // Macro slope (rise over run) at scene (x, z) — canyon walls are ~0.3-1.
  slopeAt(x, z) {
    const m = this._macro(x + this.origin.x, z + this.origin.y, 0, this._s);
    return Math.hypot(m.dx, m.dz);
  }

  // ---- floating origin -----------------------------------------------------------
  // fn(dx, dz): the scene has shifted by -(dx, dz); subtract it from positions.
  onRebase(fn) {
    this._rebaseListeners.push(fn);
    return () => { this._rebaseListeners = this._rebaseListeners.filter((f) => f !== fn); };
  }

  _setOrigin(X, Z, notify = true) {
    const dx = X - this.origin.x, dz = Z - this.origin.y;
    this.origin.set(X, Z);
    this.group.position.set(-X, 0, -Z);
    if (notify && (dx || dz)) {
      this.stats.rebases++;
      for (const fn of this._rebaseListeners) fn(dx, dz);
    }
  }

  // Move the scene origin by (dx, dz) metres (normally automatic).
  rebase(dx, dz) {
    this._setOrigin(this.origin.x + dx, this.origin.y + dz, true);
  }

  // ---- per-frame -------------------------------------------------------------------
  update(camera) {
    this._frame++;
    const cam = camera.position;
    const R = this.options.rebaseDistance;
    if (Math.abs(cam.x) > R || Math.abs(cam.z) > R) {
      // listeners (Game) move the camera and everything else by -(dx, dz)
      this.rebase(Math.round(cam.x), Math.round(cam.z));
    }
    if (!this.region) return;

    const CX = cam.x + this.origin.x, CZ = cam.z + this.origin.y, CY = cam.y;
    // stream 30 m tiles around the camera (a few at a time) and drop far ones
    // (time-based, and immediately after a jump, so slow frame rates still stream)
    const nowMs = performance.now();
    const jumped = !this._lastTileCheck || Math.hypot(CX - this._lastTileCheck.x, CZ - this._lastTileCheck.z) > 1000;
    if (jumped || nowMs - (this._lastTileCheck ? this._lastTileCheck.t : 0) > 250) {
      this._lastTileCheck = { x: CX, z: CZ, t: nowMs };
      const want = this._tilesNear(CX, CZ, this.options.tileRadius);
      want.sort((a, b) => this._tileDist(a, CX, CZ) - this._tileDist(b, CX, CZ));
      for (const k of want) if (this._tileLoads < 3 && !this._tiles.has(k)) this._loadTile(k);
      if (this._tiles.size > 20) {
        for (const [k, g] of this._tiles) {
          if (g instanceof Grid && this._tileDist(k, CX, CZ) > this.options.tileRadius * 2) this._tiles.delete(k);
        }
      }
    }

    // quadtree LOD selection
    const view = Math.min(this.options.maxViewDistance, camera.far * 1.05);
    const want = new Map();
    const root = this.options.rootSize;
    const r0 = Math.floor((CX - view) / root), r1 = Math.floor((CX + view) / root);
    const s0 = Math.floor((CZ - view) / root), s1 = Math.floor((CZ + view) / root);
    for (let j = s0; j <= s1; j++) for (let i = r0; i <= r1; i++) this._select(i * root, j * root, root, CX, CY, CZ, view, want);

    // build missing chunks nearest-first within a time budget
    const pending = [];
    for (const [key, node] of want) {
      const c = this._chunks.get(key);
      if (!c) pending.push(node);
      else if (c.dirty) pending.push(node);
    }
    pending.sort((a, b) => a.dist - b.dist);
    const t0 = performance.now();
    let built = 0;
    for (const node of pending) {
      if (built > 0 && performance.now() - t0 > this.options.buildBudgetMs) break;
      this._buildChunk(node);
      built++;
    }
    this.stats.builtThisFrame = built;
    this.stats.buildMs = performance.now() - t0;

    // retire chunks that are no longer wanted, unless they still cover a hole
    const missing = [];
    for (const [key, node] of want) if (!this._chunks.has(key)) missing.push(node);
    for (const [key, c] of this._chunks) {
      if (want.has(key)) continue;
      let covers = false;
      for (const m of missing) {
        if (c.x < m.x + m.size && c.x + c.size > m.x && c.z < m.z + m.size && c.z + c.size > m.z) { covers = true; break; }
      }
      if (!covers) this._disposeChunk(key, c);
    }

    this.stats.chunks = this._chunks.size;
    this.stats.pending = missing.length;
    this.stats.tiles = [...this._tiles.values()].filter((g) => g instanceof Grid).length;
    this.stats.triangles = this._chunks.size * this._index.count / 3;
    this.material.userData.terrainUniforms.uTime.value = performance.now() / 1000;
    if (this.loaded) {
      this.flora.update(CX, CZ, CY);
      this.stats.flora = this.flora.stats;
    }
  }

  _tileDist(key, X, Z) {
    const [i, j] = key.split('_').map(Number);
    const L = this.L0, ts = L.tileCells * L.res;
    const cx = L.xMin + (i + 0.5) * ts, cz = L.zMin + (j + 0.5) * ts;
    return Math.max(0, Math.hypot(cx - X, cz - Z) - ts * 0.7);
  }

  _select(x, z, size, CX, CY, CZ, view, out) {
    // horizontal distance from the camera to the node's square
    const dx = Math.max(x - CX, 0, CX - (x + size));
    const dz = Math.max(z - CZ, 0, CZ - (z + size));
    const dh = Math.hypot(dx, dz);
    if (dh > view) return;
    // vertical distance to the (coarse) terrain height there
    const hy = this.region.sample(Math.min(Math.max(CX, x), x + size), Math.min(Math.max(CZ, z), z + size), this._s2).h;
    const dist = Math.hypot(dh, Math.max(0, Math.abs(CY - hy) - size * 0.25));
    // from the air the view reaches the whole coast: split less eagerly
    const split = CY > 0 ? this.options.splitFactor * 0.7 : this.options.splitFactor;
    if (size > this.options.minChunkSize && dist < size * split) {
      const h = size / 2;
      this._select(x, z, h, CX, CY, CZ, view, out);
      this._select(x + h, z, h, CX, CY, CZ, view, out);
      this._select(x, z + h, h, CX, CY, CZ, view, out);
      this._select(x + h, z + h, h, CX, CY, CZ, view, out);
    } else {
      out.set(`${size}_${x}_${z}`, { x, z, size, dist });
    }
  }

  _buildChunk(node) {
    const key = `${node.size}_${node.x}_${node.z}`;
    const { x: X0, z: Z0, size } = node;
    const sp = size / N;
    const W = N + 3; // apron of one sample for normals
    const hg = new Float64Array(W * W);
    const rockG = new Float32Array((N + 1) * (N + 1));
    const m = this._s;
    this._l0Missing = false;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const X = X0 + (i - 1) * sp, Z = Z0 + (j - 1) * sp;
      this._macro(X, Z, sp, m);
      hg[j * W + i] = m.h + this._detail(X, Z, m, sp);
      if (i >= 1 && j >= 1 && i <= N + 1 && j <= N + 1) {
        rockG[(j - 1) * (N + 1) + (i - 1)] = smoothstep(0.25, 0.7, Math.hypot(m.dx, m.dz));
      }
    }
    const usesL0 = sp < 100 && this.L0 &&
      X0 < this.L0.xMin + this.L0.size && X0 + size > this.L0.xMin && Z0 < this.L0.zMin + this.L0.size && Z0 + size > this.L0.zMin;

    const nv = (N + 1) * (N + 1) + this._ring.length;
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const ter = new Float32Array(nv * 4);
    const sed = new Float32Array(nv * 3);
    const baseX = Math.floor(X0 / WRAP) * WRAP, baseZ = Math.floor(Z0 / WRAP) * WRAP;
    let minY = Infinity, maxY = -Infinity;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const v = j * (N + 1) + i;
      const g = (j + 1) * W + (i + 1);
      const h = hg[g];
      pos[v * 3] = i * sp; pos[v * 3 + 1] = h; pos[v * 3 + 2] = j * sp;
      const nx = -(hg[g + 1] - hg[g - 1]) / (2 * sp), nz = -(hg[g + W] - hg[g - W]) / (2 * sp);
      const l = Math.hypot(nx, 1, nz);
      nor[v * 3] = nx / l; nor[v * 3 + 1] = 1 / l; nor[v * 3 + 2] = nz / l;
      // rockiness from the slope actually drawn at this LOD (the analytic
      // bicubic gradient beats against coarse vertex spacing and makes moire)
      const drawnSlope = Math.hypot(nx, nz);
      const rockBase = sp < 16 ? Math.max(rockG[v] * 0.85, smoothstep(0.45, 0.9, drawnSlope)) : smoothstep(0.25, 0.7, drawnSlope);
      // non-repeating large-scale patchiness (outcrops vs sediment drape)
      const VX = X0 + i * sp, VZ = Z0 + j * sp;
      const reef = this.reefAt(VX, VZ, -h, sp);
      ter[v * 4] = Math.max(reef, rockBase + 0.25 * gnoise(VX / 380, VZ / 380, 21) * Math.min(1, rockBase * 3));
      sed[v * 3] = this.siltAt(VX, VZ, -h, sp);
      sed[v * 3 + 1] = reef;
      sed[v * 3 + 2] = this.shoreRockAt(VX, VZ, h);
      ter[v * 4 + 1] = -h;
      ter[v * 4 + 2] = X0 + i * sp - baseX;
      ter[v * 4 + 3] = Z0 + j * sp - baseZ;
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
    // skirts hang below the edge, deep enough to cover the neighbour's error
    const skirt = Math.max(6, sp * 1.5) + (maxY - minY) * 0.02;
    const base = (N + 1) * (N + 1);
    for (let k = 0; k < this._ring.length; k++) {
      const s = this._ring[k], v = base + k;
      // near and above the waterline a hanging skirt shows as a curtain through
      // the (transparent) surface: keep those short. Below, full length.
      const ey = pos[s * 3 + 1];
      const len = ey > -4 ? Math.min(skirt, 0.6) : ey > -12 ? Math.min(skirt, 1 + (-4 - ey) * 0.6) : skirt;
      pos[v * 3] = pos[s * 3]; pos[v * 3 + 1] = ey - len; pos[v * 3 + 2] = pos[s * 3 + 2];
      nor[v * 3] = nor[s * 3]; nor[v * 3 + 1] = nor[s * 3 + 1]; nor[v * 3 + 2] = nor[s * 3 + 2];
      for (let q = 0; q < 4; q++) ter[v * 4 + q] = ter[s * 4 + q];
      for (let q = 0; q < 3; q++) sed[v * 3 + q] = sed[s * 3 + q];
    }
    minY -= skirt;

    const geo = new THREE.BufferGeometry();
    geo.setIndex(this._index);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aTerrain', new THREE.BufferAttribute(ter, 4));
    geo.setAttribute('aSed', new THREE.BufferAttribute(sed, 3));
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, minY, 0), new THREE.Vector3(size, maxY, size));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());

    const old = this._chunks.get(key);
    if (old) { this.group.remove(old.mesh); old.mesh.geometry.dispose(); }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(X0, 0, Z0);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = 'terrain-chunk';
    this.group.add(mesh);
    this._chunks.set(key, {
      mesh, x: X0, z: Z0, size, usesL0, complete: !(usesL0 && this._l0Missing), dirty: false,
    });
  }

  _disposeChunk(key, c) {
    this.group.remove(c.mesh);
    c.mesh.geometry.dispose();
    this._chunks.delete(key);
  }

  setVisible(v) {
    this.group.visible = v;
  }

  dispose() {
    this.flora.dispose();
    for (const [k, c] of this._chunks) this._disposeChunk(k, c);
    this.scene.remove(this.group);
    this.material.userData.terrainUniforms.uDetail.value.dispose();
    this.material.dispose();
    this._tiles.clear();
    this._rebaseListeners = [];
  }
}

function distToPolyline(x, z, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const vx = bx - ax, vz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
    const d = Math.hypot(x - ax - vx * t, z - az - vz * t);
    if (d < best) best = d;
  }
  return best;
}

function pointInPolygon(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
