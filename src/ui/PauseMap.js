// Pause-screen map of Monterey Bay in the ink-on-glass style (design doc §6.5).
//
// Base layer (built once per zoom level, cached): the baked relief map
// (assets/bathymetry/map_bay.png / map_region.png) turned into ink — a
// desaturated, high-passed relief so ridges and canyon walls read without a
// coloured panel — plus bathymetric contour hairlines traced from the same
// grids the terrain streams (every 100 m, bolder every 500 m; coarser on the
// region map). Land is a flat faint ink fill with a coastline hairline.
// Overlay (every open): the current region outline, named regions/POIs from
// regions.json, and the player as a bio-cyan arrow with its heading.
//
// Coordinates: the manifest's `maps` block gives each image's extent in
// absolute bay metres (x east, z south). The scene uses a floating origin, so
// absolute = scene position + terrain.origin.

const DATA_URL = new URL('../../assets/bathymetry/', import.meta.url);
const RES = 1024; // base canvas resolution (device px)
const INK = [234, 246, 248];

const LEVELS = {
  bay: { step: 100, bold: 500, max: 3200, scaleKm: 10, grid: 'bay' },
  region: { step: 500, bold: 1000, max: 4000, scaleKm: 50, grid: 'region' },
};

export class PauseMap {
  constructor(root) {
    this.root = root;
    this.level = 'bay';
    this._bases = {};
    this._building = null;
    this.base = root.querySelector('.map-base');
    this.overlay = root.querySelector('.map-overlay');
    this.labels = root.querySelector('.map-labels');
    this.marker = root.querySelector('.map-you');
    this.scale = root.querySelector('.map-scale');
    this.scaleLabel = root.querySelector('.map-scale-label');
    root.querySelectorAll('[data-map-level]').forEach((b) =>
      b.addEventListener('click', () => this.setLevel(b.dataset.mapLevel)),
    );
  }

  setLevel(level) {
    if (!LEVELS[level] || level === this.level) return;
    this.level = level;
    if (this._game) this.show(this._game);
  }

  // Draw the map for the current game state. Safe to call before terrain loads.
  async show(game) {
    this._game = game;
    const t = game && game.terrain;
    const ready = t && t.loaded && t.manifest && t.manifest.maps;
    this.root.classList.toggle('empty', !ready);
    if (!ready) return;
    this.root.querySelectorAll('[data-map-level]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mapLevel === this.level)),
    );
    const map = t.manifest.maps[this.level];
    const base = await this._baseFor(this.level, t);
    if (!base) return;
    const ctx = this.base.getContext('2d');
    this.base.width = this.base.height = RES;
    ctx.drawImage(base, 0, 0);
    this._drawOverlay(game, map);
  }

  // ---- base layer ------------------------------------------------------------
  _baseFor(level, terrain) {
    if (this._bases[level]) return Promise.resolve(this._bases[level]);
    return new Promise((resolve) => {
      const map = terrain.manifest.maps[level];
      const img = new Image();
      img.onload = () => {
        try {
          this._bases[level] = this._buildBase(img, terrain[LEVELS[level].grid], LEVELS[level]);
        } catch (e) {
          console.warn('[PauseMap] base failed', e);
          this._bases[level] = null;
        }
        resolve(this._bases[level]);
      };
      img.onerror = () => resolve(null);
      img.src = new URL(map.image, DATA_URL).href;
    });
  }

  _buildBase(img, grid, cfg) {
    const W = RES;
    const c = document.createElement('canvas');
    c.width = c.height = W;
    const ctx = c.getContext('2d', { willReadFrequently: true });

    // relief: luminance of the baked shaded map, high-passed against a blur
    ctx.drawImage(img, 0, 0, W, W);
    const src = ctx.getImageData(0, 0, W, W).data;
    ctx.filter = 'blur(10px)';
    ctx.drawImage(img, 0, 0, W, W);
    ctx.filter = 'none';
    const blur = ctx.getImageData(0, 0, W, W).data;
    const out = ctx.createImageData(W, W);
    const o = out.data;
    const n = grid ? grid.n : 0;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4;
        const lum = 0.3 * src[k] + 0.59 * src[k + 1] + 0.11 * src[k + 2];
        const lb = 0.3 * blur[k] + 0.59 * blur[k + 1] + 0.11 * blur[k + 2];
        let land;
        if (grid) {
          const i = Math.round((x / (W - 1)) * (n - 1)), j = Math.round((y / (W - 1)) * (n - 1));
          land = grid.at(i, j) > 0;
        } else land = src[k] > src[k + 2] + 8;
        o[k] = INK[0]; o[k + 1] = INK[1]; o[k + 2] = INK[2];
        if (land) {
          o[k + 3] = 0.08 * 255;
        } else {
          // lit slopes become ink; flats stay glass. Deep water gets a whisper
          // of depth so the canyon reads even where it is smooth.
          // only the lit side of relief becomes ink, so flat water stays clear
          const lit = Math.min(1, Math.max(0, (lum - lb) / 28));
          const shallow = lum / 255;
          o[k + 3] = 255 * Math.min(0.4, 0.34 * lit ** 1.3 + 0.05 * shallow * shallow);
        }
      }
    }
    ctx.putImageData(out, 0, 0);

    // contours (marching squares on the terrain grid, same extent as the image)
    if (grid) {
      const s = W / (n - 1);
      const levels = [];
      for (let d = cfg.step; d <= cfg.max; d += cfg.step) levels.push(d);
      ctx.lineCap = 'round';
      for (const d of levels) {
        const bold = d % cfg.bold === 0;
        ctx.beginPath();
        this._contour(ctx, grid, -d, s);
        ctx.strokeStyle = `rgba(${INK}, ${bold ? 0.5 : 0.18})`;
        ctx.lineWidth = bold ? 1.4 : 0.9;
        ctx.stroke();
      }
      // coastline
      ctx.beginPath();
      this._contour(ctx, grid, 0, s);
      ctx.strokeStyle = `rgba(${INK}, 0.7)`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    return c;
  }

  // Adds the iso-line h = level of the grid to the current path.
  _contour(ctx, grid, level, s) {
    const n = grid.n, data = grid.data, sc = grid.scale;
    const L = level / sc; // compare in raw int16 units
    for (let j = 0; j < n - 1; j++) {
      const r0 = j * n, r1 = r0 + n;
      for (let i = 0; i < n - 1; i++) {
        const a = data[r0 + i], b = data[r0 + i + 1], c = data[r1 + i + 1], d = data[r1 + i];
        const idx = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        // edge points: top (a-b), right (b-c), bottom (d-c), left (a-d)
        const top = () => [(i + (L - a) / (b - a)) * s, j * s];
        const right = () => [(i + 1) * s, (j + (L - b) / (c - b)) * s];
        const bottom = () => [(i + (L - d) / (c - d)) * s, (j + 1) * s];
        const left = () => [i * s, (j + (L - a) / (d - a)) * s];
        const seg = (p, q) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
        switch (idx) {
          case 1: case 14: seg(left(), bottom()); break;
          case 2: case 13: seg(bottom(), right()); break;
          case 3: case 12: seg(left(), right()); break;
          case 4: case 11: seg(top(), right()); break;
          case 6: case 9: seg(top(), bottom()); break;
          case 7: case 8: seg(left(), top()); break;
          case 5: seg(left(), top()); seg(bottom(), right()); break;
          case 10: seg(top(), right()); seg(left(), bottom()); break;
        }
      }
    }
  }

  // ---- overlay: region, labels, you ----------------------------------------------
  _drawOverlay(game, map) {
    const t = game.terrain;
    const toPx = (x, z) => [((x - map.xMin) / map.size) * RES, ((z - map.zMin) / map.size) * RES];
    const inside = (p) => p[0] > RES * 0.03 && p[0] < RES * 0.97 && p[1] > RES * 0.03 && p[1] < RES * 0.97;

    // current region outline
    const cv = this.overlay;
    cv.width = cv.height = RES;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, RES, RES);
    const hereId = game.region && game.region.id;
    const here = hereId && t.regions ? t.regions.find((r) => r.id === hereId) : null;
    if (here) {
      ctx.strokeStyle = 'rgba(143, 245, 228, 0.55)';
      ctx.fillStyle = 'rgba(143, 245, 228, 0.06)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      if (here.type === 'circle') {
        const [px, py] = toPx(here.cx, here.cz);
        ctx.arc(px, py, (here.r / map.size) * RES, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (here.type === 'polygon') {
        here.pts.forEach((p, k) => { const q = toPx(p[0], p[1]); k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (here.type === 'corridor') {
        ctx.setLineDash([]);
        ctx.lineJoin = ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(3, ((here.hw * 2) / map.size) * RES);
        ctx.strokeStyle = 'rgba(143, 245, 228, 0.1)';
        here.pts.forEach((p, k) => { const q = toPx(p[0], p[1]); k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
        ctx.stroke();
      }
    }

    // labels: named regions and POIs (not the catch-alls)
    this.labels.textContent = '';
    const big = this.level === 'region';
    for (const r of t.regions || []) {
      if (r.type === 'all') continue;
      // the region map is 3.7x wider: keep only the big features
      if (big && r.id !== hereId && !(r.type === 'circle' && r.r >= 5000) && r.kind !== 'slope' && r.id !== 'monterey-canyon') continue;
      let p;
      if (r.type === 'circle') p = [r.cx, r.cz];
      else if (r.type === 'corridor') p = r.pts[Math.floor(r.pts.length * 0.55)];
      else if (r.type === 'polygon') p = centroid(r.pts);
      if (!p) continue;
      const q = toPx(p[0], p[1]);
      if (!inside(q)) continue;
      const el = document.createElement('span');
      el.className = `map-label ${r.kind}${r.id === hereId ? ' here' : ''}`;
      el.style.left = `${(q[0] / RES) * 100}%`;
      el.style.top = `${(q[1] / RES) * 100}%`;
      // anchor labels near the edges inward so they never leave the map
      const fx = q[0] / RES;
      if (fx > 0.72) el.classList.add('end');
      else if (fx < 0.28) el.classList.add('start');
      el.textContent = r.name;
      this.labels.appendChild(el);
    }

    // you: position (absolute = scene + origin) and heading
    const c = game.controller;
    if (c) {
      const X = c.position.x + t.origin.x, Z = c.position.z + t.origin.y;
      const q = toPx(X, Z);
      const on = q[0] >= 0 && q[0] <= RES && q[1] >= 0 && q[1] <= RES;
      this.marker.hidden = !on;
      if (on) {
        this.marker.style.left = `${(q[0] / RES) * 100}%`;
        this.marker.style.top = `${(q[1] / RES) * 100}%`;
        // forward is (-sin yaw, -cos yaw) in x/z; north (-z) is up on the map
        this.marker.style.transform = `translate(-50%, -50%) rotate(${-c.yaw}rad)`;
      }
    }

    // scale bar
    const km = LEVELS[this.level].scaleKm;
    this.scale.style.width = `${((km * 1000) / map.size) * 100}%`;
    this.scaleLabel.textContent = `${km} km`;
  }
}

function centroid(pts) {
  let x = 0, z = 0;
  for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / pts.length, z / pts.length];
}
