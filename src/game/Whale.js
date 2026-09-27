import * as THREE from 'three';
import { makeWhaleSkinMaps, makeFinMap, makeMouthTexture } from './textures.js';
import { SPECIES } from './species.js';

// Procedural whale. The body is one closed, lofted mesh: rings of a
// superellipse cross-section (per-species stations along the spine, with
// dorsal/ventral crests), split at the lip line so the lower jaw can drop and
// a mouth cavity (baleen racks / white sperm-whale lining) opens between the
// lips. A travelling wave bends the spine; the fluke, flippers, dorsal fin,
// eyes, tubercles and teeth ride the spine as small separate meshes, the fins
// built as closed, cambered hydrofoils. Anatomy numbers live in species.js.
//
// Model space: nose along +X, up +Y, whale's right +Z. The group rotates the
// model so the nose faces -Z (three.js forward) for the controller.

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Monotone cubic (Fritsch-Carlson) interpolant through rows [x, ...], column c:
// no overshoot, so profiles stay where the stations put them.
function pchip(rows, c = 1) {
  const n = rows.length;
  const xs = rows.map((r) => r[0]);
  const ys = rows.map((r) => r[c]);
  const h = [], d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (xs[i + 1] < x) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// Area-weighted vertex normals over an index buffer. No allocation; callers
// weld seams / degenerate rings afterwards.
function accumulateNormals(pos, index, nrm) {
  nrm.fill(0);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
    nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
    nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
  }
}
function sumInto(nrm, a, b) {
  a *= 3; b *= 3;
  const x = nrm[a] + nrm[b], y = nrm[a + 1] + nrm[b + 1], z = nrm[a + 2] + nrm[b + 2];
  nrm[a] = nrm[b] = x; nrm[a + 1] = nrm[b + 1] = y; nrm[a + 2] = nrm[b + 2] = z;
}
function normalizeAll(nrm, fx = 1, fy = 0, fz = 0) {
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]);
    if (l > 1e-12) { nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; }
    else { nrm[i] = fx; nrm[i + 1] = fy; nrm[i + 2] = fz; }
  }
}
function signedVolume(pos, index) {
  let v = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v / 6;
}
function flipWinding(index) {
  for (let t = 0; t < index.length; t += 3) {
    const tmp = index[t + 1];
    index[t + 1] = index[t + 2];
    index[t + 2] = tmp;
  }
}

// ---- hydrofoils ------------------------------------------------------------
// A closed, lofted wing: span along +Z, chord toward -X from the leading edge,
// thickness along Y. Each station is a NACA-00xx section (round leading edge,
// thin sharp trailing edge) with parabolic camber. plan(s, o) fills o with
// { x, y, z } (leading edge), c (chord), t (thickness ratio), m (camber ratio).
const FOIL_M = 14; // chordwise samples per surface
const _xc = Array.from({ length: FOIL_M }, (_, k) => (1 - Math.cos((Math.PI * k) / (FOIL_M - 1))) / 2);
function naca(xc) {
  return 5 * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc * xc + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
}
function buildFoil(stations, plan, { capRoot = false, uOf = (s) => s } = {}) {
  const nS = stations.length;
  const R = 2 * FOIL_M - 1; // TE(upper) -> LE -> TE(lower); first/last share a position
  const nV = nS * R + (capRoot ? 1 : 0);
  const pos = new Float32Array(nV * 3);
  const uv = new Float32Array(nV * 2);
  const o = { x: 0, y: 0, z: 0, c: 0, t: 0, m: 0 };
  for (let i = 0; i < nS; i++) {
    const s = stations[i];
    plan(s, o);
    for (let r = 0; r < R; r++) {
      const upper = r < FOIL_M;
      const xc = _xc[upper ? FOIL_M - 1 - r : r - FOIL_M + 1];
      const yt = naca(xc) * o.t * 0.5;
      const yc = o.m * 4 * xc * (1 - xc);
      const vi = i * R + r;
      pos[vi * 3] = o.x - xc * o.c;
      pos[vi * 3 + 1] = o.y + (yc + (upper ? yt : -yt)) * o.c;
      pos[vi * 3 + 2] = o.z;
      uv[vi * 2] = uOf(s);
      uv[vi * 2 + 1] = upper ? 0.5 * (1 - xc) : 0.5 * (1 + xc);
    }
  }
  const index = [];
  for (let i = 0; i < nS - 1; i++) {
    for (let r = 0; r < R - 1; r++) {
      const a = i * R + r, b = a + 1, c = a + R + 1, d = a + R;
      index.push(a, b, c, a, c, d);
    }
  }
  if (capRoot) {
    const ci = nS * R;
    let cx = 0, cy = 0, cz = 0;
    for (let r = 0; r < R; r++) { cx += pos[r * 3]; cy += pos[r * 3 + 1]; cz += pos[r * 3 + 2]; }
    pos[ci * 3] = cx / R; pos[ci * 3 + 1] = cy / R; pos[ci * 3 + 2] = cz / R;
    uv[ci * 2] = uOf(stations[0]); uv[ci * 2 + 1] = 0.5;
    for (let r = 0; r < R - 1; r++) index.push(ci, r + 1, r);
  }
  const idx = new Uint32Array(index);
  if (signedVolume(pos, idx) < 0) flipWinding(idx);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nV * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const foil = { geo, nS, R, base: new Float32Array(pos) };
  foilNormals(foil);
  return foil;
}
function foilNormals(foil) {
  const { geo, nS, R } = foil;
  const nrm = geo.attributes.normal.array;
  accumulateNormals(geo.attributes.position.array, geo.index.array, nrm);
  for (let i = 0; i < nS; i++) sumInto(nrm, i * R, i * R + R - 1); // trailing-edge seam
  normalizeAll(nrm, 0, 1, 0);
  geo.attributes.normal.needsUpdate = true;
}

// stations over [a, b], denser toward both ends
function stationsBetween(a, b, n, ends = 0.6) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(a + (b - a) * (t - (ends * Math.sin(TAU * t)) / TAU));
  }
  return out;
}

// Pectoral fin planforms (span s: 0 root -> 1 tip), in units of fin length.
const FLIPPERS = {
  // long, narrow, curved back, ~10 leading-edge tubercles, rounded tip
  humpback: {
    chord: pchip([[0, 0.19], [0.08, 0.205], [0.3, 0.215], [0.5, 0.19], [0.7, 0.15], [0.85, 0.105], [0.95, 0.06], [0.99, 0.025], [1, 0.0]]),
    le: (s) => -0.1 * s * s,
    droop: (s) => -0.035 * s * s,
    thick: (s) => 0.25 - 0.08 * s,
    bumps: { n: 10, from: 0.28, to: 0.97, amp: 0.02 },
  },
  // slender and pointed
  blue: {
    chord: pchip([[0, 0.25], [0.15, 0.27], [0.5, 0.2], [0.8, 0.12], [0.94, 0.06], [0.99, 0.022], [1, 0]]),
    le: (s) => -0.16 * Math.max(0, s) ** 1.6,
    droop: (s) => -0.02 * s * s,
    thick: (s) => 0.21 - 0.05 * s,
  },
  // short, broad, spoon-shaped paddle
  sperm: {
    chord: pchip([[0, 0.36], [0.2, 0.42], [0.5, 0.44], [0.75, 0.38], [0.9, 0.27], [0.97, 0.15], [0.995, 0.06], [1, 0]]),
    le: (s) => -0.06 * s * s,
    droop: (s) => -0.03 * s * s,
    thick: (s) => 0.24 - 0.06 * s,
  },
};

// Fluke planforms (a = |spanwise|, 0 notch -> 1 tip), units of half-span.
const FLUKES = {
  // swept leading edge, S-curved serrated trailing edge, median notch, pointed tips
  humpback: {
    le: (a) => 0.16 - 0.72 * a ** 1.5,
    te: pchip([[0, -0.26], [0.05, -0.36], [0.18, -0.45], [0.45, -0.47], [0.7, -0.49], [0.9, -0.53], [1, -0.56]]),
    thick: (a) => 0.13 + 0.11 * Math.exp(-((a / 0.12) ** 2)),
    serrate: { n: 13, from: 0.1, to: 0.93, amp: 0.02 },
  },
  blue: {
    le: (a) => 0.14 - 0.62 * a ** 1.4,
    te: pchip([[0, -0.2], [0.05, -0.29], [0.25, -0.36], [0.6, -0.42], [0.85, -0.46], [1, -0.48]]),
    thick: (a) => 0.11 + 0.1 * Math.exp(-((a / 0.12) ** 2)),
  },
  // broad triangle, straight trailing edge, deep notch
  sperm: {
    le: (a) => 0.18 - 0.7 * a ** 1.2,
    te: pchip([[0, -0.17], [0.07, -0.34], [0.3, -0.4], [0.7, -0.46], [0.9, -0.5], [1, -0.52]]),
    thick: (a) => 0.13 + 0.12 * Math.exp(-((a / 0.12) ** 2)),
  },
};

// Mouth-cavity profile between the lips, per side: fraction of the way from
// upper lip U to lower lip D, and how far toward the midline (1 = at the lip,
// 0 = on the midline septum). Rorquals: the baleen rack hangs from the upper
// jaw, then palate, midline, tongue/pouch floor, inner lower lip.
const POCKET_RORQUAL = { f: [0, 0.16, 0.24, 0.3, 0.84, 0.92, 1], z: [1, 0.92, 0.45, 0, 0, 0.55, 1] };
const POCKET_SPERM = { f: [0, 0.08, 0.2, 0.3, 0.78, 0.9, 1], z: [1, 0.75, 0.35, 0, 0, 0.5, 1] };
const PK = 7;

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);

export class Whale {
  constructor(speciesId) {
    this.sp = SPECIES[speciesId];
    this.anat = this.sp.anatomy;
    this.L = this.sp.length;
    this.group = new THREE.Group();
    this.group.name = 'whale';
    this._model = new THREE.Group();
    this._model.rotation.y = Math.PI / 2;
    this.group.add(this._model);

    const f = this.anat.flipper;
    this._phase = 0; // accumulated fluke-beat phase (never jumps when frequency changes)
    this._beatAmp = this.anat.stroke.amp[0];
    this._turnS = 0;
    this._pitchS = 0;
    this._gape = 0; // 0..1 of the species' max gape
    this._engulf = 0; // rorqual throat-pouch inflation
    this._airS = 0;
    this._t = 0;
    this._flip = { d: f.dihedral, s: f.sweep, t: f.twist, dl: f.dihedral, sl: f.sweep, tl: f.twist, flex: 0 };

    this._initSections();
    this._build();
  }

  // ---- body plan ---------------------------------------------------------

  _initSections() {
    const A = this.anat;
    this._fW = pchip(A.stations, 1);
    this._fT = pchip(A.stations, 2);
    this._fB = pchip(A.stations, 3);
    this._fnU = pchip(A.shape, 1);
    this._fnL = pchip(A.shape, 2);
    const jaw = A.jaw;
    this._fLip = jaw.lip ? pchip(jaw.lip, 1) : null;
    this._fJawW = jaw.jawWidth ? pchip(jaw.jawWidth, 1) : null;
    this._fJawD = jaw.jawDepth ? pchip(jaw.jawDepth, 1) : null;
    this._sec = { W: 0, T: 0, B: 0, nU: 2, nL: 2, lip: 1, jd: 0, u: 0 };
  }

  // Cross-section at u (lengths in metres). Returns a shared object.
  _section(u) {
    const L = this.L, s = this._sec, jaw = this.anat.jaw;
    s.u = u;
    s.W = Math.max(0, this._fW(u)) * L;
    s.T = Math.max(0, this._fT(u)) * L;
    s.B = Math.max(0, this._fB(u)) * L;
    s.nU = this._fnU(u);
    s.nL = this._fnL(u);
    s.jd = 0;
    if (this._fJawW) {
      // sperm: the lip sits where the narrow lower jaw meets the head's underside
      const jz = u < jaw.chin ? 0 : Math.max(0, this._fJawW(u)) * L;
      const r = s.W > 1e-6 ? Math.min(1, jz / s.W) : 0;
      s.lip = r <= 1e-4 ? Math.PI : Math.PI - Math.asin(Math.min(1, r ** (s.nL / 2)));
      s.jd = u < jaw.chin ? 0 : Math.max(0, this._fJawD(u)) * L;
    } else {
      s.lip = this._fLip(u) * D2R;
    }
    return s;
  }

  // Rest-pose surface point at angle phi (0 dorsal, PI ventral, >PI left side).
  _surf(sec, phi, out) {
    const L = this.L;
    const side = phi <= Math.PI ? 1 : -1;
    const a = side > 0 ? phi : TAU - phi;
    const c = Math.cos(a), s = Math.max(0, Math.sin(a));
    const upper = c >= 0;
    const n = upper ? sec.nU : sec.nL;
    const z = sec.W * s ** (2 / n) * side;
    let y = upper ? sec.T * c ** (2 / n) : -sec.B * (-c) ** (2 / n);
    // crests: hump, knuckles, splash guard, keel
    const u = sec.u;
    for (const r of this.anat.ridges) {
      const [u0, u1, u2, u3] = r.u;
      if (u <= u0 || u >= u3) continue;
      let w = smoothstep(u0, u1, u) * (1 - smoothstep(u2, u3, u));
      if (r.knobs) {
        const k = 0.5 + 0.5 * Math.cos((TAU * r.knobs * (u - u1)) / (u3 - u1));
        w *= 0.3 + 0.7 * k * k;
      }
      const ang = r.side > 0 ? a : Math.PI - a;
      y += r.side * r.h * L * w * Math.exp(-((ang / r.sigma) ** 2));
    }
    // sperm whale: the narrow, underslung lower jaw hangs below the lip
    if (sec.jd > 0 && a > sec.lip) {
      const t = (a - sec.lip) / (Math.PI - sec.lip);
      y -= sec.jd * Math.sqrt(1 - (1 - t) * (1 - t));
    }
    out.x = L * (0.5 - u);
    out.y = y;
    out.z = z;
    return out;
  }

  // ---- materials ---------------------------------------------------------

  _makeSkinMaterial(map, normalMap = null) {
    // Whale skin is matte-ish rubbery tissue with a thin wet film: a rough
    // dielectric base, a faint low-intensity clearcoat for the film and a
    // little sheen for the soft grazing-angle lift seen in footage. Under water
    // the environment is diffuse, so the resulting specular is broad and soft.
    // Above the water (breach, logging at the surface) the skin is sheeting
    // wet: per fragment we raise the clearcoat and drop its roughness when the
    // point is in air, giving crisp sun highlights and sky reflections. Sheen
    // is kept low: at depth its grazing lift made fin edges glow.
    const mat = new THREE.MeshPhysicalMaterial({
      map,
      color: 0xffffff,
      roughness: 0.66,
      metalness: 0,
      clearcoat: 0.12,
      clearcoatRoughness: 0.5,
      sheen: 0.15,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0x7f98a4),
      envMapIntensity: 0.9,
      // all whale geometry is closed and outward-wound: no back faces to leak light
      side: THREE.FrontSide,
    });
    if (normalMap) {
      mat.normalMap = normalMap;
      // Game disposes material.map; take the normal map with it
      mat.addEventListener('dispose', () => normalMap.dispose());
    }
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_physical_fragment>',
        /* glsl */ `#include <lights_physical_fragment>
	#ifdef USE_FOG
	{
		float kwAir = smoothstep( - 0.05, 0.15, vKwWorld.y - KW_LEVEL );
		material.clearcoat = mix( material.clearcoat, 0.85, kwAir );
		material.clearcoatRoughness = mix( material.clearcoatRoughness, 0.1, kwAir );
		material.roughness = mix( material.roughness, 0.5, kwAir );
	}
	#endif`
      );
    };
    return mat;
  }

  // ---- construction ------------------------------------------------------

  _build() {
    this._buildBody();
    const maps = makeWhaleSkinMaps(this.sp.id, this._layout);
    this._skinMat = this._makeSkinMaterial(maps.map, maps.normalMap);
    const mouthMat = new THREE.MeshStandardMaterial({
      map: makeMouthTexture(), vertexColors: true, roughness: 0.75, metalness: 0,
    });
    this._body = new THREE.Mesh(this._bodyGeo, [this._skinMat, mouthMat]);
    this._body.name = 'body';
    this._model.add(this._body);

    this._riders = [];
    this._buildFluke();
    this._buildFlippers();
    this._buildDorsal();
    this._buildEyes();
    this._buildJawParts();
    // first pose, so the mesh is valid before the first update()
    this.update(0, { speed: 0, thrust: 0, turn: 0, pitchRate: 0, lunge: 0, airborne: false });
  }

  _buildBody() {
    const A = this.anat, L = this.L, jaw = A.jaw;
    const Nr = A.rings;
    const [Nup, Nlo] = A.cols;

    // columns around a ring: right side top -> upper lip, mouth pocket (upper
    // lip -> lower lip), lower lip -> ventral midline, then mirrored up the
    // left side back to a duplicate of the top (texture seam)
    const cols = [];
    for (let j = 0; j <= Nup; j++) cols.push({ arc: 0, side: 1, t: j / Nup });
    for (let k = 0; k < PK; k++) cols.push({ arc: 2, side: 1, k });
    for (let j = 0; j <= Nlo; j++) cols.push({ arc: 1, side: 1, t: j / Nlo });
    for (let j = Nlo - 1; j >= 0; j--) cols.push({ arc: 1, side: -1, t: j / Nlo });
    for (let k = PK - 1; k >= 0; k--) cols.push({ arc: 2, side: -1, k });
    for (let j = Nup; j >= 0; j--) cols.push({ arc: 0, side: -1, t: j / Nup });
    const Nc = cols.length;
    const cUR = Nup, cPR = Nup + 1, cDR = Nup + 1 + PK;
    const cDL = cDR + 2 * Nlo, cPL = cDL + 1, cUL = cDL + 1 + PK;
    this._c = { Nc, cUR, cPR, cDR, cDL, cPL, cUL };
    const isLower = new Uint8Array(Nc);
    const isPocket = new Uint8Array(Nc);
    cols.forEach((c, i) => { isLower[i] = c.arc === 1 ? 1 : 0; isPocket[i] = c.arc === 2 ? 1 : 0; });
    this._isLower = isLower;

    // ring stations: denser at the snout (blunt sperm face, jaw tip) and tail
    const us = new Float32Array(Nr);
    for (let i = 0; i < Nr; i++) {
      const t = i / (Nr - 1);
      us[i] = Math.min(1, Math.max(0, t - (0.75 * Math.sin(TAU * t)) / TAU));
    }
    us[Nr - 1] = 1;

    const Nv = Nr * Nc;
    const pos = new Float32Array(Nv * 3);
    const uv = new Float32Array(Nv * 2);
    const col = new Float32Array(Nv * 3).fill(1);
    const rowX = new Float32Array(Nr);
    const jawW = new Float32Array(Nr);
    const pouchW = new Float32Array(Nr);
    const lipMerge = new Uint8Array(Nr);
    const lowerDeg = new Uint8Array(Nr);
    const degRing = new Uint8Array(Nr);
    const S = new Float32Array(Nr); // meridian arc length (texture u)
    const p = { x: 0, y: 0, z: 0 };
    const lat = { x: 0, y: 0, z: 0 };
    const prev = { x: 0, y: 0, z: 0 };

    const pocket = jaw.baleen ? POCKET_RORQUAL : POCKET_SPERM;
    this._pocket = pocket;
    const pocketColors = jaw.baleen
      ? [0x2a2724, 0x1b1917, 0x4a433c, 0x2e1e1d, 0x3c2826, 0x5e4845, 0x7d736c]
      : [0xd8d2c8, 0xc8c0b6, 0xa8968e, 0x6e5a56, 0x8a726c, 0xc6bcb2, 0xe2dcd2];

    for (let i = 0; i < Nr; i++) {
      const u = us[i];
      const sec = this._section(u);
      if (i === Nr - 1) { sec.W = sec.T = sec.B = 0; sec.jd = 0; } // close the tail
      rowX[i] = L * (0.5 - u);
      degRing[i] = sec.W < 1e-6 ? 1 : 0;
      // jaw joint: the whole lower jaw ahead of the hinge swings as one
      jawW[i] = u >= jaw.chin - 1e-6 ? 1 - smoothstep(jaw.hinge - jaw.fade, jaw.hinge, u) : 0;
      lipMerge[i] = u < jaw.chin - 1e-6 || u > jaw.hinge + 0.004 ? 1 : 0;
      lowerDeg[i] = sec.lip > Math.PI - 1e-4 ? 1 : 0;
      if (jaw.pouch) {
        const [p0, p1] = jaw.pouch;
        const q = (u - p0) / (p1 - p0);
        pouchW[i] = q > 0 && q < 1 ? Math.sin(Math.PI * q ** 0.8) : 0;
      }
      // lateral meridian length -> texture u
      this._surf(sec, Math.PI / 2, lat);
      if (i > 0) S[i] = S[i - 1] + Math.hypot(lat.x - prev.x, lat.y - prev.y, lat.z - prev.z);
      prev.x = lat.x; prev.y = lat.y; prev.z = lat.z;

      const lip = sec.lip;
      for (let c = 0; c < Nc; c++) {
        const cc = cols[c];
        let phi;
        if (cc.arc === 0) phi = cc.t * lip;
        else if (cc.arc === 1) phi = lip + cc.t * (Math.PI - lip);
        else phi = lip;
        if (cc.side < 0) phi = TAU - phi;
        this._surf(sec, phi, p);
        const vi = i * Nc + c;
        pos[vi * 3] = p.x; pos[vi * 3 + 1] = p.y; pos[vi * 3 + 2] = p.z;
        if (cc.arc === 2) {
          uv[vi * 2 + 1] = cc.k / (PK - 1);
          const hex = pocketColors[cc.k];
          col[vi * 3] = ((hex >> 16) & 255) / 255;
          col[vi * 3 + 1] = ((hex >> 8) & 255) / 255;
          col[vi * 3 + 2] = (hex & 255) / 255;
        } else {
          uv[vi * 2 + 1] = phi / TAU;
        }
      }
    }
    const Stot = S[Nr - 1];
    for (let i = 0; i < Nr; i++) {
      for (let c = 0; c < Nc; c++) {
        const vi = i * Nc + c;
        uv[vi * 2] = isPocket[c] ? (S[i] / L) * 18 : S[i] / Stot;
      }
    }

    // triangles: skin first (group 0), then the mouth cavity (group 1)
    const skin = [], mouth = [];
    for (let i = 0; i < Nr - 1; i++) {
      for (let c = 0; c < Nc - 1; c++) {
        if (isPocket[c] !== isPocket[c + 1]) continue; // the lips: no skin across the gape
        const a = i * Nc + c, b = a + 1, d = a + Nc, e = d + 1;
        (isPocket[c] ? mouth : skin).push(a, b, e, a, e, d);
      }
    }
    const idx = new Uint32Array(skin.length + mouth.length);
    idx.set(skin, 0);
    idx.set(mouth, skin.length);
    if (signedVolume(pos, idx.subarray(0, skin.length)) < 0) flipWinding(idx);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(Nv * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.addGroup(0, skin.length, 0);
    geo.addGroup(skin.length, mouth.length, 1);
    geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geo.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    // the deformation stays well inside this; no per-frame bounds
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -0.05 * L, 0), 0.72 * L);

    this._bodyGeo = geo;
    this._base = new Float32Array(pos);
    this._Nr = Nr;
    this._us = us;
    this._rowX = rowX;
    this._jawW = jawW;
    this._pouchW = pouchW;
    this._lipMerge = lipMerge;
    this._lowerDeg = lowerDeg;
    this._degRing = degRing;
    // jaw joint at the mouth corner, on the lip line
    const hs = this._section(jaw.hinge);
    this._surf(hs, hs.lip, p);
    this._hinge = { x: p.x, y: p.y };
    // per-row spine state, filled each frame
    this._rowDy = new Float32Array(Nr);
    this._rowDz = new Float32Array(Nr);
    this._rowCt = new Float32Array(Nr).fill(1);
    this._rowSt = new Float32Array(Nr);
    this._rowCp = new Float32Array(Nr).fill(1);
    this._rowSp = new Float32Array(Nr);
    this._rowTh = new Float32Array(Nr);
    this._rowPs = new Float32Array(Nr);

    // texture layout for the skin painter
    const sOfU = (u) => {
      let i = 0;
      while (i < Nr - 2 && us[i + 1] < u) i++;
      const t = clamp01((u - us[i]) / Math.max(1e-6, us[i + 1] - us[i]));
      return (S[i] + (S[i + 1] - S[i]) * t) / Stot;
    };
    const circAt = (u) => {
      const sec = this._section(Math.min(0.999, Math.max(0.001, u)));
      const a = sec.W, b = (sec.T + sec.B) / 2;
      return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))) + 1e-3;
    };
    const lipAt = (u) => this._section(u).lip;
    this._layout = { L, meridian: Stot, sOfU, circAt, lipAt, anatomy: A };
  }

  _rowAt(u) {
    const us = this._us;
    let best = 0;
    for (let i = 1; i < us.length; i++) if (Math.abs(us[i] - u) < Math.abs(us[best] - u)) best = i;
    return best;
  }

  // A rider follows the spine at the row nearest u: rest position p0 (model
  // space), local rotation q applied under the row's bend.
  _addRider(obj, u, p0, q = null) {
    const r = { obj, row: this._rowAt(u), p0: p0.clone(), q: q || new THREE.Quaternion() };
    this._riders.push(r);
    this._model.add(obj);
    return r;
  }

  // rest-pose surface point + outward normal at (u, phi)
  _surfFrame(u, phi, outP, outN) {
    const e = 0.004;
    const a = {}, b = {}, c = {}, d = {};
    this._surf(this._section(u), phi, a);
    this._surf(this._section(Math.max(0, u - e)), phi, b);
    this._surf(this._section(Math.min(1, u + e)), phi, c);
    this._surf(this._section(u), phi + e * 4, d);
    outP.set(a.x, a.y, a.z);
    const du = new THREE.Vector3(c.x - b.x, c.y - b.y, c.z - b.z);
    const dv = new THREE.Vector3(d.x - a.x, d.y - a.y, d.z - a.z);
    outN.crossVectors(dv, du).normalize();
    if (outN.dot(new THREE.Vector3(0, a.y, a.z)) < 0) outN.negate();
    return outP;
  }

  _buildFluke() {
    const A = this.anat, L = this.L;
    const F = FLUKES[A.fluke.style];
    const HS = (A.fluke.span * L) / 2;
    const half = stationsBetween(0, 1, 30, 0.7);
    const stations = [];
    for (let i = half.length - 1; i > 0; i--) stations.push(-half[i]);
    for (let i = 0; i < half.length; i++) stations.push(half[i]);
    const ser = F.serrate;
    const plan = (s, o) => {
      const a = Math.abs(s);
      const le = F.le(a);
      let te = F.te(a);
      if (ser && a > ser.from && a < ser.to) {
        // scalloped trailing edge, not mirror-exact (every fluke is unique)
        const k = ((a - ser.from) / (ser.to - ser.from)) * ser.n + (s < 0 ? 0.37 : 0);
        te += ser.amp * (Math.abs(Math.sin(Math.PI * k)) - 0.5) * (0.6 + 0.4 * Math.sin(a * 17));
      }
      o.x = le * HS;
      o.c = Math.max(0, (le - te) * HS) * (a > 0.94 ? Math.sqrt(clamp01((1 - a) / 0.06)) : 1);
      o.y = 0;
      o.z = s * HS;
      o.t = F.thick(a);
      o.m = 0;
    };
    this._flukeFoil = buildFoil(stations, plan, { uOf: (s) => (s + 1) / 2 });
    this._flukeHS = HS;
    this._flukeMat = this._makeSkinMaterial(makeFinMap(this.sp.id, 'fluke', A.skin));
    this._fluke = new THREE.Mesh(this._flukeFoil.geo, this._flukeMat);
    this._fluke.name = 'fluke';
    this._flukePivot = new THREE.Group();
    this._flukePivot.add(this._fluke);
    this._model.add(this._flukePivot);
  }

  _buildFlippers() {
    const A = this.anat, L = this.L, f = A.flipper;
    const P = FLIPPERS[f.style];
    const len = f.len * L;
    const bumps = P.bumps;
    const plan = (s, o) => {
      let le = P.le(s), c = P.chord(s);
      if (bumps && s > bumps.from && s < bumps.to) {
        const k = ((s - bumps.from) / (bumps.to - bumps.from)) * bumps.n;
        const b = Math.sin(Math.PI * k);
        const amp = bumps.amp * (1 - 0.4 * s) * (b > 0 ? b ** 0.7 : 0);
        le += amp;
        c += amp;
      }
      o.x = le * len;
      o.y = P.droop(s) * len;
      o.z = s * len;
      o.c = c * len;
      o.t = P.thick(s);
      o.m = 0.025;
    };
    const stations = stationsBetween(-0.12, 1, bumps ? 90 : 40, 0.5);
    this._flipFoil = buildFoil(stations, plan, { capRoot: true, uOf: (s) => clamp01(s) });
    this._flipLen = len;
    this._flipMat = this._makeSkinMaterial(makeFinMap(this.sp.id, 'flipper', A.skin));

    // shoulder on the lower flank; the root is sunk into the body
    const pR = new THREE.Vector3(), nR = new THREE.Vector3();
    this._surfFrame(f.u, f.phi * D2R, pR, nR);
    pR.addScaledVector(nR, -0.05 * len);
    this._flipperR = new THREE.Mesh(this._flipFoil.geo, this._flipMat);
    this._flipperR.name = 'flipper';
    this._flipperL = new THREE.Mesh(this._flipFoil.geo, this._flipMat);
    this._flipperL.name = 'flipper';
    this._flipperL.scale.z = -1; // mirror (the renderer flips the winding)
    const gR = new THREE.Group(), gL = new THREE.Group();
    gR.add(this._flipperR);
    gL.add(this._flipperL);
    this._flipRiderR = this._addRider(gR, f.u, pR);
    this._flipRiderL = this._addRider(gL, f.u, new THREE.Vector3(pR.x, pR.y, -pR.z));
  }

  _buildDorsal() {
    const A = this.anat, L = this.L, d = A.dorsal;
    if (!d) return;
    const H = d.height * L, C = d.base * L;
    const chord = pchip([[-0.4, 1.12], [0, 1], [0.35, 0.66], [0.7, 0.38], [0.9, 0.2], [0.98, 0.09], [1, 0]]);
    const plan = (s, o) => {
      const h = Math.max(0, s);
      o.x = C * 0.5 - d.sweep * H * h ** 1.15;
      o.y = 0;
      o.z = s * H;
      o.c = chord(s) * C;
      o.t = 0.3 - 0.08 * h;
      o.m = 0;
    };
    // skin: sample the body texture along the dorsal midline
    const s0 = this._layout.sOfU(d.u);
    const foil = buildFoil(stationsBetween(-0.4, 1, 26, 0.5), plan, { capRoot: true, uOf: () => s0 });
    foil.geo.rotateX(-Math.PI / 2); // span -> +Y, thickness -> Z
    const uvA = foil.geo.attributes.uv.array;
    for (let i = 1; i < uvA.length; i += 2) uvA[i] = 0.004 + 0.004 * uvA[i];
    foil.geo.computeVertexNormals();
    const mesh = new THREE.Mesh(foil.geo, this._skinMat);
    mesh.name = 'dorsal';
    const p = {};
    this._surf(this._section(d.u), 0, p);
    this._addRider(mesh, d.u, new THREE.Vector3(p.x, p.y - 0.02 * H, 0));
  }

  _buildEyes() {
    const A = this.anat, L = this.L, e = A.eye;
    const r = e.r * L;
    const g = new THREE.Group();
    g.name = 'eyes';
    const eyeGeo = new THREE.SphereGeometry(r, 16, 12);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x07090a, roughness: 0.12, metalness: 0 });
    const lidGeo = new THREE.SphereGeometry(r * 1.9, 16, 10);
    const phi = e.phi != null ? e.phi * D2R : this._layout.lipAt(e.u) + e.dphi * D2R;
    const s0 = this._layout.sOfU(e.u), v0 = phi / TAU;
    const uvA = lidGeo.attributes.uv.array;
    for (let i = 0; i < uvA.length; i += 2) { uvA[i] = s0; uvA[i + 1] = v0; }
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (const side of [1, -1]) {
      this._surfFrame(e.u, side > 0 ? phi : TAU - phi, p, n);
      // a low swelling of skin around the eye, the eye set into it
      const lid = new THREE.Mesh(lidGeo, this._skinMat);
      lid.position.copy(p).addScaledVector(n, -r * 1.35);
      lid.scale.set(1.25, 0.8, 1);
      lid.lookAt(_v.copy(lid.position).add(n));
      g.add(lid);
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.copy(p).addScaledVector(n, 0.05 * r);
      eye.scale.set(1.3, 0.8, 0.55);
      eye.lookAt(_v.copy(eye.position).add(n));
      g.add(eye);
    }
    this._addRider(g, e.u, new THREE.Vector3());
  }

  // Humpback tubercles (on the rostrum and the lower jaw) and sperm-whale
  // teeth. Upper tubercles ride the head; the rest ride the lower jaw.
  _buildJawParts() {
    const A = this.anat, L = this.L;
    const hinge = new THREE.Vector3(this._hinge.x, this._hinge.y, 0);
    this._jaw = new THREE.Group();
    this._jaw.name = 'jaw';
    this._jawRider = this._addRider(this._jaw, A.jaw.hinge, hinge);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    if (A.tubercles) {
      const up = [], lo = [];
      const add = (list, u, phi, size) => list.push([u, phi, size * (0.75 + 0.5 * rnd())]);
      // rostrum: a midline row and two rows each side
      for (let u = 0.016; u < 0.17; u += 0.0125 + 0.004 * rnd()) add(up, u, 0.02 * (rnd() - 0.5), 1);
      for (const a of [22, 40]) {
        for (let u = 0.02 + 0.01 * rnd(); u < 0.16 - a * 0.0008; u += 0.016 + 0.006 * rnd()) {
          add(up, u, (a + 5 * (rnd() - 0.5)) * D2R, 0.9);
          add(up, u + 0.004 * (rnd() - 0.5), TAU - (a + 5 * (rnd() - 0.5)) * D2R, 0.9);
        }
      }
      // lower jaw: a row along each lip, a sparser second row, the chin knob
      for (let u = 0.008; u < 0.2; u += 0.013 + 0.004 * rnd()) {
        const lip = this._layout.lipAt(u);
        add(lo, u, lip + 8 * D2R, 0.95);
        add(lo, u + 0.003, TAU - lip - 8 * D2R, 0.95);
        if (u < 0.11 && rnd() > 0.35) {
          add(lo, u + 0.006, lip + 20 * D2R, 0.8);
          add(lo, u + 0.004, TAU - lip - 20 * D2R, 0.8);
        }
      }
      for (let i = 0; i < 9; i++) add(lo, 0.006 + 0.03 * rnd(), (135 + 90 * rnd()) * D2R, 1.25);
      const r = 0.0042 * L;
      const upMesh = new THREE.Mesh(this._tubercleGeo(up, r, new THREE.Vector3()), this._skinMat);
      upMesh.name = 'tubercles';
      this._addRider(upMesh, 0.09, new THREE.Vector3());
      const loMesh = new THREE.Mesh(this._tubercleGeo(lo, r, hinge), this._skinMat);
      loMesh.name = 'tubercles';
      this._jaw.add(loMesh);
    }

    if (A.jaw.teeth) {
      // conical teeth along the top of the lower jaw; closed, they sit in
      // sockets inside the head
      const n = A.jaw.teeth;
      const cone = new THREE.ConeGeometry(0.0022 * L, 0.0085 * L, 7, 1);
      cone.translate(0, 0.0035 * L, 0);
      const parts = [];
      const p = {};
      for (let i = 0; i < n; i++) {
        const u = A.jaw.chin + 0.012 + (i / (n - 1)) * (A.jaw.hinge - A.jaw.chin - 0.06);
        const sec = this._section(u);
        this._surf(sec, sec.lip, p);
        for (const side of [1, -1]) {
          const g = cone.clone();
          g.rotateZ(0.12);
          g.translate(p.x - hinge.x, p.y - hinge.y - 0.001 * L, side * p.z * 0.55);
          parts.push(g);
        }
      }
      cone.dispose();
      const teeth = new THREE.Mesh(mergeSimple(parts), new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.35 }));
      teeth.name = 'teeth';
      this._jaw.add(teeth);
    }
  }

  _tubercleGeo(list, r, origin) {
    const hemi = new THREE.SphereGeometry(1, 8, 4, 0, TAU, 0, Math.PI / 2);
    const parts = [];
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const one = new THREE.Vector3(1, 1, 1);
    for (const [u, phi, size] of list) {
      this._surfFrame(u, phi, p, n);
      const g = hemi.clone();
      const rr = r * size;
      g.scale(rr, rr * 0.62, rr);
      q.setFromUnitVectors(_Y, n);
      m.compose(p.clone().addScaledVector(n, -0.3 * rr).sub(origin), q, one);
      g.applyMatrix4(m);
      const s0 = this._layout.sOfU(u), v0 = phi / TAU;
      const uvA = g.attributes.uv.array;
      for (let i = 0; i < uvA.length; i += 2) { uvA[i] = s0; uvA[i + 1] = v0; }
      parts.push(g);
    }
    hemi.dispose();
    return mergeSimple(parts);
  }

  // ---- animation ---------------------------------------------------------

  // state: { speed, thrust, turn, pitchRate, lunge, filtering, airborne, ... }
  update(dt, state) {
    const A = this.anat, L = this.L;
    this._t += dt;
    const thrust = state.thrust || 0;
    const air = !!state.airborne;

    // ---- fluke beat: the phase accumulates, so frequency changes never jump
    const [f0, f1, f2] = A.stroke.hz;
    const [a0, a1, a2] = A.stroke.amp;
    const tc = clamp01(thrust);
    const ts = clamp01(thrust - 1);
    const freq = (f0 + (f1 - f0) * tc + (f2 - f1) * ts) * (air ? 0.6 : 1);
    this._phase = (this._phase + dt * freq * TAU) % (TAU * 100);
    const ampT = (a0 + (a1 - a0) * tc + (a2 - a1) * ts) * (air ? 0.35 : 1);
    this._beatAmp += (ampT - this._beatAmp) * damp(1.6, dt);
    this._turnS += ((state.turn || 0) - this._turnS) * damp(3, dt);
    this._pitchS += ((state.pitchRate || 0) - this._pitchS) * damp(3, dt);
    this._airS += ((air ? 1 : 0) - this._airS) * damp(air ? 4 : 1.5, dt);

    // ---- jaw + throat pouch: gape on the lunge, close and filter after
    const lunging = (state.lunge || 0) > 0;
    const gT = lunging ? 1 : state.filtering ? 0.05 : 0;
    this._gape += (gT - this._gape) * damp(gT > this._gape ? 4.5 : 1.6, dt);
    if (A.jaw.pouch) {
      const pT = lunging || this._gape > 0.3 ? 1 : 0;
      const rate = pT > this._engulf ? 2.4 : state.filtering ? 0.45 : 0.7;
      this._engulf += (pT - this._engulf) * damp(rate, dt);
    }

    // ---- spine: travelling wave + the body following its own turn/pitch
    const Nr = this._Nr, us = this._us;
    const dyA = this._rowDy, dzA = this._rowDz;
    const amp = this._beatAmp * L;
    const K = 2.4; // radians of wave lag nose -> tail (wavelength > body)
    for (let i = 0; i < Nr; i++) {
      const u = us[i];
      // head heave ~5% of the tail, a node near the flippers, max at the fluke
      const env = u < 0.33 ? 0.05 * (1 - u / 0.33) ** 2 : ((u - 0.33) / 0.67) ** 2.1;
      const bend = Math.max(0, u - 0.3) / 0.7;
      const bs = bend * bend;
      dyA[i] = amp * env * Math.sin(this._phase - K * u) + this._pitchS * 0.05 * L * bs;
      dzA[i] = -this._turnS * 0.08 * L * bs;
    }
    const rowX = this._rowX;
    for (let i = 0; i < Nr; i++) {
      const a = Math.max(0, i - 1), b = Math.min(Nr - 1, i + 1);
      const dx = rowX[b] - rowX[a];
      const th = Math.atan((dyA[b] - dyA[a]) / dx);
      const ps = Math.atan((dzA[b] - dzA[a]) / dx);
      this._rowTh[i] = th; this._rowPs[i] = ps;
      this._rowCt[i] = Math.cos(th); this._rowSt[i] = Math.sin(th);
      this._rowCp[i] = Math.cos(ps); this._rowSp[i] = Math.sin(ps);
    }

    this._deformBody();
    this._animateFluke(K);
    this._animateFlippers(dt, state);

    // jaw parts swing with the gape
    this._jawRider.q.setFromAxisAngle(_Z, -A.jaw.gape * this._gape);
    for (const r of this._riders) this._placeRider(r);
  }

  _deformBody() {
    const jaw = this.anat.jaw, L = this.L;
    const { Nc, cUR, cPR, cDR, cDL, cPL, cUL } = this._c;
    const pos = this._bodyGeo.attributes.position.array;
    const nrm = this._bodyGeo.attributes.normal.array;
    const base = this._base;
    const isLower = this._isLower;
    const hx = this._hinge.x, hy = this._hinge.y;
    const gapeA = jaw.gape * this._gape;
    const engulf = this._engulf;
    const pd = (jaw.pouchDepth || 0) * L;
    const pk = this._pocket;
    const open0 = 0.015 * L;

    for (let i = 0; i < this._Nr; i++) {
      const row = i * Nc;
      const P = engulf * this._pouchW[i];
      const al = gapeA * this._jawW[i];
      const ca = Math.cos(al), sa = Math.sin(al);
      for (let c = 0; c < Nc; c++) {
        if ((c >= cPR && c < cDR) || (c >= cPL && c < cUL)) continue; // pocket: below
        const v = (row + c) * 3;
        let x = base[v], y = base[v + 1], z = base[v + 2];
        if (P > 1e-4 && y < 0) {
          // the pleated throat balloons down and out
          const low = -y / (-y + Math.abs(z) + 1e-5);
          y = y * (1 + P * 0.9 * low) - P * pd * low * low;
          z *= 1 + P * 0.3 * low;
        }
        if (al > 1e-5 && isLower[c]) {
          const X = x - hx, Y = y - hy;
          x = hx + X * ca + Y * sa;
          y = hy - X * sa + Y * ca;
        }
        pos[v] = x; pos[v + 1] = y; pos[v + 2] = z;
      }
      // mouth cavity between the (possibly parted) lips, each side
      this._fillPocket(pos, row, cUR, cDR, cPR, 1, pk, open0);
      this._fillPocket(pos, row, cUL, cDL, cPL, -1, pk, open0);

      // bend the ring onto the spine
      const ct = this._rowCt[i], st = this._rowSt[i], cp = this._rowCp[i], sp = this._rowSp[i];
      const x0 = this._rowX[i], dy = this._rowDy[i], dz = this._rowDz[i];
      for (let c = 0; c < Nc; c++) {
        const v = (row + c) * 3;
        const X = pos[v] - x0, Y = pos[v + 1], Z = pos[v + 2];
        const x1 = X * ct - Y * st, y1 = X * st + Y * ct;
        pos[v] = x0 + x1 * cp - Z * sp;
        pos[v + 1] = dy + y1;
        pos[v + 2] = dz + x1 * sp + Z * cp;
      }
    }

    // normals from the deformed surface, then weld seams
    accumulateNormals(pos, this._bodyGeo.index.array, nrm);
    for (let i = 0; i < this._Nr; i++) {
      const row = i * Nc;
      sumInto(nrm, row, row + Nc - 1); // dorsal texture seam
      if (this._degRing[i]) {
        // snout tip / tail end: one point, one normal
        let x = 0, y = 0, z = 0;
        for (let c = 0; c < Nc; c++) { const v = (row + c) * 3; x += nrm[v]; y += nrm[v + 1]; z += nrm[v + 2]; }
        for (let c = 0; c < Nc; c++) { const v = (row + c) * 3; nrm[v] = x; nrm[v + 1] = y; nrm[v + 2] = z; }
      } else if (this._lowerDeg[i]) {
        // sperm snout ahead of the jaw: the lower arc is a point; weld across it
        sumInto(nrm, row + cUR, row + cUL);
        const w = (row + cUR) * 3;
        for (let c = cUR + 1; c < cUL; c++) {
          const v = (row + c) * 3;
          nrm[v] = nrm[w]; nrm[v + 1] = nrm[w + 1]; nrm[v + 2] = nrm[w + 2];
        }
      } else if (this._lipMerge[i]) {
        sumInto(nrm, row + cUR, row + cDR);
        sumInto(nrm, row + cUL, row + cDL);
      }
    }
    normalizeAll(nrm);
    this._bodyGeo.attributes.position.needsUpdate = true;
    this._bodyGeo.attributes.normal.needsUpdate = true;
  }

  _fillPocket(pos, row, cU, cD, cP, side, pk, open0) {
    const u = (row + cU) * 3, d = (row + cD) * 3;
    const ux = pos[u], uy = pos[u + 1], uz = pos[u + 2];
    const vx = pos[d] - ux, vy = pos[d + 1] - uy, vz = pos[d + 2] - uz;
    // closed lips: the cavity folds flat onto the lip line
    const open = Math.min(1, Math.hypot(vx, vy, vz) / open0);
    for (let k = 0; k < PK; k++) {
      const f = pk.f[k], zf = 1 - (1 - pk.z[k]) * open;
      const w = (row + cP + (side > 0 ? k : PK - 1 - k)) * 3;
      pos[w] = ux + vx * f;
      pos[w + 1] = uy + vy * f;
      pos[w + 2] = (uz + vz * f) * zf;
    }
  }

  _placeRider(r) {
    const i = r.row;
    const ct = this._rowCt[i], st = this._rowSt[i], cp = this._rowCp[i], sp = this._rowSp[i];
    const x0 = this._rowX[i];
    const X = r.p0.x - x0, Y = r.p0.y, Z = r.p0.z;
    const x1 = X * ct - Y * st, y1 = X * st + Y * ct;
    r.obj.position.set(x0 + x1 * cp - Z * sp, this._rowDy[i] + y1, this._rowDz[i] + x1 * sp + Z * cp);
    // row bend: Ry(-psi) * Rz(theta), then the rider's own rotation
    _qb.setFromAxisAngle(_Y, -this._rowPs[i]);
    _qc.setFromAxisAngle(_Z, this._rowTh[i]);
    _qa.multiplyQuaternions(_qb, _qc);
    r.obj.quaternion.multiplyQuaternions(_qa, r.q);
  }

  _animateFluke(K) {
    const A = this.anat, Nr = this._Nr, L = this.L;
    const tip = Nr - 1;
    const pv = this._flukePivot;
    pv.position.set(-L * 0.5, this._rowDy[tip], this._rowDz[tip]);
    // pitch: part of the spine tangent plus an angle of attack in phase with
    // the heave velocity (the fluke leads the wave), ~25 deg at cruise
    const rel = this._beatAmp / A.stroke.amp[1];
    const hv = Math.cos(this._phase - K);
    const theta = this._rowTh[tip] * 0.55 + 0.42 * rel * hv - this._pitchS * 0.1;
    _qb.setFromAxisAngle(_Y, -this._rowPs[tip]);
    _qc.setFromAxisAngle(_Z, theta);
    pv.quaternion.multiplyQuaternions(_qb, _qc);

    // flex: the trailing edge and the tips lag the stroke
    const foil = this._flukeFoil;
    const HS = this._flukeHS;
    const posA = foil.geo.attributes.position.array, base = foil.base;
    const flex = -0.2 * rel * hv - 0.04 * this._pitchS;
    const sflex = -0.09 * rel * Math.cos(this._phase - K - 0.5);
    for (let v = 0; v < posA.length; v += 3) {
      const aft = Math.max(0, -base[v]) / HS;
      const a = Math.abs(base[v + 2]) / HS;
      posA[v + 1] = base[v + 1] + HS * (flex * aft * aft + sflex * a * a);
    }
    foil.geo.attributes.position.needsUpdate = true;
    foilNormals(foil);
  }

  _animateFlippers(dt, state) {
    const f = this.anat.flipper, F = this._flip;
    const hump = f.style === 'humpback';
    const t = this._t;
    const thrust = state.thrust || 0;
    const turn = this._turnS, pitch = this._pitchS, air = this._airS, gape = this._gape;
    // rest set: down (dihedral), back (sweep), leading edge up (twist)
    let d = f.dihedral, s = f.sweep, tw = f.twist;
    // slow sculling / trimming, a touch of stroke coupling
    tw += 0.05 * Math.sin(t * 0.45) + 0.04 * Math.sin(this._phase + 1.1) * Math.min(1, thrust + 0.2);
    d += 0.04 * Math.sin(t * 0.31 + 1) + 0.03 * Math.sin(this._phase + 2.2) * Math.min(1, thrust);
    // pitch trim: both fins act as elevators
    tw += pitch * 0.45;
    // tucked in a glide, flared when the mouth opens
    s += 0.12 * (1 - Math.min(1, thrust));
    s -= (hump ? 0.45 : 0.2) * gape;
    d -= 0.15 * gape;
    // humpbacks reach out with both flippers in turns
    s -= (hump ? 0.35 : 0.12) * Math.abs(turn);
    // breach: flippers out, humpbacks wave them
    if (air > 0.01) {
      const w = air * (hump ? 1 : 0.4);
      const flap = hump ? 0.45 * Math.sin(t * 2.4) : 0.08 * Math.sin(t * 1.6);
      s += (0.1 - s) * w;
      d += (-0.05 + flap - d) * w;
    }
    // turn (turn > 0 = left): the inside fin dips and bites, the outside rises
    const dR = d - 0.25 * turn, dL = d + 0.25 * turn;
    const tR = tw - 0.2 * turn, tL = tw + 0.2 * turn;
    const k = damp(3, dt);
    F.d += (dR - F.d) * k; F.s += (s - F.s) * k; F.t += (tR - F.t) * k;
    F.dl += (dL - F.dl) * k; F.sl += (s - F.sl) * k; F.tl += (tL - F.tl) * k;
    _e.set(F.d, -F.s, F.t, 'YXZ');
    this._flipRiderR.q.setFromEuler(_e);
    // the left fin mesh is mirrored in z: mirrored Euler is (-x, -y, z)
    _e.set(-F.dl, F.sl, F.tl, 'YXZ');
    this._flipRiderL.q.setFromEuler(_e);

    // spanwise flex: the outer fin lags (shared geometry, symmetric)
    const flexT = 0.05 * Math.sin(this._phase + 1.6) * Math.min(1, thrust + 0.3) +
      (hump ? 0.12 * air * Math.cos(t * 2.4) : 0) + 0.06 * gape;
    F.flex += (flexT - F.flex) * damp(6, dt);
    const foil = this._flipFoil, len = this._flipLen;
    const posA = foil.geo.attributes.position.array, base = foil.base;
    for (let v = 0; v < posA.length; v += 3) {
      const sN = Math.max(0, base[v + 2] / len);
      posA[v + 1] = base[v + 1] + len * F.flex * sN * sN;
    }
    foil.geo.attributes.position.needsUpdate = true;
    foilNormals(foil);
  }

  // Mouth position in whale-group space (includes the model's +X→-Z turn).
  getMouthPosition(out) {
    out.set(this.L * 0.55, -this.L * 0.02, 0);
    out.y += this._rowDy[0];
    return out.applyAxisAngle(_Y, Math.PI / 2);
  }
}

// merge indexed geometries with position/normal/uv (build time only)
function mergeSimple(geos) {
  let nv = 0, ni = 0;
  for (const g of geos) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, ov * 3);
    nrm.set(g.attributes.normal.array, ov * 3);
    uv.set(g.attributes.uv.array, ov * 2);
    for (let i = 0; i < g.index.count; i++) idx[oi++] = g.index.array[i] + ov;
    ov += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export const WHALE_SPECIES = SPECIES;
