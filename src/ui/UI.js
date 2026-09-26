const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.species = 'blue';
    this._levelBannerTimer = null;

    this.cards = [...document.querySelectorAll('.species-card')];
    this.cards.forEach((card) => {
      card.addEventListener('click', () => this.selectSpecies(card.dataset.species));
    });
    this.selectSpecies('blue');
  }

  selectSpecies(id) {
    this.species = id;
    this.cards.forEach((c) => c.classList.toggle('selected', c.dataset.species === id));
  }

  // ---- HUD ----
  showHud() {
    $('hud').classList.remove('hidden');
  }

  hideHud() {
    $('hud').classList.add('hidden');
  }

  setKrill(n) {
    $('krill-count').textContent = n.toLocaleString();
  }

  addKrill(n) {
    this.setKrill(n);
  }

  setGrowth(pct, level) {
    const fill = $('growth-fill');
    fill.style.width = `${Math.round(pct * 100)}%`;
    $('growth-pct').textContent = `${Math.round(pct * 100)}%`;
    const hint = $('growth-hint');
    hint.textContent = pct >= 0.85
      ? 'Almost there — one more feast to grow!'
      : 'Eat krill to grow and dive deeper';
  }

  setZone(name, level) {
    $('zone-name').textContent = name;
    $('zone-level').textContent = `Zone ${level}`;
  }

  setDepth(d) {
    $('depth-value').textContent = `${d} m`;
  }

  setLunge(charge, active) {
    const fill = $('lunge-fill');
    fill.style.width = `${Math.round(charge * 100)}%`;
    if (active) {
      fill.style.background = 'linear-gradient(90deg, #7bffc8, #57e6c8)';
    } else {
      fill.style.background = '';
    }
  }

  setBreach(charge, ready, cost = 1) {
    $('breach-fill').style.width = `${Math.round(Math.min(1, charge / cost) * 100)}%`;
    $('breach-wrap').classList.toggle('ready', ready);
    if (!this._promptTimer) {
      $('breach-hint').textContent = ready ? 'dive, then hold F' : 'eat krill to charge';
    }
  }

  // Short one-line message in the breach prompt (e.g. why F did nothing).
  prompt(text) {
    $('breach-hint').textContent = text;
    clearTimeout(this._promptTimer);
    this._promptTimer = setTimeout(() => { this._promptTimer = null; }, 1800);
  }

  toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  breach(count) {
    const el = $('breach-wrap');
    el.classList.remove('fired');
    void el.offsetWidth;
    el.classList.add('fired');
  }

  levelUp(level, zoneName) {
    $('levelup-title').textContent = `Zone ${level} — ${zoneName}`;
    $('levelup-sub').textContent = 'You grew. The depths open below you.';
    const banner = $('levelup-banner');
    banner.style.animation = 'none';
    void banner.offsetWidth;
    banner.style.animation = '';
    banner.classList.remove('hidden');
    clearTimeout(this._levelBannerTimer);
    this._levelBannerTimer = setTimeout(() => banner.classList.add('hidden'), 3400);
  }

  setPaused(paused) {
    $('pause-screen').classList.toggle('hidden', !paused);
  }

  fadeControlsHint() {
    const hint = $('controls-hint');
    if (hint) hint.classList.add('faded');
  }
}
