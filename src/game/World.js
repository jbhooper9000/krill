import * as THREE from 'three';
import {
  makeSandTexture,
  makeUnderwaterEnvCube,
  makeTileableNoiseTexture,
} from './textures.js';
import { zoneForDepth } from './species.js';
import {
  WATER_GLSL,
  SURFACE_GLSL,
  IOR_WATER,
  waterData,
  waterUniform,
  waterSlots,
  makeWaterAware,
  installWaterShading,
} from './WaterMedium.js';

const SURFACE_Y = 0;
const _tmpColor = new THREE.Color();
const FLOOR_Y = -84;

// ---------------------------------------------------------------------------
// Optical constants (per RGB channel, 1/m). Real clear-ocean values are
// roughly c = (0.35, 0.06, 0.03), Kd = (0.4, 0.07, 0.03); the game compresses
// ~1000 m of water column into 84 units, so Kd is a little stronger in green/
// blue (deep zones go dark) and c a little weaker (whales stay readable at the
// 25–40 m camera distance).
// ---------------------------------------------------------------------------
const OPTICS = {
  ext: [0.2, 0.04, 0.03], // beam extinction along the view ray
  kd: [0.3, 0.068, 0.042], // diffuse attenuation of downwelling light
  w0: [0.012, 0.115, 0.17], // horizontal water radiance just below the surface
  forward: 0.4, // sun forward-scatter glow in the water
  floor: 0.045, // minimum light at depth (game readability)
  caustics: 0.95,
  causticScale: 0.6, // caustic cells per metre
  sunColor: [1.0, 0.96, 0.9],
  zenith: [0.035, 0.15, 0.62],
  horizon: [0.36, 0.55, 0.84],
  waves: 1.0,
  sunDisc: 70,
};

// Sun in air: elevation 58 deg, in front-left of the default camera heading (-Z)
// so light shafts converge in view when swimming.
const SUN_ELEV = (58 * Math.PI) / 180;
const SUN_AZ = new THREE.Vector2(-0.45, -0.89).normalize();

// ---------------------------------------------------------------------------
// Surface + dome shaders
// ---------------------------------------------------------------------------
const commonVert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// The surface mesh: opaque Snell's window / TIR from below, Fresnel-weighted
// sky reflection composited (premultiplied) over the water from above.
const surfaceFrag = /* glsl */ `
  ${WATER_GLSL}
  ${SURFACE_GLSL}
  varying vec3 vWorld;
  void main() {
    vec3 ro = cameraPosition;
    vec3 d = vWorld - ro;
    float dist = length( d );
    vec3 v = d / dist;
    vec3 col;
    float alpha = 1.0;
    if ( ro.y < KW_LEVEL ) {
      col = kwSurfaceBelow( vWorld, v, dist );
      col = kwWater( col, ro, vWorld );
    } else {
      float F;
      col = kwSurfaceAbove( vWorld, v, dist, F );
      // grazing / distant: fade toward the analytic dome (horizon haze)
      float haze = 1.0 - exp( - dist / 700.0 );
      F = mix( F, 1.0, haze );
      col = mix( col, KW_HORIZ, haze * 0.6 );
      col *= F;
      alpha = F;
    }
    gl_FragColor = vec4( max( col, 0.0 ), alpha );
  }
`;

// Background: an analytic, infinite version of the same surface + sky, so the
// horizon never shows the edge of any mesh and matches the fog exactly.
const domeFrag = /* glsl */ `
  uniform mat4 projectionMatrix; // not in three's fragment prefix
  ${WATER_GLSL}
  ${SURFACE_GLSL}
  varying vec3 vWorld;
  void main() {
    vec3 ro = cameraPosition;
    vec3 v = normalize( vWorld - ro );
    float y0 = ro.y - KW_LEVEL;
    vec3 col;
    if ( y0 < 0.0 ) {
      if ( v.y > 1e-3 ) {
        float t = min( - y0 / v.y, 6000.0 );
        vec3 hit = ro + v * t;
        col = kwWater( kwSurfaceBelow( hit, v, t ), ro, hit );
      } else {
        col = kwWater( vec3( 0.0 ), ro, ro + v * 6000.0 );
      }
    } else {
      if ( v.y >= 0.0 ) {
        col = kwSky( v );
      } else {
        float t = min( y0 / - v.y, 6000.0 );
        vec3 hit = ro + v * t;
        // what lies under the surface: same formula the per-fragment fog
        // uses (unrefracted ray, like the geometry), so the sea floor and
        // everything else fade seamlessly into this colour.
        col = kwWater( vec3( 0.0 ), ro, hit + v * 6000.0 );
        // The surface mesh composites the reflection on top of this. Where
        // the mesh is missing — clipped by the near plane when the camera
        // straddles the waterline, or beyond its extent — do it here.
        float viewZ = - ( viewMatrix * vec4( hit, 1.0 ) ).z;
        float nearZ = projectionMatrix[ 3 ][ 2 ] / ( projectionMatrix[ 2 ][ 2 ] - 1.0 );
        if ( viewZ < nearZ || t > 280.0 ) {
          float F;
          vec3 R = kwSurfaceAbove( hit, v, t, F );
          float haze = 1.0 - exp( - t / 700.0 );
          F = mix( F, 1.0, haze );
          R = mix( R, KW_HORIZ, haze * 0.6 );
          col = mix( col, R, F );
        }
      }
    }
    gl_FragColor = vec4( max( col, 0.0 ), 1.0 );
  }
`;

// Marine snow: tiny lit particles, additive, attenuated (not in-scattered) by
// the water between them and the camera, lit by the light field at their depth.
const snowVert = /* glsl */ `
  ${WATER_GLSL}
  uniform float uPixelScale;
  uniform float uSize;
  varying vec3 vLight;
  varying float vAlpha;
  void main() {
    vec4 wp = modelMatrix * vec4( position, 1.0 );
    vec4 mv = viewMatrix * wp;
    gl_Position = projectionMatrix * mv;
    float h = fract( sin( dot( position.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    float size = uSize * ( 0.4 + h * 1.2 ) * uPixelScale / max( - mv.z, 0.1 );
    // defocused near particles become big faint discs rather than big blobs
    float clamped = min( size, 14.0 );
    gl_PointSize = max( clamped, 1.0 );
    vAlpha = min( 1.0, size * size ) * ( clamped / max( size, 1e-3 ) ) * ( 0.35 + 0.65 * h );
    vec3 T;
    kwWaterT( vec3( 0.0 ), cameraPosition, wp.xyz, T );
    vLight = kwAmbientTransmit( wp.xyz ) * T;
  }
`;
const snowFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vLight;
  varying float vAlpha;
  void main() {
    float r = length( gl_PointCoord - 0.5 ) * 2.0;
    float a = 1.0 - smoothstep( 0.35, 1.0, r );
    gl_FragColor = vec4( uColor * vLight * a * vAlpha * uOpacity, 1.0 );
  }
`;

export class World {
  constructor(scene) {
    installWaterShading();
    this.scene = scene;
    this.waterLevel = SURFACE_Y;
    this.floorY = FLOOR_Y;
    this.time = 0;

    // --- public, read-only-ish state for other systems ---
    /** true when the camera is below the water surface (updated in update()) */
    this.isCameraUnderwater = true;
    /** unit vector pointing TOWARD the sun, in air */
    this.sunDirection = new THREE.Vector3(
      Math.cos(SUN_ELEV) * SUN_AZ.x,
      Math.sin(SUN_ELEV),
      Math.cos(SUN_ELEV) * SUN_AZ.y
    ).normalize();
    /** unit vector pointing toward the sun as seen from under water (refracted) */
    this.sunDirectionWater = new THREE.Vector3();
    {
      const sinA = Math.cos(SUN_ELEV); // sin of zenith angle in air
      const sinW = sinA / IOR_WATER;
      const cosW = Math.sqrt(1 - sinW * sinW);
      this.sunDirectionWater.set(SUN_AZ.x * sinW, cosW, SUN_AZ.y * sinW).normalize();
    }
    /** the shared water parameter block (see WaterMedium.js) */
    this.waterData = waterData;
    this.optics = { ...OPTICS };
    this._extScale = 1;

    this._writeOptics();
    this._noise = makeTileableNoiseTexture(256, 8, 4, 5);
    this._buildLights();
    this._buildEnvironment();
    this._buildSurface();
    this._buildFloor();
    this._buildRocks();
    this._buildKelp();
    this._buildSnow();
    this._buildBackground();

    this._currentZone = -1;
    this._fogColor = new THREE.Color(0x1a6f7a);
    // scene.fog is kept as the USE_FOG switch for three's shaders; its colour/
    // density are NOT used by the water model (see WaterMedium.js), but colour is
    // kept roughly in sync for any code that reads it.
    scene.fog = new THREE.FogExp2(this._fogColor.getHex(), 0.016);
  }

  /**
   * Make a material water-aware. Built-in materials already are (global chunk
   * override) — this is only needed for custom ShaderMaterials (it adds the
   * fog + water uniforms; include <fog_pars_*>/<fog_*> chunks in the shader) or
   * for additive materials: patchMaterial(mat, { additive: true }).
   */
  patchMaterial(material, opts) {
    return makeWaterAware(material, opts);
  }

  _writeOptics() {
    const o = this.optics;
    const { set3, setW } = waterSlots;
    const e = this._extScale;
    set3(0, o.ext[0] * e, o.ext[1] * e, o.ext[2] * e);
    set3(1, ...o.w0);
    setW(1, this.waterLevel);
    set3(2, ...o.kd);
    setW(2, o.caustics);
    set3(3, this.sunDirectionWater.x, this.sunDirectionWater.y, this.sunDirectionWater.z);
    setW(3, o.forward);
    set3(4, this.sunDirection.x, this.sunDirection.y, this.sunDirection.z);
    setW(4, o.floor);
    set3(5, ...o.sunColor);
    setW(5, o.causticScale);
    set3(6, ...o.zenith);
    setW(6, o.waves);
    set3(7, ...o.horizon);
    setW(7, o.sunDisc);
  }

  // ---- lights ------------------------------------------------------------
  // Intensities are SURFACE values: the water shader attenuates them with the
  // depth of every shaded point (and projects caustics onto the sun term).
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x9fd8ff, 0x0a2230, 0.12);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff3e4, 2.7);
    this.sun.position.copy(this.sunDirectionWater).multiplyScalar(100);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  // Image-based ambient light: the underwater radiance distribution.
  _buildEnvironment() {
    const w0 = this.optics.w0;
    this.envMap = makeUnderwaterEnvCube({
      window: [1.05, 1.3, 1.45],
      horizon: [w0[0] * 1.3, w0[1] * 1.3, w0[2] * 1.3],
      deep: [w0[0] * 0.2, w0[1] * 0.25, w0[2] * 0.3],
    });
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 1.0;
  }

  // Background dome: analytic infinite surface + sky + deep water.
  _buildBackground() {
    const geo = new THREE.SphereGeometry(300, 48, 32);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { krillWater: waterUniform, kwNoise: { value: this._noise } },
      vertexShader: commonVert,
      fragmentShader: domeFrag,
    });
    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = -1000;
    dome.frustumCulled = false;
    dome.name = 'background';
    this.scene.add(dome);
    this._dome = dome;
    this._domeMat = mat;
  }

  // ---- water surface -----------------------------------------------------
  _buildSurface() {
    const geo = new THREE.PlaneGeometry(600, 600);
    geo.rotateX(-Math.PI / 2); // horizontal
    this.surfaceMat = new THREE.ShaderMaterial({
      vertexShader: commonVert,
      fragmentShader: surfaceFrag,
      uniforms: { krillWater: waterUniform, kwNoise: { value: this._noise } },
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(geo, this.surfaceMat);
    mesh.position.y = this.waterLevel;
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;
    mesh.name = 'waterSurface';
    this.scene.add(mesh);
    this.surface = mesh;
  }

  // ---- sea floor ---------------------------------------------------------
  _buildFloor() {
    const sand = makeSandTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: sand,
      bumpMap: sand,
      bumpScale: 0.6,
      roughness: 0.95,
      metalness: 0,
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
      color: 0x6b6558,
      roughness: 0.92,
      metalness: 0,
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
      color: 0x7a6a2a, // giant kelp is olive / golden brown
      roughness: 0.6,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const rand = (() => { let s = 11; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
    for (let i = 0; i < 44; i++) {
      const h = 7 + rand() * 15;
      const geo = new THREE.PlaneGeometry(1.6, h, 1, 10);
      // taper the ribbon
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const y = pos.getY(v) / h;
        const t = 1 - Math.abs(y * 2 + 1);
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
      this._snowVel[i] = 0.15 + Math.random() * 0.5;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this._snowMat = new THREE.ShaderMaterial({
      uniforms: {
        krillWater: waterUniform,
        uColor: { value: new THREE.Color(0.9, 0.95, 1.0) },
        uOpacity: { value: 0.55 },
        uSize: { value: 0.07 },
        uPixelScale: { value: 600 },
      },
      vertexShader: snowVert,
      fragmentShader: snowFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.snow = new THREE.Points(geo, this._snowMat);
    this.snow.frustumCulled = false; // particles wrap around the camera
    this.scene.add(this.snow);
  }

  // ---- per-frame ---------------------------------------------------------
  update(dt, camera) {
    this.time += dt;
    const t = this.time;
    waterSlots.setW(0, t);

    if (camera) {
      this.isCameraUnderwater = camera.position.y < this.waterLevel;
      // keep the surface and background dome centered on the camera
      this.surface.position.x = camera.position.x;
      this.surface.position.z = camera.position.z;
      this._dome.position.copy(camera.position);
      if (camera.isPerspectiveCamera) {
        const h = (typeof window !== 'undefined' ? window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.5) : 720);
        this._snowMat.uniforms.uPixelScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      }
    }

    // marine snow only exists (and is only visible) under water
    this.snow.visible = this.isCameraUnderwater;
    if (this.snow.visible) {
      const pos = this._snowPos;
      const cx = camera ? camera.position.x : 0;
      const cz = camera ? camera.position.z : 0;
      const half = 75, span = 150;
      for (let i = 0; i < this._snowCount; i++) {
        const i3 = i * 3;
        pos[i3 + 1] -= this._snowVel[i] * dt;
        pos[i3] += Math.sin(t * 0.5 + i) * 0.004;
        pos[i3 + 2] += Math.cos(t * 0.4 + i) * 0.004;
        if (pos[i3 + 1] < this.floorY + 1) pos[i3 + 1] = this.waterLevel - 0.5;
        if (pos[i3] - cx > half) pos[i3] -= span;
        else if (pos[i3] - cx < -half) pos[i3] += span;
        if (pos[i3 + 2] - cz > half) pos[i3 + 2] -= span;
        else if (pos[i3 + 2] - cz < -half) pos[i3 + 2] += span;
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
    }

    // kelp sway
    for (const blade of this._kelp.children) {
      const ud = blade.userData;
      blade.rotation.z = Math.sin(t * ud.speed + ud.phase) * 0.12;
      blade.rotation.x = Math.cos(t * ud.speed * 0.8 + ud.phase) * 0.06;
    }
  }

  // ---- zone / depth ------------------------------------------------------
  // Darkening/blueing with depth is physical (per-fragment, see WaterMedium);
  // zones only nudge turbidity and keep scene.fog.color in sync for others.
  setDepth(depth) {
    const { zone, index } = zoneForDepth(depth);
    this._fogColor.lerp(_tmpColor.set(zone.fog), 0.03);
    this.scene.fog.color.copy(this._fogColor);
    this.scene.fog.density = zone.density;

    const targetExt = 1 + (zone.density / 0.016 - 1) * 0.5;
    this._extScale += (targetExt - this._extScale) * 0.03;
    const e = this._extScale;
    const o = this.optics;
    waterSlots.set3(0, o.ext[0] * e, o.ext[1] * e, o.ext[2] * e);

    if (index !== this._currentZone) {
      this._currentZone = index;
      return { zone, index, changed: true };
    }
    return { zone, index, changed: false };
  }
}
