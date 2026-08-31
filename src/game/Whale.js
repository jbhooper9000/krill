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
const WIDTH_PROFILE = [
  [0.0, 0.10], [0.06, 0.52], [0.16, 0.86], [0.30, 1.0], [0.46, 0.86],
  [0.62, 0.64], [0.75, 0.42], [0.85, 0.22], [0.93, 0.12], [1.0, 0.03],
];
const HEIGHT_PROFILE = [
  [0.0, 0.09], [0.06, 0.48], [0.16, 0.80], [0.30, 0.94], [0.46, 0.80],
  [0.62, 0.60], [0.75, 0.40], [0.85, 0.21], [0.93, 0.11], [1.0, 0.03],
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
    this._feedAmount = 0;
    this._build();
  }

  // ---- materials ---------------------------------------------------------

  _makeSkinMaterial() {
    const sp = this.sp;
    const map = makeSkinTexture(sp.skinTop, sp.skinBottom, sp.mottle, sp.id.length * 13);
    return new THREE.MeshPhysicalMaterial({
      map,
      color: 0xffffff,
      roughness: 0.42,
      metalness: 0.02,
      clearcoat: 0.55,
      clearcoatRoughness: 0.35,
      side: THREE.DoubleSide,
    });
  }

  // ---- construction ------------------------------------------------------

  _build() {
    this._body = this._buildBody();
    this._model.add(this._body);

    this._fluke = this._buildFluke();
    this._model.add(this._fluke);

    this._flipperL = this._buildFlipper(-1);
    this._flipperR = this._buildFlipper(1);
    this._model.add(this._flipperL, this._flipperR);

    this._dorsal = this._buildDorsal();
    this._model.add(this._dorsal);

    this._eyes = this._buildEyes();
    this._model.add(this._eyes);

    if (this.sp.id === 'humpback') this._buildTubercles();

    this._feedCone = this._buildFeedCone();
    this._model.add(this._feedCone);
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
    const tailWeight = new Float32Array(vertexCount);

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

        const tw = (u - 0.52) / (1 - 0.52);
        tailWeight[idx] = tw < 0 ? 0 : tw * tw;
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
    this._tailWeight = tailWeight;
    this._bodyGeo = geo;
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
    mesh.position.set(-L * 0.5 - C, 0, 0); // leading edge sits at the tail tip
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
  }

  _buildFeedCone() {
    const L = this.sp.length;
    const r = this.sp.mouthRadius * L * 0.28;
    const geo = new THREE.ConeGeometry(r, L * 0.5, 24, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x9fe8ff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const cone = new THREE.Mesh(geo, mat);
    cone.rotation.z = -Math.PI / 2; // apex points +X (out the nose, forward)
    cone.position.set(L * 0.62, -L * 0.02, 0);
    cone.name = 'feedCone';
    return cone;
  }

  // ---- animation ---------------------------------------------------------

  // state: { speed, turn, pitch, feeding, lunge, time }
  update(dt, state) {
    const L = this.sp.length;
    const t = state.time;

    const speedFactor = THREE.MathUtils.clamp(state.speed / 0.8, 0.2, 1.5);
    const beatFreq = 1.4 * speedFactor;
    const amp = 0.22 * speedFactor + state.lunge * 0.18;

    const pos = this._bodyGeo.attributes.position.array;
    const nrm = this._bodyGeo.attributes.normal.array;
    const base = this._baseBody;
    const baseN = this._baseNormals;
    const tw = this._tailWeight;
    const pivotX = -L * 0.02;

    for (let i = 0; i < base.length; i += 3) {
      const wgt = tw[i / 3];
      if (wgt <= 0) {
        // static vertices: keep base position/normal
        pos[i] = base[i];
        pos[i + 1] = base[i + 1];
        pos[i + 2] = base[i + 2];
        continue;
      }
      const bx = base[i], by = base[i + 1];
      const phase = t * beatFreq * Math.PI * 2 - wgt * 2.4;
      let angle = amp * wgt * Math.sin(phase);
      angle -= state.turn * 0.16 * wgt;

      const dx = bx - pivotX, dy = by;
      const ca = Math.cos(angle), sa = Math.sin(angle);
      pos[i] = pivotX + dx * ca - dy * sa;
      pos[i + 1] = dx * sa + dy * ca;
      pos[i + 2] = base[i + 2];

      // rotate the normal by the same angle about Z
      const nxx = baseN[i], nyy = baseN[i + 1];
      nrm[i] = nxx * ca - nyy * sa;
      nrm[i + 1] = nxx * sa + nyy * ca;
      nrm[i + 2] = baseN[i + 2];
    }
    this._bodyGeo.attributes.position.needsUpdate = true;
    this._bodyGeo.attributes.normal.needsUpdate = true;

    const flukeAngle = amp * 1.15 * Math.sin(t * beatFreq * Math.PI * 2) - state.turn * 0.2;
    this._fluke.rotation.z = flukeAngle;

    const fp = Math.sin(t * beatFreq * Math.PI * 2 + 1.2) * 0.12 * speedFactor + state.pitch * 0.4;
    this._flipperL.rotation.x = fp;
    this._flipperR.rotation.x = fp;

    this._feedAmount += ((state.feeding > 0 ? 1 : 0) - this._feedAmount) * Math.min(1, dt * 8);
    const cone = this._feedCone;
    const targetScale = 0.6 + state.lunge * 1.2 + state.feeding * 0.4;
    cone.scale.setScalar(THREE.MathUtils.lerp(cone.scale.x, targetScale, Math.min(1, dt * 6)));
    cone.material.opacity = this._feedAmount * (0.10 + state.lunge * 0.30);
    cone.visible = cone.material.opacity > 0.01;
  }

  get mouthPosition() {
    const L = this.sp.length;
    return new THREE.Vector3(L * 0.55, -L * 0.02, 0);
  }
}

export const WHALE_SPECIES = SPECIES;
