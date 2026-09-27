// Whale physiology (docs/design/GAME_DESIGN.md s4.1, s4.2): oxygen drains
// underwater and refills in blows at the surface; Condition (blubber) is the
// long-term score; the stomach caps intake so patches can't be farmed forever.
// Physiology runs ~4x faster than real; budgets below are game seconds.

export class Physiology {
  constructor(sp) {
    this.sp = sp;
    this.o2 = 1;
    this.condition = sp.startCondition;
    this.target = sp.conditionTarget;
    this.stomach = 0; // 0..1
    this.blackout = false;
    this._blowTimer = 0.4;
    this._surfaced = false;
    this._sinceSurface = 99; // seconds since the blowhole was last clear
    this._stomachWarned = false;
    // day stats for the summary card
    this.stats = { kg: 0, dives: 0, lunges: 0, breaches: 0, blackouts: 0, bestLunge: 0 };
    this._lungeCatch = 0;
  }

  get stomachFull() {
    return this.stomach >= 1;
  }

  // ctx: { atSurface, airborne, exertion (0..~2 thrust), deepBreath }
  // Returns an event name or null: 'blow' | 'blackout' | 'recovered' | 'dive' | 'stomach-full'
  update(dt, ctx) {
    const sp = this.sp;
    let event = null;

    // metabolism: Condition drains slowly all the time
    this.condition = Math.max(0, this.condition - sp.metabolism * dt);
    // digestion empties the stomach over ~90 s
    this.stomach = Math.max(0, this.stomach - dt / 90);
    if (this.stomach < 0.85) this._stomachWarned = false;

    // airborne (breach): no drain, no blows, not a dive
    if (ctx.airborne) return null;

    if (ctx.atSurface) {
      if (!this._surfaced) {
        this._surfaced = true;
        // first blow soon after the blowhole clears — unless we only dipped
        // under for a moment (no farming blows by bobbing)
        if (this._sinceSurface > 4) this._blowTimer = 0.6;
      }
      this._sinceSurface = 0;
      // a series of blows. Real surface intervals are ~1-3 min per 5-8 min
      // dive (15-45 s at the 4x physiology clock): ~3.5 s between blows,
      // +12% each; holding a deep breath is slower but fills more per blow
      if (this.o2 < 1) {
        this._blowTimer -= dt;
        if (this._blowTimer <= 0) {
          this.o2 = Math.min(1, this.o2 + (ctx.deepBreath ? 0.24 : 0.12));
          this._blowTimer = ctx.deepBreath ? 5 : 3.5;
          event = 'blow';
        }
      }
      if (this.blackout && this.o2 >= 0.35) {
        this.blackout = false;
        event = 'recovered';
      }
    } else {
      this._sinceSurface += dt;
      if (this._surfaced && !this.blackout && this._sinceSurface > 4) {
        this._surfaced = false;
        this.stats.dives++;
        event = 'dive';
      }
      // exertion (lunges, run-ups, sprinting) burns oxygen faster
      const burn = 1 + Math.max(0, ctx.exertion - 1) * 0.6;
      this.o2 = Math.max(0, this.o2 - (burn * dt) / sp.o2Budget);
      if (this.o2 <= 0 && !this.blackout) {
        this.blackout = true;
        this.condition = Math.max(0, this.condition - 25);
        this.stats.blackouts++;
        event = 'blackout';
      }
    }
    return event;
  }

  lungeStarted() {
    this.o2 = Math.max(0, this.o2 - this.sp.lungeO2);
    this.condition = Math.max(0, this.condition - 0.15);
    this.stats.lunges++;
    this._lungeCatch = 0;
  }

  breached() {
    this.o2 = Math.max(0, this.o2 - 0.1);
    this.condition = Math.max(0, this.condition - 4);
    this.stats.breaches++;
  }

  // How many of `count` krill in the mouth actually fit in the stomach.
  swallow(count, lunging) {
    const room = Math.max(0, Math.floor((1 - this.stomach) * this.sp.stomachKrill));
    const n = Math.min(count, room);
    this.stomach = Math.min(1, this.stomach + n / this.sp.stomachKrill);
    this.condition = Math.min(100, this.condition + n * this.sp.conditionPerKrill);
    this.stats.kg += n * this.sp.krillKg;
    if (lunging) {
      this._lungeCatch += n;
      this.stats.bestLunge = Math.max(this.stats.bestLunge, this._lungeCatch);
    }
    return n;
  }

  // true once per fill-up, so the game can prompt without spamming
  takeStomachWarning() {
    if (this.stomachFull && !this._stomachWarned) {
      this._stomachWarned = true;
      return true;
    }
    return false;
  }
}
