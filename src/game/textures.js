import * as THREE from 'three';

// Procedural canvas textures — no external assets needed.

function canvas(size, fn) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  fn(c.getContext('2d'), size);
  return c;
}

function toTexture(c, opts = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  Object.assign(t, opts);
  return t;
}

// --- Whale skin: mottled back + lighter belly + ventral pleat grooves ---
export function makeSkinTexture(topColor, bottomColor, mottle = true, seed = 1) {
  const size = 1024;
  const c = canvas(size, (ctx, s) => {
    // base vertical gradient (back -> belly)
    const css = (n) => '#' + n.toString(16).padStart(6, '0');
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, css(topColor));
    g.addColorStop(0.62, css(topColor));
    g.addColorStop(0.66, css(bottomColor));
    g.addColorStop(1, css(bottomColor));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);

    // deterministic-ish noise
    let r = seed * 9301 + 49297;
    const rand = () => {
      r = (r * 9301 + 49297) % 233280;
      return r / 233280;
    };

    if (mottle) {
      // mottled blotches on the back
      for (let i = 0; i < 220; i++) {
        const x = rand() * s;
        const y = rand() * s * 0.62;
        const rad = (4 + rand() * 26);
        const a = 0.03 + rand() * 0.1;
        const light = rand() > 0.5;
        ctx.fillStyle = light
          ? `rgba(255,255,255,${a})`
          : `rgba(0,0,0,${a * 0.9})`;
        ctx.beginPath();
        ctx.ellipse(x, y, rad, rad * (0.6 + rand() * 0.5), rand() * 3.14, 0, 6.283);
        ctx.fill();
      }
    }

    // subtle horizontal streaking
    for (let i = 0; i < 60; i++) {
      const y = rand() * s;
      const a = 0.02 + rand() * 0.05;
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillRect(0, y, s, 1 + rand() * 2);
    }

    // ventral pleats (grooves) toward the belly — vertical lines so they run
    // nose-to-tail once mapped around the body.
    const pleats = 26;
    const pleatTop = s * 0.7;
    for (let p = 0; p < pleats; p++) {
      const x = (p / (pleats - 1)) * s;
      ctx.strokeStyle = 'rgba(28,40,46,0.22)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(x, pleatTop);
      ctx.lineTo(x, s - 4);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(x + 2, pleatTop + 2);
      ctx.lineTo(x + 2, s - 4);
      ctx.stroke();
    }
  });
  const t = toTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// --- Sandy sea floor ---
export function makeSandTexture() {
  const size = 512;
  const c = canvas(size, (ctx, s) => {
    ctx.fillStyle = '#7d6f56'; // sand albedo ~0.2-0.3 linear
    ctx.fillRect(0, 0, s, s);
    let r = 7;
    const rand = () => {
      r = (r * 16807) % 2147483647;
      return r / 2147483647;
    };
    for (let i = 0; i < 9000; i++) {
      const x = rand() * s;
      const y = rand() * s;
      const a = 0.04 + rand() * 0.1;
      const v = 150 + rand() * 90;
      ctx.fillStyle = `rgba(${v},${v * 0.88},${v * 0.68},${a})`;
      ctx.fillRect(x, y, 1 + rand() * 2.2, 1 + rand() * 2.2);
    }
    // subtle ripples
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      const x = rand() * s, y = rand() * s;
      ctx.arc(x, y, 20 + rand() * 60, rand() * 3.14, rand() * 3.14 + 2.4);
      ctx.stroke();
    }
  });
  const t = toTexture(c);
  t.repeat.set(14, 14);
  return t;
}

// --- Caustics pattern (light lattice) ---
export function makeCausticsTexture() {
  const size = 512;
  const c = canvas(size, (ctx, s) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, s, s);
    let r = 17;
    const rand = () => {
      r = (r * 16807) % 2147483647;
      return r / 2147483647;
    };
    // Voronoi-ish bright cells
    const pts = [];
    for (let i = 0; i < 34; i++) pts.push([rand() * s, rand() * s]);
    const cell = s / 8;
    for (let cx = 0; cx < s; cx += cell) {
      for (let cy = 0; cy < s; cy += cell) {
        // find nearest point
        let best = Infinity;
        let bx = cx, by = cy;
        for (const [px, py] of pts) {
          const dx = cx - px, dy = cy - py;
          const d = dx * dx + dy * dy;
          if (d < best) { best = d; bx = px; by = py; }
        }
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, cell * 2.4);
        g.addColorStop(0, 'rgba(255,255,255,0.9)');
        g.addColorStop(0.4, 'rgba(255,255,255,0.28)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx, cy, cell, cell);
      }
    }
    // bright connecting lines
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2.5;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
        if (dx * dx + dy * dy < (s * 0.3) ** 2) {
          ctx.beginPath();
          ctx.moveTo(pts[i][0], pts[i][1]);
          ctx.lineTo(pts[j][0], pts[j][1]);
          ctx.stroke();
        }
      }
    }
  });
  const t = toTexture(c);
  t.repeat.set(2.4, 2.4);
  return t;
}

// --- Soft round sprite for particles / marine snow ---
export function makeSoftSprite(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const size = 64;
  const c = canvas(size, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.4, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// --- Soft light-shaft gradient (fades vertically AND horizontally) ---
export function makeShaftTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext('2d');
  // vertical falloff: bright at the top, transparent at the bottom
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, 'rgba(175,225,255,0.5)');
  g.addColorStop(0.45, 'rgba(140,220,255,0.16)');
  g.addColorStop(1, 'rgba(120,200,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 256);
  // horizontal mask so the shaft edges are soft, not hard rectangles
  ctx.globalCompositeOperation = 'destination-in';
  const hg = ctx.createLinearGradient(0, 0, 128, 0);
  hg.addColorStop(0, 'rgba(0,0,0,0)');
  hg.addColorStop(0.5, 'rgba(0,0,0,1)');
  hg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = hg;
  ctx.fillRect(0, 0, 128, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// --- Small elongated krill sprite for billboard-style rendering fallback ---
export function makeFishTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = '#cfe9f2';
  ctx.beginPath();
  ctx.ellipse(32, 32, 20, 9, 0, 0, 6.283);
  ctx.fill();
  ctx.fillStyle = '#2a3f4a';
  ctx.beginPath();
  ctx.arc(44, 32, 2.4, 0, 6.283);
  ctx.fill();
  ctx.fillStyle = '#cfe9f2';
  ctx.beginPath();
  ctx.moveTo(14, 32);
  ctx.lineTo(6, 24);
  ctx.lineTo(6, 40);
  ctx.closePath();
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// --- Tileable fbm value noise (single channel in RGBA8) --------------------
// Used by the volumetric light-shaft pass: sampled in world XZ (projected along
// the sun direction) it gives the slowly drifting pattern of lit / shadowed
// columns that the wavy surface throws into the water.
export function makeTileableNoiseTexture(size = 256, period = 8, octaves = 4, seed = 1) {
  let s = seed * 7919 + 13;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const maxP = period << (octaves - 1);
  const lattice = new Float32Array(maxP * maxP);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const fade = (t) => t * t * (3 - 2 * t);
  const sample = (x, y, p) => {
    // lattice of size p x p (wrapping), reading a sub-grid of the big lattice
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = fade(x - x0), fy = fade(y - y0);
    const L = (ix, iy) => lattice[((iy % p + p) % p) * maxP + ((ix % p + p) % p)];
    const a = L(x0, y0), b = L(x0 + 1, y0), c = L(x0, y0 + 1), d = L(x0 + 1, y0 + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0, amp = 0.5, norm = 0, p = period;
      for (let o = 0; o < octaves; o++) {
        v += amp * sample((x / size) * p, (y / size) * p, p);
        norm += amp;
        amp *= 0.5;
        p *= 2;
      }
      const b = Math.round((v / norm) * 255);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// --- HDR underwater environment (radiance vs. elevation) -------------------
// A half-float cube map of the light field just below the surface: the bright
// Snell's window straight up (sky compressed into a ~48.6 deg cone), the
// dimmer totally-internally-reflecting ring, water-coloured horizon and a dark
// upwelling floor. three pre-filters it with PMREM for image-based lighting,
// which gives soft, physically plausible ambient + reflections (silvery fish,
// the whale's wet sheen). WaterMedium attenuates it with the depth of each
// shaded point, so one environment serves every depth.
export function makeUnderwaterEnvCube({ window: win, horizon, deep, size = 32 } = {}) {
  const cosWin = Math.cos((48.6 * Math.PI) / 180);
  const radiance = (dy, out) => {
    if (dy > cosWin) {
      const k = THREE.MathUtils.smoothstep(dy, cosWin, cosWin + 0.1);
      for (let c = 0; c < 3; c++) out[c] = horizon[c] * 1.8 + (win[c] - horizon[c] * 1.8) * k;
    } else if (dy >= 0) {
      const k = dy / cosWin;
      for (let c = 0; c < 3; c++) out[c] = horizon[c] * (1 + 0.8 * k * k);
    } else {
      const k = Math.sqrt(-dy);
      for (let c = 0; c < 3; c++) out[c] = horizon[c] + (deep[c] - horizon[c]) * k;
    }
  };
  const toHalf = THREE.DataUtils.toHalfFloat;
  const faces = [];
  const rgb = [0, 0, 0];
  for (let f = 0; f < 6; f++) {
    const data = new Uint16Array(size * size * 4);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const u = ((i + 0.5) / size) * 2 - 1;
        const v = ((j + 0.5) / size) * 2 - 1;
        // radially symmetric about +Y, so only the vertical component matters
        let dy;
        if (f === 2) dy = 1 / Math.hypot(1, u, v); // +Y
        else if (f === 3) dy = -1 / Math.hypot(1, u, v); // -Y
        else dy = -v / Math.hypot(1, u, v); // side faces: row 0 is up
        radiance(dy, rgb);
        const o = (j * size + i) * 4;
        data[o] = toHalf(rgb[0]);
        data[o + 1] = toHalf(rgb[1]);
        data[o + 2] = toHalf(rgb[2]);
        data[o + 3] = toHalf(1);
      }
    }
    const face = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
    face.needsUpdate = true;
    faces.push(face);
  }
  const cube = new THREE.CubeTexture(faces);
  cube.type = THREE.HalfFloatType;
  cube.format = THREE.RGBAFormat;
  cube.colorSpace = THREE.LinearSRGBColorSpace;
  cube.minFilter = THREE.LinearFilter;
  cube.magFilter = THREE.LinearFilter;
  cube.generateMipmaps = false;
  cube.needsUpdate = true;
  return cube;
}

// ---- procedural whale skin ------------------------------------------------
// Painted per pixel in the body's UV space: u = meridian arc length nose ->
// tail, v = angle around the body (0 dorsal midline, 0.25 right flank, 0.5
// ventral midline, 0.75 left flank). Produces albedo + a tangent-space normal
// map (throat pleats, sperm-whale wrinkles, scars, blowholes, barnacles).
// Canvases are cached per species; each Whale gets its own textures.

function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// value noise, periodic in y with integer period py (0 = not periodic)
function vnoise(x, y, py, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  let y0 = iy, y1 = iy + 1;
  if (py) { y0 = ((iy % py) + py) % py; y1 = (y0 + 1) % py; }
  const a = hash2(ix, y0, seed), b = hash2(ix + 1, y0, seed);
  const c = hash2(ix, y1, seed), d = hash2(ix + 1, y1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, py, seed, oct = 3) {
  let s = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < oct; o++) {
    s += amp * vnoise(x, y, py, seed + o * 17);
    norm += amp;
    x *= 2; y *= 2; py *= 2; amp *= 0.5;
  }
  return s / norm;
}
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function heightToNormalCanvas(h, W, H, dxm, dym) {
  // dxm: metres per pixel along x; dym[x]: metres per pixel along y at column x
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let x = 0; x < W; x++) {
    const xm = Math.max(0, x - 1), xp = Math.min(W - 1, x + 1);
    const sx = 1 / ((xp - xm) * dxm);
    const sy = 1 / (2 * dym[x]);
    for (let y = 0; y < H; y++) {
      const ym = (y + H - 1) % H, yp = (y + 1) % H;
      const gx = (h[y * W + xp] - h[y * W + xm]) * sx;
      const gy = (h[yp * W + x] - h[ym * W + x]) * sy;
      const l = Math.hypot(gx, gy, 1);
      const i = (y * W + x) * 4;
      d[i] = (0.5 - (0.5 * gx) / l) * 255;
      d[i + 1] = (0.5 - (0.5 * gy) / l) * 255;
      d[i + 2] = (0.5 + 0.5 / l) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const _skinCache = new Map();
function paintWhaleSkin(id, lay) {
  const A = lay.anatomy, sk = A.skin, jaw = A.jaw;
  const W = 2048, H = 1024;
  const Lm = lay.meridian;
  const alb = new Float32Array(W * H * 3);
  const hgt = new Float32Array(W * H);
  const seed = id.length * 97 + id.charCodeAt(0);

  // per-column body coordinates
  const colU = new Float32Array(W), colC = new Float32Array(W), colLip = new Float32Array(W);
  {
    const N = 4096, uT = new Float32Array(N + 1), sT = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) { uT[i] = i / N; sT[i] = lay.sOfU(i / N); }
    let j = 0;
    for (let x = 0; x < W; x++) {
      const s = (x + 0.5) / W;
      while (j < N - 1 && sT[j + 1] < s) j++;
      const t = Math.min(1, Math.max(0, (s - sT[j]) / Math.max(1e-9, sT[j + 1] - sT[j])));
      colU[x] = uT[j] + (uT[j + 1] - uT[j]) * t;
      colC[x] = lay.circAt(colU[x]);
      colLip[x] = lay.lipAt(colU[x]);
    }
  }
  const Cmid = lay.circAt(0.4);
  const P = (m) => Math.max(1, Math.round(Cmid / m)); // noise cells around for feature size m (metres)

  const back = rgb(sk.back), belly = rgb(sk.belly);
  const pl = A.pleats;
  const plSpread = (pl.spread * Math.PI) / 180;
  const plDepth = id === 'blue' ? 0.006 : 0.011;
  const pBig = P(1.4), pMid = P(id === 'blue' ? 0.28 : 0.45), pSm = P(0.12), pWr = P(0.09);
  const hump = id === 'humpback', blue = id === 'blue', sperm = id === 'sperm';
  const lips = sk.lips ? rgb(sk.lips) : null;
  const diatom = rgb(0xa9a37a);

  for (let x = 0; x < W; x++) {
    const u = colU[x];
    const X = ((x + 0.5) / W) * Lm; // metres along
    const xc = X / Cmid; // in "around" units, so noise is isotropic mid-body
    const lip = colLip[x];
    // humpback ventral white: throat and pleats to the navel, little on the tail stock
    const wv = u < 0.03 ? 0.2 + u * 6 : u < 0.46 ? 0.38 : u < 0.6 ? 0.38 - (u - 0.46) * 2 : u < 0.85 ? 0.1 - (u - 0.6) * 0.2 : 0.05;
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      const phi = v * Math.PI * 2;
      const a = phi <= Math.PI ? phi : Math.PI * 2 - phi;
      const an = a / Math.PI;
      const n1 = fbm(xc * pBig, v * pBig, pBig, seed, 3);
      const n2 = fbm(xc * pMid, v * pMid, pMid, seed + 5, 3);
      const n3 = vnoise(xc * pSm, v * pSm, pSm, seed + 9);
      let c;
      let h = 0.0015 * n3;
      if (hump) {
        const edge = 1 - wv;
        let white = sstep(edge - 0.035, edge + 0.035, an + 0.16 * (n1 - 0.5));
        white *= 1 - 0.9 * sstep(0.6, 0.68, n2) * sstep(0.2, 0.5, white); // black marbling in the white
        c = mix3(back, belly, white);
        const m = 0.9 + 0.2 * n3;
        c = [c[0] * m, c[1] * m, c[2] * m];
        if (white < 0.5) c = mix3(c, [70, 76, 80], 0.25 * sstep(0.3, 0.15, n2));
      } else if (blue) {
        c = mix3(back, belly, sstep(0.42, 0.95, an + 0.16 * (n1 - 0.5)));
        // the blue whale's mottling: pale dapples over the whole body
        const spots = sstep(0.55, 0.7, n2 + 0.12 * (n3 - 0.5)) * 0.6;
        c = mix3(c, [Math.min(255, c[0] * 1.35 + 30), Math.min(255, c[1] * 1.3 + 30), Math.min(255, c[2] * 1.25 + 30)], spots);
        const dark = sstep(0.62, 0.72, fbm(xc * pMid * 1.7, v * pMid * 2, pMid * 2, seed + 21, 2));
        c = mix3(c, [c[0] * 0.72, c[1] * 0.75, c[2] * 0.8], dark * 0.7);
        c = mix3(c, diatom, 0.22 * sstep(0.7, 0.9, an) * n1);
        const m = 0.94 + 0.12 * n3;
        c = [c[0] * m, c[1] * m, c[2] * m];
      } else {
        c = mix3(back, belly, sstep(0.62, 1.02, an + 0.14 * (n1 - 0.5)));
        c = mix3(c, [c[0] * 1.25 + 12, c[1] * 1.25 + 12, c[2] * 1.25 + 12], 0.5 * sstep(0.58, 0.7, n2));
        if (u < 0.34) c = mix3(c, [c[0] * 1.15 + 10, c[1] * 1.15 + 10, c[2] * 1.15 + 10], 0.35); // head greyer
        // white mouth: the lower jaw and the upper lip rim
        if (lips && u > jaw.chin - 0.01 && u < jaw.hinge + 0.015) {
          const fade = 1 - sstep(jaw.hinge - 0.01, jaw.hinge + 0.015, u);
          const t = Math.max(sstep(lip - 0.07, lip - 0.01, a) * 0.75, a > lip ? 1 : 0) * fade;
          c = mix3(c, lips, t * (0.8 + 0.2 * n3));
        }
        // prune-like wrinkles behind the head, fainter on it
        const wr = 0.25 + 0.75 * sstep(0.28, 0.38, u) * (1 - sstep(0.9, 0.98, u));
        const w1 = vnoise((xc * pWr) / 3 + 3 * n2, v * pWr, pWr, seed + 31);
        const w2 = vnoise((xc * pWr) / 1.5, v * pWr * 2 + 2 * n1, pWr * 2, seed + 37);
        const r = (1 - Math.abs(2 * w1 - 1)) ** 2 * 0.7 + (1 - Math.abs(2 * w2 - 1)) ** 2 * 0.3;
        h += 0.009 * wr * r;
        const m = (0.82 + 0.25 * r * wr) * (0.95 + 0.1 * n3);
        c = [c[0] * m, c[1] * m, c[2] * m];
      }
      // ventral pleats (throat grooves)
      const q = (Math.PI - a) / plSpread;
      if (q < 1) {
        const uS = (pl.from ?? 0.012) + 0.07 * q * q;
        const uE = pl.to - 0.12 * q ** 1.5;
        const w = sstep(uS, uS + 0.02, u) * (1 - sstep(uE - 0.03, uE, u)) * (1 - sstep(0.85, 1, q));
        if (w > 0) {
          const k = q * (pl.n / 2) + 0.35 * (n2 - 0.5);
          const fr = k - Math.round(k);
          const groove = Math.exp(-((fr / 0.12) ** 2));
          h -= plDepth * groove * w;
          const g = 1 - 0.22 * groove * w;
          c = [c[0] * g, c[1] * g, c[2] * g];
        }
      }
      const i = y * W + x;
      alb[i * 3] = c[0]; alb[i * 3 + 1] = c[1]; alb[i * 3 + 2] = c[2];
      hgt[i] = h;
    }
  }

  // ---- stamps (scars, barnacles, blowholes), sized in metres
  let rs = seed * 7 + 3;
  const rnd = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
  const stamp = (u, phi, rxM, ryM, ang, fn) => {
    const cx = lay.sOfU(u) * W, cy = (phi / (Math.PI * 2)) * H;
    const col = Math.max(0, Math.min(W - 1, Math.round(cx)));
    const rx = (rxM * W) / Lm, ry = (ryM * H) / colC[col];
    const R = Math.ceil(Math.max(rx, ry) + 1);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rcx = Math.round(cx), rcy = Math.round(cy);
    for (let dy = -R; dy <= R; dy++) {
      const yy = (((rcy + dy) % H) + H) % H;
      for (let dx = -R; dx <= R; dx++) {
        const xx = rcx + dx;
        if (xx < 0 || xx >= W) continue;
        const ox = xx - cx, oy = rcy + dy - cy;
        const lx = (ox * ca + oy * sa) / rx, ly = (-ox * sa + oy * ca) / ry;
        const t = lx * lx + ly * ly;
        if (t < 1) fn(yy * W + xx, t);
      }
    }
  };
  const tint = (i, col, f, dh) => {
    alb[i * 3] += (col[0] - alb[i * 3]) * f;
    alb[i * 3 + 1] += (col[1] - alb[i * 3 + 1]) * f;
    alb[i * 3 + 2] += (col[2] - alb[i * 3 + 2]) * f;
    hgt[i] += dh;
  };
  const scarCol = sperm ? [200, 196, 188] : [150, 156, 158];
  for (let n = 0; n < (sk.scars || 0); n++) {
    const u = sperm && n < sk.scars * 0.7 ? 0.01 + 0.3 * rnd() : 0.05 + 0.85 * rnd();
    let phi = (0.15 + 0.7 * rnd()) * Math.PI;
    if (rnd() < 0.5) phi = Math.PI * 2 - phi;
    const len = 0.3 + 1.4 * rnd(), dir = (rnd() - 0.5) * 1.2, curve = (rnd() - 0.5) * 0.6;
    const steps = Math.ceil(len / 0.02);
    const tines = sperm ? 1 : 1 + Math.floor(rnd() * 3); // orca rake marks run in parallel
    for (let tn = 0; tn < tines; tn++) {
      let uu = u, pp = phi + tn * 0.035, dd = dir;
      for (let s = 0; s < steps && uu < 0.99; s++) {
        stamp(uu, pp, 0.01, 0.008, 0, (i, t) => tint(i, scarCol, (sperm ? 0.3 : 0.4) * (1 - t), -0.0015 * (1 - t)));
        uu += (0.02 / lay.L) * Math.cos(dd);
        pp += ((0.02 * Math.sin(dd)) / lay.circAt(uu)) * Math.PI * 2;
        dd += curve / steps;
      }
    }
  }
  if (sperm) {
    // squid sucker scars: small pale rings on the head
    for (let n = 0; n < 70; n++) {
      const u = 0.01 + 0.3 * rnd();
      let phi = (0.1 + 0.8 * rnd()) * Math.PI;
      if (rnd() < 0.5) phi = Math.PI * 2 - phi;
      const r = 0.025 + 0.035 * rnd();
      stamp(u, phi, r, r, 0, (i, t) => {
        const ring = Math.exp(-(((Math.sqrt(t) - 0.8) / 0.15) ** 2));
        tint(i, scarCol, 0.28 * ring, 0);
      });
    }
  }
  for (let n = 0; n < (sk.barnacles || 0) / 7; n++) {
    // acorn barnacles cluster on the chin, the lower-jaw tip and the throat
    const cu = 0.004 + 0.1 * rnd() ** 2;
    const cphi = (0.55 + 0.9 * rnd()) * Math.PI;
    const k = 3 + Math.floor(rnd() * 8);
    for (let j = 0; j < k; j++) {
      const r = 0.015 + 0.025 * rnd();
      stamp(cu + 0.006 * (rnd() - 0.5), cphi + 0.08 * (rnd() - 0.5), r, r, 0, (i, t) => {
        tint(i, [188, 184, 172], 0.9, 0.012 * Math.sqrt(1 - t));
      });
    }
  }
  // blowholes
  const bh = A.blowhole;
  if (bh.paired) {
    const sep = 0.009 * lay.L, len = (blue ? 0.028 : 0.032) * lay.L;
    const circ = lay.circAt(bh.u);
    for (const s of [1, -1]) {
      const phi = (((s * sep) / circ) * Math.PI * 2 + Math.PI * 2) % (Math.PI * 2);
      stamp(bh.u, phi, len / 2, 0.0022 * lay.L, -s * 0.12, (i, t) => tint(i, [22, 24, 26], 0.95 * (1 - t * t), -0.04 * (1 - t)));
      const phi2 = (((s * sep * 1.9) / circ) * Math.PI * 2 + Math.PI * 2) % (Math.PI * 2);
      stamp(bh.u, phi2, len / 2, 0.004 * lay.L, -s * 0.12, (i, t) => { hgt[i] += 0.012 * (1 - t); });
    }
  } else {
    const phi = ((bh.phi * Math.PI) / 180 + Math.PI * 2) % (Math.PI * 2);
    for (let j = -1; j <= 1; j++) {
      stamp(bh.u + j * 0.0028, phi + j * 0.035, 0.0035 * lay.L, 0.0011 * lay.L, 0.5 - j * 0.5,
        (i, t) => tint(i, [20, 18, 16], 0.95 * (1 - t * t), -0.03 * (1 - t)));
    }
  }

  const albC = document.createElement('canvas');
  albC.width = W; albC.height = H;
  const actx = albC.getContext('2d');
  const img = actx.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    img.data[i * 4] = alb[i * 3];
    img.data[i * 4 + 1] = alb[i * 3 + 1];
    img.data[i * 4 + 2] = alb[i * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  actx.putImageData(img, 0, 0);
  const dym = new Float32Array(W);
  for (let x = 0; x < W; x++) dym[x] = colC[x] / H;
  return { albedo: albC, normal: heightToNormalCanvas(hgt, W, H, Lm / W, dym) };
}

export function makeWhaleSkinMaps(id, layout) {
  let e = _skinCache.get(id);
  if (!e) { e = paintWhaleSkin(id, layout); _skinCache.set(id, e); }
  const setup = (t) => {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.flipY = false;
    t.anisotropy = 4;
    return t;
  };
  const map = setup(new THREE.CanvasTexture(e.albedo));
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = setup(new THREE.CanvasTexture(e.normal));
  return { map, normalMap };
}

// Fin albedo: x = span (flipper root -> tip; fluke left tip -> right tip),
// y = around the section (0 upper trailing edge, 0.5 leading edge, 1 lower TE).
const _finCache = new Map();
function paintFin(id, kind, sk) {
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const top = rgb(sk.finTop), under = rgb(sk.finUnder);
  const seed = id.length * 31 + (kind === 'fluke' ? 7 : 3);
  for (let x = 0; x < W; x++) {
    const X = (x + 0.5) / W;
    const s = kind === 'fluke' ? 2 * X - 1 : X;
    const a = Math.abs(s);
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      const upper = v < 0.5;
      const xc = Math.abs(v - 0.5) * 2; // 0 leading edge, 1 trailing edge
      const n1 = fbm(X * 6, v * 6, 0, seed, 3);
      const n2 = fbm(X * 18, v * 10, 0, seed + 3, 3);
      const n3 = vnoise(X * 90, v * 60, 0, seed + 9);
      let col;
      if (id === 'humpback' && kind === 'flipper') {
        if (upper) {
          col = mix3(top, under, 0.85 * sstep(0.22, 0.04, xc + 0.08 * (n1 - 0.5)) * sstep(0.1, 0.3, s));
          col = mix3(col, under, sstep(0.7, 0.95, s + 0.3 * (n1 - 0.5)) * 0.8);
        } else {
          col = mix3(under, top, 0.6 * sstep(0.18, 0.0, s + 0.1 * (n1 - 0.5)));
          col = mix3(col, [120, 126, 128], 0.35 * sstep(0.62, 0.72, n2));
        }
        // barnacles on the leading-edge knobs
        if (xc < 0.12 && n3 > 0.82) col = mix3(col, [190, 186, 174], 0.8);
      } else if (id === 'humpback') {
        if (upper) {
          col = top;
          if (n3 > 0.9 && n2 > 0.5) col = mix3(col, [150, 154, 156], 0.5);
        } else {
          // the "fingerprint": white underside, black trailing-edge rim, dark
          // flares from the notch and asymmetric blotches
          let dark = sstep(0.84, 0.92, xc + 0.05 * (n2 - 0.5));
          dark = Math.max(dark, sstep(0.14, 0.04, a) * sstep(0.3, 0.6, xc));
          dark = Math.max(dark, sstep(0.58, 0.64, n1 + 0.1 * (s > 0 ? 1 : -1) * n2));
          dark = Math.max(dark, 0.6 * sstep(0.12, 0.0, xc));
          dark = Math.max(dark, sstep(0.93, 0.99, a));
          col = mix3(under, top, dark);
          const rake = Math.abs(Math.sin((s * 3 + v * 9) * 7)) < 0.04 && n1 > 0.55 ? 0.6 : 0;
          col = mix3(col, [90, 94, 96], rake);
        }
      } else if (id === 'blue') {
        col = upper ? top : under;
        col = mix3(col, [col[0] * 1.3 + 25, col[1] * 1.3 + 25, col[2] * 1.3 + 25], 0.7 * sstep(0.55, 0.68, n2));
        if (kind === 'flipper' && xc < 0.08) col = mix3(col, [210, 216, 216], 0.6);
      } else {
        col = upper ? top : under;
        col = mix3(col, [col[0] * 1.25, col[1] * 1.25, col[2] * 1.25], 0.4 * sstep(0.55, 0.7, n2));
        if (n3 > 0.93 && n2 > 0.45) col = mix3(col, [190, 186, 178], 0.4);
        if (xc > 0.9 && n1 > 0.55) col = mix3(col, [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8], 1);
      }
      const m = 0.93 + 0.14 * n3;
      const i = (y * W + x) * 4;
      img.data[i] = col[0] * m; img.data[i + 1] = col[1] * m; img.data[i + 2] = col[2] * m; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
export function makeFinMap(id, kind, skin) {
  const key = id + ':' + kind;
  let c = _finCache.get(key);
  if (!c) { c = paintFin(id, kind, skin); _finCache.set(key, c); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.anisotropy = 4;
  return t;
}

// Mouth lining multiplier: baleen plates as fine stripes along the top of the
// cavity, plain lining below (the colour comes from vertex colours).
let _mouthCanvas = null;
export function makeMouthTexture() {
  if (!_mouthCanvas) {
    _mouthCanvas = canvas(128, (ctx, s) => {
      const img = ctx.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        const v = (y + 0.5) / s;
        for (let x = 0; x < s; x++) {
          const stripe = 0.5 + 0.5 * Math.cos((x / s) * Math.PI * 2 * 16 + vnoise(x * 0.3, y * 0.1, 0, 5) * 2);
          const bal = 1 - sstep(0.3, 0.42, v);
          const g = (1 - bal) * (0.85 + 0.15 * vnoise(x * 0.2, y * 0.2, 0, 9)) + bal * (0.45 + 0.55 * stripe);
          const i = (y * s + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = g * 255;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    });
  }
  const t = new THREE.CanvasTexture(_mouthCanvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  return t;
}
