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

// ---- materials ------------------------------------------------------------
// Both are MeshStandardMaterial (so they get the water model: depth-attenuated
// sun + caustics + absorption, see WaterMedium.js) with small shader tweaks
// driven by the instance-local vertex position.

// Krill: translucent shell with orange-red chromatophores, a darker gut and
// black eyes at the head (+X is forward, along velocity). Sunlight passing
// THROUGH the thin body (looking toward the sun) and a little wrapped light
// give the glowing-translucent read; low-ish roughness gives the glints that
// make a swarm shimmer as individuals turn.
function makeKrillMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.38,
    metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vKLocal;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvKLocal = position;'
    );
    shader.fragmentShader = 'varying vec3 vKLocal;\n' + shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
	float kEye;
	float kGut;
	{
		float ax = vKLocal.x / 0.45;                 // -1 tail .. +1 head
		float chroma = 0.5 + 0.5 * sin( ax * 21.0 + vKLocal.z * 70.0 );
		vec3 shell = vec3( 0.82, 0.40, 0.24 );
		vec3 pigment = vec3( 0.62, 0.11, 0.05 );
		vec3 c = mix( shell, pigment, 0.35 + 0.45 * chroma * smoothstep( - 0.7, 0.5, ax ) );
		kGut = 1.0 - smoothstep( 0.0, 0.35, abs( ax - 0.15 ) );
		c = mix( c, vec3( 0.22, 0.2, 0.08 ), 0.45 * kGut );
		kEye = smoothstep( 0.6, 0.78, ax ) * smoothstep( 0.02, 0.055, abs( vKLocal.z ) );
		c = mix( c, vec3( 0.012 ), kEye );
		diffuseColor.rgb = c;
	}`
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
	#ifdef USE_FOG
	{
		vec3 kV = normalize( vViewPosition );
		float kBack = pow( saturate( dot( - kV, kwSunV ) ), 3.0 );
		float kWrap = saturate( dot( - normal, kwSunV ) * 0.5 + 0.5 );
		outgoingLight += diffuseColor.rgb * kwSunT * ( kBack * 1.1 + kWrap * 0.22 );
		outgoingLight += diffuseColor.rgb * kwAmbT * 0.06;
		// see-through body: the water radiance behind the animal, tinted by
		// the shell, replaces part of the reflected light (cheap stand-in for
		// real transmission, no sorting or extra passes)
		vec3 kDir = normalize( vKwWorld - cameraPosition );
		vec3 kBg = kwWaterRadiance( kDir ) * kwLightAt( vKwWorld.y - KW_LEVEL ) * 1.15;
		vec3 kTint = mix( vec3( 1.0 ), diffuseColor.rgb * 1.3, 0.6 );
		float kTrans = 0.5 * ( 1.0 - kEye ) * ( 1.0 - 0.6 * kGut );
		outgoingLight = mix( outgoingLight, kBg * kTint, kTrans );
	}
	#endif
	#include <opaque_fragment>`
      );
  };
  return mat;
}

// Fish: counter-shaded — dark blue-green, fairly matte back; mirror-like
// silver flanks (high metalness reflecting the underwater environment: the
// bright Snell's window above, dark water below) and a white belly.
function makeFishMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.14,
    metalness: 0.9,
    envMapIntensity: 1.8,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vFLocal;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvFLocal = position;'
    );
    shader.fragmentShader = 'varying vec3 vFLocal;\n' + shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
	float fBack = smoothstep( 0.02, 0.16, vFLocal.y );
	{
		float belly = smoothstep( - 0.05, - 0.18, vFLocal.y );
		vec3 flank = vec3( 0.92, 0.95, 0.97 );
		vec3 c = mix( flank, vec3( 0.95 ), belly );
		c = mix( c, vec3( 0.07, 0.16, 0.19 ), fBack );
		diffuseColor.rgb = c;
	}`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n\tmetalnessFactor = mix( metalnessFactor, 0.15, fBack );'
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, 0.55, fBack );'
      );
  };
  return mat;
}

const _dummy = new THREE.Object3D();
const _mouth = new THREE.Vector3();
const _xAxis = new THREE.Vector3();
const _yAxis = new THREE.Vector3();
const _zAxis = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _home = [0, 0, 0];

export class KrillManager {
  // terrain (optional): Terrain with heightAt/slopeAt — patches are placed in
  // deep-enough water near canyon edges and kept above the local seafloor.
  constructor(scene, bounds, terrain = null) {
    this.scene = scene;
    this.bounds = bounds;
    this.terrain = terrain;
    this._recycleTimer = 0;

    this.krillClouds = [];
    this.fishSchools = [];
    this.totalEaten = 0;
    this.eatenThisFrame = 0;

    this._krillGeo = makeKrillGeometry();
    this._fishGeo = makeFishGeometry();
    this._krillMat = makeKrillMaterial();
    this._fishMat = makeFishMaterial();
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
      depthOffset: (Math.random() - 0.5) * 16, // swarms spread through the DVM layer
      dead: [], // eaten boid indices, regrown slowly
      regrow: 0,
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

  // Krill patches are spread across the bay in the diel-migration layer
  // (krillY); anchovy schools stay near the surface.
  spawnAround(playerPos, krillY) {
    if (this.terrain) {
      // real bathymetry: pick sites in deep-enough water, favouring canyon edges
      const rings = [[30, 80], [60, 160], [90, 220], [120, 280]];
      for (const [r0, r1] of rings) {
        const s = this._pickSite(playerPos.x, playerPos.z, r0, r1, null);
        this._addKrillCloud([s.x, this._layerY(krillY, s.x, s.z), s.z]);
      }
    } else {
      const offsets = [[-34, 20], [60, -70], [-90, -40], [110, 60]];
      for (const o of offsets) {
        this._addKrillCloud([playerPos.x + o[0], krillY + (Math.random() - 0.5) * 12, playerPos.z + o[1]]);
      }
    }
    const fishOffsets = [[-20, -40], [45, 30], [10, 50]];
    for (const o of fishOffsets) {
      this._addFishSchool([playerPos.x + o[0], -8 - Math.random() * 10, playerPos.z + o[1]]);
    }
  }

  // Krill layer y at (x, z): the DVM layer, clamped above the local seafloor.
  _layerY(krillY, x, z) {
    let y = Math.min(-6, krillY);
    if (this.terrain) y = Math.max(y, this.terrain.heightAt(x, z) + 12);
    return Math.min(-6, y);
  }

  // Best of a few random candidates in a ring around (cx, cz): krill patches
  // need water deeper than ~45 m (E. pacifica live off the shelf) and gather on
  // canyon edges, where upwelled water and topography concentrate them.
  // dir (optional, {x, z} unit): bias candidates ahead of the player.
  _pickSite(cx, cz, r0, r1, dir) {
    let best = null, bestScore = -Infinity;
    for (let k = 0; k < 20; k++) {
      let a = Math.random() * Math.PI * 2;
      if (dir) a = Math.atan2(dir.z, dir.x) + (Math.random() - 0.5) * 2.2;
      const r = r0 + Math.random() * (r1 - r0);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const water = -this.terrain.heightAt(x, z);
      const slope = this.terrain.slopeAt(x, z);
      const score = (water < 45 ? -10 + water / 45 : Math.min(1, water / 200)) + 2 * Math.min(1, slope / 0.4) + Math.random() * 0.4;
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    }
    return best;
  }

  // Patches far behind the player dissolve and a new one forms ahead, so the
  // edgeless world always has prey within reach (checked every ~2 s).
  _recycle(dt, player, krillY, heading) {
    this._recycleTimer -= dt;
    if (this._recycleTimer > 0 || !this.terrain) return;
    this._recycleTimer = 2;
    const far = 700;
    for (const cloud of this.krillClouds) {
      const d = Math.hypot(cloud.homeCenter.x - player.x, cloud.homeCenter.z - player.z);
      if (d < far) continue;
      const s = this._pickSite(player.x, player.z, 180, 420, heading);
      const y = this._layerY(krillY + cloud.depthOffset, s.x, s.z);
      cloud.homeCenter.set(s.x, y, s.z);
      cloud.system.seed([s.x, y, s.z], 14);
      cloud.system.params.boundsCenter = [s.x, y, s.z];
      cloud.dead.length = 0;
      cloud.regrow = 0;
    }
    for (const school of this.fishSchools) {
      const d = Math.hypot(school.homeCenter.x - player.x, school.homeCenter.z - player.z);
      if (d < far) continue;
      const a = heading ? Math.atan2(heading.z, heading.x) + (Math.random() - 0.5) * 2 : Math.random() * 6.28;
      const r = 120 + Math.random() * 200;
      const x = player.x + Math.cos(a) * r, z = player.z + Math.sin(a) * r;
      const y = Math.max(-8 - Math.random() * 10, this.terrain.heightAt(x, z) + 4);
      school.homeCenter.set(x, Math.min(-3, y), z);
      school.system.seed(school.homeCenter.toArray(), 9);
      school.system.params.boundsCenter = school.homeCenter.toArray();
    }
  }

  // Floating origin: the scene shifted by -(dx, dz) (see Terrain.onRebase).
  rebase(dx, dz) {
    for (const g of [...this.krillClouds, ...this.fishSchools]) {
      const p = g.system.pos;
      for (let i = 0; i < g.system.count; i++) { p[i * 3] -= dx; p[i * 3 + 2] -= dz; }
      g.homeCenter.x -= dx; g.homeCenter.z -= dz;
      g.home.position[0] -= dx; g.home.position[2] -= dz;
      g.flee.position[0] -= dx; g.flee.position[2] -= dz;
      const bc = g.system.params.boundsCenter;
      g.system.params.boundsCenter = [bc[0] - dx, bc[1], bc[2] - dz];
    }
  }

  // Returns number of krill eaten this frame.
  // env: { krillY (DVM layer centre, world y), room (krill the stomach can still take) }
  update(dt, time, whale, controller, allowFeeding = true, env = { krillY: -40, room: Infinity }) {
    let room = env.room;
    this.eatenThisFrame = 0;

    const mouthPos = controller.mouthPosition;
    const sp = whale.sp;
    const scale = whale.group.scale.x;
    const lunging = controller.state.isLunging;
    const mouthRadius = sp.mouthRadius * scale * (lunging ? TUNING.lungePower : 1.15);

    _mouth.copy(mouthPos);
    const fwd = controller.forwardDir;
    const hl = Math.hypot(fwd.x, fwd.z);
    this._recycle(dt, whale.group.position, env.krillY, hl > 0.1 ? { x: fwd.x / hl, z: fwd.z / hl } : null);

    for (const cloud of this.krillClouds) {
      const sys = cloud.system;
      // live tuning
      sys.params.maxSpeed = TUNING.krillSpeed;
      sys.params.separationRadius = TUNING.krillSpacing;
      // steer flee + home toward current conditions
      cloud.flee.position[0] = whale.group.position.x;
      cloud.flee.position[1] = whale.group.position.y;
      cloud.flee.position[2] = whale.group.position.z;

      // home drifts slowly; its depth follows diel vertical migration
      const layerY = this._layerY(env.krillY + cloud.depthOffset, cloud.homeCenter.x, cloud.homeCenter.z);
      cloud.homeCenter.y += (layerY - cloud.homeCenter.y) * Math.min(1, dt * 0.02);
      if (this.terrain) {
        // drifting over rising ground: never sink into the seafloor
        cloud.homeCenter.y = Math.max(cloud.homeCenter.y, this.terrain.heightAt(cloud.homeCenter.x, cloud.homeCenter.z) + 8);
      }
      cloud.homeCenter.x += Math.sin(time * 0.05 + cloud.homeCenter.x * 0.01) * dt * 1.2;
      cloud.homeCenter.z += Math.cos(time * 0.04 + cloud.homeCenter.z * 0.01) * dt * 1.2;
      cloud.home.position[0] = cloud.homeCenter.x;
      cloud.home.position[1] = cloud.homeCenter.y;
      cloud.home.position[2] = cloud.homeCenter.z;

      sys.update(dt, time);

      // feeding
      if (allowFeeding) {
        for (let i = 0; i < sys.count && room > 0; i++) {
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
              room--;
              cloud.dead.push(i);
            }
          }
        }
      }

      // patches are finite: biomass regrows over game hours, not seconds
      if (cloud.dead.length > 0) {
        const perSecond = sys.count / ((TUNING.regrowHours * 3600) / TUNING.timeCompression);
        cloud.regrow += perSecond * dt;
        while (cloud.regrow >= 1 && cloud.dead.length > 0) {
          cloud.regrow -= 1;
          _home[0] = cloud.homeCenter.x; _home[1] = cloud.homeCenter.y; _home[2] = cloud.homeCenter.z;
          sys.respawn(cloud.dead.pop(), _home, 12);
        }
      } else {
        cloud.regrow = 0;
      }

      this._writeInstances(cloud.mesh, sys, TUNING.krillSize);
    }

    for (const school of this.fishSchools) {
      const sys = school.system;
      school.flee.position[0] = whale.group.position.x;
      school.flee.position[1] = whale.group.position.y;
      school.flee.position[2] = whale.group.position.z;

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
    // (rebuild resets biomass: it's a tuning tool)
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
