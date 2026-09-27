import { Game } from './game/Game.js';
import { UI } from './ui/UI.js';
import { GameAudio } from './game/Audio.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');

const ui = new UI();
const game = new Game(canvas, ui);
ui.attach(game);

// Procedural sound (src/game/Audio.js). Browsers only allow audio after a user
// gesture, so the context is created on the first click / key press (the
// start button counts). ?noaudio turns it off.
const audio = new GameAudio({ disabled: new URLSearchParams(location.search).has('noaudio') });
game.audio = audio;
ui.attachAudio(audio);
const unlockAudio = () => {
  if (!audio.unlock() && audio.enabled) return;
  for (const t of ['pointerdown', 'keydown', 'touchend']) window.removeEventListener(t, unlockAudio, true);
};
for (const t of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(t, unlockAudio, true);
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

const params = new URLSearchParams(location.search);
const autostart = params.has('autostart');

// The live scene is the menu: the selected whale idles behind the text.
ui.onSelect = (id) => game.previewSpecies(id);
const initial = params.get('species');
if (['humpback', 'blue', 'sperm'].includes(initial)) ui.selectSpecies(initial, true);
if (!autostart) game.previewSpecies(ui.species);

// Reveal the start screen over the live ocean once the first frames are ready.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const loading = $('loading-screen');
    loading.classList.add('fading');
    setTimeout(() => loading.classList.add('hidden'), 450);
    if (!autostart) {
      const tab = document.querySelector('.tab[aria-selected="true"]');
      if (tab) tab.focus({ preventScroll: true });
    }
  });
});

const startScreen = $('start-screen');
function startGame(species = ui.species) {
  if (game.running || ui.isLocked(species)) return;
  startScreen.classList.add('fading');
  setTimeout(() => startScreen.classList.add('hidden'), 450);
  game.start(species);
}

$('start-btn').addEventListener('click', () => startGame());

// Menu keys: ←/→ switch species, Enter dives in. Pause: Enter resumes.
window.addEventListener('keydown', (e) => {
  if (!game.running) {
    if (startScreen.classList.contains('hidden')) return;
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      ui.cycleSpecies(e.code === 'ArrowLeft' ? -1 : 1);
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      startGame();
    }
  } else if (game.paused && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
    // let a focused Restart button keep its own Enter
    if (document.activeElement === $('restart-btn')) return;
    e.preventDefault();
    resume();
  }
});

// Optional auto-start for headless testing / deep links: ?autostart=humpback
if (autostart) {
  const species = ['humpback', 'blue', 'sperm'].includes(params.get('autostart'))
    ? params.get('autostart')
    : 'blue';
  requestAnimationFrame(() => {
    ui.selectSpecies(species, true);
    startScreen.classList.add('hidden');
    game.start(species);
  });
}
// handle for automated testing
if (autostart || params.has('test')) window.krill = game;

function resume() {
  if (ui.consumeDayCard()) return; // the day card's "Next day"
  game.paused = false;
  ui.setPaused(false);
  game.input.lock();
}

$('resume-btn').addEventListener('click', resume);

$('restart-btn').addEventListener('click', () => {
  window.location.reload();
});

// Re-acquire pointer lock by clicking the canvas mid-game.
canvas.addEventListener('click', () => {
  if (game.running && !game.paused && !game.input.pointerLocked) {
    game.input.lock();
  }
});
