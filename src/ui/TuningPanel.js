import { TUNABLES, TUNING } from '../game/Tuning.js';

// Generates the slider panel that edits the live TUNING values.
export class TuningPanel {
  constructor(onRebuild) {
    this.onRebuild = onRebuild;
    this.el = document.getElementById('tuning-panel');
    this._build();
  }

  _fmt(value, step) {
    return step >= 1 ? String(Math.round(value)) : value.toFixed(2);
  }

  _build() {
    const title = document.createElement('div');
    title.className = 'tune-title';
    title.textContent = 'Tune';
    this.el.appendChild(title);

    for (const t of TUNABLES) {
      const row = document.createElement('div');
      row.className = 'tune-row';

      const head = document.createElement('div');
      head.className = 'tune-head';

      const label = document.createElement('span');
      label.className = 'tune-label';
      label.textContent = t.label;

      const val = document.createElement('span');
      val.className = 'tune-val';
      val.textContent = this._fmt(t.value, t.step);

      head.appendChild(label);
      head.appendChild(val);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = t.min;
      input.max = t.max;
      input.step = t.step;
      input.value = t.value;

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        TUNING[t.id] = v;
        val.textContent = this._fmt(v, t.step);
      });
      if (t.rebuild) {
        input.addEventListener('change', () => this.onRebuild && this.onRebuild());
      }

      row.appendChild(head);
      row.appendChild(input);
      this.el.appendChild(row);
    }

    const note = document.createElement('div');
    note.className = 'tune-note';
    note.textContent = 'Press T to close — values apply live.';
    this.el.appendChild(note);
  }

  show() {
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }
}
