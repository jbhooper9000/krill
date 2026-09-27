import { TUNING } from './Tuning.js';

// Time of day at sea. Compressed so a session is roughly "a day"; later this
// can be driven by real local time (and real weather) for Monterey Bay.
export class Clock {
  constructor(startHour = 9) {
    this.hours = startHour; // 0..24
  }

  update(dt) {
    this.hours = (this.hours + (dt * TUNING.timeCompression) / 3600) % 24;
  }

  get hh() {
    return Math.floor(this.hours);
  }

  get mm() {
    return Math.floor((this.hours % 1) * 60);
  }

  // 1 in full daylight, 0 at night, smooth over dawn (5:30-7:30) and dusk (18:30-20:30)
  get daylight() {
    const h = this.hours;
    const ramp = (a, b, x) => Math.min(1, Math.max(0, (x - a) / (b - a)));
    return ramp(5.5, 7.5, h) * (1 - ramp(18.5, 20.5, h));
  }
}
