// Species configuration. Each entry drives the procedural whale's proportions,
// PBR skin, and the movement/feeding feel.

export const SPECIES = {
  humpback: {
    id: 'humpback',
    // Breach (design doc s5): surge cost in krill, run-up climb angle, max exit
    // speed (m/s), twist default/max (rad). Humpbacks are the acrobats.
    breachKrill: 150,
    breachClimb: 1.31, // 75 deg
    vExitMax: 9.5,
    twistDefault: 2.44, // 140 deg
    twistMax: 3.49, // 200 deg
    name: 'Humpback',
    emoji: '🐋',
    // Body proportions (all relative to body length L)
    length: 14, // world units
    maxWidth: 0.135, // relative half-width at thickest point (real: ~0.25-0.3 L girth diameter)
    maxHeight: 0.125, // relative half-height at thickest point
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
    // Physiology (design doc s4.1/4.2); budgets in game seconds (~4x real)
    o2Budget: 120,
    lungeO2: 0.08,
    stomachKrill: 420,
    conditionPerKrill: 0.02,
    krillKg: 2,
    metabolism: 0.012, // Condition points per second
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
    breachKrill: 260,
    breachClimb: 1.05, // 60 deg
    vExitMax: 7.0,
    twistDefault: 0.7, // 40 deg
    twistMax: 1.22, // 70 deg
    name: 'Blue',
    emoji: '🐳',
    length: 22,
    maxWidth: 0.085, // blues are very slender
    maxHeight: 0.08,
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
    o2Budget: 150,
    lungeO2: 0.06,
    stomachKrill: 800,
    conditionPerKrill: 0.012,
    krillKg: 2,
    metabolism: 0.014,
    startCondition: 40,
    conditionTarget: 80,
    filterTime: 4,
    blow: { height: 9, spread: 0.18, lean: 0 }, // tall narrow column
    startDepth: 12,
  },
  sperm: {
    id: 'sperm',
    breachKrill: 200, // design doc: 4 squid once squid exist
    breachClimb: 1.4, // 80 deg
    vExitMax: 9.0,
    twistDefault: 1.57, // 90 deg
    twistMax: 2.27, // 130 deg
    name: 'Sperm',
    emoji: '🐋',
    length: 16,
    maxWidth: 0.11,
    maxHeight: 0.13, // sperm whales are notably tall/bulky at the head
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
    o2Budget: 360,
    lungeO2: 0.07,
    stomachKrill: 350,
    conditionPerKrill: 0.018,
    krillKg: 2,
    metabolism: 0.01,
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
