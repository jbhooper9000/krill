// Species configuration. Each entry drives the procedural whale's proportions,
// PBR skin, and the movement/feeding feel.

export const SPECIES = {
  humpback: {
    id: 'humpback',
    name: 'Humpback',
    emoji: '🐋',
    // Body proportions (all relative to body length L)
    length: 14, // world units
    maxWidth: 0.30, // relative half-width at thickest point
    maxHeight: 0.26, // relative half-height at thickest point
    flukeSpan: 0.32, // relative full span of tail fluke
    flipperLen: 0.42, // humpbacks have very long pectorals
    dorsalHeight: 0.06,
    // Skin
    skinTop: 0x2e4450,
    skinBottom: 0xdfe8e4,
    mottle: true,
    // Movement
    speed: 1.0,
    turnRate: 1.0,
    lungePower: 1.25,
    mouthRadius: 1.0,
    // Starting conditions
    startDepth: 14,
  },
  blue: {
    id: 'blue',
    name: 'Blue',
    emoji: '🐳',
    length: 22,
    maxWidth: 0.20,
    maxHeight: 0.18,
    flukeSpan: 0.24,
    flipperLen: 0.16,
    dorsalHeight: 0.012,
    skinTop: 0x6b8794,
    skinBottom: 0xeef3f1,
    mottle: true,
    speed: 0.82,
    turnRate: 0.72,
    lungePower: 0.85,
    mouthRadius: 1.5,
    startDepth: 12,
  },
  sperm: {
    id: 'sperm',
    name: 'Sperm',
    emoji: '🐋',
    length: 16,
    maxWidth: 0.24,
    maxHeight: 0.30, // sperm whales are notably tall/bulky at the head
    flukeSpan: 0.26,
    flipperLen: 0.12,
    dorsalHeight: 0.05,
    skinTop: 0x4a4038,
    skinBottom: 0xcfc4b6,
    mottle: false,
    speed: 0.9,
    turnRate: 0.85,
    lungePower: 1.0,
    mouthRadius: 1.05,
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
