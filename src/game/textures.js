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
    ctx.fillStyle = '#4a3f30';
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
