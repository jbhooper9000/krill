// A fast, configurable boids engine with spatial-hash neighbour lookup.
// Positions/velocities live in flat Float32Arrays so a caller can push them
// straight into InstancedMesh matrices.

const TMP = new Float32Array(3);

export class BoidSystem {
  constructor(count, params = {}) {
    this.count = count;
    this.params = Object.assign(
      {
        maxSpeed: 4,
        minSpeed: 0.4,
        neighborRadius: 6,
        separationRadius: 2.2,
        separationWeight: 1.6,
        alignmentWeight: 1.0,
        cohesionWeight: 0.9,
        wanderAmount: 0.8,
        wanderSpeed: 0.6,
        boundsSize: 60,
        boundsCenter: [0, -40, 0],
        boundsStrength: 0.6,
        drag: 0.35,
      },
      params
    );

    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.phase = new Float32Array(count);
    this.alive = new Uint8Array(count).fill(1);

    // externals: { type: 'flee'|'attract', position: [x,y,z], radius, strength }
    this.externals = [];

    this._grid = new Map();
    this._cell = this.params.neighborRadius || 6;
  }

  seed(center, spread = 18) {
    const { pos, vel, phase, count } = this;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      pos[i3] = center[0] + (Math.random() - 0.5) * spread;
      pos[i3 + 1] = center[1] + (Math.random() - 0.5) * spread;
      pos[i3 + 2] = center[2] + (Math.random() - 0.5) * spread;
      const a = Math.random() * Math.PI * 2;
      vel[i3] = Math.cos(a);
      vel[i3 + 1] = (Math.random() - 0.5) * 0.4;
      vel[i3 + 2] = Math.sin(a);
      phase[i] = Math.random() * Math.PI * 2;
      this.alive[i] = 1;
    }
  }

  _key(ix, iy, iz) {
    // pack into a single integer (world is small and bounded)
    return (ix + 512) + (iy + 512) * 1024 + (iz + 512) * 1048576;
  }

  _buildGrid() {
    const { pos, count } = this;
    const cell = this._cell;
    this._grid.clear();
    for (let i = 0; i < count; i++) {
      if (!this.alive[i]) continue;
      const i3 = i * 3;
      const ix = Math.floor(pos[i3] / cell);
      const iy = Math.floor(pos[i3 + 1] / cell);
      const iz = Math.floor(pos[i3 + 2] / cell);
      const k = this._key(ix, iy, iz);
      let arr = this._grid.get(k);
      if (!arr) {
        arr = [];
        this._grid.set(k, arr);
      }
      arr.push(i);
    }
  }

  _neighbors(i, out) {
    const { pos } = this;
    const cell = this._cell;
    const i3 = i * 3;
    const ix = Math.floor(pos[i3] / cell);
    const iy = Math.floor(pos[i3 + 1] / cell);
    const iz = Math.floor(pos[i3 + 2] / cell);
    out.length = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = this._grid.get(this._key(ix + dx, iy + dy, iz + dz));
          if (!arr) continue;
          for (let n = 0; n < arr.length; n++) {
            const j = arr[n];
            if (j !== i) out.push(j);
          }
        }
      }
    }
  }

  update(dt, time) {
    const { pos, vel, phase, alive, count, params: p } = this;
    const maxSpeed2 = p.maxSpeed * p.maxSpeed;
    const neigh = [];
    this._buildGrid();

    for (let i = 0; i < count; i++) {
      if (!alive[i]) continue;
      const i3 = i * 3;
      this._neighbors(i, neigh);

      let sx = 0, sy = 0, sz = 0; // separation
      let ax = 0, ay = 0, az = 0; // alignment
      let cx = 0, cy = 0, cz = 0; // cohesion
      let nCount = 0;

      for (let n = 0; n < neigh.length; n++) {
        const j = neigh[n];
        if (!alive[j]) continue;
        const j3 = j * 3;
        const dx = pos[i3] - pos[j3];
        const dy = pos[i3 + 1] - pos[j3 + 1];
        const dz = pos[i3 + 2] - pos[j3 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;

        ax += vel[j3];
        ay += vel[j3 + 1];
        az += vel[j3 + 2];
        cx += pos[j3];
        cy += pos[j3 + 1];
        cz += pos[j3 + 2];
        nCount++;

        if (d2 > 1e-6 && d2 < p.separationRadius * p.separationRadius) {
          const d = Math.sqrt(d2);
          const w = (1 - d / p.separationRadius) / d;
          sx += dx * w;
          sy += dy * w;
          sz += dz * w;
        }
      }

      let fx = 0, fy = 0, fz = 0;
      if (nCount > 0) {
        // separation
        fx += sx * p.separationWeight;
        fy += sy * p.separationWeight;
        fz += sz * p.separationWeight;
        // alignment
        fx += (ax / nCount - vel[i3]) * p.alignmentWeight;
        fy += (ay / nCount - vel[i3 + 1]) * p.alignmentWeight;
        fz += (az / nCount - vel[i3 + 2]) * p.alignmentWeight;
        // cohesion
        fx += (cx / nCount - pos[i3]) * p.cohesionWeight;
        fy += (cy / nCount - pos[i3 + 1]) * p.cohesionWeight;
        fz += (cz / nCount - pos[i3 + 2]) * p.cohesionWeight;
      }

      // wander (smooth noise via sin/cos of phase)
      const ph = phase[i];
      const wa = p.wanderAmount;
      fx += Math.sin(time * p.wanderSpeed + ph) * wa * 0.6 + Math.sin(time * p.wanderSpeed * 1.7 + ph * 2.1) * wa * 0.4;
      fy += Math.sin(time * p.wanderSpeed * 1.3 + ph * 1.3) * wa * 0.6;
      fz += Math.cos(time * p.wanderSpeed + ph * 1.1) * wa * 0.6 + Math.cos(time * p.wanderSpeed * 1.9 + ph) * wa * 0.4;

      // bounds (soft keep inside a box)
      const bc = p.boundsCenter, bs = p.boundsSize, bst = p.boundsStrength;
      const bx = pos[i3] - bc[0], by = pos[i3 + 1] - bc[1], bz = pos[i3 + 2] - bc[2];
      if (bx > bs) fx -= (bx - bs) * bst;
      else if (bx < -bs) fx -= (bx + bs) * bst;
      if (by > bs) fy -= (by - bs) * bst;
      else if (by < -bs) fy -= (by + bs) * bst;
      if (bz > bs) fz -= (bz - bs) * bst;
      else if (bz < -bs) fz -= (bz + bs) * bst;

      // external forces (flee from whale, attract to goal, etc.)
      for (let e = 0; e < this.externals.length; e++) {
        const ex = this.externals[e];
        if (!ex || !ex.active) continue;
        const dx = pos[i3] - ex.position[0];
        const dy = pos[i3 + 1] - ex.position[1];
        const dz = pos[i3 + 2] - ex.position[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        const r2 = ex.radius * ex.radius;
        if (d2 < r2 && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const falloff = 1 - d / ex.radius;
          const strength = ex.strength * falloff * falloff;
          const inv = 1 / d;
          if (ex.type === 'flee') {
            fx += dx * inv * strength;
            fy += dy * inv * strength;
            fz += dz * inv * strength;
          } else if (ex.type === 'attract') {
            fx -= dx * inv * strength;
            fy -= dy * inv * strength;
            fz -= dz * inv * strength;
          }
        }
      }

      // integrate
      vel[i3] += fx * dt;
      vel[i3 + 1] += fy * dt;
      vel[i3 + 2] += fz * dt;

      // drag toward cruise speed range
      const sp2 = vel[i3] * vel[i3] + vel[i3 + 1] * vel[i3 + 1] + vel[i3 + 2] * vel[i3 + 2];
      const sp = Math.sqrt(sp2) || 1e-5;
      let target = sp;
      if (sp > p.maxSpeed) target = sp - (sp - p.maxSpeed) * Math.min(1, p.drag * dt * 4);
      else if (sp < p.minSpeed) target = p.minSpeed;
      const k = target / sp;
      vel[i3] *= k;
      vel[i3 + 1] *= k;
      vel[i3 + 2] *= k;

      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
    }
  }

  // Mark a boid eaten (e.g. swallowed by the whale). Returns true if it was alive.
  remove(index) {
    if (!this.alive[index]) return false;
    this.alive[index] = 0;
    // park it far away so it doesn't render/interact
    const i3 = index * 3;
    this.pos[i3] = -99999;
    this.pos[i3 + 1] = -99999;
    this.pos[i3 + 2] = -99999;
    this.vel[i3] = this.vel[i3 + 1] = this.vel[i3 + 2] = 0;
    return true;
  }

  aliveCount() {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.alive[i]) n++;
    return n;
  }

  respawn(index, center, spread = 10) {
    const i3 = index * 3;
    this.pos[i3] = center[0] + (Math.random() - 0.5) * spread;
    this.pos[i3 + 1] = center[1] + (Math.random() - 0.5) * spread;
    this.pos[i3 + 2] = center[2] + (Math.random() - 0.5) * spread;
    const a = Math.random() * Math.PI * 2;
    this.vel[i3] = Math.cos(a) * this.params.maxSpeed;
    this.vel[i3 + 1] = (Math.random() - 0.5) * 0.4;
    this.vel[i3 + 2] = Math.sin(a) * this.params.maxSpeed;
    this.alive[index] = 1;
  }
}
