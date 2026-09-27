import * as THREE from 'three';
import { SPECIES } from './species.js';
import { TUNING } from './Tuning.js';

const _fwd = new THREE.Vector3();
const _euler = new THREE.Euler();
const _q = new THREE.Quaternion();
const _desiredCam = new THREE.Vector3();
const _desiredLook = new THREE.Vector3();
const _mouthLocal = new THREE.Vector3();

const G = 9.81;
const _right = new THREE.Vector3();
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// frame-rate independent exponential smoothing factor
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

// The camera (mouse) sets an *aim*; the whale has its own heading and momentum
// and steers toward the aim with a limited, smoothly-accelerating turn rate.
// Movement is always along the whale's body, never along the camera.
export class PlayerController {
  constructor(camera, whale, speciesId, bounds) {
    this.camera = camera;
    this.whale = whale;
    this.sp = SPECIES[speciesId];
    this.bounds = bounds; // { minY, maxY, floorAt?(x, z) -> seafloor y }

    // aim (camera) — raw target and smoothed value
    this._aimYawTarget = 0;
    this._aimPitchTarget = -0.08;
    this.aimYaw = 0;
    this.aimPitch = -0.08;
    this.zoom = 1;

    // whale heading + angular velocity
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this._yawVel = 0;
    this._pitchVel = 0;

    this.position = new THREE.Vector3(0, -this.sp.startDepth, 0);
    this.velocity = new THREE.Vector3();
    this.speed = 0; // forward speed along the body
    this.thrust = 0; // 0..~2, how hard the flukes are working

    this.lungeCharge = 0;
    this.lungeTimer = 0;
    this.lungePower = 0;
    this._wasCharging = false;

    this.fovOffset = 0;

    // breaching (see docs/design/GAME_DESIGN.md section 5): hold F from depth
    // to run up, launch at the surface, fly ballistically, twist, crash back.
    // mode: 'swim' | 'air'. Game sets breachReady and listens via onEvent.
    this.mode = 'swim';
    this.breachReady = false;
    this.onEvent = null; // (type, data): runup | breach-denied | breach-abort | breach | splash
    this._runup = false;
    this._breachHeld = false;
    this._twistBias = 0; // mouse-X steering of the twist during run-up
    this._twist = 0; // roll rate while airborne
    this._twistLeft = 0; // roll still to apply while airborne
    this._submerge = 0; // seconds of reduced control after re-entry
    this._cooldown = 0;
    this._launchInfo = { clearance: 0, q: 0, twist: 0 };
    this.timeScale = 1; // apex slow-motion, applied by Game to the whole sim
    this._filter = 0; // rorquals filter the engulfed water after each lunge
    this.forceClimb = false; // blackout: the body takes over and heads for air
    this.atSurface = false; // blowhole clear of the water
    this.shake = 0;
    this._witness = 0; // blend toward the side-on "witness" camera while airborne
    this._witnessPos = new THREE.Vector3();
    this._camCeil = -0.6; // highest the camera may go (rises above water during a breach)
    this._camDistMul = 1;

    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camTarget = new THREE.Vector3().copy(this.position);
    this._mouth = new THREE.Vector3();

    this.whale.group.position.copy(this.position);
    this.whale.group.rotation.order = 'YXZ';

    this.state = {
      speed: 0,
      thrust: 0,
      turn: 0,
      pitchRate: 0,
      pitch: 0,
      feeding: 0,
      lunge: 0,
      lungeCharge: 0,
      time: 0,
      forward: 0,
      isLunging: false,
    };

    this._updateCamera(0, true);
  }

  get scale() {
    return this.whale.group.scale.x;
  }

  forwardVector(yaw = this.aimYaw, pitch = this.aimPitch) {
    _euler.set(pitch, yaw, 0, 'YXZ');
    return _fwd.set(0, 0, -1).applyEuler(_euler);
  }

  // Orbit camera around a softly-sprung follow point on the whale.
  _updateCamera(dt, snap = false) {
    const L = this.sp.length * this.scale;
    const height = L * 0.12;

    // the follow point lags the whale a little, so speed reads on screen
    if (snap) this._camTarget.copy(this.position);
    else this._camTarget.lerp(this.position, damp(9, dt));

    // pull back and allow the camera above the waterline during a breach
    const air = this.mode === 'air';
    this._camDistMul += ((air ? 1.35 : 1) - this._camDistMul) * damp(air ? 2 : 0.8, dt);
    const ceil = air ? L * 0.6 : this.atSurface ? L * 0.3 : -0.6;
    this._camCeil += (ceil - this._camCeil) * damp(air ? 3 : 1.2, dt);
    const dist = L * TUNING.cameraDist * this.zoom * this._camDistMul;

    const fwd = this.forwardVector();
    _desiredCam.copy(this._camTarget).addScaledVector(fwd, -dist);
    _desiredCam.y += height;
    _desiredLook.copy(this._camTarget).addScaledVector(fwd, dist * 0.6);
    _desiredLook.y += height * 0.5;

    // airborne: glide to a side-on witness shot just above the water
    this._witness += ((air ? 1 : 0) - this._witness) * damp(air ? 2.5 : 1.0, dt);
    if (this._witness > 0.001) {
      _desiredCam.lerp(this._witnessPos, this._witness);
      _desiredLook.lerp(this.position, this._witness);
    }

    // don't let the camera poke through the surface or floor
    const camFloor = this.bounds.floorAt
      ? this.bounds.floorAt(_desiredCam.x, _desiredCam.z) + 1.5
      : this.bounds.minY - L * 0.3;
    _desiredCam.y = THREE.MathUtils.clamp(_desiredCam.y, camFloor, this._camCeil);

    if (snap) {
      this._camPos.copy(_desiredCam);
      this._camLook.copy(_desiredLook);
    } else {
      this._camPos.lerp(_desiredCam, damp(14, dt));
      this._camLook.lerp(_desiredLook, damp(18, dt));
    }
    // NaN guard: one bad frame (e.g. a scripted teleport) must not poison the camera forever
    if (!Number.isFinite(this._camPos.x + this._camPos.y + this._camPos.z)
      || !Number.isFinite(this._camLook.x + this._camLook.y + this._camLook.z)) {
      const ok = Number.isFinite(_desiredCam.x + _desiredCam.y + _desiredCam.z);
      this._camPos.copy(ok ? _desiredCam : this.position);
      if (!ok) this._camPos.z += L * 2;
      this._camLook.copy(this.position);
    }
    this.camera.position.copy(this._camPos);
    if (this.shake > 0.001) {
      const a = this.shake * this.shake * L * 0.025;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a;
      this.camera.position.z += (Math.random() - 0.5) * a;
      this.shake *= Math.exp(-dt * 3);
    }
    this.camera.lookAt(this._camLook);
  }

  // input: { lookX, lookY, forward, ascend, descend, lunge, breach, zoom }
  update(dt, input) {
    const sp = this.sp;
    const cruise = TUNING.swimSpeed * sp.speed;

    // ---- aim (mouse), lightly smoothed to hide uneven mouse polling ----
    this._aimYawTarget -= input.lookX * 0.0028;
    this._aimPitchTarget -= input.lookY * 0.0028;
    this._aimPitchTarget = THREE.MathUtils.clamp(this._aimPitchTarget, -1.3, 1.3);
    const a = damp(22, dt);
    this.aimYaw += (this._aimYawTarget - this.aimYaw) * a;
    this.aimPitch += (this._aimPitchTarget - this.aimPitch) * a;
    this.zoom = THREE.MathUtils.clamp(this.zoom + input.zoom * 0.06, 0.55, 2.0);

    // ---- lunge charging / release ----
    let lungeActive = false;
    if (this._filter > 0) this._filter = Math.max(0, this._filter - dt);
    if (input.lunge && this._filter <= 0 && !this.forceClimb && this.mode === 'swim') {
      if (!this._wasCharging) this.lungeCharge = 0;
      this.lungeCharge = Math.min(1, this.lungeCharge + dt / 0.9);
      this._wasCharging = true;
    } else {
      if (this._wasCharging && this.lungeCharge > 0.25) {
        this.lungeTimer = 1.15;
        this.lungePower = this.lungeCharge;
        this._emit('lunge', { power: this.lungePower });
      }
      this._wasCharging = false;
    }
    if (this.lungeTimer > 0) {
      this.lungeTimer -= dt;
      lungeActive = true;
      if (this.lungeTimer <= 0) {
        // mouth closes: rorquals now filter the engulfed water
        this._filter = this.sp.filterTime;
        if (this._filter > 0) this._emit('filter', { time: this._filter });
      }
    }

    if (this.mode === 'air') {
      this._updateAir(dt, input, cruise);
      return;
    }

    this.timeScale += (1 - this.timeScale) * damp(6, dt);
    const L = sp.length * this.scale;
    const depth = -this.position.y;
    if (this._cooldown > 0) this._cooldown -= dt;
    if (this._submerge > 0) this._submerge = Math.max(0, this._submerge - dt);
    const control = 0.4 + 0.6 * (1 - this._submerge / 1.8);

    // ---- breach run-up: F pressed inside the breach window ----
    if (input.breach && !this._breachHeld && !this._runup) {
      let reason = null;
      if (!this.breachReady) reason = 'Surge not ready';
      else if (this._cooldown > 0) reason = 'Catching your breath';
      else if (depth < 0.8 * L) reason = 'Too shallow — dive deeper first';
      else if (depth > 4 * L) reason = 'Too deep — rise closer to the surface';
      else if (this.bounds.floorAt && -this.bounds.floorAt(this.position.x, this.position.z) < 1.5 * L) {
        reason = 'Too shallow here — find deeper water'; // design doc 5.3: water depth >= 1.5 L
      }
      if (reason) this._emit('breach-denied', { reason });
      else {
        this._runup = true;
        this._twistBias = 0;
        this._emit('runup', {});
      }
    }
    this._breachHeld = input.breach;
    if (this._runup && !input.breach && depth > 0.8 * L) {
      this._runup = false;
      this._emit('breach-abort', {});
    }
    if (this._runup) {
      this._twistBias = THREE.MathUtils.clamp(this._twistBias * Math.exp(-dt * 0.5) - input.lookX * 0.01, -1, 1);
    }

    // ---- thrust / forward speed (momentum; the whale glides when idle) ----
    let targetSpeed = 0;
    let targetThrust = 0;
    if (input.forward) { targetSpeed = cruise; targetThrust = 1; }
    if (this._runup) {
      targetSpeed = Math.max(cruise * 1.3, sp.vExitMax * 1.05);
      targetThrust = 2;
    } else if (this.forceClimb) {
      targetSpeed = cruise * 0.7;
      targetThrust = 0.8;
    } else if (lungeActive) {
      // real engulfment: a short sprint to ~1.7x cruise, then the open mouth brakes hard
      targetSpeed = cruise * 1.7;
      targetThrust = 1.4 + this.lungePower * 0.6;
    } else if (this._wasCharging) {
      targetSpeed = Math.min(targetSpeed, cruise * 0.4);
      targetThrust = 0.35;
    }
    if (this._filter > 0) {
      targetSpeed *= 0.45;
      targetThrust *= 0.5;
    }
    this.thrust += (targetThrust - this.thrust) * damp(targetThrust > this.thrust ? 3 : 1.5, dt);

    if (this._runup) {
      // breach run-up: real fluke-stroke acceleration (m/s^2), so exit speed
      // depends on how deep you start and how fast you were already going
      this.speed = Math.min(targetSpeed, this.speed + sp.breachAccel * dt);
    } else if (targetSpeed > this.speed) {
      // accelerate — heavier animals build speed more slowly
      const accel = (lungeActive ? 2.4 : 0.9) * (14 / sp.length);
      this.speed += (targetSpeed - this.speed) * damp(accel, dt);
    } else {
      // coast: hydrodynamic drag, faster bleed-off when well over target
      const drag = targetSpeed > 0 ? 1.2 : 0.35;
      this.speed += (targetSpeed - this.speed) * damp(drag, dt);
    }
    const speedN = this.speed / cruise; // ~0..2

    // ---- steering: whale heading chases the aim ----
    const vertical = (input.ascend ? 1 : 0) - (input.descend ? 1 : 0);
    const desiredPitch = this._runup
      ? sp.breachClimb + vertical * 0.26 // auto-climb, +-15 deg trim
      : this.forceClimb
        ? (this.atSurface ? 0 : 1.0) // head for air, then lie level to breathe
        : THREE.MathUtils.clamp(this.aimPitch + vertical * 0.75, -1.2, 1.2);
    const maxTurn = TUNING.turnRate * sp.turnRate * 0.5 * (0.35 + 0.65 * Math.min(1, speedN + 0.2)) * control
      * (this._runup ? 1.4 : 1);
    const maxPitchTurn = this._runup ? maxTurn * 1.2 : maxTurn * 0.8;
    const yawErr = wrapAngle(this.aimYaw - this.yaw);
    const pitchErr = desiredPitch - this.pitch;
    const wantYawVel = THREE.MathUtils.clamp(yawErr * 2.2, -maxTurn, maxTurn);
    const wantPitchVel = THREE.MathUtils.clamp(pitchErr * 2.2, -maxPitchTurn, maxPitchTurn);
    const angAccel = damp(3.2, dt);
    this._yawVel += (wantYawVel - this._yawVel) * angAccel;
    this._pitchVel += (wantPitchVel - this._pitchVel) * angAccel;
    this.yaw += this._yawVel * dt;
    this.pitch += this._pitchVel * dt;

    // bank into turns in proportion to real yaw rate and speed
    const targetRoll = THREE.MathUtils.clamp(-this._yawVel * (0.35 + speedN * 0.45), -0.65, 0.65);
    this.roll += (targetRoll - this.roll) * damp(2.5, dt);

    _euler.set(this.pitch, this.yaw, this.roll, 'YXZ');
    _q.setFromEuler(_euler);
    this.whale.group.quaternion.copy(_q);

    // ---- movement: velocity follows the body, lateral slip decays ----
    const bodyFwd = this.forwardVector(this.yaw, this.pitch);
    const along = this.velocity.dot(bodyFwd);
    // lateral component = velocity minus its forward part
    this.velocity.addScaledVector(bodyFwd, -along);
    this.velocity.multiplyScalar(Math.exp(-dt * 2.5));
    this.velocity.addScaledVector(bodyFwd, this.speed);
    // gentle vertical fin/buoyancy control when nearly stopped
    this.velocity.y += vertical * 2.0 * dt * Math.max(0, 1 - speedN);
    this.position.addScaledVector(this.velocity, dt);

    // ---- breach: the run-up reaches the surface ----
    if (this._runup && this.position.y >= -0.2) {
      this._launch(bodyFwd);
      this._finishFrame(dt, input, cruise, maxTurn, lungeActive);
      return;
    }

    // ---- bounds (the surface is soft: whales loll with their backs out) ----
    // Seafloor: terrain-aware when bounds.floorAt(x, z) is given — clearance
    // under the body centre and the head, eased up so canyon walls don't snap.
    let minY = this._floorMinY(bodyFwd, L);
    if (minY > this.bounds.maxY) {
      // too shallow to fit (beach, reef top): the shore stops the whale
      this.position.x -= this.velocity.x * dt;
      this.position.z -= this.velocity.z * dt;
      this.velocity.x *= 0.5; this.velocity.z *= 0.5;
      this.speed *= 0.9;
      minY = this.bounds.maxY;
    }
    if (this.position.y < minY) {
      const hard = minY - L * 0.25;
      this.position.y += (minY - this.position.y) * damp(10, dt);
      if (this.position.y < hard) this.position.y = hard;
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else if (!this._runup && !input.forward && !input.descend && !this.forceClimb
      && this.position.y > this.bounds.maxY - 1.5 && this.position.y <= this.bounds.maxY) {
      // idle at the surface: whales loll (log) with the blowhole clear
      this.position.y += (this.bounds.maxY - this.position.y) * damp(1.5, dt);
      this.velocity.y *= Math.exp(-dt * 3);
    } else if (this.position.y > this.bounds.maxY && !this._runup) {
      this.position.y += (this.bounds.maxY - this.position.y) * damp(4, dt);
      if (this.velocity.y > 0) this.velocity.y = 0;
    }
    this.atSurface = this.position.y >= this.bounds.maxY - 0.6;
    this._finishFrame(dt, input, cruise, maxTurn, lungeActive);
  }

  // Lowest allowed body-centre y: floor under the centre and the head + clearance.
  _floorMinY(bodyFwd, L) {
    const floorAt = this.bounds.floorAt;
    if (!floorAt) return this.bounds.minY;
    const p = this.position;
    const hx = p.x + bodyFwd.x * L * 0.45, hz = p.z + bodyFwd.z * L * 0.45;
    const floor = Math.max(floorAt(p.x, p.z), floorAt(hx, hz));
    return Math.max(this.bounds.minY ?? -Infinity, floor + L * 0.4);
  }

  // Shared end of frame: camera and state for the whale mesh. (No horizontal
  // bounds: the streamed Monterey world has no edges.)
  _finishFrame(dt, input, cruise, maxTurn, lungeActive) {
    const speedN = this.speed / cruise;
    this.whale.group.position.copy(this.position);

    // ---- camera ----
    this._updateCamera(dt);
    const fovTarget = Math.max(0, speedN - 0.6) * 7 + (this.mode === 'air' ? 4 : 0);
    this.fovOffset += (fovTarget - this.fovOffset) * damp(2, dt);

    // ---- state for whale mesh + game ----
    const st = this.state;
    st.speed = speedN;
    st.thrust = this.thrust;
    st.turn = THREE.MathUtils.clamp(this._yawVel / Math.max(0.2, maxTurn), -1, 1);
    st.pitchRate = THREE.MathUtils.clamp(this._pitchVel / Math.max(0.2, maxTurn), -1, 1);
    st.pitch = this.pitch;
    st.feeding = (input.forward || lungeActive) ? 1 : 0;
    st.lunge = lungeActive ? this.lungePower : 0;
    st.lungeCharge = this._wasCharging ? this.lungeCharge : 0;
    st.time += dt;
    st.forward = input.forward ? 1 : 0;
    st.isLunging = lungeActive;
    st.filtering = this._filter > 0;
    st.airborne = this.mode === 'air';

    this.whale.update(dt, st);
  }

  _emit(type, data) {
    if (this.onEvent) this.onEvent(type, data);
  }

  // Leave the water. Launch quality q = speed/vExitMax x angleFactor
  // (1 at 70-80 deg climb, 0.6 at 45 deg); real gravity then decides clearance.
  _launch(bodyFwd) {
    const sp = this.sp;
    const L = sp.length * this.scale;
    const deg = THREE.MathUtils.radToDeg(this.pitch);
    const angleFactor = deg >= 70 ? 1 : THREE.MathUtils.clamp(0.6 + (0.4 * (deg - 45)) / 25, 0.6, 1);
    const q = Math.min(1, this.speed / sp.vExitMax) * angleFactor;
    const v = sp.vExitMax * q;
    const sinP = Math.max(0.2, Math.sin(this.pitch));
    const vy = v * sinP;
    const h = v * Math.cos(this.pitch);
    const hl = Math.hypot(bodyFwd.x, bodyFwd.z) || 1;
    const fx = bodyFwd.x / hl, fz = bodyFwd.z / hl;
    this.velocity.set(fx * h, vy, fz * h);

    this.mode = 'air';
    this._runup = false;
    this.breachReady = false;
    this.atSurface = false;

    // twist: species default; the mouse biases direction and adds up to 40%
    const tAir = Math.max(0.6, (2 * vy) / G);
    const bias = this._twistBias;
    const dir = Math.abs(bias) > 0.15 ? Math.sign(bias) : Math.random() < 0.5 ? -1 : 1;
    const twist = Math.min(sp.twistMax, sp.twistDefault * (1 + 0.4 * Math.abs(bias)));
    this._twist = (dir * twist) / tAir;
    this._twistLeft = twist;

    const apex = (vy * vy) / (2 * G) + this.position.y;
    const clearance = THREE.MathUtils.clamp((apex + 0.5 * L * sinP) / (L * sinP), 0, 1);
    this._launchInfo = { clearance, q, twist };

    // witness camera: stay on whichever side of the whale the camera already is
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const side = Math.sign(
      (this.camera.position.x - this.position.x) * _right.x + (this.camera.position.z - this.position.z) * _right.z,
    ) || 1;
    this._witnessPos.set(
      this.position.x + _right.x * side * 2.5 * L + fx * 0.6 * L,
      0.3 * L,
      this.position.z + _right.z * side * 2.5 * L + fz * 0.6 * L,
    );

    this._emit('breach', { position: this.position, forward: bodyFwd, vy, q, clearance });
  }

  // Ballistic flight: gravity, nose pitches over, body twists onto side/back.
  _updateAir(dt, input, cruise) {
    this.velocity.y -= G * dt;
    const hd = Math.exp(-0.02 * dt);
    this.velocity.x *= hd;
    this.velocity.z *= hd;
    this.position.addScaledVector(this.velocity, dt);

    this.pitch = Math.max(-1.3, this.pitch - 1.1 * dt);
    this._pitchVel = 0;
    this._yawVel *= Math.exp(-dt * 3);
    const dr = Math.min(Math.abs(this._twist * dt), this._twistLeft);
    this._twistLeft -= dr;
    this.roll += Math.sign(this._twist) * dr;
    this.thrust += (0 - this.thrust) * damp(3, dt);
    this.speed = this.velocity.length();

    // slow-motion around the apex (~0.7 s window)
    const slow = TUNING.breachSlowmo && Math.abs(this.velocity.y) < G * 0.35 ? 0.45 : 1;
    this.timeScale += (slow - this.timeScale) * damp(7, dt);

    _euler.set(this.pitch, this.yaw, this.roll, 'YXZ');
    this.whale.group.quaternion.setFromEuler(_euler);
    this.whale.group.position.copy(this.position);

    // re-entry once the body's centre drops through the surface
    if (this.position.y <= 0 && this.velocity.y < 0) {
      const impact = -this.velocity.y;
      const twisted = this._launchInfo.twist - this._twistLeft;
      // landing on the side/back throws the full splash; a belly flop less
      const attitude = Math.abs(wrapAngle(this.roll)) >= THREE.MathUtils.degToRad(60) ? 1 : 0.7;
      this.mode = 'swim';
      this.roll = wrapAngle(this.roll);
      this.velocity.multiplyScalar(0.35);
      this.speed *= 0.35;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.2, 1.2);
      this._submerge = 1.8;
      this._cooldown = 4;
      this.shake = Math.min(1.2, 0.5 + impact / 12);
      this._emit('splash', {
        position: this.position,
        speed: impact,
        attitude,
        clearance: this._launchInfo.clearance,
        twist: THREE.MathUtils.radToDeg(twisted),
      });
    }

    this._finishFrame(dt, input, cruise, 1, false);
  }

  get mouthPosition() {
    this.whale.group.updateMatrixWorld(true);
    return this.whale.getMouthPosition(_mouthLocal).applyMatrix4(this.whale.group.matrixWorld);
  }

  get forwardDir() {
    return this.forwardVector(this.yaw, this.pitch);
  }
}
