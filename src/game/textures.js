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

// --- Spray / mist puff atlas (2x2 cells, white on transparent) ---
// Each cell is a different irregular puff: a cluster of soft blobs with a
// ragged, noisy edge (no round "cotton balls"), for splash mist, blow vapour
// and underwater bubble clouds. Sample cell k at (uv * 0.5 + offset).
export function makeMistAtlas(seed = 11) {
  const size = 256;
  const half = size / 2;
  let r = seed;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const c = canvas(size, (ctx) => {
    ctx.clearRect(0, 0, size, size);
    for (let cell = 0; cell < 4; cell++) {
      const ox = (cell % 2) * half, oy = Math.floor(cell / 2) * half;
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, half, half);
      ctx.clip();
      const blobs = 26 + cell * 6;
      for (let i = 0; i < blobs; i++) {
        const a = rand() * Math.PI * 2;
        const d = Math.pow(rand(), 0.8) * half * 0.26;
        const x = ox + half / 2 + Math.cos(a) * d * (1 + 0.3 * cell / 3);
        const y = oy + half / 2 + Math.sin(a) * d * 0.85;
        const rad = half * (0.06 + rand() * 0.16) * (1 - (0.6 * d) / (half * 0.3));
        const al = 0.05 + rand() * 0.12;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        g.addColorStop(0, `rgba(255,255,255,${al})`);
        g.addColorStop(0.6, `rgba(255,255,255,${al * 0.45})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      // fine droplet speckle for texture
      for (let i = 0; i < 160; i++) {
        const a = rand() * Math.PI * 2;
        const d = Math.pow(rand(), 0.6) * half * 0.36;
        ctx.fillStyle = `rgba(255,255,255,${0.05 + rand() * 0.12})`;
        ctx.fillRect(ox + half / 2 + Math.cos(a) * d, oy + half / 2 + Math.sin(a) * d, 1 + rand() * 1.5, 1 + rand() * 1.5);
      }
      ctx.restore();
    }
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; // used as coverage, not colour
  return t;
}
