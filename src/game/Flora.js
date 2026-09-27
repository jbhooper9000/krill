import * as THREE from 'three';

// Streamed seafloor dressing on top of Terrain: scattered boulders / reef rock
// and giant-kelp (Macrocystis pyrifera) forests.
//
// Both layers are deterministic per world cell (same rocks every visit), are
// generated around the camera as it moves, and live in one InstancedMesh per
// layer inside terrain.group, so the floating origin moves them for free.
// Instance matrices are stored relative to an anchor near the camera (reset
// on every rebuild) to keep float32 precision high far from the bay centre.
//
// Placement uses Terrain: heightAtAbs (so rocks sit on the rendered floor),
// macro slope, reefAt (rocky patches) and the kelp zones from regions.json
// (kelp only grows on rock in ~3-30 m of water: Cannery Row, Point Pinos,
// Point Lobos, Carmel Bay, the Santa Cruz points).

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpC = new THREE.Color();

// small deterministic PRNG per cell
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const cellSeed = (i, j, salt) => (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;

// Poisson sample count with mean m (small m; Knuth)
function poisson(m, r) {
  if (m <= 0) return 0;
  if (m > 30) return Math.round(m + Math.sqrt(m) * (r() + r() + r() - 1.5) * 1.4);
  const L = Math.exp(-m);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}

// ---- geometry ------------------------------------------------------------------
function makeRockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  // lumpy, flat-bottomed boulder
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + 0.22 * Math.sin(x * 3.1 + z * 1.7) + 0.15 * Math.sin(y * 4.3 - x * 2.2) + 0.1 * Math.cos(z * 5.1 + y);
    p.setXYZ(i, x * n, (y < -0.2 ? -0.2 + (y + 0.2) * 0.3 : y) * n, z * n);
  }
  g.computeVertexNormals();
  return g;
}

// One kelp plant, unit height (y 0..1; instance y-scale = plant height in m,
// x/z scale 1 so blade lengths stay in metres; vertical blade extents are
// authored for a ~15 m plant). Two stipes, each with tapered blades on small
// floats angled up the stipe, and a canopy of long sagging blades streaming
// out just under the surface.
function makeKelpGeometry() {
  const pos = [], nor = [], idx = [];
  const H = 15; // reference height for vertical sizes (m)
  const tri = (a, b, c, n) => {
    const base = pos.length / 3;
    for (const v of [a, b, c]) { pos.push(...v); nor.push(...n); }
    idx.push(base, base + 1, base + 2);
  };
  const quad = (a, b, c, d, n) => { tri(a, b, c, n); tri(a, c, d, n); };
  const r = rng(12345);
  const stipes = [[0, 0, 0], [0.35, 0.2, 1.7]];
  for (const [sx, sz, ph] of stipes) {
    const bend = (y) => Math.sin(y * 3 + ph) * 0.3;
    const segs = 8, w = 0.02;
    for (let s = 0; s < segs; s++) {
      const y0 = s / segs, y1 = (s + 1) / segs;
      const c0 = bend(y0), c1 = bend(y1);
      quad([sx + c0 - w, y0, sz], [sx + c0 + w, y0, sz], [sx + c1 + w, y1, sz], [sx + c1 - w, y1, sz], [0, 0, 1]);
    }
    // blades: tapered, 0.35-0.8 m, rising at ~30-45 deg from their float
    const blades = 22;
    for (let b = 0; b < blades; b++) {
      const y = 0.05 + (b / blades) * 0.86 + r() * 0.02;
      const a = b * 2.4 + r() * 0.8 + ph;
      const len = 0.35 + r() * 0.45;
      const up = (0.5 + r() * 0.4) * len / H;
      const dx = Math.cos(a), dz = Math.sin(a);
      const hw = 0.05 / H; // half base width, as unit y
      const x0 = sx + bend(y), z0 = sz;
      const tip = [x0 + dx * len, y + up, z0 + dz * len];
      const mid = [x0 + dx * len * 0.45, y + up * 0.5, z0 + dz * len * 0.45];
      const n = [-dz, 0.3, dx];
      tri([x0, y - hw, z0], [mid[0], mid[1] - hw * 1.2, mid[2]], tip, n);
      tri([x0, y - hw, z0], tip, [x0, y + hw, z0], n);
    }
    // canopy: long blades in two sagging segments, streaming with the current
    for (let b = 0; b < 8; b++) {
      const a = ph + b * 0.55 + r() * 0.4 - 1.2; // mostly downstream
      const len = 1.0 + r() * 1.3;
      const dx = Math.cos(a), dz = Math.sin(a);
      const y = 0.955 + r() * 0.035;
      const sag = -(0.15 + r() * 0.2) / H;
      const px = -dz * 0.07, pz = dx * 0.07;
      const x0 = sx + bend(1), z0 = sz;
      const m = [x0 + dx * len * 0.5, y + sag, z0 + dz * len * 0.5];
      const t = [x0 + dx * len, y + sag * 0.4, z0 + dz * len];
      quad([x0 - px, y, z0 - pz], [m[0] - px, m[1], m[2] - pz], [m[0] + px, m[1], m[2] + pz], [x0 + px, y, z0 + pz], [0, 1, 0]);
      tri([m[0] - px, m[1], m[2] - pz], t, [m[0] + px, m[1], m[2] + pz], [0, 1, 0]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---- a streamed instanced layer ----------------------------------------------------
class ScatterLayer {
  constructor(parent, { geometry, material, cellSize, radius, capacity, generate }) {
    this.cellSize = cellSize;
    this.radius = radius;
    this.capacity = capacity;
    this.generate = generate; // (i, j) => array of instances or null (not ready yet)
    this.cells = new Map();
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    parent.add(this.mesh);
    this._key = '';
    this._dirty = false;
    this.anchor = new THREE.Vector2();
  }

  update(X, Z, budget) {
    const cs = this.cellSize;
    const ci = Math.floor(X / cs), cj = Math.floor(Z / cs);
    const R = Math.ceil(this.radius / cs);
    // generate missing cells nearest first (a few per frame)
    const want = [];
    for (let j = cj - R; j <= cj + R; j++) for (let i = ci - R; i <= ci + R; i++) {
      const dx = (i + 0.5) * cs - X, dz = (j + 0.5) * cs - Z;
      const d = Math.hypot(dx, dz);
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
    // drop far cells
    for (const [k, c] of this.cells) {
      if (Math.hypot((c.i + 0.5) * cs - X, (c.j + 0.5) * cs - Z) > this.radius * 1.4 + cs) {
        this.cells.delete(k);
        this._dirty = true;
      }
    }
    // rebuild the instance buffer when the set changed or we moved a cell
    const key = ci + ',' + cj;
    if (this._dirty || key !== this._key) {
      this._key = key;
      this._dirty = false;
      this._rebuild(X, Z);
    }
  }

  _rebuild(X, Z) {
    const cs = this.cellSize;
    this.anchor.set(Math.floor(X / cs) * cs, Math.floor(Z / cs) * cs);
    this.mesh.position.set(this.anchor.x, 0, this.anchor.y);
    const r2 = (this.radius + cs) * (this.radius + cs);
    let n = 0;
    for (const c of this.cells.values()) {
      for (const it of c.inst) {
        if (n >= this.capacity) break;
        const dx = it.x - X, dz = it.z - Z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2 || (it.far && d2 > it.far * it.far)) continue;
        tmpP.set(it.x - this.anchor.x, it.y, it.z - this.anchor.y);
        tmpE.set(it.rx, it.ry, it.rz);
        tmpQ.setFromEuler(tmpE);
        tmpS.set(it.sx, it.sy, it.sz);
        tmpM.compose(tmpP, tmpQ, tmpS);
        this.mesh.setMatrixAt(n, tmpM);
        if (this.mesh.instanceColor || it.color !== undefined) {
          this.mesh.setColorAt(n, tmpC.setHex(it.color ?? 0xffffff));
        }
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.cells.clear();
    this._dirty = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class Flora {
  constructor(terrain, options = {}) {
    this.terrain = terrain;
    this.options = Object.assign({
      rockRadius: 170, // m
      kelpRadius: 75, // m (green Monterey water: ~15-30 m visibility)
      cellsPerFrame: 8,
      patchMaterial: null,
    }, options);
    this.group = new THREE.Group();
    this.group.name = 'flora';
    terrain.group.add(this.group);
    this.time = 0;
    this._t0 = performance.now();

    // boulders: flat-shaded, per-instance tint
    const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, flatShading: true });
    if (this.options.patchMaterial) this.options.patchMaterial(rockMat); // underwater light model hook
    this.rocks = new ScatterLayer(this.group, {
      geometry: makeRockGeometry(),
      material: rockMat,
      cellSize: 48,
      radius: this.options.rockRadius,
      capacity: 4000,
      generate: (i, j) => this._genRocks(i, j),
    });

    // kelp: golden-brown, double-sided, swaying in the surge
    const kelpMat = new THREE.MeshStandardMaterial({
      color: 0x8a6a2c, roughness: 0.65, metalness: 0, side: THREE.DoubleSide,
      // kelp is translucent: seen against the light it glows golden, never black
      emissive: 0x6a4c16, emissiveIntensity: 0.55,
    });
    this._kelpUniforms = { uTime: { value: 0 }, uAnchor: { value: new THREE.Vector2() } };
    kelpMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this._kelpUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec2 uAnchor;')
        .replace('#include <project_vertex>', /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
{
	// surge: a slow swell-driven sway, coherent across the forest, travelling
	// shoreward; amplitude grows up the stipe (tethered at the holdfast)
	vec2 wp = mvPosition.xz + uAnchor;
	float hy = position.y;
	float ph = uTime * 0.55 - dot(wp, vec2(0.045, 0.03));
	float a = hy * hy * (1.4 + 0.4 * sin(dot(wp, vec2(0.7, 1.3))));
	mvPosition.x += (sin(ph) + 0.35 * sin(ph * 2.3 + 1.7)) * a;
	mvPosition.z += (0.6 * cos(ph * 0.8 + 1.3)) * a;
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
    };
    kelpMat.customProgramCacheKey = () => 'krill-kelp-v1';
    if (this.options.patchMaterial) this.options.patchMaterial(kelpMat);
    this.kelp = new ScatterLayer(this.group, {
      geometry: makeKelpGeometry(),
      material: kelpMat,
      cellSize: 32,
      radius: this.options.kelpRadius,
      capacity: 2500,
      generate: (i, j) => this._genKelp(i, j),
    });
    this.stats = { rocks: 0, kelp: 0, triangles: 0 };
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
    if (depth < 0.5) return out;
    const slope = Math.hypot(m.dx, m.dz);
    const wall = Math.min(1, Math.max(0, (slope - 0.2) / 0.35));
    const reef = t.reefAt(cx, cz, depth);
    const r = rng(cellSeed(i, j, 7));
    // sparse boulders and cobbles on open sediment are the scale cue; dense on reefs/walls
    const mean = 6 + 9 * wall + 16 * reef;
    const n = poisson(mean, r);
    for (let k = 0; k < n; k++) {
      const x = X0 + r() * cs, z = Z0 + r() * cs;
      const localReef = t.reefAt(x, z, depth);
      const big = reef > 0.2 || wall > 0.3;
      // log-uniform size: cobbles 0.25 m .. boulders 2.5 m (4 m on reefs/walls)
      const size = Math.exp(Math.log(0.25) + r() * Math.log((big ? 4 : 2.2) / 0.25)) * (0.6 + 0.6 * Math.max(localReef, wall));
      const h = t.heightAtAbs(x, z);
      const flat = 0.45 + r() * 0.35;
      const shallow = depth < 40;
      // tint: grey-brown granite / mudstone; coralline pink and sponge orange on shallow reef rock
      let col;
      const c = r();
      if (shallow && localReef > 0.3 && c < 0.35) col = c < 0.2 ? 0xb07a7e : 0xb58a55;
      else col = [0x7a746a, 0x6b675f, 0x837a6a, 0x5f5d58][Math.floor(r() * 4)];
      out.push({
        x, z, y: h - size * flat * 0.35,
        rx: (r() - 0.5) * 0.5, ry: r() * Math.PI * 2, rz: (r() - 0.5) * 0.5,
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
    // a dense forest is ~1 plant per 25-40 m2 of rocky bottom
    const n = poisson(zw * 22, r);
    for (let k = 0; k < n; k++) {
      const x = X0 + r() * cs, z = Z0 + r() * cs;
      const h = t.heightAtAbs(x, z);
      const depth = -h;
      if (depth < 3 || depth > 30) continue; // Macrocystis: ~3-30 m
      // holdfasts need rock: reef patches, with a little tolerance at the edges
      const reef = t.reefAt(x, z, depth);
      if (reef < 0.15 && r() > 0.25) continue;
      // canopy lies just under the surface; plants in deeper water trail more
      const height = Math.max(2, depth - 0.3 - r() * 0.8);
      out.push({ x, z, y: h - 0.2, rx: 0, ry: r() * Math.PI * 2, rz: 0, sx: 1, sy: height, sz: 1 });
    }
    return out;
  }

  // X, Z: camera in absolute bay metres
  update(X, Z, cameraY) {
    this.time = (performance.now() - this._t0) / 1000;
    const b = this.options.cellsPerFrame;
    this.rocks.update(X, Z, b);
    // kelp only matters within reach of shallow water
    if (cameraY > -80) this.kelp.update(X, Z, b);
    this._kelpUniforms.uTime.value = this.time;
    this._kelpUniforms.uAnchor.value.copy(this.kelp.anchor);
    const rt = this.rocks.mesh.geometry.index ? this.rocks.mesh.geometry.index.count / 3 : this.rocks.mesh.geometry.attributes.position.count / 3;
    const kt = this.kelp.mesh.geometry.index.count / 3;
    this.stats.rocks = this.rocks.mesh.count;
    this.stats.kelp = this.kelp.mesh.count;
    this.stats.triangles = this.rocks.mesh.count * rt + this.kelp.mesh.count * kt;
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
