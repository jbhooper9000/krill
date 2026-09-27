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
//   Parameters live in ONE shared uniform, `vec4 krillWater[16]`, backed by a
//   single Float32Array. We add it to every ShaderLib entry and UniformsLib.fog.
//   three's cloneUniforms() copies Vector/Color values but keeps typed arrays by
//   reference, so every material program uploads the same live array: updating
//   `waterData` once per frame updates the whole scene.
//
// MODEL (all per RGB channel, units = metres = world units)
//   water column  : deep water (c, Kd) + an optional plankton layer in the
//                   upper tens of metres adding (dc, dKd), ramping linearly
//                   between two depths. Optical depths through the layer are
//                   integrated analytically (kwLayerH).
//   view ray      : L = L0 * T + inscatter,  T = exp(-c_mean * s) (Beer–Lambert)
//                   s = length of the view segment BELOW the surface.
//   inscatter     : light field in the water falls off with depth as
//                   exp(-tau_down(y)); integrating c * W(dir) * light(y(t)) *
//                   T(t) along the segment has a closed form (see kwWaterT), so
//                   the fog colour gets darker/bluer looking down and brighter
//                   looking up, and deep objects go blue-green-black.
//   key light     : the sun by day, the moon by night (World.setTimeOfDay);
//                   direct light at a point = exp(-tau_down / cos) * caustics
//   ambient/IBL   : exp(-tau_down) (+ a tiny artistic floor so the abyss is
//                   readable in a game; mostly kept out of specular)
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
const N2 = (IOR_WATER * IOR_WATER).toFixed(4);
const ETA_W = IOR_WATER.toFixed(4); // water -> air
const ETA_A = (1 / IOR_WATER).toFixed(4); // air -> water
const COS_CRIT = Math.sqrt(1 - 1 / (IOR_WATER * IOR_WATER)).toFixed(4); // cos(48.6 deg)

// Shared parameter block. Layout mirrors the #defines in WATER_GLSL.
export const WATER_SLOTS = 17;
export const waterData = new Float32Array(WATER_SLOTS * 4);
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
const getW = (slot) => waterData[slot * 4 + 3];
export const waterSlots = { set3, setW, getW };
/** slot index of the surface light level (w), relative to a clear noon */
export const SLOT_LIGHT = 15;

export const WATER_GLSL = /* glsl */ `
uniform vec4 krillWater[ ${WATER_SLOTS} ];
#define KW_EXT    krillWater[0].xyz   // deep-water beam extinction c (1/m)
#define KW_TIME   krillWater[0].w
#define KW_W0     krillWater[1].xyz   // horizontal water radiance just below the surface
#define KW_LEVEL  krillWater[1].w     // water level (y)
#define KW_KD     krillWater[2].xyz   // deep-water diffuse attenuation (1/m)
#define KW_CAUST  krillWater[2].w     // caustics strength
#define KW_SUNW   krillWater[3].xyz   // direction TO the key light (sun/moon), refracted into the water
#define KW_FWD    krillWater[3].w     // forward-scattering glow strength around the key light
#define KW_SUNA   krillWater[4].xyz   // direction TO the key light in air
#define KW_FLOOR  krillWater[4].w     // artistic minimum light level at depth
#define KW_SUNCOL krillWater[5].xyz   // key light irradiance (colour * intensity)
#define KW_CSCALE krillWater[5].w     // caustic cells per metre
#define KW_ZENITH krillWater[6].xyz   // sky zenith radiance
#define KW_WAVES  krillWater[6].w     // wind-wave slope scale
#define KW_HORIZ  krillWater[7].xyz   // sky horizon radiance
#define KW_SUNI   krillWater[7].w     // key disc radiance / irradiance
#define KW_DEXT   krillWater[8].xyz   // extra extinction inside the plankton layer
#define KW_LTOP   krillWater[8].w     // layer fully on above this y
#define KW_DKD    krillWater[9].xyz   // extra diffuse attenuation inside the layer
#define KW_LBOT   krillWater[9].w     // layer fully off below this y
#define KW_WIND   krillWater[10]      // xy: downwind dir (x,z), z: wind m/s, w: whitecap coverage
#define KW_SWELL  krillWater[11]      // xy: propagation dir (x,z), z: amplitude m, w: wavelength m
#define KW_CLOUDC krillWater[12].xyz  // lit cloud colour
#define KW_CLOUDV krillWater[12].w    // cloud cover 0..1
#define KW_GLOW   krillWater[13].xyz  // twilight horizon glow toward the sun
#define KW_NIGHT  krillWater[13].w    // star visibility 0..1
#define KW_SUNT   krillWater[14].xyz  // true sun direction in air (even below the horizon)
#define KW_MLAYER krillWater[14].w    // marine-layer fog bank strength 0..1
#define KW_HAZE   krillWater[15].xyz  // fog bank colour
#define KW_LIGHT  krillWater[15].w    // surface light level relative to a clear noon
#define KW_KEYT   krillWater[16].x    // key light transmitted through the surface (Fresnel)

vec2 kwHash2( vec2 p ) {
	p = vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) );
	return fract( sin( p ) * 43758.5453 );
}

// ---- plankton layer profile (1 above KW_LTOP, 0 below KW_LBOT, linear) ----
float kwLayer( float y ) {
	return clamp( ( y - KW_LBOT ) / max( KW_LTOP - KW_LBOT, 1e-3 ), 0.0, 1.0 );
}
// integral of kwLayer from -infinity to y
float kwLayerH( float y ) {
	float w = max( KW_LTOP - KW_LBOT, 1e-3 );
	float u = y - KW_LBOT;
	if ( u <= 0.0 ) return 0.0;
	if ( u <= w ) return 0.5 * u * u / w;
	return 0.5 * w + ( u - w );
}
float kwLayerMean( float ya, float yb ) {
	float d = yb - ya;
	return abs( d ) < 1e-3 ? kwLayer( 0.5 * ( ya + yb ) ) : ( kwLayerH( yb ) - kwLayerH( ya ) ) / d;
}
// optical depth of downwelling light from the surface down to y (relative to the level)
vec3 kwTauDown( float y ) {
	y = min( y, 0.0 );
	return KW_KD * ( - y ) + KW_DKD * ( kwLayerH( 0.0 ) - kwLayerH( y ) );
}
vec3 kwExtAt( float y ) { return KW_EXT + KW_DEXT * kwLayer( y ); }
vec3 kwKdAt( float y ) { return KW_KD + KW_DKD * kwLayer( y ); }

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
// refracted key-light direction, so it lands consistently on floor, whale and
// krill. Caustics need a few metres to focus (weak right under the surface),
// then defocus (widen, lose contrast) with depth; the peak gain is capped so
// shallow bodies never show a wireframe "net".
float kwCaustics( vec3 wp, float depth ) {
	float amp = KW_CAUST * exp( - depth / 30.0 ) * smoothstep( 0.5, 6.0, depth );
	if ( amp < 0.003 ) return 1.0;
	vec2 q = ( wp.xz + KW_SUNW.xz * ( depth / max( KW_SUNW.y, 0.3 ) ) ) * KW_CSCALE;
	float t = KW_TIME;
	float w = 0.07 + depth * 0.005;
	float e1 = kwCellEdge( q + vec2( 0.11, 0.05 ) * t, t * 0.65 );
	float e2 = kwCellEdge( q * 1.43 + vec2( 3.7, 9.1 ) - vec2( 0.07, 0.12 ) * t, t * 0.8 + 2.0 );
	float iw = 1.0 / ( w * w );
	float l = exp( - e1 * e1 * iw ) + exp( - e2 * e2 * iw );
	float mean = min( 1.6, 4.3 * w );
	return max( 0.0, mix( 1.0, min( l / mean, 3.2 ), amp ) );
}

// The artistic floor has the SAME spectral shape as the real light at that
// depth (computed in log space so it never underflows), slightly biased blue.
// A fixed-hue floor made the water navy while white parts (humpback flippers)
// showed the true cyan-green light, so they read as glowing at 40-60 m.
vec3 kwFloorLight( float y ) {
	vec3 tau = kwTauDown( y );
	float m = min( tau.r, min( tau.g, tau.b ) );
	return KW_FLOOR * exp( - ( tau - m ) ) * vec3( 0.5, 0.85, 1.0 );
}

// Light-at-depth for the diffuse (ambient / sky) field, with a small bluish
// floor so deep scenes stay legible (a game compromise, documented).
vec3 kwLightAt( float y ) {
	return exp( - kwTauDown( y ) ) + kwFloorLight( y );
}

vec3 kwAmbientTransmit( vec3 wp ) {
	return kwLightAt( wp.y - KW_LEVEL );
}
// For specular IBL: the artistic floor is mostly left out, so thin flat parts
// (flukes, flippers) do not mirror a glowing "window" in the dark at depth.
vec3 kwAmbientTransmitSpec( vec3 wp ) {
	return exp( - kwTauDown( wp.y - KW_LEVEL ) ) + 0.15 * kwFloorLight( wp.y - KW_LEVEL );
}

// Direct key light arriving at wp: slant-path attenuation * projected caustics.
vec3 kwSunTransmit( vec3 wp ) {
	float depth = KW_LEVEL - wp.y;
	if ( depth <= 0.0 ) return vec3( 1.0 );
	vec3 T = exp( - kwTauDown( - depth ) / max( KW_SUNW.y, 0.3 ) );
	return T * ( KW_KEYT * kwCaustics( wp, depth ) );
}

float kwPhase( float cosT, float g ) {
	float g2 = g * g;
	return ( 1.0 - g2 ) / ( 12.5664 * pow( max( 1.0 + g2 - 2.0 * g * cosT, 1e-4 ), 1.5 ) );
}

// Radiance of an infinitely long underwater path starting at the surface, per
// direction: brighter looking up (downwelling light), much darker looking down,
// plus the forward-scattering glow around the refracted key light.
vec3 kwWaterRadiance( vec3 dir ) {
	float up = dir.y;
	float ang = up >= 0.0 ? 1.0 + 1.4 * up * up : 1.0 - 0.72 * sqrt( - up );
	float sun = KW_FWD * kwPhase( dot( dir, KW_SUNW ), 0.82 );
	return KW_W0 * ( ang + sun );
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
	// mean extinction over the segment (analytic through the plankton layer)
	vec3 c = KW_EXT + KW_DEXT * kwLayerMean( startY, startY + dir.y * s );
	T = exp( - c * s );
	// in-scatter: integral_0^s c W light(y(t)) e^{-c t} dt, light ~ exponential
	vec3 a = c - kwKdAt( startY ) * dir.y;
	a = mix( a, vec3( 1e-4 ), step( abs( a ), vec3( 1e-4 ) ) );
	vec3 g = ( 1.0 - exp( - a * s ) ) / a;
	vec3 W = kwWaterRadiance( dir );
	vec3 ins = W * ( c * g * exp( - kwTauDown( startY ) ) + kwFloorLight( startY ) * ( 1.0 - T ) );
	return col * T + ins;
}

vec3 kwWater( vec3 col, vec3 ro, vec3 p ) {
	vec3 T;
	return kwWaterT( col, ro, p, T );
}
`;

// ---------------------------------------------------------------------------
// Surface / sky GLSL (used by World's surface mesh and background dome, which
// also bind `kwNoise`, a tileable noise texture).
// ---------------------------------------------------------------------------
export const SURFACE_GLSL = /* glsl */ `
uniform sampler2D kwNoise;
vec2 kwNoiseGrad( vec2 uv ) {
	const float e = 1.0 / 256.0;
	float c = texture2D( kwNoise, uv ).r;
	return vec2( texture2D( kwNoise, uv + vec2( e, 0.0 ) ).r - c, texture2D( kwNoise, uv + vec2( 0.0, e ) ).r - c ) / e;
}

// Sea-surface normal: a long NW swell (two close components -> wave groups),
// a wind sea spread around the downwind direction (wavelength and steepness
// from the wind speed; deep-water dispersion w = sqrt(g k)), and noise-derived
// chop modulated by elongated wind streaks (rough bands / glassy slicks).
// Short waves fade with distance (pixel footprint) to avoid aliasing.
// Also returns a whitecap mask (crests of the wind sea x breaking noise,
// thresholded by the wind's whitecap coverage).
vec3 kwWaveNormalF( vec2 xz, float dist, out float foam ) {
	float t = KW_TIME;
	vec2 grad = vec2( 0.0 );
	// swell
	vec2 sd = KW_SWELL.xy;
	float sA = KW_SWELL.z;
	float sL = max( KW_SWELL.w, 1.0 );
	for ( int i = 0; i < 2; i ++ ) {
		float fi = float( i );
		float ang = ( fi - 0.5 ) * 0.3;
		vec2 dd = vec2( sd.x * cos( ang ) - sd.y * sin( ang ), sd.x * sin( ang ) + sd.y * cos( ang ) );
		float wl = sL * ( 1.0 - 0.17 * fi );
		float k = 6.2831 / wl;
		float ph = k * dot( dd, xz ) - sqrt( 9.81 * k ) * t + fi * 2.1;
		grad += dd * ( k * sA ) * cos( ph ) * ( 1.0 + 0.3 * sin( ph ) );
	}
	// wind sea
	vec2 wd = KW_WIND.xy;
	float wAng = atan( wd.y, wd.x );
	float wl = clamp( 1.1 * KW_WIND.z * KW_WIND.z, 6.0, 60.0 );
	float crest = 0.0;
	for ( int i = 0; i < 9; i ++ ) {
		float fi = float( i );
		float ang = wAng + sin( fi * 2.3999 + 0.4 ) * 0.95;
		vec2 dd = vec2( cos( ang ), sin( ang ) );
		float k = 6.2831 / wl;
		float ph = k * dot( dd, xz ) - sqrt( 9.81 * k ) * t + fi * 1.93;
		float fade = 1.0 - smoothstep( wl * 22.0, wl * 90.0, dist );
		// sharpened crest profile: slope of a slightly peaked wave
		grad += dd * cos( ph ) * ( 1.0 + 0.35 * sin( ph ) ) * fade * ( 0.045 * KW_WAVES );
		if ( i < 3 ) crest += sin( ph ) * ( 0.45 - 0.1 * fi );
		wl *= 0.66 + 0.08 * sin( fi * 4.1 );
	}
	// wind streaks: long bands of rough water / smooth slicks along the wind
	vec2 wp = vec2( dot( xz, wd ), dot( xz, vec2( - wd.y, wd.x ) ) );
	float streak = texture2D( kwNoise, vec2( wp.x * 0.0022, wp.y * 0.028 ) + vec2( 0.0015 * t, 0.0 ) ).r;
	float rough = mix( 0.3, 1.4, smoothstep( 0.32, 0.68, streak ) );
	float fadeD = 1.0 - smoothstep( 30.0, 200.0, dist );
	float chop = KW_WAVES * rough;
	grad += kwNoiseGrad( xz * ( 1.0 / 14.0 ) + wd * ( 0.02 * t ) ) * ( 0.012 * fadeD * chop );
	grad += kwNoiseGrad( xz * ( 1.0 / 5.0 ) + vec2( - 0.017, 0.029 ) * t ) * ( 0.004 * fadeD * chop );
	// whitecaps
	float cov = KW_WIND.w;
	foam = 0.0;
	if ( cov > 0.001 ) {
		// breaking patches ride the crests of the wind sea, streaked downwind
		float nf = smoothstep( 0.3, 0.72, texture2D( kwNoise, vec2( wp.x / 34.0, wp.y / 16.0 ) - vec2( 0.05 * t, 0.0 ) ).r );
		float nd = texture2D( kwNoise, xz / 3.3 + wd * ( 0.11 * t ) ).r;
		float x = nf * 0.62 + ( crest * 0.5 + 0.5 ) * 0.38;
		float thr = 0.95 - 1.4 * cov;
		foam = smoothstep( thr, thr + 0.06, x ) * smoothstep( 0.22, 0.6, nd );
		foam *= 1.0 - smoothstep( 300.0, 1200.0, dist ) * 0.7;
	}
	return normalize( vec3( - grad.x, 1.0, - grad.y ) );
}

vec3 kwSkyAmbient() { return 0.5 * ( KW_ZENITH + KW_HORIZ ); }

// Sky radiance in air for an (upper hemisphere) direction: zenith/horizon
// gradient, twilight glow toward the sun, key-light aureole + disc (sun or
// moon), stars at night, procedural clouds and a marine-layer fog bank low on
// the horizon.
vec3 kwSky( vec3 d ) {
	float y = max( d.y, 0.0 );
	vec3 col = mix( KW_HORIZ, KW_ZENITH, pow( y, 0.45 ) );
	// twilight glow along the horizon toward the (true) sun
	vec2 sh = KW_SUNT.xz;
	float cosAz = dot( normalize( d.xz + vec2( 1e-5 ) ), normalize( sh + vec2( 1e-5 ) ) );
	col += KW_GLOW * pow( 0.5 + 0.5 * cosAz, 3.0 ) * exp( - y * 5.0 );
	// stars
	if ( KW_NIGHT > 0.01 && d.y > 0.0 ) {
		vec3 sp = d * 160.0;
		vec3 ip = floor( sp );
		float h = fract( sin( dot( ip, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
		float r = length( fract( sp ) - 0.5 );
		float star = step( 0.994, h ) * ( 1.0 - smoothstep( 0.05, 0.16, r ) ) * ( 0.3 + 3.0 * fract( h * 97.0 ) );
		col += vec3( 0.8, 0.85, 1.0 ) * star * 0.004 * KW_NIGHT * smoothstep( 0.0, 0.2, d.y );
	}
	// key light aureole + disc
	float sd = max( dot( d, KW_SUNA ), 0.0 );
	col += KW_SUNCOL * ( pow( sd, 6.0 ) * 0.06 + pow( sd, 60.0 ) * 0.3 + pow( sd, 900.0 ) * 1.6 );
	col += KW_SUNCOL * smoothstep( 0.99955, 0.99985, sd ) * KW_SUNI;
	// clouds on a plane ~1.5 km up, drifting downwind
	if ( KW_CLOUDV > 0.01 && d.y > 0.0 ) {
		vec2 uv = d.xz / ( d.y + 0.06 ) * 0.22 + KW_WIND.xy * ( KW_TIME * 0.0006 );
		float n = texture2D( kwNoise, uv * 0.5 ).r * 0.65 + texture2D( kwNoise, uv * 1.7 + 0.37 ).r * 0.35;
		float c = smoothstep( 1.0 - KW_CLOUDV, 1.0 - KW_CLOUDV + 0.3, n ) * smoothstep( 0.0, 0.1, d.y );
		vec3 cc = KW_CLOUDC * ( 0.7 + 0.45 * n ) + KW_SUNCOL * pow( sd, 12.0 ) * 0.25;
		col = mix( col, cc, c * 0.92 );
	}
	// marine layer: a low grey fog bank sitting on the horizon
	col = mix( col, KW_HAZE, KW_MLAYER * exp( - y * 28.0 ) );
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

// Beckmann glitter lobe for sub-pixel (unresolved) wave facets: radiance
// factor for a light of irradiance 1 from direction L.
float kwGlint( vec3 v, vec3 n, vec3 L, float s2 ) {
	vec3 h = normalize( - v + L );
	float nh = max( dot( n, h ), 1e-3 );
	float nh2 = nh * nh;
	float D = exp( ( nh2 - 1.0 ) / ( s2 * nh2 ) ) / ( 3.14159 * s2 * nh2 * nh2 );
	return D / ( 4.0 * max( dot( n, - v ), 0.08 ) );
}
float kwGlitterVar() { return 0.002 + 0.0012 * KW_WIND.z; }

// Upwelling radiance of the deep water seen from just below/above the surface.
vec3 kwDeepUpwelling( vec3 dirDown ) {
	vec3 c = kwExtAt( 0.0 );
	return kwWaterRadiance( dirDown ) * c / ( c + kwKdAt( 0.0 ) * abs( dirDown.y ) );
}

// Underside of the surface: Snell's window (sky compressed into a ~97 deg
// cone) with the sky distorted by the wave normals, a soft (~3 deg) rim, and
// total internal reflection of the dark water outside it. The window test
// uses a gentler normal than the distortion so the rim stays a rippled circle
// instead of breaking into binary blotches.
vec3 kwSurfaceBelow( vec3 hit, vec3 v, float dist ) {
	float foam;
	vec3 n = kwWaveNormalF( hit.xz, dist, foam );
	vec3 nWin = normalize( mix( vec3( 0.0, 1.0, 0.0 ), n, 0.45 ) );
	vec3 refl = reflect( v, - n );
	refl.y = min( refl.y, - 0.02 );
	vec3 mirror = kwDeepUpwelling( normalize( refl ) );
	float cosW = clamp( dot( v, nWin ), 0.0, 1.0 );
	float inside = smoothstep( ${COS_CRIT} - 0.022, ${COS_CRIT} + 0.03, cosW );
	vec3 r = refract( v, - n, ${ETA_W} );
	if ( dot( r, r ) < 1e-4 ) r = refract( v, - nWin, ${ETA_W} );
	if ( dot( r, r ) < 1e-4 ) r = normalize( vec3( v.x, 0.02, v.z ) );
	float F = kwFresnel( max( cosW, ${COS_CRIT} + 0.001 ), ${ETA_W} );
	// radiance is compressed by n^2 when it enters the denser medium
	vec3 sky = kwSky( r ) * ${N2};
	vec3 col = mix( mirror, mix( sky, mirror, F ), inside );
	// whitecaps seen from below: light diffused through the foam
	vec3 foamL = 0.3 * ( KW_SUNCOL * max( KW_SUNA.y, 0.0 ) * 0.318 + kwSkyAmbient() );
	return mix( col, foamL, foam * 0.7 );
}

// Top side. Returns PREMULTIPLIED colour; 'block' is the fraction of the
// underwater radiance that does NOT reach the eye, so the caller composites
//     out = col + (1 - block) * underwater.
// Transmission from water to air loses the Fresnel part AND the n^2 radiance
// factor (radiance expands when leaving the denser medium). Reflectance uses
// the wave facet, blended toward the mean-surface Fresnel at grazing angles so
// distant water reads as a mirror (facets hidden behind crests).
vec3 kwSurfaceAbove( vec3 hit, vec3 v, float dist, out float block ) {
	float foam;
	vec3 n = kwWaveNormalF( hit.xz, dist, foam );
	float cosI = clamp( dot( - v, n ), 0.0, 1.0 );
	float Fw = kwFresnel( cosI, ${ETA_A} );
	float Fg = kwFresnel( clamp( - v.y, 0.0, 1.0 ), ${ETA_A} );
	float F = mix( Fw, max( Fw, Fg ), 0.7 );
	vec3 r = reflect( v, n );
	r.y = abs( r.y );
	vec3 R = kwSky( r );
	if ( KW_SUNA.y > 0.0 ) R += KW_SUNCOL * kwGlint( v, n, KW_SUNA, kwGlitterVar() );
	vec3 foamCol = 0.8 * ( KW_SUNCOL * max( KW_SUNA.y, 0.0 ) * 0.318 + kwSkyAmbient() );
	block = 1.0 - ( 1.0 - foam ) * ( 1.0 - F ) / ${N2};
	return ( 1.0 - foam ) * F * R + foam * foamCol;
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

  // --- lighting: attenuate key / ambient by depth of the lit point, caustics
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
	vec3 kwAmbTS = kwAmbientTransmitSpec( vKwWorld );
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
		radiance *= kwAmbTS;
		clearcoatRadiance *= kwAmbTS;
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
