// Live-tunable gameplay parameters. The in-game panel (toggle `T`) edits these
// at runtime; the game reads them every frame, so changes apply immediately.
// `rebuild: true` params require rebuilding a swarm when changed.

export const TUNABLES = [
  { id: 'krillSize', label: 'Krill size', min: 0.2, max: 2.0, step: 0.05, value: 0.2 },
  { id: 'krillCount', label: 'Krill per swarm', min: 300, max: 3000, step: 100, value: 1500, rebuild: true },
  { id: 'krillSpacing', label: 'Krill spacing', min: 0.6, max: 3.0, step: 0.1, value: 1.9 },
  { id: 'krillSpeed', label: 'Krill speed', min: 1.0, max: 8.0, step: 0.2, value: 6.4 },
  { id: 'swimSpeed', label: 'Swim speed', min: 4, max: 20, step: 0.5, value: 10 },
  { id: 'turnRate', label: 'Turn rate', min: 0.3, max: 3.0, step: 0.1, value: 2.2 },
  { id: 'cameraDist', label: 'Camera distance', min: 0.3, max: 1.8, step: 0.05, value: 1.8 },
  { id: 'lungePower', label: 'Lunge power', min: 1.5, max: 4.0, step: 0.1, value: 2.4 },
  { id: 'breachCost', label: 'Breach surge cost ×', min: 0.1, max: 2, step: 0.05, value: 1 },
  { id: 'breachSlowmo', label: 'Breach slow-mo (0/1)', min: 0, max: 1, step: 1, value: 1 },
  { id: 'krillPerLevel', label: 'Krill per level', min: 40, max: 500, step: 20, value: 220 },
];

export const TUNING = {};
for (const t of TUNABLES) TUNING[t.id] = t.value;
