import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Streamed seafloor dressing on top of Terrain: boulders / reef rock and giant
// kelp (Macrocystis pyrifera) forests.
//
// Everything is deterministic per world cell (same rocks every visit), is
// generated around the camera as it moves, and lives in InstancedMeshes inside
// terrain.group, so the floating origin moves it for free. Instance matrices
// are relative to an anchor near the camera (reset on every rebuild) to keep
// float32 precision high far from the bay centre.
//
// LOD per layer: every instance has a kind, and each kind has one mesh per
// distance band (near: detailed geometry; far: cheap geometry / cards).
//
// Kelp is built from three pieces:
//   plant (near)  7 flexible stipes fanning up from one holdfast, each lined
//                 with textured blades (wrinkled, ruffled, a gas bladder at the
//                 base) and trailing blades at the surface
//   plant (far)   two crossed alpha cards with a painted plant silhouette
//   canopy mat    a horizontal alpha card of tangled blades lying just under
//                 the surface: the dense golden mat seen from below
// All kelp shares one sway (a slow, coherent surge that travels shoreward)
// and a translucency term: looking up toward the light, blades glow golden.

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpC = new THREE.Color();

// small deterministic PRNG
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const cellSeed = (i, j, salt) => (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;

// Poisson sample count with mean m
function poisson(m, r) {
  if (m <= 0) return 0;
  if (m > 30) return Math.max(0, Math.round(m + Math.sqrt(m) * (r() + r() + r() - 1.5) * 1.4));
  const L = Math.exp(-m);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

// ---- canvas textures (browser only; null under Node tests) ---------------------
const hasDOM = typeof document !== 'undefined';
function canvasTexture(w, h, draw) {
  if (!hasDOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// One Macrocystis blade, base at (x0, y0) pointing along -y rotated by ang:
// lanceolate, ruffled margin, transverse corrugations, a small gas bladder
// (pneumatocyst) at the base.
function drawBlade(g, x0, y0, len, wid, ang, r, shade = 1) {
  const k = shade;
  g.save();
  g.translate(x0, y0);
  g.rotate(ang);
  const pts = 18;
  g.beginPath();
  g.moveTo(0, 0);
  for (let i = 1; i <= pts; i++) {
    const t = i / pts;
    const w = wid * Math.sin(Math.PI * Math.pow(t, 0.8)) * (0.9 + 0.2 * Math.sin(t * 37 + r() * 3));
    g.lineTo(w * 0.5, -t * len);
  }
  for (let i = pts; i >= 1; i--) {
    const t = i / pts;
    const w = wid * Math.sin(Math.PI * Math.pow(t, 0.8)) * (0.9 + 0.2 * Math.sin(t * 29 + 1.3));
    g.lineTo(-w * 0.5, -t * len);
  }
  g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, -len);
  grad.addColorStop(0, `rgb(${120 * k | 0},${88 * k | 0},${34 * k | 0})`);
  grad.addColorStop(0.5, `rgb(${168 * k | 0},${128 * k | 0},${52 * k | 0})`);
  grad.addColorStop(1, `rgb(${150 * k | 0},${118 * k | 0},${48 * k | 0})`);
  g.fillStyle = grad;
  g.fill();
  // corrugations
  g.clip();
  for (let i = 0; i < len / 3; i++) {
    const y = -i * 3 - r() * 2;
    g.strokeStyle = i % 2 ? 'rgba(60,40,10,0.13)' : 'rgba(230,200,120,0.09)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(-wid, y);
    g.quadraticCurveTo(0, y - 2, wid, y + 1);
    g.stroke();
  }
  g.restore();
  // pneumatocyst
  g.save();
  g.translate(x0, y0);
  g.rotate(ang);
  g.fillStyle = `rgb(${128 * k | 0},${96 * k | 0},${38 * k | 0})`;
  g.beginPath();
  g.ellipse(0, -wid * 0.05, wid * 0.16, wid * 0.28, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function makeBladeTexture() {
  const t = canvasTexture(64, 256, (g, w, h) => {
    drawBlade(g, w / 2, h - 2, h - 6, w * 0.9, 0, rng(7));
  });
  if (t) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// far-LOD plant silhouette: stipes fanning up, lined with blades
function makePlantTexture() {
  return canvasTexture(128, 512, (g, w, h) => {
    const r = rng(21);
    for (let s = 0; s < 5; s++) {
      const bx = w * 0.35 + (r() - 0.5) * 10;
      const top = Math.min(w - 8, bx + w * (0.1 + 0.45 * r()));
      g.strokeStyle = 'rgb(96,74,30)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(bx, h);
      g.bezierCurveTo(bx, h * 0.6, top + (r() - 0.5) * 20, h * 0.3, top, 4);
      g.stroke();
      for (let b = 0; b < 34; b++) {
        const t = b / 34;
        const x = bx + (top - bx) * t * t + Math.sin(t * 6 + s) * 3;
        const y = h - t * (h - 6);
        drawBlade(g, x, y, 22 + r() * 14, 10 + r() * 5, Math.PI / 2 + (r() - 0.35) * 1.1, r, 0.8 + r() * 0.3);
      }
    }
  });
}

// surface canopy mat: a tangle of blades, densest in the middle, ragged edges
function makeMatTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const r = rng(33);
    for (let i = 0; i < 420; i++) {
      const rad = Math.pow(r(), 0.6);
      const a = r() * Math.PI * 2;
      const x = w * 0.42 + Math.cos(a) * rad * w * 0.4, y = h / 2 + Math.sin(a) * rad * h * 0.36;
      const ang = Math.PI / 2 + (r() - 0.5) * 0.9 + Math.sin(y * 0.05) * 0.3;
      drawBlade(g, x, y, 26 + r() * 30, 9 + r() * 7, ang, r, 0.65 + r() * 0.5);
    }
  });
}

// ---- geometry ----------------------------------------------------------------------
function makeRockGeometry(detail) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position;
  // rounded, lumpy boulder with a flattened base (seated in the sediment)
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + 0.18 * Math.sin(x * 2.6 + z * 1.7) + 0.12 * Math.sin(y * 3.3 - x * 2.2) + 0.07 * Math.cos(z * 4.1 + y * 1.3);
    const yy = y < -0.3 ? -0.3 + (y + 0.3) * 0.25 : y;
    p.setXYZ(i, x * n, yy * n, z * n);
  }
  g.computeVertexNormals();
  return g;
}

// Near-LOD kelp plant, unit height (instance y-scale = plant height in m; x/z
// scale 1 so blade sizes stay in metres; vertical blade extents are authored
// for a ~15 m plant).
function makeKelpPlantGeometry() {
  const pos = [], nor = [], uv = [], idx = [];
  const H = 15;
  const quad = (a, b, c, d, n, uvs) => {
    const base = pos.length / 3;
    for (const v of [a, b, c, d]) { pos.push(...v); nor.push(...n); }
    uv.push(...uvs);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const SOLID = [0.45, 0.4, 0.55, 0.4, 0.55, 0.42, 0.45, 0.42]; // solid middle of the blade texture
  const BLADE = [0, 0, 1, 0, 1, 1, 0, 1]; // u across, v along (base at v=0)
  const r = rng(12345);
  const stipes = 5;
  for (let s = 0; s < stipes; s++) {
    // the current flows toward +x: stipes fan out a little and lean downstream
    const a0 = (s / stipes) * Math.PI * 2 + r() * 0.8;
    const spread = 0.3 + r() * 0.9;
    const bx = Math.cos(a0) * 0.15, bz = Math.sin(a0) * 0.15;
    const tx = Math.cos(a0) * spread + 1.2 + r() * 1.8, tz = Math.sin(a0) * spread;
    const wob = r() * 6;
    const at = (y) => {
      const k = y * y * (3 - 2 * y);
      return [bx + (tx - bx) * k + Math.sin(y * 5 + wob) * 0.3, y, bz + (tz - bz) * k + Math.cos(y * 4 + wob) * 0.3];
    };
    // stipe ribbon
    const segs = 6, w = 0.01;
    for (let i = 0; i < segs; i++) {
      const p0 = at(i / segs), p1 = at((i + 1) / segs);
      quad([p0[0] - w, p0[1], p0[2]], [p0[0] + w, p0[1], p0[2]], [p1[0] + w, p1[1], p1[2]], [p1[0] - w, p1[1], p1[2]], [0, 0, 1], SOLID);
    }
    // blades: 30-80 cm, rising at 25-60 deg from their bladder on alternating sides
    // blades: 45-95 cm, streaming downstream from their bladders, drooping,
    // bent in two segments so they don't read as flat cards
    const blades = 34;
    for (let b = 0; b < blades; b++) {
      const y = 0.04 + (b / blades) * 0.92 + r() * 0.015;
      const p = at(y);
      const az = (b % 2 ? 1 : -1) * (0.25 + r() * 0.6) + (r() - 0.5) * 0.4;
      const len = 0.5 + r() * 0.5, wid = 0.15 + r() * 0.15;
      const el = 0.35 - r() * 0.55, el2 = el - 0.3 - r() * 0.3;
      const ca = Math.cos(az), sa = Math.sin(az);
      const sx = -sa * wid * 0.5, sz = ca * wid * 0.5; // horizontal width axis
      const h1 = len * 0.5;
      const m = [p[0] + ca * Math.cos(el) * h1, p[1] + (Math.sin(el) * h1) / H, p[2] + sa * Math.cos(el) * h1];
      const t = [m[0] + ca * Math.cos(el2) * h1, m[1] + (Math.sin(el2) * h1) / H, m[2] + sa * Math.cos(el2) * h1];
      const n = [-ca * Math.sin(el), Math.cos(el), -sa * Math.sin(el)];
      quad([p[0] - sx * 0.5, p[1], p[2] - sz * 0.5], [p[0] + sx * 0.5, p[1], p[2] + sz * 0.5], [m[0] + sx, m[1], m[2] + sz], [m[0] - sx, m[1], m[2] - sz], n,
        [0.25, 0, 0.75, 0, 1, 0.5, 0, 0.5]);
      quad([m[0] - sx, m[1], m[2] - sz], [m[0] + sx, m[1], m[2] + sz], [t[0] + sx * 0.6, t[1], t[2] + sz * 0.6], [t[0] - sx * 0.6, t[1], t[2] - sz * 0.6], n,
        [0, 0.5, 1, 0.5, 1, 1, 0, 1]);
    }
    // trailing blades lying on the surface at the top
    const top = at(1);
    for (let b = 0; b < 4; b++) {
      const az = (r() - 0.5) * 0.8;
      const d0 = 0.2 + b * 0.55;
      const len = 0.5 + r() * 0.4, wid = 0.12 + r() * 0.06;
      const ox = top[0] + d0, oz = top[2] + (r() - 0.5) * 0.4;
      const dx = Math.cos(az), dz = Math.sin(az);
      const sx = -dz * wid * 0.5, sz = dx * wid * 0.5;
      const y = 1 - (0.1 + r() * 0.15) / H;
      quad([ox - sx, y, oz - sz], [ox + sx, y, oz + sz], [ox + dx * len + sx, y, oz + dz * len + sz], [ox + dx * len - sx, y, oz + dz * len - sz],
        [0, 1, 0], BLADE);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Far-LOD kelp: two crossed cards, 3.2 m wide, unit height
function makeKelpCardGeometry() {
  const w = 1.6;
  const pos = [-w, 0, 0, w, 0, 0, w, 1, 0, -w, 1, 0, 0, 0, -w, 0, 0, w, 0, 1, w, 0, 1, -w];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  const nor = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

// Canopy mat: unit horizontal square (instance x/z scale = size in m)
function makeMatGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 2, 2);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ---- materials -------------------------------------------------------------------
const SWAY_GLSL = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
{
	// surge: slow, coherent across the forest, travelling shoreward; stipes are
	// tethered at the holdfast, the canopy moves as a whole
	vec2 wp = mvPosition.xz + uAnchor;
	float ph = uTime * 0.55 - dot(wp, vec2(0.045, 0.03));
	#ifdef KELP_MAT
		float a = 1.2 + 0.3 * sin(dot(wp, vec2(0.21, 0.17)));
		mvPosition.y += 0.06 * sin(uTime * 1.3 + dot(wp, vec2(0.9, 0.7)));
	#else
		float hy = position.y;
		float a = hy * hy * (1.3 + 0.4 * sin(dot(wp, vec2(0.7, 1.3))));
	#endif
	mvPosition.x += (sin(ph) + 0.35 * sin(ph * 2.3 + 1.7)) * a;
	mvPosition.z += (0.6 * cos(ph * 0.8 + 1.3)) * a;
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`;

function makeKelpMaterial(map, uniforms, { mat = false } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: map ? 0xffffff : 0x8a6a2c,
    map,
    roughness: 0.55,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: map ? 0.45 : 0,
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (mat) shader.defines = { ...(shader.defines || {}), KELP_MAT: '' };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uAnchor;')
      .replace('#include <project_vertex>', SWAY_GLSL);
    // translucency: looking up toward the light, thin kelp tissue glows golden
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uLight;')
      .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
{
	vec3 vdW = normalize( ( vec4( normalize( -vViewPosition ), 0.0 ) * viewMatrix ).xyz );
	float up = smoothstep( -0.15, 0.85, vdW.y );
	float dd = 0.0;
	#ifdef USE_FOG
		dd = max( 0.0, -vKwWorld.y );
	#endif
	totalEmissiveRadiance += diffuseColor.rgb * vec3( 1.0, 0.82, 0.45 ) * ( 0.12 + 1.1 * up ) * exp( -0.09 * dd ) * uLight;
}`);
  };
  m.customProgramCacheKey = () => (mat ? 'krill-kelp-mat-v2' : 'krill-kelp-v2');
  return m;
}

function makeRockMaterial(uniforms) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockP;\nvarying vec3 vRockN;\nvarying float vRockY;')
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
vRockN = normal;
vRockP = position;
vRockY = 0.0;
#ifdef USE_INSTANCING
	vRockP = position * vec3( length( instanceMatrix[0].xyz ), length( instanceMatrix[1].xyz ), length( instanceMatrix[2].xyz ) )
		+ instanceMatrix[3].xyz * 0.37; // per-rock offset into the noise
	vRockY = ( modelMatrix * instanceMatrix * vec4( position, 1.0 ) ).y;
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
uniform sampler2D uDetail;
varying vec3 vRockP;
varying vec3 vRockN;
varying float vRockY;
float tEnc;
vec4 triS(vec3 p, vec3 w) {
	return texture2D(uDetail, p.yz) * w.x + texture2D(uDetail, p.xz) * w.y + texture2D(uDetail, p.xy) * w.z;
}
vec3 rockW() { vec3 w = pow(abs(normalize(vRockN)), vec3(4.0)); return w / dot(w, vec3(1.0)); }
vec3 rPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
	vec3 vSigmaX = dFdx(surf_pos);
	vec3 vSigmaY = dFdy(surf_pos);
	vec3 R1 = cross(vSigmaY, surf_norm);
	vec3 R2 = cross(surf_norm, vSigmaX);
	float fDet = dot(vSigmaX, R1) * faceDir;
	vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
	return normalize(abs(fDet) * surf_norm - vGrad);
}`)
      .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
{
	vec3 w = rockW();
	vec4 a = triS(vRockP * 0.18, w);
	vec4 b = triS(vRockP * 0.7, w);
	float depth = -vRockY;
	// granite / sandstone grain and weathering
	diffuseColor.rgb *= 0.62 + 0.55 * b.g + 0.25 * (a.r - 0.5);
	float upF = smoothstep(-0.3, 0.6, normalize(vRockN).y);
	// encrusting coats in patches: coralline pink (deeper than ~3 m), olive turf
	// algae on sunlit tops in the shallows, pale sponges now and then
	float patchP = smoothstep(0.55, 0.72, a.a + (b.r - 0.5) * 0.3) * smoothstep(3.0, 6.0, depth) * (0.4 + 0.6 * upF);
	diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.36, 0.40) * (0.75 + 0.4 * b.b), patchP * 0.7);
	float turf = smoothstep(0.5, 0.7, a.g) * upF * (1.0 - smoothstep(8.0, 30.0, depth)) * smoothstep(-0.5, 0.5, depth);
	diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.28, 0.30, 0.15), turf * 0.6);
	float sponge = smoothstep(0.82, 0.9, b.a) * (1.0 - upF * 0.5) * smoothstep(1.0, 3.0, depth);
	diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.70, 0.55, 0.30), sponge * 0.6);
	// wet dark rock / barnacle band on emergent shore rocks
	diffuseColor.rgb *= mix(1.0, 0.55, smoothstep(-0.8, 0.2, -depth) * (1.0 - smoothstep(0.8, 1.6, -depth)));
	tEnc = max(patchP, turf);
}`)
      .replace('#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
{
	vec3 w = rockW();
	float B = triS(vRockP * 0.35, w).r * 0.25 + triS(vRockP * 1.4, w).g * 0.06 * (1.0 - tEnc * 0.6);
	normal = rPerturb(-vViewPosition, normal, vec2(dFdx(B), dFdy(B)), faceDirection);
}`);
  };
  m.customProgramCacheKey = () => 'krill-rock-v2';
  return m;
}

// ---- a streamed, LOD'd instanced layer ---------------------------------------------
class ScatterLayer {
  // meshes: [{ kind, min, max, geometry, material, capacity }]
  constructor(parent, { cellSize, generate, meshes, rebuildStep = 8 }) {
    this.cellSize = cellSize;
    this.generate = generate; // (i, j) => instances [{kind, x, y, z, ...}] or null (not ready)
    this.radius = Math.max(...meshes.map((m) => m.max));
    this.rebuildStep = rebuildStep;
    this.cells = new Map();
    this.lods = meshes.map((m) => {
      const mesh = new THREE.InstancedMesh(m.geometry, m.material, m.capacity);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      parent.add(mesh);
      const idx = m.geometry.index;
      return { ...m, mesh, n: 0, tris: (idx ? idx.count : m.geometry.attributes.position.count) / 3 };
    });
    this._dirty = false;
    this._last = null;
    this.anchor = new THREE.Vector2();
  }

  update(X, Z, budget) {
    const cs = this.cellSize;
    const ci = Math.floor(X / cs), cj = Math.floor(Z / cs);
    const R = Math.ceil(this.radius / cs);
    const want = [];
    for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
      const d = Math.hypot((i + 0.5) * cs - X, (j + 0.5) * cs - Z);
      if (d > this.radius + cs) continue;
      const k = i + ',' + j;
      if (!this.cells.has(k)) want.push({ k, i, j, d });
    }
    want.sort((a, b) => a.d - b.d);
    let made = 0;
    for (const w of want) {
      if (made >= budget) break;
      const inst = this.generate(w.i, w.j);
      if (!inst) continue; // data not streamed in yet: try again later
      this.cells.set(w.k, { i: w.i, j: w.j, inst });
      made++;
      this._dirty = true;
    }
    for (const [k, c] of this.cells) {
      if (Math.hypot((c.i + 0.5) * cs - X, (c.j + 0.5) * cs - Z) > this.radius * 1.4 + cs) {
        this.cells.delete(k);
        this._dirty = true;
      }
    }
    // rebuild when the set changed or the camera moved enough to shift LOD bands
    if (this._dirty || !this._last || Math.hypot(X - this._last.x, Z - this._last.z) > this.rebuildStep) {
      this._dirty = false;
      this._last = { x: X, z: Z };
      this._rebuild(X, Z);
    }
  }

  _rebuild(X, Z) {
    const cs = this.cellSize;
    this.anchor.set(Math.floor(X / cs) * cs, Math.floor(Z / cs) * cs);
    for (const l of this.lods) { l.n = 0; l.mesh.position.set(this.anchor.x, 0, this.anchor.y); }
    for (const c of this.cells.values()) {
      for (const it of c.inst) {
        const d = Math.hypot(it.x - X, it.z - Z);
        if (it.far && d > it.far) continue;
        for (const l of this.lods) {
          if (l.kind !== it.kind || d < l.min || d >= l.max || l.n >= l.capacity) continue;
          tmpP.set(it.x - this.anchor.x, it.y, it.z - this.anchor.y);
          tmpE.set(it.rx || 0, it.ry || 0, it.rz || 0);
          tmpQ.setFromEuler(tmpE);
          tmpS.set(it.sx, it.sy, it.sz);
          tmpM.compose(tmpP, tmpQ, tmpS);
          l.mesh.setMatrixAt(l.n, tmpM);
          if (it.color !== undefined) l.mesh.setColorAt(l.n, tmpC.setHex(it.color));
          l.n++;
          break;
        }
      }
    }
    for (const l of this.lods) {
      l.mesh.count = l.n;
      l.mesh.instanceMatrix.needsUpdate = true;
      if (l.mesh.instanceColor) l.mesh.instanceColor.needsUpdate = true;
    }
  }

  get triangles() {
    return this.lods.reduce((a, l) => a + l.mesh.count * l.tris, 0);
  }

  count(kind) {
    return this.lods.filter((l) => l.kind === kind).reduce((a, l) => a + l.mesh.count, 0);
  }

  clear() {
    this.cells.clear();
    this._dirty = true;
  }

  dispose() {
    const seen = new Set();
    for (const l of this.lods) {
      l.mesh.removeFromParent();
      for (const o of [l.mesh.geometry, l.mesh.material, l.mesh.material.map]) {
        if (o && !seen.has(o)) { seen.add(o); o.dispose(); }
      }
    }
  }
}

export class Flora {
  constructor(terrain, options = {}) {
    this.terrain = terrain;
    this.options = Object.assign({
      cellsPerFrame: 8,
      patchMaterial: null,
      lightLevel: null, // () => 0..1 daylight
    }, options);
    this.group = new THREE.Group();
    this.group.name = 'flora';
    terrain.group.add(this.group);
    this._t0 = performance.now();
    // underwater light model hook (world.patchMaterial) for every flora material
    const patch = (m) => { if (this.options.patchMaterial) this.options.patchMaterial(m); return m; };

    // ---- rocks ----
    const rockMat = patch(makeRockMaterial({ uDetail: terrain.material.userData.terrainUniforms.uDetail }));
    this.rocks = new ScatterLayer(this.group, {
      cellSize: 48,
      generate: (i, j) => this._genRocks(i, j),
      meshes: [
        { kind: 'rock', min: 0, max: 30, geometry: makeRockGeometry(2), material: rockMat, capacity: 1500 },
        { kind: 'rock', min: 30, max: 170, geometry: makeRockGeometry(1), material: rockMat, capacity: 4000 },
      ],
    });

    // ---- kelp ----
    this._kelpUniforms = { uTime: { value: 0 }, uAnchor: { value: new THREE.Vector2() }, uLight: { value: 1 } };
    const u = this._kelpUniforms;
    this.kelp = new ScatterLayer(this.group, {
      cellSize: 32,
      generate: (i, j) => this._genKelp(i, j),
      meshes: [
        { kind: 'plant', min: 0, max: 22, geometry: makeKelpPlantGeometry(), material: patch(makeKelpMaterial(makeBladeTexture(), u)), capacity: 1500 },
        { kind: 'plant', min: 22, max: 90, geometry: makeKelpCardGeometry(), material: patch(makeKelpMaterial(makePlantTexture(), u)), capacity: 5000 },
        { kind: 'mat', min: 0, max: 110, geometry: makeMatGeometry(), material: patch(makeKelpMaterial(makeMatTexture(), u, { mat: true })), capacity: 6000 },
      ],
    });
    this.stats = { rocks: 0, kelp: 0, canopy: 0, triangles: 0, meshes: 5 };
  }

  // Can we place things here yet? (true once the 30 m tile under it is loaded,
  // or outside the tiled area)
  _ready(X, Z) {
    const t = this.terrain;
    if (!t.region) return false;
    const L = t.L0;
    if (X < L.xMin || Z < L.zMin || X >= L.xMin + L.size || Z >= L.zMin + L.size) return true;
    const ts = L.tileCells * L.res;
    const g = t._tiles.get(`${Math.floor((X - L.xMin) / ts)}_${Math.floor((Z - L.zMin) / ts)}`);
    return !!(g && g.data);
  }

  _genRocks(i, j) {
    const t = this.terrain, cs = this.rocks.cellSize;
    const X0 = i * cs, Z0 = j * cs;
    const cx = X0 + cs / 2, cz = Z0 + cs / 2;
    if (!this._ready(cx, cz)) return null;
    const m = t._macro(cx, cz, 0, { h: 0, dx: 0, dz: 0 });
    const depth = -m.h;
    const out = [];
    if (depth < -3) return out;
    const slope = Math.hypot(m.dx, m.dz);
    const wall = Math.min(1, Math.max(0, (slope - 0.2) / 0.35));
    const reef = t.reefAt(cx, cz, depth);
    const shore = t.shoreRockAt(cx, cz, m.h);
    const r = rng(cellSeed(i, j, 7));
    // sparse boulders and cobbles on open sediment are the scale cue; dense on reefs/walls
    const n = poisson(6 + 9 * wall + 16 * reef + 10 * shore, r);
    for (let k = 0; k < n; k++) {
      const x = X0 + r() * cs, z = Z0 + r() * cs;
      const h = t.heightAtAbs(x, z);
      // nothing high and dry except genuine shore rocks on the rocky headlands
      if (h > -0.5 && !(h < 1.5 && t.shoreRockAt(x, z, h) > 0.4)) continue;
      const d = -h;
      const localReef = t.reefAt(x, z, d);
      const big = reef > 0.2 || wall > 0.3 || shore > 0.3;
      // log-uniform size: cobbles 0.25 m .. boulders 2.2 m (3.5 m on reefs/walls)
      const size = Math.exp(Math.log(0.25) + r() * Math.log((big ? 3.5 : 2.2) / 0.25)) * (0.7 + 0.5 * Math.max(localReef, wall));
      const flat = 0.5 + r() * 0.35;
      // muted granite / sandstone / mudstone greys and browns (encrustation is in the shader)
      const col = [0x8a857c, 0x7c776e, 0x928a7a, 0x6f6c66, 0x857b6a][Math.floor(r() * 5)];
      out.push({
        kind: 'rock', x, z, y: h - size * flat * 0.4, // seated: the flat base sits below the sediment
        rx: (r() - 0.5) * 0.35, ry: r() * Math.PI * 2, rz: (r() - 0.5) * 0.35,
        sx: size * (0.8 + r() * 0.5), sy: size * flat, sz: size * (0.8 + r() * 0.5),
        color: col,
        // small stones only near the camera (they vanish in the haze anyway)
        far: size < 0.7 ? 55 : size < 1.5 ? 100 : 0,
      });
    }
    return out;
  }

  _genKelp(i, j) {
    const t = this.terrain, cs = this.kelp.cellSize;
    const X0 = i * cs, Z0 = j * cs;
    const cx = X0 + cs / 2, cz = Z0 + cs / 2;
    const zw = t._zoneWeight(cx, cz, true);
    if (zw <= 0) return [];
    if (!this._ready(cx, cz)) return null;
    const r = rng(cellSeed(i, j, 11));
    const out = [];
    // a dense forest: ~1 holdfast per 10-25 m2 of rocky bottom
    const n = poisson((zw * cs * cs) / 16, r);
    for (let k = 0; k < n; k++) {
      const x = X0 + r() * cs, z = Z0 + r() * cs;
      const h = t.heightAtAbs(x, z);
      const depth = -h;
      if (depth < 3 || depth > 30) continue; // Macrocystis: ~3-30 m
      // holdfasts need rock: reef patches, with a little tolerance at the edges
      const reef = t.reefAt(x, z, depth);
      if (reef < 0.15 && r() > 0.2) continue;
      // stipes reach the surface; the canopy lies on it
      const height = Math.max(2, depth - 0.15);
      // ry near 0 everywhere: blades and canopy all stream with one current
      out.push({ kind: 'plant', x, z, y: h - 0.2, ry: (r() - 0.5) * 0.6, sx: 1, sy: height, sz: 1 });
      // this plant's canopy, streaming a little downstream
      if (depth > 4) {
        const s = 5 + r() * 5;
        out.push({
          kind: 'mat', x: x + 1.5 + r() * 2.5, z: z + (r() - 0.5) * 1.5, y: -0.15 - r() * 0.3,
          ry: (r() - 0.5) * 0.7, sx: s, sy: 1, sz: s * (0.45 + r() * 0.3),
        });
      }
    }
    return out;
  }

  // X, Z: camera in absolute bay metres
  update(X, Z, cameraY) {
    const b = this.options.cellsPerFrame;
    this.rocks.update(X, Z, b);
    // kelp only matters within reach of shallow water
    if (cameraY > -80) this.kelp.update(X, Z, b);
    const u = this._kelpUniforms;
    u.uTime.value = (performance.now() - this._t0) / 1000;
    u.uAnchor.value.copy(this.kelp.anchor);
    u.uLight.value = this.options.lightLevel ? this.options.lightLevel() : 1;
    this.stats.rocks = this.rocks.count('rock');
    this.stats.kelp = this.kelp.count('plant');
    this.stats.canopy = this.kelp.count('mat');
    this.stats.triangles = this.rocks.triangles + this.kelp.triangles;
  }

  // Re-place everything (e.g. when better height data arrives)
  refresh() {
    this.rocks.clear();
    this.kelp.clear();
  }

  setVisible(v) {
    this.group.visible = v;
  }

  dispose() {
    this.rocks.dispose();
    this.kelp.dispose();
    this.group.removeFromParent();
  }
}
