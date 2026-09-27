// Live-tunable gameplay parameters. The in-game panel (toggle `T`) edits these
// at runtime; the game reads them every frame, so changes apply immediately.
// `rebuild: true` params require rebuilding a swarm when changed.

export const TUNABLES = [
  { id: 'krillSize', label: 'Krill size', min: 0.2, max: 2.0, step: 0.05, value: 0.2 },
  { id: 'krillCount', label: 'Krill per swarm', min: 300, max: 3000, step: 100, value: 1500, rebuild: true },
  { id: 'krillSpacing', label: 'Krill spacing', min: 0.6, max: 3.0, step: 0.1, value: 1.9 },
  // krill cruise slowly and flick away in short escapes (real: < 1 m/s)
  { id: 'krillSpeed', label: 'Krill speed', min: 0.6, max: 8.0, step: 0.2, value: 2.2 },
  // cruise speed (m/s) before species factor; real rorqual cruise is ~2-5 m/s
  { id: 'swimSpeed', label: 'Swim speed', min: 2, max: 20, step: 0.5, value: 4.5 },
  { id: 'turnRate', label: 'Turn rate', min: 0.3, max: 3.0, step: 0.1, value: 2.2 },
  // in body lengths; ~1.1 keeps the whale readable in Monterey's 10-15 m visibility
  { id: 'cameraDist', label: 'Camera distance', min: 0.3, max: 1.8, step: 0.05, value: 1.1 },
  { id: 'lungePower', label: 'Lunge power', min: 1.5, max: 4.0, step: 0.1, value: 2.4 },
  { id: 'breachCost', label: 'Breach surge cost ×', min: 0.1, max: 2, step: 0.05, value: 1 },
  { id: 'breachSlowmo', label: 'Breach slow-mo (0/1)', min: 0, max: 1, step: 1, value: 1 },
  // game seconds per real second for the time of day (36 -> a day in 40 min)
  { id: 'timeCompression', label: 'Time compression', min: 1, max: 240, step: 1, value: 36 },
  // a 1,500-krill patch regrowing over 12 game h = 1.25 krill/s, well under a
  // whale's ~4.7/s intake, so patches really deplete and you must move on
  { id: 'regrowHours', label: 'Swarm regrow (game h)', min: 0.25, max: 48, step: 0.25, value: 12 },
];

export const TUNING = {};
for (const t of TUNABLES) TUNING[t.id] = t.value;
