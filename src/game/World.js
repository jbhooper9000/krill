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
  SLOT_LIGHT,
  waterData,
  waterUniform,
  waterSlots,
  makeWaterAware,
  installWaterShading,
} from './WaterMedium.js';

const SURFACE_Y = 0;
const _tmpColor = new THREE.Color();
const FLOOR_Y = -84;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------
// Water optics presets (per RGB channel, 1/m). `ext` = beam extinction for the
// view ray, `kd` = diffuse attenuation of downwelling light, `w0` = horizontal
// water radiance just below the surface at a clear noon. `layer` adds a
// plankton layer (extra dExt / dKd) that is fully on above `top` and fades out
// by `bottom` (world y, metres).
//
// monterey   : summer upwelling / feeding season. Chlorophyll + CDOM absorb
//              blue, so the layer transmits green; heavy particulate
//              scattering gives the milky green-grey, short-visibility water
//              with bright forward-scatter haze. Below ~35 m (and offshore) the
//              water clears and turns blue. Visibility (contrast ~2%) in the
//              layer ~40 m green; a whale at 25 m reads as a soft silhouette.
// open-ocean : clear oligotrophic blue water (the previous look).
// ---------------------------------------------------------------------------
export const WATER_PRESETS = {
  monterey: {
    ext: [0.3, 0.044, 0.042],
    kd: [0.32, 0.06, 0.042],
    layer: { dExt: [0.1, 0.027, 0.048], dKd: [0.14, 0.045, 0.075], top: -8, bottom: -36 },
    w0: [0.07, 0.135, 0.13],
    forward: 0.7,
  },
  'open-ocean': {
    ext: [0.2, 0.04, 0.03],
    kd: [0.3, 0.068, 0.042],
    layer: { dExt: [0, 0, 0], dKd: [0, 0, 0], top: -8, bottom: -36 },
    w0: [0.012, 0.115, 0.17],
    forward: 0.4,
  },
};

const OPTICS = {
  floor: 0.045, // minimum light at depth (game readability)
  caustics: 0.95,
  causticScale: 0.6, // caustic cells per metre
  disc: 30, // key-light disc radiance / irradiance
  sunIrradiance: 2.9, // clear-noon sun (DirectionalLight intensity)
  moonIrradiance: 0.05, // full moon, exaggerated for play (real ~2e-6 of the sun)
};

// Monterey (36.8 N) in the summer feeding season (declination ~ +18 deg).
// Clock hours are local (PDT); solar noon at 121.9 W is ~13:05, which also
// matches Clock.daylight's dawn/dusk ramps.
const LAT = 36.8 * D2R;
const DECL = 18 * D2R;
const SOLAR_NOON = 13;

function celestialDir(hours, decl, out) {
  const H = (hours - SOLAR_NOON) * 15 * D2R;
  const E = -Math.cos(decl) * Math.sin(H);
  const N = Math.sin(decl) * Math.cos(LAT) - Math.cos(decl) * Math.sin(LAT) * Math.cos(H);
  const U = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H);
  return out.set(E, U, -N).normalize(); // world: x east, y up, z south
}

function refractIntoWater(air, out) {
  const h = Math.hypot(air.x, air.z);
  const sinA = Math.min(1, h); // sin of zenith angle in air (|air| = 1)
  const sinW = sinA / IOR_WATER;
  const cosW = Math.sqrt(1 - sinW * sinW);
  const k = h > 1e-6 ? sinW / h : 0;
  return out.set(air.x * k, cosW, air.z * k).normalize();
}

// Sky keyframes by sin(sun elevation): radiance (linear, same scale as the
// clear-noon sun irradiance of ~2.9).
const SKY_KEYS = [
  { s: -0.3, zen: [0.0004, 0.0006, 0.0015], hor: [0.0008, 0.001, 0.0017], glow: [0, 0, 0], cloud: [0.0008, 0.0009, 0.0013], haze: [0.001, 0.0011, 0.0015] },
  { s: -0.15, zen: [0.0008, 0.0016, 0.0045], hor: [0.003, 0.0032, 0.005], glow: [0.004, 0.0016, 0.0008], cloud: [0.002, 0.002, 0.0026], haze: [0.003, 0.003, 0.004] },
  { s: -0.05, zen: [0.0025, 0.005, 0.015], hor: [0.03, 0.022, 0.024], glow: [0.08, 0.03, 0.012], cloud: [0.035, 0.018, 0.016], haze: [0.025, 0.02, 0.022] },
  { s: 0.05, zen: [0.012, 0.03, 0.1], hor: [0.2, 0.16, 0.14], glow: [0.35, 0.17, 0.06], cloud: [0.4, 0.24, 0.16], haze: [0.2, 0.16, 0.15] },
  { s: 0.25, zen: [0.035, 0.13, 0.5], hor: [0.34, 0.48, 0.7], glow: [0.06, 0.03, 0.015], cloud: [0.95, 0.9, 0.86], haze: [0.58, 0.61, 0.66] },
  { s: 1.0, zen: [0.035, 0.15, 0.62], hor: [0.36, 0.55, 0.84], glow: [0, 0, 0], cloud: [1.05, 1.05, 1.05], haze: [0.62, 0.67, 0.74] },
];
const _sky = { zen: [0, 0, 0], hor: [0, 0, 0], glow: [0, 0, 0], cloud: [0, 0, 0], haze: [0, 0, 0] };
function skyAt(s) {
  let i = 0;
  while (i < SKY_KEYS.length - 2 && s > SKY_KEYS[i + 1].s) i++;
  const a = SKY_KEYS[i], b = SKY_KEYS[i + 1];
  const t = THREE.MathUtils.clamp((s - a.s) / (b.s - a.s), 0, 1);
  for (const k of ['zen', 'hor', 'glow', 'cloud', 'haze']) {
    for (let c = 0; c < 3; c++) _sky[k][c] = a[k][c] + (b[k][c] - a[k][c]) * t;
  }
  return _sky;
}
const smooth = THREE.MathUtils.smoothstep;

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

// The surface mesh: opaque Snell's window / TIR from below; from above the
// premultiplied reflection + foam with 'block' in alpha, blended as
//   out = src + (1 - block) * underwater   (ONE, ONE_MINUS_SRC_ALPHA).
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
      float block;
      col = kwSurfaceAbove( vWorld, v, dist, block );
      // aerial perspective toward the horizon
      float haze = 1.0 - exp( - dist / 1800.0 );
      col = mix( col, kwSky( normalize( vec3( v.x, 0.002, v.z ) ) ), haze );
      alpha = mix( block, 1.0, haze );
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
          float block;
          vec3 R = kwSurfaceAbove( hit, v, t, block );
          float haze = 1.0 - exp( - t / 1800.0 );
          R = mix( R, kwSky( normalize( vec3( v.x, 0.002, v.z ) ) ), haze );
          block = mix( block, 1.0, haze );
          col = R + ( 1.0 - block ) * col;
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
    vLight = kwAmbientTransmit( wp.xyz ) * T * KW_LIGHT;
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
  // options.flatFloor = false hides the flat arena floor, rocks and kelp (the
  // streamed Monterey terrain replaces them).
  constructor(scene, options = {}) {
    installWaterShading();
    this.scene = scene;
    this.waterLevel = SURFACE_Y;
    this.floorY = FLOOR_Y;
    this.time = 0;

    // --- public, read-only-ish state for other systems ---
    /** true when the camera is below the water surface (updated in update()) */
    this.isCameraUnderwater = true;
    /** unit vector pointing TOWARD the sun, in air (may point below the horizon at night) */
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    /** unit vector toward the sun as seen from under water (refracted) */
    this.sunDirectionWater = new THREE.Vector3(0, 1, 0);
    /** unit vector toward the moon (full moon, opposite the sun) */
    this.moonDirection = new THREE.Vector3(0, -1, 0);
    /** current key light (sun by day, moon by night), in air and refracted */
    this.keyDirection = new THREE.Vector3(0, 1, 0);
    this.keyDirectionWater = new THREE.Vector3(0, 1, 0);
    /** surface light level relative to a clear noon (0.002 at night .. 1) */
    this.lightLevel = 1;
    /** 0 at night .. 1 in full daylight (from the sun elevation) */
    this.daylight = 1;
    /** the shared water parameter block (see WaterMedium.js) */
    this.waterData = waterData;
    this.optics = { ...OPTICS };
    this.hours = 9;
    this.wind = { kts: 12, dirDeg: 300 };
    this.swell = { height: 1.8, period: 10, dirDeg: 305 };
    this.sky = { cloudCover: 0.3, marineLayer: 0.55 };

    this._noise = makeTileableNoiseTexture(256, 8, 4, 5);
    this._buildLights();
    this.setWaterPreset(options.water || 'monterey');
    this._buildSurface();
    this._buildFloor();
    this._buildRocks();
    this._buildKelp();
    this._buildSnow();
    this._buildBackground();
    if (options.flatFloor === false) {
      this.floor.visible = false;
      this._rocks.visible = false;
      this._kelp.visible = false;
    }

    this._currentZone = -1;
    this._fogColor = new THREE.Color(0x1a6f7a);
    // scene.fog is kept as the USE_FOG switch for three's shaders; its colour/
    // density are NOT used by the water model (see WaterMedium.js), but colour is
    // kept roughly in sync for any code that reads it.
    scene.fog = new THREE.FogExp2(this._fogColor.getHex(), 0.016);

    this.setWind(this.wind.kts, this.wind.dirDeg);
    this.setSwell(this.swell.height, this.swell.period, this.swell.dirDeg);
    this.setTimeOfDay(this.hours);
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

  // ---- water optics --------------------------------------------------------
  /** Switch the water body: 'monterey' (default, green plankton layer) or 'open-ocean'. */
  setWaterPreset(name) {
    const p = WATER_PRESETS[name] || WATER_PRESETS.monterey;
    this.waterPreset = WATER_PRESETS[name] ? name : 'monterey';
    this._preset = p;
    const { set3, setW } = waterSlots;
    set3(0, ...p.ext);
    setW(1, this.waterLevel);
    set3(2, ...p.kd);
    setW(4, this.optics.floor);
    setW(5, this.optics.causticScale);
    set3(8, ...p.layer.dExt);
    setW(8, this.waterLevel + p.layer.top);
    set3(9, ...p.layer.dKd);
    setW(9, this.waterLevel + p.layer.bottom);
    // image-based ambient: the underwater radiance distribution for this water
    if (this.envMap) this.envMap.dispose();
    const w0 = p.w0;
    this.envMap = makeUnderwaterEnvCube({
      window: [1.05, 1.3, 1.45],
      horizon: [w0[0] * 1.3, w0[1] * 1.3, w0[2] * 1.3],
      deep: [w0[0] * 0.2, w0[1] * 0.25, w0[2] * 0.3],
    });
    this.scene.environment = this.envMap;
    if (this.hours !== undefined && this.sun) this.setTimeOfDay(this.hours);
  }

  // ---- time of day -------------------------------------------------------
  /**
   * Set local time (hours 0..24, PDT). Moves the sun along a Monterey summer
   * path (and a full moon opposite it), sets the key light, sky colours, water
   * light level, caustics / shaft strength and star visibility. Cheap (no
   * allocation); safe to call every frame.
   */
  setTimeOfDay(hours) {
    if (!Number.isFinite(hours)) return;
    this.hours = ((hours % 24) + 24) % 24;
    const o = this.optics;
    const { set3, setW } = waterSlots;
    celestialDir(this.hours, DECL, this.sunDirection);
    celestialDir(this.hours + 12, -DECL, this.moonDirection);
    refractIntoWater(this.sunDirection, this.sunDirectionWater);
    const sSun = this.sunDirection.y;
    const sMoon = this.moonDirection.y;
    const cover = this.sky.cloudCover;
    const cloudDim = 1 - 0.6 * cover * cover;

    // key light: the sun until it is a little below the horizon, then the moon
    const sunUp = smooth(sSun, -0.02, 0.2);
    const moonUp = smooth(sMoon, -0.02, 0.2) * (1 - smooth(sSun, -0.12, 0.0));
    const useSun = sSun > -0.04;
    const warm = 1 - smooth(sSun, 0.03, 0.4);
    let kr, kg, kb, kI;
    if (useSun) {
      kr = 1.0; kg = 0.96 - 0.44 * warm; kb = 0.9 - 0.65 * warm;
      // air mass: a low sun is dimmer (and redder, above)
      const airMass = Math.exp(-0.1 * (1 / Math.max(sSun, 0.05) - 1));
      kI = o.sunIrradiance * sunUp * cloudDim * airMass;
      this.keyDirection.copy(this.sunDirection);
    } else {
      kr = 0.6; kg = 0.72; kb = 1.0; // moonlight, Purkinje-shifted toward blue
      kI = o.moonIrradiance * moonUp * cloudDim;
      this.keyDirection.copy(this.moonDirection);
    }
    refractIntoWater(this.keyDirection, this.keyDirectionWater);
    // Fresnel transmission of the direct beam into the water (grazing sun
    // mostly reflects off the sea: low-sun shafts and caustics fade)
    {
      const ci = Math.max(this.keyDirection.y, 0.02);
      const eta = 1 / IOR_WATER;
      const st2 = eta * eta * (1 - ci * ci);
      const ct = Math.sqrt(1 - st2);
      const rs = (eta * ci - ct) / (eta * ci + ct);
      const rp = (eta * ct - ci) / (eta * ct + ci);
      waterData[16 * 4] = 1 - 0.5 * (rs * rs + rp * rp);
    }
    this.sun.color.setRGB(kr, kg, kb);
    this.sun.intensity = kI;
    this.sun.position.copy(this.keyDirectionWater).multiplyScalar(100);
    this.daylight = sunUp;

    // diffuse skylight, relative to a clear noon
    const skyL = 0.0035 + 0.004 * moonUp + Math.pow(smooth(sSun, -0.18, 0.55), 1.6) * (1 - 0.3 * cover);
    const keyUp = Math.max(this.keyDirection.y, 0);
    const direct = (kI / o.sunIrradiance) * Math.min(1, keyUp / 0.8);
    const light = Math.max(0.002, 0.55 * skyL + 0.45 * direct);
    this.lightLevel = light;
    setW(SLOT_LIGHT, light);

    // underwater light field follows the surface light (slightly warm at golden hour)
    const w0 = this._preset.w0;
    const tint = 0.25 * warm * sunUp;
    set3(1, w0[0] * light * (1 + tint), w0[1] * light, w0[2] * light * (1 - 0.5 * tint));
    this.scene.environmentIntensity = light;
    this.hemi.intensity = 0.12 * skyL;
    set3(3, this.keyDirectionWater.x, this.keyDirectionWater.y, this.keyDirectionWater.z);
    setW(3, this._preset.forward * THREE.MathUtils.clamp(direct / light, 0, 1.6));
    set3(4, this.keyDirection.x, this.keyDirection.y, this.keyDirection.z);
    set3(5, kr * kI, kg * kI, kb * kI);
    setW(7, o.disc);
    // caustics need a high, direct key light
    setW(2, o.caustics * smooth(keyUp, 0.08, 0.45) * (1 - 0.7 * cover));

    // sky
    const sk = skyAt(sSun);
    const mz = 0.0015 * moonUp;
    set3(6, sk.zen[0] + mz, sk.zen[1] + mz * 1.3, sk.zen[2] + mz * 2.6);
    set3(7, sk.hor[0] + mz, sk.hor[1] + mz * 1.2, sk.hor[2] + mz * 2);
    const cd = 1 - 0.35 * cover;
    set3(12, sk.cloud[0] * cd, sk.cloud[1] * cd, sk.cloud[2] * cd);
    setW(12, cover);
    set3(13, ...sk.glow);
    setW(13, 1 - smooth(sSun, -0.22, -0.08));
    set3(14, this.sunDirection.x, this.sunDirection.y, this.sunDirection.z);
    setW(14, this.sky.marineLayer);
    set3(15, ...sk.haze);
  }

  /** Cloud cover 0..1 and marine-layer (horizon fog bank) strength 0..1. */
  setSky({ cloudCover, marineLayer } = {}) {
    if (Number.isFinite(cloudCover)) this.sky.cloudCover = THREE.MathUtils.clamp(cloudCover, 0, 1);
    if (Number.isFinite(marineLayer)) this.sky.marineLayer = THREE.MathUtils.clamp(marineLayer, 0, 1);
    this.setTimeOfDay(this.hours);
  }

  // ---- wind / sea state --------------------------------------------------
  /**
   * Wind at 10 m: speed in knots, direction in degrees it blows FROM
   * (meteorological, 0 = N, 90 = E). Drives wind-sea wavelength/steepness,
   * streaks, whitecap coverage (Monahan-style, exaggerated for visibility),
   * sun-glitter width and cloud drift.
   */
  setWind(speedKts, dirDeg) {
    if (!Number.isFinite(speedKts)) return;
    const kts = Math.max(0, speedKts);
    const dir = Number.isFinite(dirDeg) ? dirDeg : this.wind.dirDeg;
    this.wind.kts = kts;
    this.wind.dirDeg = dir;
    const U = kts * 0.5144;
    // downwind = opposite of where it blows from; world x = east, z = south
    const dx = -Math.sin(dir * D2R), dz = Math.cos(dir * D2R);
    const cov = Math.min(0.2, 3.84e-6 * Math.pow(U, 3.41) * 4);
    waterSlots.set3(10, dx, dz, U);
    waterSlots.setW(10, cov);
    waterSlots.setW(6, THREE.MathUtils.clamp(0.15 + U / 6, 0.15, 2.6));
  }

  /** Swell: significant height (m), period (s), direction it comes FROM (deg). */
  setSwell(heightM, periodS, dirDeg) {
    if (!Number.isFinite(heightM)) return;
    this.swell = { height: heightM, period: periodS || this.swell.period, dirDeg: Number.isFinite(dirDeg) ? dirDeg : this.swell.dirDeg };
    const d = this.swell.dirDeg * D2R;
    const wl = 1.56 * this.swell.period * this.swell.period; // deep-water wavelength
    waterSlots.set3(11, -Math.sin(d), Math.cos(d), heightM * 0.5);
    waterSlots.setW(11, wl);
  }

  // ---- lights ------------------------------------------------------------
  // Intensities are SURFACE values: the water shader attenuates them with the
  // depth of every shaded point (and projects caustics onto the key term).
  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x9fd8ff, 0x0a2230, 0.12);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff3e4, 2.7);
    this.sun.position.set(0, 100, 0);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
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
      // vertically the snow also wraps around the camera (the canyon is 3 km deep)
      const cy = camera ? camera.position.y : -40;
      const vHalf = 42, vSpan = 84;
      const top = this.waterLevel - 0.5;
      for (let i = 0; i < this._snowCount; i++) {
        const i3 = i * 3;
        pos[i3 + 1] -= this._snowVel[i] * dt;
        pos[i3] += Math.sin(t * 0.5 + i) * 0.004;
        pos[i3 + 2] += Math.cos(t * 0.4 + i) * 0.004;
        if (pos[i3 + 1] < cy - vHalf) pos[i3 + 1] = Math.min(top, pos[i3 + 1] + vSpan);
        else if (pos[i3 + 1] > Math.min(top, cy + vHalf)) pos[i3 + 1] -= vSpan;
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

  // Floating origin: the scene shifted by -(dx, dz) (see Terrain.onRebase).
  rebase(dx, dz) {
    const p = this._snowPos;
    for (let i = 0; i < this._snowCount; i++) { p[i * 3] -= dx; p[i * 3 + 2] -= dz; }
    this.snow.geometry.attributes.position.needsUpdate = true;
    for (const g of [this._rocks, this._kelp, this.floor]) {
      if (g) { g.position.x -= dx; g.position.z -= dz; }
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

    if (index !== this._currentZone) {
      this._currentZone = index;
      return { zone, index, changed: true };
    }
    return { zone, index, changed: false };
  }
}
