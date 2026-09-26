import * as THREE from 'three';
import { makeSkinTexture } from './textures.js';
import { SPECIES } from './species.js';

// Catmull-Rom spline through control points (sorted by x). Returns y at x.
function catmullRom(points, x) {
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];

  let i = 0;
  while (points[i + 1][0] < x) i++;
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(points.length - 1, i + 2)];

  const t = (x - p1[0]) / (p2[0] - p1[0]);
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    ((2 * p1[1]) +
      (-p0[1] + p2[1]) * t +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
      (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
  );
}

// Body outline profiles (fraction of max half-width/height along u: 0=nose, 1=tail)
// Fusiform: tapered rostrum, thickest ~35% back, long tail stock to the flukes.
const WIDTH_PROFILE = [
  [0.0, 0.05], [0.04, 0.34], [0.12, 0.68], [0.24, 0.93], [0.36, 1.0], [0.5, 0.9],
  [0.64, 0.68], [0.76, 0.42], [0.86, 0.2], [0.94, 0.09], [1.0, 0.035],
];
const HEIGHT_PROFILE = [
  [0.0, 0.04], [0.04, 0.26], [0.12, 0.58], [0.24, 0.88], [0.36, 1.0], [0.5, 0.94],
  [0.64, 0.76], [0.76, 0.52], [0.86, 0.28], [0.94, 0.12], [1.0, 0.04],
];

export class Whale {
  constructor(speciesId) {
    this.sp = SPECIES[speciesId];
    this.group = new THREE.Group();
    this.group.name = 'whale';
    // The model is authored with the nose along +X; rotate so the nose faces
    // -Z (three.js's canonical forward) to match the controller's aim math.
    this._model = new THREE.Group();
    this._model.rotation.y = Math.PI / 2;
    this.group.add(this._model);
    this._skinMat = this._makeSkinMaterial();
    this._phase = 0; // accumulated tail-beat phase (never jumps when speed changes)
    this._beatAmp = 0; // smoothed tail-beat amplitude
    this._turnS = 0; // smoothed body bends
    this._pitchS = 0;
    this._engulf = 0; // rorqual throat-pouch inflation after a lunge
    this._airS = 0; // smoothed airborne blend
    this._build();
  }

  // ---- materials ---------------------------------------------------------

  _makeSkinMaterial() {
    const sp = this.sp;
    const map = makeSkinTexture(sp.skinTop, sp.skinBottom, sp.mottle, sp.id.length * 13);
    // Whale skin is matte-ish rubbery tissue with a thin wet film: a rough
    // dielectric base, a faint low-intensity clearcoat for the film and a
    // little sheen for the soft grazing-angle lift seen in footage. Under water
    // the environment is diffuse, so the resulting specular is broad and soft.
    return new THREE.MeshPhysicalMaterial({
      map,
      color: 0xffffff,
      roughness: 0.66,
      metalness: 0,
      clearcoat: 0.12,
      clearcoatRoughness: 0.5,
      sheen: 0.35,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0x7f98a4),
      envMapIntensity: 0.9,
      side: THREE.DoubleSide,
    });
  }

  // ---- construction ------------------------------------------------------

  _build() {
    this._body = this._buildBody();
    this._model.add(this._body);

    // the fluke hangs off a pivot at the tail tip so it follows the spine wave
    this._flukePivot = new THREE.Group();
    this._flukePivot.position.set(-this.sp.length * 0.5, 0, 0);
    this._flukePivot.rotation.order = 'YZX';
    this._fluke = this._buildFluke();
    this._flukePivot.add(this._fluke);
    this._model.add(this._flukePivot);

    this._flipperL = this._buildFlipper(-1);
    this._flipperR = this._buildFlipper(1);
    this._model.add(this._flipperL, this._flipperR);

    this._dorsal = this._buildDorsal();
    this._model.add(this._dorsal);

    this._eyes = this._buildEyes();
    this._model.add(this._eyes);

    this._tubercles = this.sp.id === 'humpback' ? this._buildTubercles() : null;

    // parts that ride on the spine: [object, u along body, base position, base rotation.z]
    const L = this.sp.length;
    this._riders = [
      [this._flipperL, 0.34], [this._flipperR, 0.34], [this._dorsal, 0.63],
      [this._eyes, 0.18],
    ];
    if (this._tubercles) this._riders.push([this._tubercles, 0.08]);
    for (const r of this._riders) r.push(r[0].position.clone(), r[0].rotation.z);
    this._mouthBase = new THREE.Vector3(L * 0.55, -L * 0.02, 0);
  }

  _buildBody() {
    const sp = this.sp;
    const L = sp.length;
    const W = sp.maxWidth * L;
    const H = sp.maxHeight * L;
    const Nu = 64;
    const Nv = 32;

    const w = (u) => W * catmullRom(WIDTH_PROFILE, u);
    const h = (u) => H * catmullRom(HEIGHT_PROFILE, u);
    const bellyDrop = 0.02 * L;
    const arch = sp.id === 'humpback' ? 0.028 * L : 0.0;
    const yOff = (u) => {
      const belly = -bellyDrop * Math.sin(Math.PI * u);
      const a = u - 0.5;
      return belly + arch * Math.exp(-(a * a) / 0.012);
    };

    const posAt = (u, v) => {
      const ang = v * Math.PI * 2;
      return [
        L * (0.5 - u),
        Math.sin(ang) * h(u) + yOff(u),
        Math.cos(ang) * w(u),
      ];
    };

    const vertexCount = (Nu + 1) * Nv;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);

    const EPS = 0.004;
    for (let i = 0; i <= Nu; i++) {
      const u = i / Nu;
      for (let j = 0; j < Nv; j++) {
        const v = j / Nv;
        const idx = i * Nv + j;
        const p = posAt(u, v);
        positions[idx * 3] = p[0];
        positions[idx * 3 + 1] = p[1];
        positions[idx * 3 + 2] = p[2];

        // analytic smooth normal via central differences (wraps in v via sin/cos)
        const um = Math.max(0, u - EPS), up = Math.min(1, u + EPS);
        const pm = posAt(um, v), pp = posAt(up, v);
        const vm = posAt(u, v - EPS), vp = posAt(u, v + EPS);
        const dux = pp[0] - pm[0], duy = pp[1] - pm[1], duz = pp[2] - pm[2];
        const dvx = vp[0] - vm[0], dvy = vp[1] - vm[1], dvz = vp[2] - vm[2];
        // normal = cross(dv, du) (outward)
        let nx = dvy * duz - dvz * duy;
        let ny = dvz * dux - dvx * duz;
        let nz = dvx * duy - dvy * dux;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-8) {
          nx = u < 0.5 ? 1 : -1; ny = 0; nz = 0;
        } else {
          nx /= len; ny /= len; nz /= len;
        }
        normals[idx * 3] = nx;
        normals[idx * 3 + 1] = ny;
        normals[idx * 3 + 2] = nz;

        uvs[idx * 2] = u;
        uvs[idx * 2 + 1] = 0.5 + 0.5 * Math.sin(v * Math.PI * 2);
      }
    }

    const indices = [];
    for (let i = 0; i < Nu; i++) {
      for (let j = 0; j < Nv; j++) {
        const a = i * Nv + j;
        const b = (i + 1) * Nv + j;
        const c = (i + 1) * Nv + ((j + 1) % Nv);
        const d = i * Nv + ((j + 1) % Nv);
        indices.push(a, c, b);
        indices.push(a, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    const mesh = new THREE.Mesh(geo, this._skinMat);
    mesh.name = 'body';

    this._baseBody = new Float32Array(positions);
    this._baseNormals = new Float32Array(normals);
    this._bodyGeo = geo;
    this._Nu = Nu;
    this._Nv = Nv;
    // per-row spine state, filled each frame
    this._rowDy = new Float32Array(Nu + 1);
    this._rowDz = new Float32Array(Nu + 1);
    this._rowSy = new Float32Array(Nu + 1);
    this._rowSz = new Float32Array(Nu + 1);
    this._rowPouch = new Float32Array(Nu + 1);
    return mesh;
  }

  // Extrude a 2D planform into a fin.
  // points: [x,y] = lineTo, [cpx,cpy,x,y] = quadraticCurveTo (after the initial moveTo).
  // mode 'horizontal' → fin lies flat (span along Z, thickness up/down);
  // mode 'vertical' → fin stands up (height along Y, thickness left/right).
  _finFromShape(points, thickness, bevel, mode = 'horizontal') {
    const shape = new THREE.Shape();
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      const p = points[i];
      if (p.length === 4) shape.quadraticCurveTo(p[0], p[1], p[2], p[3]);
      else shape.lineTo(p[0], p[1]);
    }
    shape.closePath();

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: thickness,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      steps: 1,
    });

    if (mode === 'horizontal') {
      geo.rotateX(-Math.PI / 2); // shape Y -> -Z (span), extrude Z -> +Y (up)
      geo.translate(0, -thickness / 2, 0);
    } else {
      geo.translate(0, 0, -thickness / 2);
    }
    geo.computeVertexNormals();
    return geo;
  }

  _buildFluke() {
    const sp = this.sp;
    const L = sp.length;
    const HS = (sp.flukeSpan * L) / 2;
    const C = HS;
    const thickness = L * 0.012;
    const bevel = L * 0.008;
    const pts = [
      [C, 0],
      [C * 0.55, HS * 0.7, C * 0.15, HS],
      [C * 0.15, HS * 0.5, C * 0.5, 0],
      [C * 0.15, -HS * 0.5, C * 0.15, -HS],
      [C * 0.55, -HS * 0.7, C, 0],
    ];
    const geo = this._finFromShape(pts, thickness, bevel, 'horizontal');
    const mesh = new THREE.Mesh(geo, this._skinMat);
    mesh.position.set(-C, 0, 0); // leading edge sits at the pivot (tail tip)
    mesh.name = 'fluke';
    return mesh;
  }

  _buildFlipper(side) {
    const sp = this.sp;
    const L = sp.length;
    const len = sp.flipperLen * L;
    const chord = len * 0.28;
    const thickness = len * 0.06;
    const bevel = len * 0.02;
    const s = -side; // so the fin spans the correct side after the rotateX
    const pts = [
      [0, 0],
      [chord * 0.2, s * len * 0.5, chord * 0.25, s * len],
      [chord * 0.5, s * len * 0.4, chord * 0.55, 0],
    ];
    const geo = this._finFromShape(pts, thickness, bevel, 'horizontal');
    const mesh = new THREE.Mesh(geo, this._skinMat);
    mesh.position.set(L * 0.16, -L * 0.05, side * L * sp.maxWidth * 0.9);
    mesh.rotation.z = side * -0.35;
    mesh.rotation.y = side * -0.15;
    mesh.name = 'flipper';
    return mesh;
  }

  _buildDorsal() {
    const sp = this.sp;
    const L = sp.length;
    const dh = sp.dorsalHeight * L;
    if (dh < 0.02) return new THREE.Group();
    const base = dh * 1.7;
    const thickness = dh * 0.5;
    const pts = [
      [0, 0],
      [base * 0.45, dh, base * 0.6, 0],
    ];
    const geo = this._finFromShape(pts, thickness, dh * 0.2, 'vertical');
    const mesh = new THREE.Mesh(geo, this._skinMat);
    mesh.position.set(-L * 0.13, L * sp.maxHeight * 0.75, 0);
    mesh.rotation.z = -0.5;
    mesh.name = 'dorsal';
    return mesh;
  }

  _buildEyes() {
    const sp = this.sp;
    const L = sp.length;
    const g = new THREE.Group();
    const eyeGeo = new THREE.SphereGeometry(L * 0.011, 16, 12);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x0a0d0f, roughness: 0.2 });
    const hlMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, emissive: 0x334455, emissiveIntensity: 0.6 });
    const w = L * sp.maxWidth * 0.82;
    const h = L * sp.maxHeight * 0.12;
    const x = L * 0.32;
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(x, h, s * w);
      g.add(eye);
      const hl = new THREE.Mesh(new THREE.SphereGeometry(L * 0.004, 8, 8), hlMat);
      hl.position.set(x + L * 0.005, h + L * 0.004, s * (w + L * 0.005));
      g.add(hl);
    }
    g.name = 'eyes';
    return g;
  }

  _buildTubercles() {
    const L = this.sp.length;
    const g = new THREE.Group();
    const geo = new THREE.SphereGeometry(1, 12, 10);
    const n = 7;
    for (let i = 0; i < n; i++) {
      const u = 0.02 + i * 0.02;
      const t = new THREE.Mesh(geo, this._skinMat);
      const r = L * (0.01 + (i / n) * 0.008);
      const w = this.sp.maxWidth * L * catmullRom(WIDTH_PROFILE, u);
      const h = this.sp.maxHeight * L * catmullRom(HEIGHT_PROFILE, u);
      t.scale.set(r * 1.3, r * 0.8, r);
      t.position.set(L * (0.5 - u), h * 0.7, 0);
      g.add(t);
    }
    g.name = 'tubercles';
    this._model.add(g);
    return g;
  }

  // ---- animation ---------------------------------------------------------

  // state: { speed, thrust, turn, pitchRate, feeding, lunge }
  update(dt, state) {
    const L = this.sp.length;
    const k = (r) => 1 - Math.exp(-r * dt);

    // ---- tail beat: phase accumulates, so frequency changes never jump ----
    const thrust = state.thrust;
    const beatFreq = 0.22 + 0.42 * Math.min(thrust, 1.2) + 0.25 * Math.max(0, thrust - 1); // Hz
    this._phase = (this._phase + dt * beatFreq * Math.PI * 2) % (Math.PI * 200);
    // a slow idle undulation keeps a gliding whale alive
    const targetAmp = 0.012 + 0.06 * Math.min(thrust, 1) + 0.035 * Math.max(0, thrust - 1);
    this._beatAmp += (targetAmp - this._beatAmp) * k(2.5);
    this._turnS += (state.turn - this._turnS) * k(4);
    this._pitchS += (state.pitchRate - this._pitchS) * k(4);

    // rorquals balloon the throat pouch while engulfing, then slowly deflate
    const rorqual = this.sp.id !== 'sperm';
    const engulfTarget = rorqual && state.lunge > 0 ? 0.5 + state.lunge * 0.5 : 0;
    this._engulf += (engulfTarget - this._engulf) * k(engulfTarget > this._engulf ? 5 : 0.8);

    // ---- per-row spine displacement + slope ----
    const Nu = this._Nu, Nv = this._Nv;
    const dyA = this._rowDy, dzA = this._rowDz, syA = this._rowSy, szA = this._rowSz, pouch = this._rowPouch;
    const amp = this._beatAmp * L;
    const WAVE_K = 2.6; // radians of wave along the body (wavelength > body length)
    for (let i = 0; i <= Nu; i++) {
      const u = i / Nu;
      // amplitude envelope: small at the head, a node near the flippers, max at the fluke
      const env = (0.02 - 0.08 * u + 0.16 * u * u) / 0.1;
      const bend = Math.max(0, u - 0.25);
      const bendShape = (bend * bend) / 0.5625;
      // body follows its own path: tail swings toward the turn/pitch direction
      dyA[i] = amp * env * Math.sin(this._phase - WAVE_K * u) + this._pitchS * 0.05 * L * bendShape;
      dzA[i] = -this._turnS * 0.07 * L * bendShape;
      const p = (u - 0.08) / 0.45;
      pouch[i] = p > 0 && p < 1 ? Math.sin(p * Math.PI) * this._engulf : 0;
    }
    const dx = -L / Nu; // x decreases as u increases
    for (let i = 0; i <= Nu; i++) {
      const a = Math.max(0, i - 1), b = Math.min(Nu, i + 1);
      syA[i] = (dyA[b] - dyA[a]) / ((b - a) * dx);
      szA[i] = (dzA[b] - dzA[a]) / ((b - a) * dx);
    }

    // ---- deform the body: rotate each cross-section to the spine tangent ----
    const pos = this._bodyGeo.attributes.position.array;
    const nrm = this._bodyGeo.attributes.normal.array;
    const base = this._baseBody;
    const baseN = this._baseNormals;
    for (let i = 0; i <= Nu; i++) {
      const th = Math.atan(syA[i]), ps = Math.atan(szA[i]);
      const ct = Math.cos(th), st = Math.sin(th), cp = Math.cos(ps), sp = Math.sin(ps);
      const dy = dyA[i], dz = dzA[i], pch = pouch[i];
      for (let j = 0; j < Nv; j++) {
        const v = (i * Nv + j) * 3;
        const bx = base[v];
        let by = base[v + 1];
        let bz = base[v + 2];
        if (pch > 0 && by < 0) {
          // inflate the lower half of the cross-section downward and outward
          const lower = -by / (Math.abs(by) + Math.abs(bz) + 1e-5);
          by *= 1 + pch * 0.55 * lower;
          bz *= 1 + pch * 0.18 * lower;
        }
        // Z-rotation (vertical bend), then Y-rotation (lateral bend)
        const o1x = -by * st, o1y = by * ct;
        pos[v] = bx + o1x * cp - bz * sp;
        pos[v + 1] = dy + o1y;
        pos[v + 2] = dz + o1x * sp + bz * cp;

        const nx = baseN[v], ny = baseN[v + 1], nz = baseN[v + 2];
        const n1x = nx * ct - ny * st, n1y = nx * st + ny * ct;
        nrm[v] = n1x * cp - nz * sp;
        nrm[v + 1] = n1y;
        nrm[v + 2] = n1x * sp + nz * cp;
      }
    }
    this._bodyGeo.attributes.position.needsUpdate = true;
    this._bodyGeo.attributes.normal.needsUpdate = true;
    this._bodyGeo.computeBoundingSphere();

    // ---- fluke rides the tail tip, pitched a little past the spine tangent ----
    const tip = Nu;
    this._flukePivot.position.set(-L * 0.5, dyA[tip], dzA[tip]);
    const flukeLag = this._beatAmp * 4.0 * Math.cos(this._phase - WAVE_K);
    this._flukePivot.rotation.z = Math.atan(syA[tip]) * 1.25 - flukeLag * 0.35;
    this._flukePivot.rotation.y = -Math.atan(szA[tip]);

    // ---- attached parts follow the spine ----
    for (const [obj, u, p0, rz0] of this._riders) {
      const i = Math.round(u * Nu);
      obj.position.set(p0.x, p0.y + dyA[i], p0.z + dzA[i]);
      obj.rotation.z = rz0 + Math.atan(syA[i]);
    }

    // pectorals: symmetric stroke + pitch trim (mirrored per side), the inside
    // fin dips in turns, and they flare out when airborne
    this._airS += ((state.airborne ? 1 : 0) - this._airS) * k(state.airborne ? 4 : 1.5);
    const stroke = Math.sin(this._phase + 1.2) * 0.06 * Math.min(1, thrust + 0.3);
    const sym = stroke - this._pitchS * 0.25 - this._airS * (0.55 + 0.15 * Math.sin(state.time * 5));
    this._flipperL.rotation.x = -sym + this._turnS * 0.25;
    this._flipperR.rotation.x = sym + this._turnS * 0.25;
  }

  // Mouth position in whale-group space (includes the model's +X→-Z turn).
  getMouthPosition(out) {
    out.copy(this._mouthBase);
    out.y += this._rowDy[0];
    return out.applyAxisAngle(_Y, Math.PI / 2);
  }
}

const _Y = new THREE.Vector3(0, 1, 0);

export const WHALE_SPECIES = SPECIES;
