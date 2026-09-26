import * as THREE from 'three';
import { BoidSystem } from './Boids.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TUNING } from './Tuning.js';

function makeKrillGeometry() {
  const g = new THREE.SphereGeometry(0.5, 8, 6);
  g.scale(0.9, 0.2, 0.2); // elongated
  return g;
}

function makeFishGeometry() {
  const body = new THREE.SphereGeometry(0.5, 10, 8);
  body.scale(1.2, 0.44, 0.3);
  // vertical tail fin
  const tail = new THREE.BufferGeometry();
  const verts = new Float32Array([
    -0.55, 0, 0,
    -1.05, 0.34, 0,
    -1.05, -0.34, 0,
  ]);
  tail.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  tail.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0.5, 1, 1]), 2));
  tail.setIndex([0, 1, 2, 0, 2, 1]);
  tail.computeVertexNormals();
  const merged = mergeGeometries([body, tail]);
  return merged;
}

const _dummy = new THREE.Object3D();
const _mouth = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class KrillManager {
  constructor(scene, bounds) {
    this.scene = scene;
    this.bounds = bounds;

    this.krillClouds = [];
    this.fishSchools = [];
    this.totalEaten = 0;
    this.eatenThisFrame = 0;

    this._krillGeo = makeKrillGeometry();
    this._fishGeo = makeFishGeometry();
    this._krillMat = new THREE.MeshStandardMaterial({
      color: 0xf6b8cc,
      roughness: 0.5,
      metalness: 0,
      emissive: 0x4a1830,
      emissiveIntensity: 0.5,
    });
    this._fishMat = new THREE.MeshStandardMaterial({
      color: 0xb9ccd6,
      roughness: 0.35,
      metalness: 0.3,
      emissive: 0x1a2a33,
      emissiveIntensity: 0.25,
    });
  }

  _addKrillCloud(center) {
    const count = TUNING.krillCount;
    const system = new BoidSystem(count, {
      maxSpeed: TUNING.krillSpeed,
      minSpeed: 0.3,
      neighborRadius: 5,
      separationRadius: TUNING.krillSpacing,
      separationWeight: 2.2,
      alignmentWeight: 0.9,
      cohesionWeight: 1.4,
      wanderAmount: 0.5,
      wanderSpeed: 0.5,
      boundsSize: 14,
      boundsCenter: [center[0], center[1], center[2]],
      boundsStrength: 0.5,
    });
    system.seed(center, 14);

    const flee = { type: 'flee', position: [0, 0, 0], radius: 14, strength: 90, active: true };
    const home = { type: 'attract', position: [center[0], center[1], center[2]], radius: 60, strength: 2.5, active: true };
    system.externals = [flee, home];

    const mesh = new THREE.InstancedMesh(this._krillGeo, this._krillMat, count);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    this.krillClouds.push({
      system, mesh, flee, home,
      homeCenter: new THREE.Vector3(...center),
      respawn: [], // { index, delay }
    });
  }

  _addFishSchool(center) {
    const count = 70;
    const system = new BoidSystem(count, {
      maxSpeed: 6.5,
      minSpeed: 1.5,
      neighborRadius: 6,
      separationRadius: 1.6,
      separationWeight: 1.8,
      alignmentWeight: 1.6,
      cohesionWeight: 1.2,
      wanderAmount: 1.1,
      wanderSpeed: 0.7,
      boundsSize: 20,
      boundsCenter: [center[0], center[1], center[2]],
      boundsStrength: 0.6,
    });
    system.seed(center, 9);

    const flee = { type: 'flee', position: [0, 0, 0], radius: 10, strength: 120, active: true };
    const home = { type: 'attract', position: [center[0], center[1], center[2]], radius: 70, strength: 2.0, active: true };
    system.externals = [flee, home];

    const mesh = new THREE.InstancedMesh(this._fishGeo, this._fishMat, count);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    this.fishSchools.push({
      system, mesh, flee, home,
      homeCenter: new THREE.Vector3(...center),
    });
  }

  spawnAround(playerPos) {
    // three krill clouds + three fish schools, spread around the player depth
    const offsets = [
      [-34, 0, 20], [22, 6, -30], [40, -4, 12],
    ];
    for (const o of offsets) {
      const c = [playerPos.x + o[0], playerPos.y + o[1], playerPos.z + o[2]];
      this._addKrillCloud(c);
    }
    const fishOffsets = [[-20, 8, -40], [45, -2, 30], [10, -10, 50]];
    for (const o of fishOffsets) {
      const c = [playerPos.x + o[0], playerPos.y + o[1], playerPos.z + o[2]];
      this._addFishSchool(c);
    }
  }

  // Returns number of krill eaten this frame.
  update(dt, time, whale, controller, allowFeeding = true) {
    this.eatenThisFrame = 0;

    const mouthPos = controller.mouthPosition;
    const sp = whale.sp;
    const scale = whale.group.scale.x;
    const lunging = controller.state.isLunging;
    const mouthRadius = sp.mouthRadius * scale * (lunging ? TUNING.lungePower : 1.15);

    _mouth.copy(mouthPos);

    for (const cloud of this.krillClouds) {
      const sys = cloud.system;
      // live tuning
      sys.params.maxSpeed = TUNING.krillSpeed;
      sys.params.separationRadius = TUNING.krillSpacing;
      // steer flee + home toward current conditions
      cloud.flee.position[0] = whale.group.position.x;
      cloud.flee.position[1] = whale.group.position.y;
      cloud.flee.position[2] = whale.group.position.z;

      // home drifts slowly and follows player depth
      cloud.homeCenter.y += (Math.min(whale.group.position.y, -6) - cloud.homeCenter.y) * Math.min(1, dt * 0.15);
      cloud.homeCenter.x += Math.sin(time * 0.05 + cloud.homeCenter.x * 0.01) * dt * 1.2;
      cloud.homeCenter.z += Math.cos(time * 0.04 + cloud.homeCenter.z * 0.01) * dt * 1.2;
      cloud.home.position[0] = cloud.homeCenter.x;
      cloud.home.position[1] = cloud.homeCenter.y;
      cloud.home.position[2] = cloud.homeCenter.z;

      sys.update(dt, time);

      // feeding
      if (allowFeeding) {
        for (let i = 0; i < sys.count; i++) {
          if (!sys.alive[i]) continue;
          const i3 = i * 3;
          const dx = sys.pos[i3] - _mouth.x;
          const dy = sys.pos[i3 + 1] - _mouth.y;
          const dz = sys.pos[i3 + 2] - _mouth.z;
          const r2 = mouthRadius * mouthRadius;
          if (dx * dx + dy * dy + dz * dz < r2) {
            if (sys.remove(i)) {
              this.totalEaten++;
              this.eatenThisFrame++;
              cloud.respawn.push({ index: i, delay: 1.4 + Math.random() * 2.0 });
            }
          }
        }
      }

      // respawn queue
      for (let r = cloud.respawn.length - 1; r >= 0; r--) {
        cloud.respawn[r].delay -= dt;
        if (cloud.respawn[r].delay <= 0) {
          sys.respawn(cloud.respawn[r].index, cloud.homeCenter.toArray(), 12);
          cloud.respawn.splice(r, 1);
        }
      }

      this._writeInstances(cloud.mesh, sys, TUNING.krillSize);
    }

    for (const school of this.fishSchools) {
      const sys = school.system;
      school.flee.position[0] = whale.group.position.x;
      school.flee.position[1] = whale.group.position.y;
      school.flee.position[2] = whale.group.position.z;

      school.homeCenter.y += (Math.min(whale.group.position.y, -6) - school.homeCenter.y) * Math.min(1, dt * 0.1);
      school.homeCenter.x += Math.sin(time * 0.06 + school.homeCenter.z) * dt * 1.6;
      school.homeCenter.z += Math.cos(time * 0.05 + school.homeCenter.x) * dt * 1.6;
      school.home.position[0] = school.homeCenter.x;
      school.home.position[1] = school.homeCenter.y;
      school.home.position[2] = school.homeCenter.z;

      sys.update(dt, time);
      this._writeInstances(school.mesh, sys, 1);
    }

    return this.eatenThisFrame;
  }

  // Rebuild krill swarms (e.g. after a count change).
  rebuildKrill() {
    const homes = this.krillClouds.map((c) => c.homeCenter.clone());
    for (const cloud of this.krillClouds) {
      this.scene.remove(cloud.mesh);
      cloud.mesh.dispose();
    }
    this.krillClouds = [];
    for (const h of homes) this._addKrillCloud(h.toArray());
  }

  _writeInstances(mesh, system, scale = 1) {
    const { pos, vel, alive, count } = system;
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      if (!alive[i]) {
        _dummy.position.set(-99999, -99999, -99999);
        _dummy.scale.setScalar(0);
        _dummy.updateMatrix();
        mesh.setMatrixAt(i, _dummy.matrix);
        continue;
      }
      _dummy.position.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
      // orient +X along velocity, keep +Y roughly up
      const vx = vel[i3], vy = vel[i3 + 1], vz = vel[i3 + 2];
      const len = Math.hypot(vx, vy, vz) || 1;
      _xAxis.set(vx / len, vy / len, vz / len);
      _zAxis.crossVectors(_xAxis, _yAxis.set(0, 1, 0));
      if (_zAxis.lengthSq() < 1e-6) _zAxis.set(0, 0, 1);
      _zAxis.normalize();
      _yAxis.crossVectors(_zAxis, _xAxis).normalize();
      _m.makeBasis(_xAxis, _yAxis, _zAxis);
      _dummy.quaternion.setFromRotationMatrix(_m);
      _dummy.scale.setScalar(scale);
      _dummy.updateMatrix();
      mesh.setMatrixAt(i, _dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}
