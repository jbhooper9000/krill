import { Game } from './game/Game.js';
import { UI } from './ui/UI.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');

const ui = new UI();
const game = new Game(canvas, ui);
console.log('[Krill] boot ready');

// Surface any runtime error on-screen instead of failing silently.
function showError(msg) {
  const screen = $('error-screen');
  if (!screen) return;
  $('error-message').textContent = msg;
  screen.classList.remove('hidden');
}
window.addEventListener('error', (e) => showError(e.message || String(e.error)));
window.addEventListener('unhandledrejection', (e) => showError(e.reason && (e.reason.message || e.reason)));
$('error-reload-btn').addEventListener('click', () => window.location.reload());

// Reveal the start screen over the live ocean once the first frame is ready.
requestAnimationFrame(() => {
  requestAnimationFrame(() => $('loading-screen').classList.add('hidden'));
});

$('start-btn').addEventListener('click', () => {
  $('start-screen').classList.add('hidden');
  game.start(ui.species);
  ui.fadeControlsHint();
});

// Optional auto-start for headless testing / deep links: ?autostart=humpback
const params = new URLSearchParams(location.search);
if (params.has('autostart')) {
  const species = ['humpback', 'blue', 'sperm'].includes(params.get('autostart'))
    ? params.get('autostart')
    : 'blue';
  requestAnimationFrame(() => {
    ui.selectSpecies(species);
    $('start-screen').classList.add('hidden');
    game.start(species);
  });
}

$('resume-btn').addEventListener('click', () => {
  game.paused = false;
  ui.setPaused(false);
  game.input.lock();
});

$('restart-btn').addEventListener('click', () => {
  window.location.reload();
});

// Re-acquire pointer lock by clicking the canvas mid-game.
canvas.addEventListener('click', () => {
  if (game.running && !game.paused && !game.input.pointerLocked) {
    game.input.lock();
  }
});
