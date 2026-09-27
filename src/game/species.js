// Species configuration. Each entry drives the procedural whale's proportions,
// PBR skin, and the movement/feeding feel.

export const SPECIES = {
  humpback: {
    id: 'humpback',
    // Breach (design doc s5): surge cost in krill, run-up climb angle, max exit
    // speed (m/s), twist default/max (rad). Humpbacks are the acrobats.
    breachKrill: 600, // ~2 dives of good lunges
    breachClimb: 1.31, // 75 deg
    vExitMax: 9.5,
    breachAccel: 1.6, // m/s^2 during the run-up
    twistDefault: 2.44, // 140 deg
    twistMax: 3.49, // 200 deg
    name: 'Humpback',
    emoji: '🐋',
    // Anatomy (visual only). Lengths are fractions of body length L; see
    // ANATOMY below for the per-species body plan the Whale builds from.
    length: 14, // m (world units)
    // Movement
    speed: 1.0,
    turnRate: 1.0,
    lungePower: 1.25,
    mouthRadius: 1.0,
    // Physiology (design doc s4.1/4.2); budgets in game seconds (~4x real)
    o2Budget: 120,
    lungeO2: 0.08,
    lungeKrill: 70, // engulfment capacity per full lunge (boids)
    stomachKrill: 250, // ~4 full lunges, then digest
    conditionPerKrill: 0.012,
    krillKg: 2,
    metabolism: 0.006, // Condition points per second (~14/day)
    startCondition: 40,
    conditionTarget: 80,
    filterTime: 3.5, // s of filtering after each lunge (rorquals)
    blow: { height: 3, spread: 0.45, lean: 0 }, // bushy
    // Starting conditions
    startDepth: 14,
  },
  blue: {
    id: 'blue',
    // blues rarely breach, and only partially
    breachKrill: 1200,
    breachClimb: 1.05, // 60 deg
    vExitMax: 7.0,
    breachAccel: 0.9, // m/s^2 during the run-up
    twistDefault: 0.7, // 40 deg
    twistMax: 1.22, // 70 deg
    name: 'Blue',
    emoji: '🐳',
    length: 24, // m; adult Monterey blues are ~22-26 m
    speed: 0.82,
    turnRate: 0.72,
    lungePower: 0.85,
    mouthRadius: 1.5,
    o2Budget: 150,
    lungeO2: 0.06,
    lungeKrill: 160, // engulfment capacity per full lunge (boids)
    stomachKrill: 560,
    conditionPerKrill: 0.007,
    krillKg: 2,
    metabolism: 0.007,
    startCondition: 40,
    conditionTarget: 80,
    filterTime: 4,
    blow: { height: 9, spread: 0.18, lean: 0 }, // tall narrow column
    startDepth: 12,
  },
  sperm: {
    id: 'sperm',
    breachKrill: 400, // design doc: 4 squid once squid exist
    breachClimb: 1.4, // 80 deg
    vExitMax: 9.0,
    breachAccel: 1.5, // m/s^2 during the run-up
    twistDefault: 1.57, // 90 deg
    twistMax: 2.27, // 130 deg
    name: 'Sperm',
    emoji: '🐋',
    length: 16, // m (adult male)
    speed: 0.9,
    turnRate: 0.85,
    lungePower: 1.0,
    mouthRadius: 1.05,
    o2Budget: 360,
    lungeO2: 0.07,
    lungeKrill: 40, // engulfment capacity per full lunge (boids)
    stomachKrill: 200,
    conditionPerKrill: 0.012,
    krillKg: 2,
    metabolism: 0.005,
    startCondition: 40,
    conditionTarget: 80,
    filterTime: 0, // sperm whales suck prey in; no baleen filtering
    blow: { height: 3, spread: 0.3, lean: 0.8 }, // angled forward-left (blowhole left of centre)
    startDepth: 34,
  },
};

// Depth zones. As the whale grows it descends into progressively deeper water,
// which shifts fog color/density and ambient lighting.
export const ZONES = [
  { name: 'Shallows', min: 0, max: 24, fog: 0x1a6f7a, density: 0.016, sky: 0.9, sun: 1.0 },
  { name: 'Twilight', min: 24, max: 46, fog: 0x0f5f7d, density: 0.02, sky: 0.55, sun: 0.7 },
  { name: 'Midnight', min: 46, max: 66, fog: 0x0d4466, density: 0.022, sky: 0.32, sun: 0.5 },
  { name: 'Abyss', min: 66, max: 88, fog: 0x0b2a46, density: 0.024, sky: 0.18, sun: 0.34 },
];

export function zoneForDepth(depth) {
  for (let i = 0; i < ZONES.length; i++) {
    if (depth <= ZONES[i].max) return { zone: ZONES[i], index: i };
  }
  return { zone: ZONES[ZONES.length - 1], index: ZONES.length - 1 };
}

// ---- anatomy (visual only) -------------------------------------------------
// The procedural Whale lofts its body from these stations and builds its
// appendages from these planforms. Lengths are fractions of body length L,
// angles around the body are degrees from the dorsal midline (90 = side,
// 180 = ventral midline).
//
// stations: [u, halfWidth, top, bottom] along the body (u 0 = snout, 1 = tail
//   notch); top/bottom are measured from the spine axis, so they draw the
//   side profile directly.
// shape: [u, nUpper, nLower] superellipse exponents of the cross-section
//   (2 = ellipse, >2 = boxier, e.g. the flat rorqual rostrum, the sperm head).
// cols: vertices per side on the upper jaw / lower jaw arcs of each ring.
// ridges: dorsal (side 1) or ventral (side -1) crests: hump, knuckles,
//   splash guard, caudal keel. u = [rise start, full, full end, fall end].
// jaw: chin (jaw tip), hinge (mouth corner / jaw joint), lip line angle,
//   max gape (rad), throat-pouch extent; sperm whales add a narrow
//   underslung lower jaw (jawWidth / jawDepth).
// stroke: fluke-beat frequency [glide, cruise, sprint] Hz and tail-tip
//   half-amplitude (fraction of L). Real cruise strokes last 3-5 s.
export const ANATOMY = {
  humpback: {
    stations: [
      [0.000, 0.000, 0.000, 0.000], [0.004, 0.017, 0.004, 0.010], [0.012, 0.031, 0.008, 0.020],
      [0.030, 0.047, 0.013, 0.034], [0.060, 0.065, 0.022, 0.052], [0.100, 0.081, 0.034, 0.070],
      [0.150, 0.096, 0.048, 0.087], [0.200, 0.108, 0.064, 0.100], [0.250, 0.119, 0.078, 0.110],
      [0.300, 0.126, 0.090, 0.117], [0.360, 0.129, 0.099, 0.120], [0.430, 0.127, 0.104, 0.116],
      [0.500, 0.119, 0.105, 0.105], [0.570, 0.106, 0.103, 0.093], [0.640, 0.090, 0.098, 0.082],
      [0.700, 0.074, 0.090, 0.073], [0.780, 0.052, 0.074, 0.060], [0.860, 0.034, 0.055, 0.046],
      [0.920, 0.024, 0.037, 0.033], [0.960, 0.019, 0.023, 0.021], [0.985, 0.017, 0.013, 0.011],
      [1.000, 0.013, 0.007, 0.006],
    ],
    shape: [[0, 2.8, 2.2], [0.15, 2.6, 2.1], [0.3, 2.2, 2.0], [0.5, 2.0, 2.0], [1, 2.0, 2.0]],
    cols: [14, 20],
    rings: 120,
    ridges: [
      { side: 1, u: [0.16, 0.18, 0.195, 0.215], h: 0.005, sigma: 0.32 }, // splash guard
      { side: 1, u: [0.52, 0.6, 0.67, 0.73], h: 0.011, sigma: 0.5 }, // the "hump" under the dorsal fin
      { side: 1, u: [0.7, 0.75, 0.93, 0.98], h: 0.006, sigma: 0.26, knobs: 6 }, // dorsal ridge, small knuckles
      { side: -1, u: [0.68, 0.77, 0.93, 0.98], h: 0.011, sigma: 0.3 }, // caudal keel
    ],
    jaw: {
      chin: 0, hinge: 0.245, fade: 0.06, gape: 1.4, // ~80 deg at full engulfment
      lip: [[0, 66], [0.1, 70], [0.18, 76], [0.245, 88], [1, 88]],
      pouch: [0.03, 0.52], pouchDepth: 0.075, baleen: true,
    },
    eye: { u: 0.258, dphi: -13, r: 0.0036 },
    blowhole: { u: 0.2, paired: true },
    tubercles: true,
    pleats: { n: 22, to: 0.5, spread: 68 },
    flipper: { style: 'humpback', u: 0.29, phi: 112, len: 0.31, dihedral: 0.5, sweep: 0.62, twist: 0.08 },
    fluke: { style: 'humpback', span: 0.32 },
    dorsal: { u: 0.645, height: 0.021, base: 0.055, sweep: 0.9 },
    stroke: { hz: [0.1, 0.3, 0.6], amp: [0.012, 0.085, 0.105] },
    skin: {
      back: 0x1d2125, belly: 0xd8dbd8, ventralPatch: 0.2, mottle: 0.12, blue: 0,
      scars: 12, barnacles: 70, finTop: 0x23282c, finUnder: 0xe4e6e2,
    },
  },
  blue: {
    stations: [
      [0.000, 0.000, 0.000, 0.000], [0.004, 0.020, 0.003, 0.008], [0.012, 0.032, 0.006, 0.016],
      [0.030, 0.044, 0.011, 0.028], [0.060, 0.054, 0.018, 0.040], [0.100, 0.061, 0.026, 0.050],
      [0.160, 0.066, 0.036, 0.059], [0.220, 0.070, 0.046, 0.066], [0.300, 0.073, 0.056, 0.071],
      [0.400, 0.074, 0.062, 0.071], [0.500, 0.070, 0.064, 0.066], [0.600, 0.062, 0.064, 0.058],
      [0.700, 0.051, 0.060, 0.050], [0.780, 0.040, 0.053, 0.044], [0.860, 0.028, 0.043, 0.036],
      [0.920, 0.019, 0.031, 0.027], [0.960, 0.015, 0.020, 0.017], [0.985, 0.013, 0.011, 0.009],
      [1.000, 0.010, 0.006, 0.005],
    ],
    shape: [[0, 3.4, 2.2], [0.12, 3.2, 2.1], [0.26, 2.4, 2.0], [0.45, 2.0, 2.0], [1, 2.0, 2.0]],
    cols: [14, 20],
    rings: 132,
    ridges: [
      { side: 1, u: [0.02, 0.05, 0.14, 0.17], h: 0.0018, sigma: 0.14 }, // median rostral ridge
      { side: 1, u: [0.155, 0.175, 0.19, 0.21], h: 0.005, sigma: 0.3 }, // splash guard
      { side: 1, u: [0.8, 0.84, 0.94, 0.98], h: 0.004, sigma: 0.24 }, // dorsal tail-stock ridge
      { side: -1, u: [0.7, 0.78, 0.94, 0.98], h: 0.008, sigma: 0.28 }, // caudal keel
    ],
    jaw: {
      chin: 0, hinge: 0.24, fade: 0.06, gape: 1.4,
      lip: [[0, 64], [0.1, 68], [0.2, 76], [0.24, 86], [1, 86]],
      pouch: [0.03, 0.5], pouchDepth: 0.06, baleen: true,
    },
    eye: { u: 0.252, dphi: -12, r: 0.0022 },
    blowhole: { u: 0.195, paired: true },
    tubercles: false,
    pleats: { n: 64, to: 0.5, spread: 70 },
    flipper: { style: 'blue', u: 0.285, phi: 110, len: 0.115, dihedral: 0.55, sweep: 0.85, twist: 0.06 },
    fluke: { style: 'blue', span: 0.26 },
    dorsal: { u: 0.77, height: 0.011, base: 0.03, sweep: 1.0 },
    stroke: { hz: [0.08, 0.22, 0.45], amp: [0.01, 0.075, 0.095] },
    skin: {
      back: 0x5a7482, belly: 0x8ea3ad, ventralPatch: 0, mottle: 0.6, blue: 1,
      scars: 4, barnacles: 0, finTop: 0x5d7684, finUnder: 0x9fb2ba,
    },
  },
  sperm: {
    stations: [
      [0.000, 0.000, 0.000, 0.000], [0.002, 0.030, 0.034, 0.024], [0.006, 0.050, 0.056, 0.040],
      [0.014, 0.064, 0.071, 0.052], [0.028, 0.073, 0.081, 0.061], [0.050, 0.079, 0.087, 0.067],
      [0.100, 0.083, 0.091, 0.072], [0.180, 0.085, 0.092, 0.077], [0.260, 0.085, 0.090, 0.082],
      [0.320, 0.083, 0.083, 0.087], [0.360, 0.081, 0.077, 0.089], [0.420, 0.082, 0.078, 0.090],
      [0.500, 0.078, 0.080, 0.085], [0.580, 0.069, 0.078, 0.077], [0.660, 0.057, 0.071, 0.067],
      [0.740, 0.044, 0.061, 0.057], [0.820, 0.031, 0.049, 0.046], [0.890, 0.022, 0.037, 0.034],
      [0.940, 0.017, 0.024, 0.022], [0.975, 0.015, 0.014, 0.012], [1.000, 0.011, 0.007, 0.006],
    ],
    shape: [[0, 3.2, 3.0], [0.26, 3.0, 2.8], [0.36, 2.2, 2.1], [0.5, 2.0, 2.0], [1, 2.0, 2.0]],
    cols: [28, 8],
    rings: 124,
    ridges: [
      { side: 1, u: [0.56, 0.61, 0.65, 0.69], h: 0.016, sigma: 0.42 }, // dorsal hump
      { side: 1, u: [0.68, 0.71, 0.86, 0.92], h: 0.009, sigma: 0.3, knobs: 6 }, // knuckles
      { side: -1, u: [0.72, 0.8, 0.94, 0.98], h: 0.012, sigma: 0.3 }, // caudal keel
    ],
    jaw: {
      chin: 0.075, hinge: 0.28, fade: 0.05, gape: 0.5,
      jawWidth: [[0.075, 0.0], [0.085, 0.009], [0.14, 0.015], [0.24, 0.019], [0.3, 0.021], [1, 0.021]],
      jawDepth: [[0.075, 0.0], [0.082, 0.011], [0.11, 0.017], [0.25, 0.016], [0.3, 0.004], [0.33, 0], [1, 0]],
      pouch: null, baleen: false, teeth: 22,
    },
    eye: { u: 0.3, dphi: 0, phi: 116, r: 0.0026 },
    blowhole: { u: 0.02, phi: -24, paired: false },
    tubercles: false,
    pleats: { n: 5, from: 0.25, to: 0.33, spread: 22 },
    flipper: { style: 'sperm', u: 0.365, phi: 124, len: 0.1, dihedral: 0.6, sweep: 0.7, twist: 0.04 },
    fluke: { style: 'sperm', span: 0.27 },
    dorsal: null,
    stroke: { hz: [0.1, 0.3, 0.55], amp: [0.012, 0.085, 0.105] },
    skin: {
      back: 0x39332f, belly: 0x544c46, ventralPatch: 0, mottle: 0.1, blue: 0,
      lips: 0xdcd6cc, scars: 60, barnacles: 0, wrinkles: 1, finTop: 0x37312d, finUnder: 0x4a433e,
    },
  },
};
for (const id of Object.keys(ANATOMY)) SPECIES[id].anatomy = ANATOMY[id];
