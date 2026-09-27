import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { WATER_GLSL, waterUniform, waterData, WATER_LEVEL, SLOT_LIGHT } from './WaterMedium.js';
import { makeTileableNoiseTexture } from './textures.js';

// -----------------------------------------------------------------------------
// Underwater composite: volumetric light shafts + camera dehaze + meniscus +
// auto exposure.
//
// SHAFTS (half resolution). For every half-res pixel we reconstruct the view
// ray from the depth buffer, clip it to its UNDERWATER part, and ray-march
// (20 jittered steps) single-scattered sunlight along it:
//     sum  beam(p) * exp(-tau_down(p) / cos) * exp(-c * t) * dt
//     * phase(view . sun) * scattering
// beam(p) is a slowly drifting noise pattern living on the surface, looked up
// by projecting p back up along the refracted sun direction — so shafts are
// true 3D columns parallel to the sun, converge toward it, are occluded by
// geometry, and fade with depth.
//   The jitter is per-pixel WHITE noise re-seeded every frame (the previous
//   interleaved-gradient noise has a regular diagonal structure that showed as
//   a screen-wide "fishnet"), and the result is reconstructed at full res with
//   a DEPTH-AWARE bilateral 3x3 filter: taps whose march distance differs from
//   the pixel's own are rejected, so dither never bleeds across silhouettes
//   (the old per-pixel march traced a dotted outline around every whale).
//   Half res also makes the march ~4x cheaper.
//
// DEHAZE (full resolution, geometry only). Monterey water is a thick veil: at
// the 15–26 m follow distance ~70 % of a whale pixel is in-scattered light,
// so shading collapses to a flat silhouette even though the optics are right.
// Documentary colourists fix exactly this with a "dehaze" grade — they invert
// part of the haze model. We know the haze model exactly (kwWaterT gives the
// in-scatter and the transmittance T for this pixel's own view segment), so:
//     object = (col - inscatter) / T
//     out    = object * T' + inscatter * (1 - T') / (1 - T),  T' = T^(1-k)
// i.e. near objects are re-fogged as if the water were (1-k) as turbid, while
// far water (T -> 0) is untouched and keeps its colour and murk. Applied only
// where the depth buffer has geometry (never to the open-water background),
// per pixel (no halos), with the gain T'/T capped.
// Rejected: lowering the preset's extinction (brings back tropical clarity
// everywhere, including the long views), a per-species camera distance (not
// ours, and only helps one camera), a fill light (flattens form further).
// -----------------------------------------------------------------------------
const FSQ_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

// view-ray reconstruction shared by both shaders
const RAY_GLSL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;
  // returns world position; L = distance (1e4 for background), sets bg
  vec3 kwRay( vec2 uv, out vec3 dir, out float L, out bool bg ) {
    float z = texture2D( tDepth, uv ).x;
    vec4 vp = uInvProj * vec4( uv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0 );
    vp /= vp.w;
    vec3 wp = ( uCamWorld * vec4( vp.xyz, 1.0 ) ).xyz;
    vec3 d = wp - uCamPos;
    L = length( d );
    dir = d / max( L, 1e-4 );
    bg = z >= 1.0;
    if ( bg ) L = 1e4;
    return wp;
  }
`;

const MarchShader = {
  uniforms: {
    tDepth: { value: null },
    tNoise: { value: null },
    uInvProj: { value: null },
    uCamWorld: { value: null },
    uCamPos: { value: null },
    uStrength: { value: 1.0 },
    uFrame: { value: 0 },
    uFullTexel: { value: new THREE.Vector2(1, 1) },
    krillWater: waterUniform,
  },
  vertexShader: FSQ_VERT,
  fragmentShader: /* glsl */ `
    ${WATER_GLSL}
    ${RAY_GLSL}
    uniform sampler2D tNoise;
    uniform float uStrength;
    uniform float uFrame;
    varying vec2 vUv;

    // "hash without sine" (Dave Hoskins, MIT): white noise, no lattice
    float hash12( vec2 p ) {
      vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
      p3 += dot( p3, p3.yzx + 33.33 );
      return fract( ( p3.x + p3.y ) * p3.z );
    }

    // stepLen: march step in metres. The pattern is pre-filtered to the step
    // length with an EXPLICIT mip level: implicit (derivative-based) LOD is
    // garbage here, because neighbouring pixels sample the pattern at unrelated
    // jittered positions, which showed up as per-2x2-quad noise.
    float beam( vec3 p, float depth, float stepLen ) {
      vec2 q = p.xz + KW_SUNW.xz * ( depth / max( KW_SUNW.y, 0.3 ) );
      float t = KW_TIME;
      // octaves rotated against each other so the tiles never line up
      vec2 q2 = mat2( 0.8, - 0.6, 0.6, 0.8 ) * q;
      float l1 = clamp( log2( stepLen * 0.021 * 256.0 ), 0.0, 8.0 );
      float l2 = clamp( log2( stepLen * 0.053 * 256.0 ), 0.0, 8.0 );
      float n = textureLod( tNoise, q * 0.021 + vec2( 0.0035, 0.0021 ) * t, l1 ).r * 0.65
              + textureLod( tNoise, q2 * 0.053 - vec2( 0.0052, 0.0031 ) * t, l2 ).r * 0.35;
      return smoothstep( 0.4, 0.7, n );
    }

    uniform vec2 uFullTexel;
    void main() {
      // represent the 2x2 full-res block by its NEAREST surface, so edge texels
      // belong to the foreground consistently (no alternating dashes)
      // half-res texel i covers full-res pixels 2i and 2i+1 exactly (explicit
      // mapping: with an odd full-res size, uv-based mapping drifts by up to a
      // pixel and picked the wrong block along edges -> dashed outlines)
      vec2 fullPx = floor( gl_FragCoord.xy ) * 2.0 + 1.0;
      vec2 uvC = fullPx * uFullTexel;
      vec3 dir; float L = 1e9; bool bg = true;
      for ( int k = 0; k < 4; k ++ ) {
        vec2 o = vec2( float( k % 2 ), float( k / 2 ) ) - 0.5;
        vec2 uvk = min( ( fullPx + o ) * uFullTexel, vec2( 1.0 ) - 0.5 * uFullTexel );
        vec3 d2; float L2; bool b2;
        kwRay( uvk, d2, L2, b2 );
        if ( L2 < L ) { L = L2; bg = b2; }
      }
      { float Lc; bool bc; kwRay( uvC, dir, Lc, bc ); }
      vec3 ro = uCamPos;
      vec3 acc = vec3( 0.0 );

      // clip the ray to the water column
      float y0 = ro.y - KW_LEVEL;
      float t0 = 0.0;
      // Monterey visibility: beyond ~55 m the view transmittance is < 5 %
      float t1 = min( L, 55.0 );
      if ( y0 > 0.0 ) {
        if ( dir.y >= - 1e-4 ) t1 = 0.0;
        else t0 = y0 / - dir.y;
        t1 = min( L, t0 + 55.0 );
      } else if ( dir.y > 1e-4 ) {
        t1 = min( t1, - y0 / dir.y );
      }

      if ( t1 > t0 && uStrength > 0.0 ) {
        const int N = 24;
        float dt = ( t1 - t0 ) / float( N );
        float j = hash12( gl_FragCoord.xy + vec2( 37.0, 17.0 ) * mod( uFrame, 256.0 ) );
        float ys = ro.y + dir.y * t0 - KW_LEVEL;
        for ( int i = 0; i < N; i ++ ) {
          float t = t0 + ( float( i ) + j ) * dt;
          vec3 p = ro + dir * t;
          float depth = max( KW_LEVEL - p.y, 0.0 );
          vec3 sunT = KW_KEYT * exp( - kwTauDown( - depth ) / max( KW_SUNW.y, 0.3 ) );
          vec3 viewT = exp( - ( KW_EXT + KW_DEXT * kwLayerMean( ys, - depth ) ) * ( t - t0 ) );
          // Zero-mean: the average in-scatter is already in the water model
          // (kwWaterT); shafts only redistribute it into lit columns and
          // shadowed gaps, so they add structure without thickening the veil.
          float form = smoothstep( 0.0, 3.0, depth ) * ( 1.0 + 0.8 * kwLayer( - depth ) );
          acc += ( beam( p, depth, dt ) - 0.36 ) * form * sunT * viewT;
        }
        acc *= dt;
        float cs = dot( dir, KW_SUNW );
        float ph = 0.75 * kwPhase( cs, 0.8 ) + 0.25 * kwPhase( cs, 0.25 );
        vec3 scat = vec3( 0.02, 0.028, 0.03 );
        acc *= scat * ph * KW_SUNCOL * uStrength * 9.0;
      }
      // alpha carries the march distance for the bilateral reconstruction
      gl_FragColor = vec4( acc, min( L, 1e4 ) );
    }
  `,
};

const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tShaft: { value: null },
    uHalfSize: { value: new THREE.Vector2(1, 1) },
    uInvProj: { value: null },
    uCamWorld: { value: null },
    uCamPos: { value: null },
    uStrength: { value: 1.0 },
    uDehaze: { value: 0.5 },
    uExposure: { value: 1.0 },
    uDebug: { value: 0 }, // 1: show the reconstructed shaft term only
    krillWater: waterUniform,
  },
  vertexShader: FSQ_VERT,
  fragmentShader: /* glsl */ `
    ${WATER_GLSL}
    ${RAY_GLSL}
    uniform sampler2D tDiffuse;
    uniform sampler2D tShaft;
    uniform vec2 uHalfSize;
    uniform float uStrength;
    uniform float uDehaze;
    uniform float uExposure;
    uniform float uDebug;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D( tDiffuse, vUv );
      vec3 col = base.rgb;
      vec3 dir; float L; bool bg;
      vec3 wp = kwRay( vUv, dir, L, bg );

      // ---- dehaze (geometry only) ----
      if ( ! bg && uDehaze > 0.0 ) {
        vec3 T;
        vec3 ins = kwWaterT( vec3( 0.0 ), uCamPos, wp, T );
        vec3 Tc = max( T, vec3( 1e-4 ) );
        vec3 Tn = min( pow( Tc, vec3( 1.0 - uDehaze ) ), Tc * 3.0 );
        vec3 obj = max( col - ins, vec3( 0.0 ) ) / Tc;
        vec3 insN = ins * ( 1.0 - Tn ) / max( 1.0 - Tc, vec3( 1e-4 ) );
        col = obj * Tn + insN;
      }

      // ---- shafts: depth-aware bilateral upsample of the half-res march ----
      if ( uStrength > 0.0 ) {
        vec2 hp = ( gl_FragCoord.xy - 1.0 ) * 0.5; // half-res texel index (see march)
        vec2 c0 = floor( hp + 0.5 );
        vec3 sum = vec3( 0.0 );
        float wsum = 0.0;
        vec3 best = vec3( 0.0 );
        float bestD = 1e9;
        float tol = 0.12 * min( L, 200.0 ) + 0.5;
        for ( int j = - 1; j <= 1; j ++ ) {
          for ( int i = - 1; i <= 1; i ++ ) {
            vec2 tc = c0 + vec2( float( i ), float( j ) );
            vec4 s = texture2D( tShaft, ( tc + 0.5 ) / uHalfSize );
            float dL = abs( min( s.a, 1e4 ) - L );
            vec2 dd = tc - hp;
            float w = exp( - dot( dd, dd ) * 0.45 ) * exp( - dL / tol );
            sum += s.rgb * w;
            wsum += w;
            if ( dL < bestD ) { bestD = dL; best = s.rgb; }
          }
        }
        vec3 sh = wsum > 1e-3 ? sum / wsum : best;
        if ( uDebug > 2.5 ) { vec4 s0 = texture2D( tShaft, ( c0 + 0.5 ) / uHalfSize ); gl_FragColor = vec4( bg ? 1.0 : 0.0, s0.a > 5000.0 ? 1.0 : 0.0, wsum > 1e-3 ? 0.0 : 1.0, 1.0 ); return; }
        if ( uDebug > 1.5 ) { gl_FragColor = vec4( wsum > 1e-3 ? 0.0 : 1.0, clamp( wsum, 0.0, 1.0 ), bg ? 1.0 : 0.0, 1.0 ); return; }
        if ( uDebug > 0.5 ) { gl_FragColor = vec4( vec3( 0.5 ) + sh * 40.0, 1.0 ); return; }
        // zero-mean shafts may darken, but never below a fraction of the pixel
        col = max( col + sh, col * 0.55 );
      }

      // Meniscus: when the camera straddles the waterline the near plane cuts
      // the surface; draw the thin water line a real lens shows there.
      vec4 nn = uInvProj * vec4( vUv * 2.0 - 1.0, - 1.0, 1.0 );
      nn /= nn.w;
      vec3 nearW = ( uCamWorld * vec4( nn.xyz, 1.0 ) ).xyz;
      float px = fwidth( nearW.y );
      float dy = abs( nearW.y - KW_LEVEL );
      float men = 1.0 - smoothstep( 0.0, px * 1.5, dy );
      float film = 1.0 - smoothstep( 0.0, px * 9.0, dy );
      col *= ( 1.0 - 0.35 * men ) * ( 1.0 - 0.12 * film );

      gl_FragColor = vec4( col * uExposure, base.a );
    }
  `,
};

class UnderwaterPass extends Pass {
  constructor(camera, noise) {
    super();
    this.needsSwap = true;
    const mk = (shader) => {
      const m = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.clone(shader.uniforms),
        vertexShader: shader.vertexShader,
        fragmentShader: shader.fragmentShader,
        depthTest: false,
        depthWrite: false,
      });
      m.uniforms.krillWater = waterUniform;
      m.uniforms.uInvProj.value = camera.projectionMatrixInverse;
      m.uniforms.uCamWorld.value = camera.matrixWorld;
      m.uniforms.uCamPos.value = camera.position;
      return m;
    };
    this.marchMat = mk(MarchShader);
    this.compMat = mk(CompositeShader);
    this.marchMat.uniforms.tNoise.value = noise;
    // one shared strength uniform (0 skips the march loop too)
    this.marchMat.uniforms.uStrength = this.compMat.uniforms.uStrength;
    this.uniforms = this.compMat.uniforms; // uStrength, uDehaze, uExposure
    this.frame = this.marchMat.uniforms.uFrame;
    this.half = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    this.compMat.uniforms.tShaft.value = this.half.texture;
    this.marchQuad = new FullScreenQuad(this.marchMat);
    this.compQuad = new FullScreenQuad(this.compMat);
  }

  setSize(w, h) {
    const hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
    this.half.setSize(hw, hh);
    this.marchMat.uniforms.uFullTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
    this.compMat.uniforms.uHalfSize.value.set(hw, hh);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.marchMat.uniforms.tDepth.value = readBuffer.depthTexture;
    this.compMat.uniforms.tDepth.value = readBuffer.depthTexture;
    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.half);
    this.marchQuad.render(renderer);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.compQuad.render(renderer);
  }

  dispose() {
    this.half.dispose();
    this.marchMat.dispose();
    this.compMat.dispose();
    this.marchQuad.dispose();
    this.compQuad.dispose();
  }
}

// Colour grade in linear HDR (before tone mapping in OutputPass): gentle
// saturation control and a soft lens vignette. Filmic, not stylised.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uUnderwater: { value: 1 },
    uScotopic: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uUnderwater;
    uniform float uScotopic;
    varying vec2 vUv;

    void main() {
      vec3 c = max( texture2D( tDiffuse, vUv ).rgb, 0.0 );
      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );

      // AgX's base look is flat; add gentle contrast in log space around
      // middle grey (no clipping, no negative values).
      c = 0.18 * pow( c / 0.18, vec3( 1.1 ) );
      l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );

      // underwater footage is slightly desaturated in the mids; air is not
      c = mix( vec3( l ), c, mix( 1.0, 0.92, uUnderwater ) );

      // scotopic vision at high gain: rods see no colour, peak ~500 nm
      c = mix( c, vec3( l ) * vec3( 0.78, 0.95, 1.12 ), uScotopic );

      // lens vignette
      float d = length( ( vUv - 0.5 ) * vec2( 1.0, 0.8 ) );
      c *= 1.0 - smoothstep( 0.3, 0.85, d ) * 0.45;

      gl_FragColor = vec4( c, 1.0 );
    }
  `,
};

export class Effects {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.camera = camera;
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();

    // HDR target with a depth texture (needed by the shaft ray-march).
    // No MSAA: measured on an RTX 3070 at 1080p, any MSAA sample count on this
    // half-float + depth-texture target cost ~1.2 ms/frame (resolve blits),
    // i.e. 3x the whole rest of the pipeline; FXAA at the end costs ~0.03 ms.
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(size.x * pr, size.y * pr),
    });
    this.composer = new EffectComposer(renderer, rt);
    // EffectComposer clones rt for its second buffer, and a cloned texture
    // shares its Source — i.e. the SAME GL depth texture. The shaft pass reads
    // one buffer's depth while drawing into the other, so they must not share
    // it (feedback loop -> black frame).
    this.composer.renderTarget2.depthTexture = new THREE.DepthTexture(size.x * pr, size.y * pr);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.shafts = new UnderwaterPass(camera, makeTileableNoiseTexture(256, 8, 4, 3));
    this.composer.addPass(this.shafts);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      0.22, // strength — subtle
      0.6, // radius
      1.1 // threshold (HDR, after exposure)
    );
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    // FXAA on tone-mapped sRGB values (what it is designed for), last pass.
    this.fxaa = new ShaderPass(FXAAShader);
    this.fxaa.uniforms.resolution.value.set(1 / (size.x * pr), 1 / (size.y * pr));
    this.composer.addPass(this.fxaa);

    this._exposure = null;
    this._frame = 0;
  }

  resize(w, h) {
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.fxaa.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    this.bloom.resolution.set(w, h);
  }

  // Auto exposure, the way a camera operator rides the iris on a dive: the
  // light field falls off as ~exp(-Kd_green * depth); we compensate about half
  // of it (in log space) so depth still reads as darker, and stop down in air.
  // Night / dusk: adapt to about half of the (log) drop in surface light, so
  // night stays dark and moody but silhouettes against the surface read.
  // At night the "camera" goes scotopic: a dark-adapted eye / low-light
  // sensor gains far more than a photopic grade would (the grade then
  // desaturates toward blue-grey, see GradeShader), so a moonlit whale at 55 m
  // is a dim silhouette instead of pure black.
  _targetExposure(y) {
    const light = Math.max(waterData[SLOT_LIGHT * 4 + 3], 1e-3);
    // night lands at ~light^0.45 of the day look (moonlit ~ 12 %, not day-bright)
    const adapt = Math.min(20, Math.pow(light, -0.55));
    if (y >= WATER_LEVEL) return 0.8 * Math.min(12, adapt);
    const depth = WATER_LEVEL - y;
    // below the photic layer the eye keeps opening at night (rods), a bit
    // further than by day, so deep night water is dim rather than black
    const night = 1 - THREE.MathUtils.smoothstep(light, 0.03, 0.3);
    return Math.min(6 + 6 * night, 1.25 * Math.exp(0.034 * depth)) * adapt;
  }

  /** Snap auto exposure to its target on the next frame (cuts, teleports, tests). */
  resetExposure() {
    this._exposure = null;
  }

  render(dt) {
    const cam = this.camera;
    const target = this._targetExposure(cam.position.y);
    if (this._exposure === null) this._exposure = target;
    // fast when crossing the surface (sudden change of scene), slow otherwise
    const crossing = Math.abs(Math.log(target / this._exposure)) > 0.6;
    const k = 1 - Math.exp(-dt * (crossing ? 6 : 1.2));
    this._exposure += (target - this._exposure) * k;

    const u = this.shafts.uniforms;
    u.uExposure.value = this._exposure;
    this.shafts.frame.value = this._frame++ % 256;
    this.grade.uniforms.uTime.value += dt;
    this.grade.uniforms.uUnderwater.value = cam.position.y < WATER_LEVEL ? 1 : 0;
    this.grade.uniforms.uScotopic.value = 0.65 * THREE.MathUtils.smoothstep(this._exposure, 12, 90);
    this.composer.render(dt);
  }
}
