import * as THREE from 'three';
import { SPECIES } from './species.js';
import { TUNING } from './Tuning.js';

const _fwd = new THREE.Vector3();
const _euler = new THREE.Euler();
const _q = new THREE.Quaternion();
const _desiredCam = new THREE.Vector3();
const _desiredLook = new THREE.Vector3();
const _mouthLocal = new THREE.Vector3();

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
    this.bounds = bounds; // { minY, maxY, radius }

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
    const dist = L * TUNING.cameraDist * this.zoom;
    const height = L * 0.12;

    // the follow point lags the whale a little, so speed reads on screen
    if (snap) this._camTarget.copy(this.position);
    else this._camTarget.lerp(this.position, damp(9, dt));

    const fwd = this.forwardVector();
    _desiredCam.copy(this._camTarget).addScaledVector(fwd, -dist);
    _desiredCam.y += height;
    _desiredLook.copy(this._camTarget).addScaledVector(fwd, dist * 0.6);
    _desiredLook.y += height * 0.5;

    // don't let the camera poke through the surface or floor
    _desiredCam.y = THREE.MathUtils.clamp(_desiredCam.y, this.bounds.minY - L * 0.3, -0.6);

    if (snap) {
      this._camPos.copy(_desiredCam);
      this._camLook.copy(_desiredLook);
    } else {
      this._camPos.lerp(_desiredCam, damp(14, dt));
      this._camLook.lerp(_desiredLook, damp(18, dt));
    }
    this.camera.position.copy(this._camPos);
    this.camera.lookAt(this._camLook);
  }

  // input: { lookX, lookY, forward, ascend, descend, lunge, zoom }
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
    if (input.lunge) {
      if (!this._wasCharging) this.lungeCharge = 0;
      this.lungeCharge = Math.min(1, this.lungeCharge + dt / 0.9);
      this._wasCharging = true;
    } else {
      if (this._wasCharging && this.lungeCharge > 0.25) {
        this.lungeTimer = 1.15;
        this.lungePower = this.lungeCharge;
      }
      this._wasCharging = false;
    }
    if (this.lungeTimer > 0) {
      this.lungeTimer -= dt;
      lungeActive = true;
    }

    // ---- thrust / forward speed (momentum; the whale glides when idle) ----
    let targetSpeed = 0;
    let targetThrust = 0;
    if (input.forward) { targetSpeed = cruise; targetThrust = 1; }
    if (lungeActive) {
      targetSpeed = cruise * (1.2 + TUNING.lungePower * 0.5);
      targetThrust = 1.4 + this.lungePower * 0.6;
    } else if (this._wasCharging) {
      targetSpeed = Math.min(targetSpeed, cruise * 0.4);
      targetThrust = 0.35;
    }
    this.thrust += (targetThrust - this.thrust) * damp(targetThrust > this.thrust ? 3 : 1.5, dt);

    if (targetSpeed > this.speed) {
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
    const desiredPitch = THREE.MathUtils.clamp(this.aimPitch + vertical * 0.75, -1.2, 1.2);
    const maxTurn = TUNING.turnRate * sp.turnRate * 0.5 * (0.35 + 0.65 * Math.min(1, speedN + 0.2));
    const yawErr = wrapAngle(this.aimYaw - this.yaw);
    const pitchErr = desiredPitch - this.pitch;
    const wantYawVel = THREE.MathUtils.clamp(yawErr * 2.2, -maxTurn, maxTurn);
    const wantPitchVel = THREE.MathUtils.clamp(pitchErr * 2.2, -maxTurn * 0.8, maxTurn * 0.8);
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

    // ---- bounds ----
    if (this.position.y < this.bounds.minY) {
      this.position.y = this.bounds.minY;
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else if (this.position.y > this.bounds.maxY) {
      this.position.y = this.bounds.maxY;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }
    const horiz = Math.hypot(this.position.x, this.position.z);
    if (horiz > this.bounds.radius) {
      const k = this.bounds.radius / horiz;
      this.position.x *= k;
      this.position.z *= k;
    }
    this.whale.group.position.copy(this.position);

    // ---- camera ----
    this._updateCamera(dt);
    const fovTarget = Math.max(0, speedN - 0.6) * 7;
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

    this.whale.update(dt, st);
  }

  get mouthPosition() {
    this.whale.group.updateMatrixWorld(true);
    return this.whale.getMouthPosition(_mouthLocal).applyMatrix4(this.whale.group.matrixWorld);
  }

  get forwardDir() {
    return this.forwardVector(this.yaw, this.pitch);
  }
}
