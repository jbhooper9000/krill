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
// lanceolate with a ruffled margin, soft mottling and a faint midrib (no fine
// line patterns: they alias into shimmer at a distance), and a gas bladder
// (pneumatocyst) at the base.
function drawBlade(g, x0, y0, len, wid, ang, r, shade = 1) {
  const k = shade;
  const c = (R, G, B, a = 1) => `rgba(${Math.min(255, R * k) | 0},${Math.min(255, G * k) | 0},${Math.min(255, B * k) | 0},${a})`;
  g.save();
  g.translate(x0, y0);
  g.rotate(ang);
  const pts = 16;
  const ph = r() * 6;
  g.beginPath();
  g.moveTo(0, 0);
  for (let i = 1; i <= pts; i++) {
    const t = i / pts;
    const w = wid * Math.sin(Math.PI * Math.pow(t, 0.75)) * (0.85 + 0.25 * Math.sin(t * 23 + ph));
    g.lineTo(w * 0.5, -t * len);
  }
  for (let i = pts; i >= 1; i--) {
    const t = i / pts;
    const w = wid * Math.sin(Math.PI * Math.pow(t, 0.75)) * (0.85 + 0.25 * Math.sin(t * 19 + ph + 1.3));
    g.lineTo(-w * 0.5, -t * len);
  }
  g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, -len);
  grad.addColorStop(0, c(118, 86, 34));
  grad.addColorStop(0.45, c(170, 128, 52));
  grad.addColorStop(1, c(150, 116, 46));
  g.fillStyle = grad;
  g.fill();
  g.clip();
  // soft mottling (large, low-contrast blotches)
  for (let i = 0; i < 5; i++) {
    const y = -r() * len, rad = wid * (0.4 + r() * 0.6);
    const rg = g.createRadialGradient(0, y, 0, 0, y, rad);
    const light = r() < 0.5;
    rg.addColorStop(0, light ? 'rgba(235,200,120,0.18)' : 'rgba(70,48,14,0.18)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(-wid, y - rad, wid * 2, rad * 2);
  }
  // faint wide midrib
  const mr = g.createLinearGradient(-wid * 0.2, 0, wid * 0.2, 0);
  mr.addColorStop(0, 'rgba(0,0,0,0)');
  mr.addColorStop(0.5, 'rgba(90,64,20,0.16)');
  mr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mr;
  g.fillRect(-wid * 0.2, -len, wid * 0.4, len);
  g.restore();
  // pneumatocyst: a soft darker bulb at the base
  g.save();
  g.translate(x0, y0);
  g.rotate(ang);
  const b = g.createRadialGradient(0, -wid * 0.08, 0, 0, -wid * 0.08, wid * 0.3);
  b.addColorStop(0, c(150, 112, 44));
  b.addColorStop(0.7, c(112, 82, 30));
  b.addColorStop(1, c(112, 82, 30, 0));
  g.fillStyle = b;
  g.beginPath();
  g.ellipse(0, -wid * 0.08, wid * 0.2, wid * 0.32, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function makeBladeTexture() {
  const t = canvasTexture(128, 512, (g, w, h) => {
    drawBlade(g, w / 2, h - 4, h - 10, w * 0.9, 0, rng(7));
  });
  if (t) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8; }
  return t;
}

// Far-LOD plant silhouettes: an atlas of 4 different plants side by side
// (128 x 512 each), picked per instance in the shader.
const CARD_VARIANTS = 4;
function makePlantTexture() {
  const t = canvasTexture(128 * CARD_VARIANTS, 512, (g, W, h) => {
    const w = 128;
    for (let v = 0; v < CARD_VARIANTS; v++) {
      const r = rng(21 + v * 97);
      g.save();
      g.beginPath();
      g.rect(v * w, 0, w, h);
      g.clip();
      const ox = v * w;
      const stipes = 4 + Math.floor(r() * 4);
      const lean = (r() - 0.5) * 0.5;
      for (let s = 0; s < stipes; s++) {
        const bx = ox + w * 0.5 + (r() - 0.5) * 16;
        const reach = 0.55 + r() * 0.45; // some stipes stop short of the surface
        const topY = h - reach * (h - 6);
        const top = Math.max(ox + 10, Math.min(ox + w - 10, bx + w * (lean + (r() - 0.5) * 0.7)));
        const c1 = bx + (r() - 0.5) * 50, c2 = top + (r() - 0.5) * 50;
        g.strokeStyle = 'rgb(96,74,30)';
        g.lineWidth = 1.4;
        g.beginPath();
        g.moveTo(bx, h);
        g.bezierCurveTo(c1, h - (h - topY) * 0.35, c2, h - (h - topY) * 0.7, top, topY);
        g.stroke();
        const n = Math.floor(28 * reach) + 8;
        for (let b = 0; b < n; b++) {
          const t = b / n;
          // cubic bezier point
          const mt = 1 - t;
          const x = mt * mt * mt * bx + 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t * top;
          const y = h - t * (h - topY);
          const ang = (r() < 0.5 ? 1 : -1) * (0.6 + r() * 1.3) + lean;
          drawBlade(g, x, y, 18 + r() * 20, 8 + r() * 7, ang, r, 0.75 + r() * 0.4);
        }
      }
      g.restore();
    }
  });
  if (t) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 8; }
  return t;
}

// surface canopy mat: a tangle of blades, densest in the middle, ragged edges
function makeMatTexture() {
  const t = canvasTexture(256, 256, (g, w, h) => {
    const r = rng(33);
    for (let i = 0; i < 420; i++) {
      const rad = Math.pow(r(), 0.6);
      const a = r() * Math.PI * 2;
      const x = w * 0.42 + Math.cos(a) * rad * w * 0.4, y = h / 2 + Math.sin(a) * rad * h * 0.36;
      const ang = Math.PI / 2 + (r() - 0.5) * 0.9 + Math.sin(y * 0.05) * 0.3;
      drawBlade(g, x, y, 26 + r() * 30, 9 + r() * 7, ang, r, 0.65 + r() * 0.5);
    }
  });
  if (t) t.anisotropy = 8;
  return t;
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
// for a ~15 m plant). aFlex = 0 on stipes and blade bases, rising to 1 at the
// blade tips: the shader flutters blades by it.
function makeKelpPlantGeometry() {
  const pos = [], nor = [], uv = [], flex = [], idx = [];
  const H = 15;
  const quad = (a, b, c, d, n, uvs, f) => {
    const base = pos.length / 3;
    for (const v of [a, b, c, d]) { pos.push(...v); nor.push(...n); }
    uv.push(...uvs);
    flex.push(...f);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const SOLID = [0.45, 0.45, 0.55, 0.45, 0.55, 0.47, 0.45, 0.47]; // solid middle of the blade texture
  const r = rng(12345);
  const stipes = 6;
  for (let s = 0; s < stipes; s++) {
    // stipes fan out from the holdfast and wander; some are young fronds that
    // stop short of the surface
    const a0 = (s / stipes) * Math.PI * 2 + r() * 0.9;
    const reach = s < 4 ? 1 : 0.45 + r() * 0.4;
    const spread = 0.4 + r() * 1.2;
    const bx = Math.cos(a0) * 0.15, bz = Math.sin(a0) * 0.15;
    const tx = Math.cos(a0) * spread + 0.6 + r() * 1.2, tz = Math.sin(a0) * spread;
    const w1 = r() * 6, w2 = r() * 6, f1 = 3 + r() * 3, f2 = 7 + r() * 4;
    const at = (y) => {
      const k = y * y * (3 - 2 * y);
      return [
        bx + (tx - bx) * k + Math.sin(y * f1 + w1) * 0.45 + Math.sin(y * f2 + w2) * 0.12,
        y,
        bz + (tz - bz) * k + Math.cos(y * f1 * 0.8 + w2) * 0.4 + Math.cos(y * f2 + w1) * 0.1,
      ];
    };
    // stipe ribbon, following the curve
    const segs = 10, w = 0.012;
    for (let i = 0; i < segs; i++) {
      const p0 = at((i / segs) * reach), p1 = at(((i + 1) / segs) * reach);
      quad([p0[0] - w, p0[1], p0[2]], [p0[0] + w, p0[1], p0[2]], [p1[0] + w, p1[1], p1[2]], [p1[0] - w, p1[1], p1[2]], [0, 0, 1], SOLID, [0, 0, 0, 0]);
    }
    // blades: 40-110 cm, in irregular clusters, drooping, bent in two
    // segments and rolled so they aren't flat cards
    const blades = Math.round(40 * reach);
    for (let b = 0; b < blades; b++) {
      const y = Math.min(reach, (0.03 + (b / blades) * 0.95 + (r() - 0.5) * 0.03) * reach);
      const p = at(y);
      const az = r() * Math.PI * 2;
      const len = 0.4 + r() * 0.7 * (0.6 + 0.4 * y), wid = 0.12 + r() * 0.2;
      const el = 0.4 - r() * 0.7, el2 = el - 0.25 - r() * 0.45;
      const roll = (r() - 0.5) * 1.4;
      const ca = Math.cos(az), sa = Math.sin(az);
      // width axis: horizontal, rolled up/down a little
      const sx = -sa * wid * 0.5 * Math.cos(roll), sz = ca * wid * 0.5 * Math.cos(roll), sy = (wid * 0.5 * Math.sin(roll)) / H;
      const h1 = len * 0.5;
      const m = [p[0] + ca * Math.cos(el) * h1, p[1] + (Math.sin(el) * h1) / H, p[2] + sa * Math.cos(el) * h1];
      const t = [m[0] + ca * Math.cos(el2) * h1, m[1] + (Math.sin(el2) * h1) / H, m[2] + sa * Math.cos(el2) * h1];
      const n = [-ca * Math.sin(el), Math.cos(el), -sa * Math.sin(el)];
      quad([p[0] - sx * 0.4, p[1] - sy * 0.4, p[2] - sz * 0.4], [p[0] + sx * 0.4, p[1] + sy * 0.4, p[2] + sz * 0.4],
        [m[0] + sx, m[1] + sy, m[2] + sz], [m[0] - sx, m[1] - sy, m[2] - sz], n,
        [0.3, 0, 0.7, 0, 1, 0.5, 0, 0.5], [0, 0, 0.5, 0.5]);
      quad([m[0] - sx, m[1] - sy, m[2] - sz], [m[0] + sx, m[1] + sy, m[2] + sz],
        [t[0] + sx * 0.5, t[1] + sy * 0.5, t[2] + sz * 0.5], [t[0] - sx * 0.5, t[1] - sy * 0.5, t[2] - sz * 0.5], n,
        [0, 0.5, 1, 0.5, 1, 1, 0, 1], [0.5, 0.5, 1, 1]);
    }
    // trailing blades lying on the surface at the top of full-length fronds
    if (reach === 1) {
      const top = at(1);
      for (let b = 0; b < 5; b++) {
        const az = (r() - 0.5) * 1.4 + a0 * 0.3;
        const d0 = 0.2 + b * 0.5;
        const len = 0.6 + r() * 0.5, wid = 0.14 + r() * 0.08;
        const ox = top[0] + d0 * Math.cos(az * 0.5), oz = top[2] + d0 * Math.sin(az * 0.5);
        const dx = Math.cos(az), dz = Math.sin(az);
        const sx = -dz * wid * 0.5, sz = dx * wid * 0.5;
        const y = 1 - (0.1 + r() * 0.15) / H;
        quad([ox - sx, y, oz - sz], [ox + sx, y, oz + sz], [ox + dx * len + sx, y, oz + dz * len + sz], [ox + dx * len - sx, y, oz + dz * len - sz],
          [0, 1, 0], [0, 0, 1, 0, 1, 1, 0, 1], [0.2, 0.2, 1, 1]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(flex, 1));
  g.setIndex(idx);
  return g;
}

// Far-LOD kelp: two crossed cards, 3.2 m wide, unit height (the atlas variant
// is chosen per instance in the shader)
function makeKelpCardGeometry() {
  const w = 1.6;
  const pos = [-w, 0, 0, w, 0, 0, w, 1, 0, -w, 1, 0, 0, 0, -w, 0, 0, w, 0, 1, w, 0, 1, -w];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  const nor = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(new Array(8).fill(0), 1));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

// Canopy mat: unit horizontal square (instance x/z scale = size in m)
function makeMatGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 2, 2);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  const f = [];
  for (let i = 0; i < p.count; i++) f.push(Math.min(1, Math.hypot(p.getX(i), p.getZ(i)) * 1.6));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(f, 1));
  return g;
}

// ---- materials -------------------------------------------------------------------
// Sway: (1) the whole plant leans with a slow, coherent surge that travels
// shoreward, tethered at the holdfast; (2) a slower bending wave travels up
// each stipe so it curves along its length; (3) blades flutter by aFlex.
// LOD: near plants dither out and far cards dither in over 18-26 m.
const SWAY_GLSL = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
float kHeight = 1.0;
vec2 kInst = vec2( 0.0 );
#ifdef USE_INSTANCING
	kHeight = length( instanceMatrix[1].xyz );
	kInst = instanceMatrix[3].xz;
	mvPosition = instanceMatrix * mvPosition;
#endif
{
	vec2 wp = mvPosition.xz + uAnchor;
	vec2 ip = kInst + uAnchor;
	float ph = uTime * 0.55 - dot( wp, vec2( 0.045, 0.03 ) );
	#ifdef KELP_MAT
		float a = 1.2 + 0.3 * sin( dot( wp, vec2( 0.21, 0.17 ) ) );
		mvPosition.y += 0.06 * sin( uTime * 1.3 + dot( wp, vec2( 0.9, 0.7 ) ) );
	#else
		float hy = position.y;
		float a = hy * hy * ( 1.1 + 0.4 * sin( dot( ip, vec2( 0.7, 1.3 ) ) ) );
		// bending wave up the stipe (per stipe phase from its local position)
		float sp = dot( ip, vec2( 0.37, 0.21 ) ) + dot( position.xz, vec2( 2.1, 1.7 ) );
		float wv = uTime * 0.7 - hy * kHeight * 0.4 + sp;
		float bend = hy * ( 1.2 - hy ) * min( kHeight, 25.0 ) * 0.045;
		mvPosition.x += sin( wv ) * bend;
		mvPosition.z += cos( wv * 0.8 + 1.1 ) * bend * 0.8;
	#endif
	mvPosition.x += ( sin( ph ) + 0.35 * sin( ph * 2.3 + 1.7 ) ) * a;
	mvPosition.z += ( 0.6 * cos( ph * 0.8 + 1.3 ) ) * a;
	// blade flutter
	float fp = uTime * 2.6 + dot( wp, vec2( 3.1, 2.7 ) ) + position.y * 37.0;
	mvPosition.y += sin( fp ) * 0.08 * aFlex;
	mvPosition.x += cos( fp * 0.8 ) * 0.06 * aFlex;
	mvPosition.z += sin( fp * 1.1 + 0.7 ) * 0.06 * aFlex;
	#if defined( KELP_FADE_OUT ) || defined( KELP_FADE_IN )
		vec3 iw = ( modelMatrix * vec4( kInst.x, 0.0, kInst.y, 1.0 ) ).xyz;
		vKelpFade = smoothstep( 18.0, 26.0, length( iw.xz - cameraPosition.xz ) );
	#endif
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`;

const KELP_FRAG_HEAD = /* glsl */ `
uniform float uLight;
varying float vKelpFade;
float kBayer2( vec2 a ) { a = floor( a ); return fract( a.x / 2.0 + a.y * a.y * 0.75 ); }
float kBayer4( vec2 a ) { return kBayer2( 0.5 * a ) * 0.25 + kBayer2( a ); }`;

function makeKelpMaterial(map, uniforms, { mat = false, fade = null, card = false } = {}) {
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
    const defs = {};
    if (mat) defs.KELP_MAT = '';
    if (card) defs.KELP_CARD = '';
    if (fade === 'out') defs.KELP_FADE_OUT = '';
    if (fade === 'in') defs.KELP_FADE_IN = '';
    shader.defines = { ...(shader.defines || {}), ...defs };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uAnchor;\nattribute float aFlex;\nvarying float vKelpFade;')
      .replace('#include <uv_vertex>', /* glsl */ `#include <uv_vertex>
#if defined( KELP_CARD ) && defined( USE_INSTANCING ) && defined( USE_MAP )
	{
		vec2 ipv = mod( instanceMatrix[3].xz + uAnchor, 997.0 );
		float variant = floor( fract( sin( dot( ipv, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * ${CARD_VARIANTS}.0 );
		vMapUv.x = ( clamp( vMapUv.x, 0.01, 0.99 ) + variant ) / ${CARD_VARIANTS}.0;
	}
#endif`)
      .replace('#include <project_vertex>', SWAY_GLSL);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + KELP_FRAG_HEAD)
      .replace('#include <clipping_planes_fragment>', /* glsl */ `#include <clipping_planes_fragment>
#ifdef KELP_FADE_OUT
	if ( kBayer4( gl_FragCoord.xy ) > 1.0 - vKelpFade ) discard;
#endif
#ifdef KELP_FADE_IN
	if ( kBayer4( gl_FragCoord.xy ) > vKelpFade ) discard;
#endif`)
      // translucency: looking up toward the light, thin kelp tissue glows golden
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
  m.customProgramCacheKey = () => `krill-kelp-v3-${mat ? 'mat' : card ? 'card' : 'plant'}-${fade || ''}`;
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
        // near and far bands overlap over 18-26 m, where they crossfade (dithered)
        { kind: 'plant', min: 0, max: 26, geometry: makeKelpPlantGeometry(), material: patch(makeKelpMaterial(makeBladeTexture(), u, { fade: 'out' })), capacity: 1500 },
        { kind: 'plant', min: 18, max: 90, geometry: makeKelpCardGeometry(), material: patch(makeKelpMaterial(makePlantTexture(), u, { fade: 'in', card: true })), capacity: 5000 },
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
      // every plant different: rotation, width, lean and a golden-to-olive tint
      // (the shared current is applied as a bend in the shader)
      const sc = 0.75 + r() * 0.55;
      const k = 0.8 + r() * 0.35;
      const tint = new THREE.Color(k * (0.95 + r() * 0.1), k * (0.88 + r() * 0.14), k * (0.75 + r() * 0.25));
      out.push({
        kind: 'plant', x, z, y: h - 0.2, rx: (r() - 0.5) * 0.12, ry: r() * Math.PI * 2, rz: (r() - 0.5) * 0.12,
        sx: sc, sy: height, sz: sc, color: tint.getHex(),
      });
      // this plant's canopy, streaming a little downstream
      if (depth > 4) {
        const s = 5 + r() * 5;
        out.push({
          kind: 'mat', x: x + 1.5 + r() * 2.5, z: z + (r() - 0.5) * 1.5, y: -0.15 - r() * 0.3,
          ry: (r() - 0.5) * 0.9, sx: s, sy: 1, sz: s * (0.45 + r() * 0.3), color: 0xffffff,
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
