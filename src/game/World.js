import * as THREE from 'three';
import {
  makeSandTexture,
  makeCausticsTexture,
  makeSoftSprite,
  makeShaftTexture,
} from './textures.js';
import { zoneForDepth } from './species.js';

const SURFACE_Y = 0;
const FLOOR_Y = -84;

// --- Water surface shader (viewed from below) -----------------------------
const surfaceVert = /* glsl */ `
  varying vec3 vWorld;
  varying vec2 vLocal;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vLocal = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const surfaceFrag = /* glsl */ `
  uniform float uTime;
  uniform vec2 uSunPos;
  uniform vec3 uSkyColor;
  uniform vec3 uDeepColor;
  uniform vec3 uHorizonColor;
  uniform float uBrightness;
  varying vec3 vWorld;
  varying vec2 vLocal;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  void main() {
    vec2 p = vWorld.xz * 0.06;
    float c = 0.0;
    c += noise(p * 2.5 + uTime * 0.5);
    c += 0.5 * noise(p * 5.0 - uTime * 0.8);
    c += 0.25 * noise(p * 11.0 + uTime * 1.2);
    c /= 1.75;

    float d = distance(vWorld.xz, uSunPos);
    float sunGlow = smoothstep(34.0, 0.0, d);

    vec3 col = mix(uDeepColor, uSkyColor, clamp(sunGlow * 0.8 + c * 0.35, 0.0, 1.0));
    // bright sun core
    col += uSkyColor * pow(max(0.0, 1.0 - d / 30.0), 3.0) * 3.0 * uBrightness;
    // shimmering highlight
    col += uSkyColor * (c - 0.45) * 0.6 * uBrightness;

    // dissolve the plane's edge into the horizon so the "lid" has no hard
    // boundary where it meets the background dome.
    float dist = length(vLocal);
    float fade = 1.0 - smoothstep(160.0, 270.0, dist);
    col = mix(uHorizonColor, col, fade);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class World {
  constructor(scene) {
    this.scene = scene;
    this.waterLevel = SURFACE_Y;
    this.floorY = FLOOR_Y;
    this.time = 0;

    this._buildLights();
    this._buildSurface();
    this._buildFloor();
    this._buildRocks();
    this._buildKelp();
    this._buildSnow();
    this._buildRays();
    this._buildBackground();

    this._currentZone = -1;
    this._fogColor = new THREE.Color(0x1a6f7a);
    scene.fog = new THREE.FogExp2(this._fogColor.getHex(), 0.016);
  }

  // A huge interior sphere with a vertical depth gradient replaces the flat
  // background color — bright near the surface, fading to the fog color below.
  _buildBackground() {
    const geo = new THREE.SphereGeometry(300, 32, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x8fe0f0) },
        uBottom: { value: new THREE.Color(0x1a6f7a) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        varying vec3 vWorld;
        void main() {
          float t = smoothstep(-90.0, 8.0, vWorld.y);
          gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
        }
      `,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = -1000;
    dome.frustumCulled = false;
    dome.name = 'background';
    this.scene.add(dome);
    this._dome = dome;
    this._domeMat = mat;
  }

  // ---- lights ------------------------------------------------------------
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x9fd8ff, 0x0a2a3a, 0.55);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xeaf7ff, 1.4);
    this.sun.position.set(40, 60, 25);
    this.scene.add(this.sun);

    this.fill = new THREE.DirectionalLight(0x2a6f8f, 0.5);
    this.fill.position.set(-30, -10, -20);
    this.scene.add(this.fill);
  }

  // ---- water surface -----------------------------------------------------
  _buildSurface() {
    const geo = new THREE.PlaneGeometry(600, 600);
    geo.rotateX(Math.PI / 2); // now horizontal, normal +Y (up)
    this.surfaceMat = new THREE.ShaderMaterial({
      vertexShader: surfaceVert,
      fragmentShader: surfaceFrag,
      uniforms: {
        uTime: { value: 0 },
        uSunPos: { value: new THREE.Vector2(20, 15) },
        uSkyColor: { value: new THREE.Color(0x9fdcff) },
        uDeepColor: { value: new THREE.Color(0x0a4a5c) },
        uHorizonColor: { value: new THREE.Color(0x8fe0f0) },
        uBrightness: { value: 1.0 },
      },
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, this.surfaceMat);
    mesh.position.y = this.waterLevel;
    mesh.renderOrder = 10;
    this.scene.add(mesh);
    this.surface = mesh;
  }

  // ---- sea floor ---------------------------------------------------------
  _buildFloor() {
    const sand = makeSandTexture();
    const caustics = makeCausticsTexture();
    this._caustics = caustics;

    const mat = new THREE.MeshStandardMaterial({
      map: sand,
      bumpMap: sand,
      bumpScale: 0.6,
      roughness: 0.95,
      metalness: 0,
      emissive: 0x9fd8ff,
      emissiveMap: caustics,
      emissiveIntensity: 0.35,
    });
    const geo = new THREE.PlaneGeometry(600, 600, 96, 96);
    geo.rotateX(-Math.PI / 2);
    // rolling terrain so the seabed isn't a flat plane
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h =
        Math.sin(x * 0.06) * Math.cos(z * 0.05) * 3.0 +
        Math.sin(x * 0.13 + 1.7) * Math.sin(z * 0.11 + 0.6) * 1.6 +
        Math.sin(x * 0.31 + z * 0.27) * 0.5;
      pos.setY(i, h);
    }
    geo.computeVertexNormals();
    const floor = new THREE.Mesh(geo, mat);
    floor.position.y = this.floorY;
    this.scene.add(floor);
    this.floor = floor;
  }

  // ---- rocks -------------------------------------------------------------
  _buildRocks() {
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x5a5648,
      roughness: 0.9,
      metalness: 0.02,
    });
    const rockGeo = new THREE.IcosahedronGeometry(1, 2);
    this._rocks = new THREE.Group();
    const rand = (() => { let s = 3; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    for (let i = 0; i < 26; i++) {
      const r = 1.2 + rand() * 4.5;
      const rock = new THREE.Mesh(rockGeo, rockMat);
      const x = (rand() - 0.5) * 200;
      const z = (rand() - 0.5) * 200;
      rock.position.set(x, this.floorY + r * 0.5, z);
      rock.scale.set(r, r * (0.5 + rand() * 0.4), r);
      rock.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      this._rocks.add(rock);
    }
    this.scene.add(this._rocks);
  }

  // ---- kelp --------------------------------------------------------------
  _buildKelp() {
    this._kelp = new THREE.Group();
    const kelpMat = new THREE.MeshStandardMaterial({
      color: 0x3f9a66,
      roughness: 0.65,
      metalness: 0,
      side: THREE.DoubleSide,
      emissive: 0x0f3a22,
      emissiveIntensity: 0.7,
    });
    const rand = (() => { let s = 11; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    for (let i = 0; i < 44; i++) {
      const h = 7 + rand() * 15;
      const geo = new THREE.PlaneGeometry(1.6, h, 1, 10);
      // taper the ribbon
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const y = pos.getY(v) / h; // 0 at top (-1..0?)
        const t = 1 - Math.abs(y * 2 + 1); // 0..1 down the blade
        pos.setX(v, pos.getX(v) * (0.2 + t * 0.8));
      }
      geo.translate(0, h / 2, 0);
      const blade = new THREE.Mesh(geo, kelpMat);
      const x = (rand() - 0.5) * 180;
      const z = (rand() - 0.5) * 180;
      blade.position.set(x, this.floorY + h / 2, z);
      blade.userData = { baseRot: rand() * 3, h, phase: rand() * 6.28, speed: 0.4 + rand() * 0.6 };
      this._kelp.add(blade);
    }
    this.scene.add(this._kelp);
  }

  // ---- marine snow -------------------------------------------------------
  _buildSnow() {
    const count = 2400;
    this._snowCount = count;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    this._snowVel = new Float32Array(count);
    this._snowPos = pos;
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 150;
      pos[i * 3 + 1] = this.waterLevel - Math.random() * Math.abs(this.floorY);
      pos[i * 3 + 2] = (Math.random() - 0.5) * 150;
      this._snowVel[i] = 0.4 + Math.random() * 1.4;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xd8f2ff,
      size: 0.6,
      map: makeSoftSprite(),
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.snow = new THREE.Points(geo, mat);
    this.scene.add(this.snow);
  }

  // ---- god rays / light shafts ------------------------------------------
  _buildRays() {
    this._rays = new THREE.Group();
    const tex = makeShaftTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const rand = (() => { let s = 5; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    for (let i = 0; i < 16; i++) {
      const w = 16 + rand() * 34;
      const h = Math.abs(this.floorY) - 6;
      const geo = new THREE.PlaneGeometry(w, h);
      const ray = new THREE.Mesh(geo, mat);
      // cluster most shafts near the sun (surface shader's uSunPos) for a
      // coherent "sunbeams" look, with a few scattered for depth.
      const nearSun = i < 10;
      const x = nearSun ? 20 + (rand() - 0.5) * 44 : (rand() - 0.5) * 140;
      const z = nearSun ? 15 + (rand() - 0.5) * 44 : (rand() - 0.5) * 140;
      ray.position.set(x, this.waterLevel - 2 - h / 2, z);
      ray.rotation.x = rand() * 0.1 - 0.05;
      ray.rotation.z = rand() * 0.16 - 0.08;
      ray.userData = { phase: rand() * 6.28, speed: 0.08 + rand() * 0.16 };
      this._rays.add(ray);
    }
    this.scene.add(this._rays);
  }

  // ---- per-frame ---------------------------------------------------------
  update(dt, camera) {
    this.time += dt;
    const t = this.time;

    // caustics drift
    if (this._caustics) {
      this._caustics.offset.x += dt * 0.012;
      this._caustics.offset.y -= dt * 0.008;
    }

    // surface shimmer
    this.surfaceMat.uniforms.uTime.value = t;

    // keep the surface and background dome centered on the camera so their
    // fade-to-horizon is always symmetric around the player
    if (camera) {
      this.surface.position.x = camera.position.x;
      this.surface.position.z = camera.position.z;
      this._dome.position.copy(camera.position);
    }

    // marine snow drift
    const pos = this._snowPos;
    for (let i = 0; i < this._snowCount; i++) {
      const i3 = i * 3;
      pos[i3 + 1] -= this._snowVel[i] * dt;
      pos[i3] += Math.sin(t * 0.5 + i) * 0.004;
      pos[i3 + 2] += Math.cos(t * 0.4 + i) * 0.004;
      if (pos[i3 + 1] < this.floorY + 1) pos[i3 + 1] = this.waterLevel - 0.5;
    }
    this.snow.geometry.attributes.position.needsUpdate = true;

    // kelp sway
    for (const blade of this._kelp.children) {
      const ud = blade.userData;
      blade.rotation.z = Math.sin(t * ud.speed + ud.phase) * 0.12;
      blade.rotation.x = Math.cos(t * ud.speed * 0.8 + ud.phase) * 0.06;
    }

    // god rays gentle sway + billboard toward camera around Y
    for (const ray of this._rays.children) {
      const ud = ray.userData;
      ray.rotation.x = Math.sin(t * ud.speed + ud.phase) * 0.08;
      if (camera) {
        const dx = camera.position.x - ray.position.x;
        const dz = camera.position.z - ray.position.z;
        ray.rotation.y = Math.atan2(dx, dz);
      }
    }
  }

  // ---- zone / depth ------------------------------------------------------
  setDepth(depth) {
    const { zone, index } = zoneForDepth(depth);
    const targetFog = new THREE.Color(zone.fog);
    this._fogColor.lerp(targetFog, 0.03);
    this.scene.fog.color.copy(this._fogColor);
    this.scene.fog.density = zone.density;

    // background gradient: bright glow above, fog color below
    this._domeMat.uniforms.uBottom.value.copy(this._fogColor);
    this._domeMat.uniforms.uTop.value.set(0x8fe0f0).lerp(this._fogColor, 1 - zone.sky);
    this.surfaceMat.uniforms.uHorizonColor.value.copy(this._domeMat.uniforms.uTop.value);

    // dim lights + surface with depth
    const k = zone.sun;
    this.sun.intensity = 1.4 * k;
    this.hemi.intensity = 0.55 * (0.4 + 0.6 * zone.sky);
    this.surfaceMat.uniforms.uBrightness.value = zone.sky;
    this.floor.material.emissiveIntensity = 0.35 * k;

    if (index !== this._currentZone) {
      this._currentZone = index;
      return { zone, index, changed: true };
    }
    return { zone, index, changed: false };
  }
}
