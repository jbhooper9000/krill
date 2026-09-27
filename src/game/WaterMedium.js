import * as THREE from 'three';

// =============================================================================
// Water medium — physically-motivated underwater light model shared by EVERY
// material in the scene.
//
// WHY A SHADER-CHUNK OVERRIDE (and not a depth-based post pass)?
//   * A post pass only sees the depth buffer, so transparent / additive things
//     (marine snow, splashes, the water surface itself) would be fogged with the
//     depth of whatever is BEHIND them. Doing it per-fragment is always right.
//   * Depth-of-the-lit-point effects (sunlight and ambient light attenuated on
//     their way DOWN to a surface, projected caustics that modulate only the
//     sun term) must happen inside the lighting equation anyway, i.e. in the
//     material shaders — so we are in there already.
//   * The camera can straddle the waterline (breaching). Per fragment we know
//     both the camera and the fragment world position, so we clip the view ray
//     analytically to its underwater segment: no absorption is ever applied to
//     the part of a ray that travels through air.
//
// HOW
//   three's built-in materials (Basic/Lambert/Phong/Standard/Physical/Toon/
//   Points/Sprite/...) all include <fog_pars_*> / <fog_*> and the lit ones
//   include <lights_fragment_begin> / <lights_fragment_maps>. We replace those
//   chunks in THREE.ShaderChunk once, before anything compiles, so every
//   material — including ones other code creates later — picks the model up for
//   free as long as `material.fog` is true (the default) and scene.fog is set
//   (World keeps a FogExp2 on the scene purely as the USE_FOG switch).
//
//   Parameters live in ONE shared uniform, `vec4 krillWater[8]`, backed by a
//   single Float32Array. We add it to every ShaderLib entry and UniformsLib.fog.
//   three's cloneUniforms() copies Vector/Color values but keeps typed arrays by
//   reference, so every material program uploads the same live array: updating
//   `waterData` once per frame updates the whole scene.
//
// MODEL (all per RGB channel, units = metres = world units)
//   view ray      : L = L0 * T + inscatter,  T = exp(-c * s)   (Beer–Lambert)
//                   s = length of the view segment BELOW the surface.
//   inscatter     : light field in the water falls off with depth as
//                   exp(Kd * y); integrating c * W(dir) * exp(Kd*y(t)) * T(t)
//                   along the segment has a closed form (see kwWater), so the
//                   fog colour correctly gets darker/bluer looking down and
//                   brighter looking up, and deep objects go blue-green-black.
//   sun at a point: exp(-Kd * depth / cos(theta_w)) * caustics(depth)
//   ambient/IBL   : exp(-Kd * depth) (+ a tiny artistic floor so the abyss is
//                   readable in a game)
//
// USING IT FROM OTHER CODE
//   * Built-in materials: nothing to do (keep material.fog = true).
//   * Additive-blended built-in materials (glows, sparkles): call
//     makeWaterAware(mat, { additive: true }) so they are only ATTENUATED and
//     do not add in-scattered light for every overlapping particle.
//   * Custom ShaderMaterial: call makeWaterAware(mat) (adds the fog + water
//     uniforms and sets fog:true) and include the standard three chunks:
//        vertex  : #include <fog_pars_vertex>  ...  (after mvPosition) #include <fog_vertex>
//        fragment: #include <fog_pars_fragment> ... (at the end)       #include <fog_fragment>
//     Or include WATER_GLSL yourself (declares the uniform + kw* functions) and
//     call kwWater(color, cameraPosition, worldPos) / kwSunTransmit(worldPos).
// =============================================================================

export const WATER_LEVEL = 0;
export const IOR_WATER = 1.333;

// Shared parameter block. Layout mirrors the #defines in WATER_GLSL.
export const waterData = new Float32Array(8 * 4);
export const waterUniform = { value: waterData };

// slot helpers
const set3 = (slot, x, y, z) => {
  waterData[slot * 4] = x;
  waterData[slot * 4 + 1] = y;
  waterData[slot * 4 + 2] = z;
};
const setW = (slot, w) => {
  waterData[slot * 4 + 3] = w;
};
export const waterSlots = { set3, setW };

export const WATER_GLSL = /* glsl */ `
uniform vec4 krillWater[ 8 ];
#define KW_EXT    krillWater[0].xyz   // beam extinction c (1/m) for the view ray
#define KW_TIME   krillWater[0].w
#define KW_W0     krillWater[1].xyz   // horizontal water radiance just below the surface
#define KW_LEVEL  krillWater[1].w     // water level (y)
#define KW_KD     krillWater[2].xyz   // diffuse attenuation of downwelling light (1/m)
#define KW_CAUST  krillWater[2].w     // caustics strength
#define KW_SUNW   krillWater[3].xyz   // direction TO the sun, refracted into the water
#define KW_FWD    krillWater[3].w     // forward-scattering sun glow strength
#define KW_SUNA   krillWater[4].xyz   // direction TO the sun in air
#define KW_FLOOR  krillWater[4].w     // artistic minimum light level at depth
#define KW_SUNCOL krillWater[5].xyz   // sun colour (radiance scale for sky / glints)
#define KW_CSCALE krillWater[5].w     // caustic cells per metre
#define KW_ZENITH krillWater[6].xyz   // sky zenith radiance
#define KW_WAVES  krillWater[6].w     // wave slope scale
#define KW_HORIZ  krillWater[7].xyz   // sky horizon radiance
#define KW_SUNI   krillWater[7].w     // sun disc radiance multiplier

vec2 kwHash2( vec2 p ) {
	p = vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) );
	return fract( sin( p ) * 43758.5453 );
}

// Distance to the nearest border of an animated Voronoi cell (F2 - F1).
// Caustic light concentrates along such a network of bright filaments.
float kwCellEdge( vec2 p, float t ) {
	vec2 ip = floor( p );
	vec2 fp = fract( p );
	float d1 = 8.0;
	float d2 = 8.0;
	for ( int y = - 1; y <= 1; y ++ ) {
		for ( int x = - 1; x <= 1; x ++ ) {
			vec2 g = vec2( float( x ), float( y ) );
			vec2 o = kwHash2( ip + g );
			o = 0.5 + 0.4 * sin( t + 6.2831 * o );
			vec2 r = g + o - fp;
			float d = dot( r, r );
			if ( d < d1 ) { d2 = d1; d1 = d; } else if ( d < d2 ) { d2 = d; }
		}
	}
	return sqrt( d2 ) - sqrt( d1 );
}

// Caustic irradiance multiplier (mean ~1) for a point 'depth' metres below the
// surface. The pattern lives on the surface and is projected along the
// refracted sun direction, so it lands consistently on floor, rocks, whale and
// krill. Filaments defocus (widen, lose contrast) with depth.
float kwCaustics( vec3 wp, float depth ) {
	vec2 q = ( wp.xz + KW_SUNW.xz * ( depth / max( KW_SUNW.y, 0.3 ) ) ) * KW_CSCALE;
	float t = KW_TIME;
	float w = 0.045 + depth * 0.0045;
	float e1 = kwCellEdge( q + vec2( 0.11, 0.05 ) * t, t * 0.65 );
	float e2 = kwCellEdge( q * 1.43 + vec2( 3.7, 9.1 ) - vec2( 0.07, 0.12 ) * t, t * 0.8 + 2.0 );
	float iw = 1.0 / ( w * w );
	float l = exp( - e1 * e1 * iw ) + exp( - e2 * e2 * iw );
	float mean = min( 1.6, 4.3 * w );
	float amp = KW_CAUST * exp( - depth / 30.0 ) * smoothstep( 0.0, 2.5, depth );
	return max( 0.0, mix( 1.0, l / mean, amp ) );
}

// Light-at-depth for the diffuse (ambient / sky) field, with a small bluish
// floor so deep scenes stay legible (a game compromise, documented).
vec3 kwLightAt( float y ) {
	return exp( KW_KD * min( y, 0.0 ) ) + KW_FLOOR * vec3( 0.05, 0.35, 1.0 );
}

vec3 kwAmbientTransmit( vec3 wp ) {
	return kwLightAt( wp.y - KW_LEVEL );
}

// Direct sunlight arriving at wp: slant-path attenuation * projected caustics.
vec3 kwSunTransmit( vec3 wp ) {
	float depth = KW_LEVEL - wp.y;
	if ( depth <= 0.0 ) return vec3( 1.0 );
	vec3 T = exp( - KW_KD * depth / max( KW_SUNW.y, 0.3 ) );
	return T * kwCaustics( wp, depth );
}

float kwPhase( float cosT, float g ) {
	float g2 = g * g;
	return ( 1.0 - g2 ) / ( 12.5664 * pow( max( 1.0 + g2 - 2.0 * g * cosT, 1e-4 ), 1.5 ) );
}

// Radiance of an infinitely long underwater path starting at the surface, per
// direction: brighter looking up (downwelling light), much darker looking down,
// plus the forward-scattering glow around the refracted sun.
vec3 kwWaterRadiance( vec3 dir ) {
	float up = dir.y;
	float ang = up >= 0.0 ? 1.0 + 1.4 * up * up : 1.0 - 0.72 * sqrt( - up );
	float sun = KW_FWD * kwPhase( dot( dir, KW_SUNW ), 0.82 );
	return KW_W0 * ( ang + sun ) + KW_SUNCOL * KW_W0 * sun * 0.6;
}

// Beer–Lambert absorption + single-scattering in-scatter along the UNDERWATER
// part of the segment ro -> p. Returns the new colour; T is the transmittance.
vec3 kwWaterT( vec3 col, vec3 ro, vec3 p, out vec3 T ) {
	T = vec3( 1.0 );
	vec3 d = p - ro;
	float L = length( d );
	if ( L < 1e-4 ) return col;
	vec3 dir = d / L;
	float y0 = ro.y - KW_LEVEL;
	float y1 = p.y - KW_LEVEL;
	float s;
	float startY;
	if ( y0 <= 0.0 && y1 <= 0.0 ) {
		s = L; startY = y0;
	} else if ( y0 > 0.0 && y1 > 0.0 ) {
		return col; // entirely in air
	} else {
		float f = y0 / ( y0 - y1 );
		if ( y0 > 0.0 ) { s = L * ( 1.0 - f ); startY = 0.0; } // camera in air
		else { s = L * f; startY = y0; }                       // ray exits to air
	}
	vec3 c = KW_EXT;
	T = exp( - c * s );
	// in-scatter: integral_0^s c W e^{Kd (startY + dir.y t)} e^{-c t} dt
	vec3 a = c - KW_KD * dir.y;
	a = mix( a, vec3( 1e-4 ), step( abs( a ), vec3( 1e-4 ) ) );
	vec3 g = ( 1.0 - exp( - a * s ) ) / a;
	vec3 W = kwWaterRadiance( dir );
	vec3 floorL = KW_FLOOR * vec3( 0.05, 0.35, 1.0 );
	vec3 ins = W * ( c * g * exp( KW_KD * startY ) + floorL * ( 1.0 - T ) );
	return col * T + ins;
}

vec3 kwWater( vec3 col, vec3 ro, vec3 p ) {
	vec3 T;
	return kwWaterT( col, ro, p, T );
}
`;

// ---------------------------------------------------------------------------
// Surface / sky GLSL (used by World's surface mesh and background dome).
// ---------------------------------------------------------------------------
export const SURFACE_GLSL = /* glsl */ `
// Sum of directional travelling waves (deep-water dispersion w = sqrt(g k))
// plus two scrolling layers of noise-derived detail normals that break up the
// regularity, returning the up-facing normal. Short waves fade with distance
// (by pixel footprint) to avoid aliasing into noise on the far surface.
uniform sampler2D kwNoise;
vec2 kwNoiseGrad( vec2 uv ) {
	const float e = 1.0 / 256.0;
	float c = texture2D( kwNoise, uv ).r;
	return vec2( texture2D( kwNoise, uv + vec2( e, 0.0 ) ).r - c, texture2D( kwNoise, uv + vec2( 0.0, e ) ).r - c ) / e;
}
vec3 kwWaveNormal( vec2 xz, float dist ) {
	float t = KW_TIME;
	vec2 grad = vec2( 0.0 );
	float wl = 21.0;
	for ( int i = 0; i < 9; i ++ ) {
		float fi = float( i );
		float ang = 0.55 + sin( fi * 2.3999 + 0.4 ) * 1.25;   // spread around the wind
		vec2 dd = vec2( cos( ang ), sin( ang ) );
		float k = 6.2831 / wl;
		float w = sqrt( 9.81 * k );
		float ph = k * dot( dd, xz ) - w * t + fi * 1.93;
		float fade = 1.0 - smoothstep( wl * 45.0, wl * 180.0, dist );
		// sharpened crest profile: slope of a slightly peaked wave
		float sl = cos( ph ) * ( 1.0 + 0.35 * sin( ph ) );
		grad += dd * sl * fade * ( 0.045 * KW_WAVES );
		wl *= 0.66 + 0.08 * sin( fi * 4.1 );
	}
	// irregular detail (capillary / wind chop)
	float fadeD = 1.0 - smoothstep( 30.0, 160.0, dist );
	grad += kwNoiseGrad( xz * ( 1.0 / 14.0 ) + vec2( 0.021, 0.013 ) * t ) * ( 0.012 * fadeD * KW_WAVES );
	grad += kwNoiseGrad( xz * ( 1.0 / 5.0 ) + vec2( - 0.017, 0.029 ) * t ) * ( 0.004 * fadeD * KW_WAVES );
	return normalize( vec3( - grad.x, 1.0, - grad.y ) );
}

// Sky radiance in air for an (upper hemisphere) direction.
vec3 kwSky( vec3 d ) {
	float y = max( d.y, 0.0 );
	vec3 col = mix( KW_HORIZ, KW_ZENITH, pow( y, 0.4 ) );
	float sd = max( dot( d, KW_SUNA ), 0.0 );
	col += KW_SUNCOL * ( pow( sd, 6.0 ) * 0.25 + pow( sd, 60.0 ) * 1.2 + pow( sd, 900.0 ) * 6.0 );
	col += KW_SUNCOL * smoothstep( 0.99955, 0.99985, sd ) * KW_SUNI;
	return col;
}

// Exact unpolarised Fresnel reflectance for light going from a medium of
// index n1 into n2 (eta = n1 / n2), cosI measured in the first medium.
float kwFresnel( float cosI, float eta ) {
	float sinT2 = eta * eta * ( 1.0 - cosI * cosI );
	if ( sinT2 >= 1.0 ) return 1.0;
	float cosT = sqrt( 1.0 - sinT2 );
	float rs = ( eta * cosI - cosT ) / ( eta * cosI + cosT );
	float rp = ( eta * cosT - cosI ) / ( eta * cosT + cosI );
	return 0.5 * ( rs * rs + rp * rp );
}

// Underside of the surface: Snell's window (sky compressed into a ~48.6 deg
// cone) and total internal reflection of the dark water outside it.
vec3 kwSurfaceBelow( vec3 hit, vec3 viewDir, float dist ) {
	vec3 n = kwWaveNormal( hit.xz, dist );
	vec3 nw = - n;                                // faces the water
	float cosI = clamp( dot( viewDir, n ), 0.0, 1.0 );
	vec3 refl = reflect( viewDir, nw );
	refl.y = min( refl.y, - 0.02 );
	vec3 mirror = kwWaterRadiance( normalize( refl ) ) * KW_EXT / ( KW_EXT + KW_KD * abs( refl.y ) );
	float F = kwFresnel( cosI, ${IOR_WATER.toFixed(3)} );
	if ( F >= 1.0 ) return mirror;                 // total internal reflection
	vec3 r = refract( viewDir, nw, ${IOR_WATER.toFixed(3)} );
	// radiance is compressed by n^2 when it enters the denser medium
	vec3 sky = kwSky( r ) * ${(IOR_WATER * IOR_WATER).toFixed(3)};
	return mix( sky, mirror, F );
}

// Upwelling radiance of the deep water seen from just above the surface.
vec3 kwDeepUpwelling( vec3 dirDown ) {
	return kwWaterRadiance( dirDown ) * KW_EXT / ( KW_EXT + KW_KD * abs( dirDown.y ) );
}

// Top side: reflected sky (+ sun glitter) with Fresnel weight F. The caller
// composites F * refl over (1 - F) * what is underneath.
vec3 kwSurfaceAbove( vec3 hit, vec3 viewDir, float dist, out float F ) {
	vec3 n = kwWaveNormal( hit.xz, dist );
	float cosI = clamp( dot( - viewDir, n ), 0.0, 1.0 );
	F = kwFresnel( cosI, ${(1 / IOR_WATER).toFixed(4)} );
	vec3 r = reflect( viewDir, n );
	r.y = abs( r.y );
	return kwSky( r );
}
`;

// ---------------------------------------------------------------------------
// Chunk overrides
// ---------------------------------------------------------------------------
let _installed = false;

export function installWaterShading() {
  if (_installed) return;
  _installed = true;
  const C = THREE.ShaderChunk;

  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vKwWorld;
#endif
`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// world position from view space: cameraPosition + R^T * viewPos
	vKwWorld = cameraPosition + ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif
`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vKwWorld;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	${WATER_GLSL}
#endif
`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	#ifdef KW_ADDITIVE
		vec3 kwT;
		kwWaterT( vec3( 0.0 ), cameraPosition, vKwWorld, kwT );
		gl_FragColor.rgb *= kwT;
	#else
		gl_FragColor.rgb = kwWater( gl_FragColor.rgb, cameraPosition, vKwWorld );
	#endif
#endif
`;

  // --- lighting: attenuate sun / ambient by depth of the lit point, caustics
  let begin = C.lights_fragment_begin;
  const anchorView = 'vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );';
  const anchorDir = 'getDirectionalLightInfo( directionalLight, directLight );';
  if (!begin.includes(anchorView) || !begin.includes(anchorDir)) {
    console.warn('[WaterMedium] lights_fragment_begin changed; caustics/depth lighting disabled');
  } else {
    begin = begin.replace(
      anchorView,
      `${anchorView}
#ifdef USE_FOG
	vec3 kwSunT = kwSunTransmit( vKwWorld );
	vec3 kwAmbT = kwAmbientTransmit( vKwWorld );
	vec3 kwSunV = normalize( ( viewMatrix * vec4( KW_SUNW, 0.0 ) ).xyz );
#endif`
    );
    begin = begin.replace(
      anchorDir,
      `${anchorDir}
		#ifdef USE_FOG
		directLight.color *= ( dot( directLight.direction, kwSunV ) > 0.98 ) ? kwSunT : kwAmbT;
		#endif`
    );
    begin += /* glsl */ `
#if defined( RE_IndirectDiffuse ) && defined( USE_FOG )
	irradiance *= kwAmbT;
#endif
`;
    C.lights_fragment_begin = begin;

    C.lights_fragment_maps += /* glsl */ `
#ifdef USE_FOG
	#if defined( RE_IndirectDiffuse )
		iblIrradiance *= kwAmbT;
	#endif
	#if defined( RE_IndirectSpecular )
		radiance *= kwAmbT;
		clearcoatRadiance *= kwAmbT;
	#endif
#endif
`;
  }

  // --- make the shared uniform available to every built-in material
  THREE.UniformsLib.fog.krillWater = waterUniform;
  for (const key of Object.keys(THREE.ShaderLib)) {
    const u = THREE.ShaderLib[key].uniforms;
    if (u && u.fogColor) u.krillWater = waterUniform;
  }
}

// Make a material participate in the water model (see header comment).
export function makeWaterAware(material, { additive = false } = {}) {
  installWaterShading();
  if (material.isShaderMaterial) {
    const fog = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    for (const k of Object.keys(fog)) {
      if (!material.uniforms[k]) material.uniforms[k] = fog[k];
    }
    material.uniforms.krillWater = waterUniform;
  }
  material.fog = true;
  if (additive) {
    material.defines = { ...(material.defines || {}), KW_ADDITIVE: '' };
  }
  material.needsUpdate = true;
  return material;
}

installWaterShading();
