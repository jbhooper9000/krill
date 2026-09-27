import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { WATER_GLSL, waterUniform, waterData, WATER_LEVEL, SLOT_LIGHT } from './WaterMedium.js';
import { makeTileableNoiseTexture } from './textures.js';

// -----------------------------------------------------------------------------
// Volumetric light shafts + auto exposure (one full-screen pass).
//
// For every pixel we reconstruct the world-space view ray from the depth
// buffer, clip it to its UNDERWATER part, and ray-march (16 jittered steps)
// single-scattered sunlight along it:
//     sum  beam(p) * exp(-Kd * depth(p) / cos) * exp(-c * t) * dt
//     * HG phase(view . sun) * scattering
// beam(p) is a slowly drifting noise pattern living on the surface, looked up
// by projecting p back up along the refracted sun direction — so the shafts
// are true 3D columns parallel to the sun, converge in perspective toward it,
// are occluded by geometry (the march stops at the depth buffer), and fade
// with depth because the sunlight feeding them is attenuated.
// Rejected alternatives: billboard planes (visible edges, wrong parallax) and
// screen-space radial blur from the sun position (only works when the sun is
// on screen; underwater it rarely is).
// -----------------------------------------------------------------------------
const ShaftShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tNoise: { value: null },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uStrength: { value: 1.0 },
    uExposure: { value: 1.0 },
    uFrame: { value: 0 },
    krillWater: waterUniform,
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    ${WATER_GLSL}
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tNoise;
    uniform mat4 uInvProj;
    uniform mat4 uCamWorld;
    uniform vec3 uCamPos;
    uniform float uStrength;
    uniform float uExposure;
    uniform float uFrame;
    varying vec2 vUv;

    float ign( vec2 p ) {
      return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
    }

    float beam( vec3 p, float depth ) {
      vec2 q = p.xz + KW_SUNW.xz * ( depth / max( KW_SUNW.y, 0.3 ) );
      float t = KW_TIME;
      float n = texture2D( tNoise, q * 0.021 + vec2( 0.0035, 0.0021 ) * t ).r * 0.62
              + texture2D( tNoise, q * 0.053 - vec2( 0.0052, 0.0031 ) * t ).r * 0.38;
      return smoothstep( 0.42, 0.78, n );
    }

    void main() {
      vec4 base = texture2D( tDiffuse, vUv );
      vec3 col = base.rgb;

      float z = texture2D( tDepth, vUv ).x;
      vec4 ndc = vec4( vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0 );
      vec4 vp = uInvProj * ndc;
      vp /= vp.w;
      vec3 wp = ( uCamWorld * vec4( vp.xyz, 1.0 ) ).xyz;
      vec3 ro = uCamPos;
      vec3 d = wp - ro;
      float L = length( d );
      vec3 dir = d / max( L, 1e-4 );
      if ( z >= 1.0 ) L = 1e4;

      // clip the ray to the water column
      float y0 = ro.y - KW_LEVEL;
      float t0 = 0.0;
      float t1 = min( L, 90.0 );
      if ( y0 > 0.0 ) {
        if ( dir.y >= - 1e-4 ) t1 = 0.0;
        else t0 = y0 / - dir.y;
        t1 = min( L, t0 + 90.0 );
      } else if ( dir.y > 1e-4 ) {
        t1 = min( t1, - y0 / dir.y );
      }

      if ( t1 > t0 && uStrength > 0.0 ) {
        const int N = 16;
        float dt = ( t1 - t0 ) / float( N );
        float j = ign( gl_FragCoord.xy + vec2( 5.588, 3.77 ) * mod( uFrame, 64.0 ) );
        vec3 acc = vec3( 0.0 );
        for ( int i = 0; i < N; i ++ ) {
          float t = t0 + ( float( i ) + j ) * dt;
          vec3 p = ro + dir * t;
          float depth = max( KW_LEVEL - p.y, 0.0 );
          vec3 sunT = KW_KEYT * exp( - kwTauDown( - depth ) / max( KW_SUNW.y, 0.3 ) );
          float ys = ro.y + dir.y * t0 - KW_LEVEL;
          vec3 viewT = exp( - ( KW_EXT + KW_DEXT * kwLayerMean( ys, - depth ) ) * ( t - t0 ) );
          // shafts need a little distance below the surface to form; the
          // plankton layer scatters much more (milky forward-scatter haze)
          float form = smoothstep( 0.0, 3.0, depth ) * ( 1.0 + 2.2 * kwLayer( - depth ) );
          acc += beam( p, depth ) * form * sunT * viewT;
        }
        acc *= dt;
        float cs = dot( dir, KW_SUNW );
        float ph = 0.75 * kwPhase( cs, 0.8 ) + 0.25 * kwPhase( cs, 0.25 );
        // scattering coefficient ~ blue-green part of the extinction
        vec3 scat = vec3( 0.02, 0.028, 0.03 );
        col += acc * scat * ph * KW_SUNCOL * uStrength * 9.0;
      }

      // Meniscus: when the camera straddles the waterline the near plane cuts
      // the surface; draw the thin dark water line a real lens shows there.
      vec4 nn = uInvProj * vec4( vUv * 2.0 - 1.0, - 1.0, 1.0 );
      nn /= nn.w;
      vec3 nearW = ( uCamWorld * vec4( nn.xyz, 1.0 ) ).xyz;
      float px = fwidth( nearW.y );
      float dy = abs( nearW.y - KW_LEVEL );
      float men = 1.0 - smoothstep( 0.0, px * 1.5, dy );          // thin core
      float film = 1.0 - smoothstep( 0.0, px * 9.0, dy );         // soft water film
      col *= ( 1.0 - 0.35 * men ) * ( 1.0 - 0.12 * film );

      gl_FragColor = vec4( col * uExposure, base.a );
    }
  `,
};

// Colour grade in linear HDR (before tone mapping in OutputPass): gentle
// saturation control and a soft lens vignette. Filmic, not stylised.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uUnderwater: { value: 1 },
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

    this.shafts = new ShaderPass(ShaftShader);
    this.shafts.uniforms.krillWater = waterUniform;
    this.shafts.uniforms.tNoise.value = makeTileableNoiseTexture(256, 8, 4, 3);
    this.shafts.uniforms.uInvProj.value = camera.projectionMatrixInverse;
    this.shafts.uniforms.uCamWorld.value = camera.matrixWorld;
    this.shafts.uniforms.uCamPos.value = camera.position;
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
  _targetExposure(y) {
    const light = Math.max(waterData[SLOT_LIGHT * 4 + 3], 1e-3);
    const adapt = Math.min(16, Math.pow(light, -0.62));
    if (y >= WATER_LEVEL) return 0.8 * adapt;
    const depth = WATER_LEVEL - y;
    return Math.min(6, 1.25 * Math.exp(0.034 * depth)) * adapt;
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
    u.uFrame.value = this._frame++ % 64;
    // the render pass draws into the composer's current read buffer
    u.tDepth.value = this.composer.readBuffer.depthTexture;
    this.grade.uniforms.uTime.value += dt;
    this.grade.uniforms.uUnderwater.value = cam.position.y < WATER_LEVEL ? 1 : 0;
    this.composer.render(dt);
  }
}
