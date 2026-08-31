import * as THREE from 'three';
import { SPECIES } from './species.js';
import { TUNING } from './Tuning.js';

const UP = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _euler = new THREE.Euler();
const _targetQ = new THREE.Quaternion();

export class PlayerController {
  constructor(camera, whale, speciesId, bounds) {
    this.camera = camera;
    this.whale = whale;
    this.sp = SPECIES[speciesId];

    this.bounds = bounds; // { minY, maxY, radius }
    this.aimYaw = 0;
    this.aimPitch = -0.08;
    this.dist = this.sp.length * TUNING.cameraDist;
    this.zoom = 1;
    this.heightOffset = this.sp.length * 0.12;

    this.position = new THREE.Vector3(0, -this.sp.startDepth, 0);
    this.velocity = new THREE.Vector3();
    this.speed = 0;

    this.lungeCharge = 0;
    this.lungeTimer = 0;
    this.lungePower = 0;
    this._wasCharging = false;

    this.roll = 0;

    // camera smoothed position
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._initCam();

    // place whale
    this.whale.group.position.copy(this.position);
    this.whale.group.rotation.order = 'YXZ';

    this.state = {
      speed: 0,
      turn: 0,
      pitch: 0,
      feeding: 0,
      lunge: 0,
      lungeCharge: 0,
      time: 0,
      forward: 0,
    };
  }

  _initCam() {
    this._updateCamera(1);
    this._camPos.copy(this.camera.position);
    this._camLook.set(0, -this.sp.startDepth, -10);
    this.camera.lookAt(this._camLook);
  }

  forwardVector() {
    _euler.set(this.aimPitch, this.aimYaw, 0, 'YXZ');
    return _fwd.set(0, 0, -1).applyEuler(_euler);
  }

  _updateCamera(smoothness) {
    const fwd = this.forwardVector();
    const target = this.position.clone().addScaledVector(UP, this.heightOffset);
    const desired = target.clone().addScaledVector(fwd, -this.dist);
    this._camPos.lerp(desired, smoothness);
    this.camera.position.copy(this._camPos);

    const look = target.clone().addScaledVector(fwd, this.dist * 0.6);
    this._camLook.lerp(look, smoothness);
    this.camera.lookAt(this._camLook);
  }

  // input: { lookX, lookY, forward, ascend, descend, lunge, zoom }
  update(dt, input) {
    const sp = this.sp;
    const cruise = TUNING.swimSpeed * sp.speed;
    const turnSpeed = TUNING.turnRate * sp.turnRate;

    // look
    this.aimYaw -= input.lookX * 0.0032;
    this.aimPitch -= input.lookY * 0.0032;
    this.aimPitch = THREE.MathUtils.clamp(this.aimPitch, -1.25, 1.25);
    this.zoom = THREE.MathUtils.clamp(this.zoom + input.zoom * 0.06, 0.55, 2.0);
    this.dist = sp.length * TUNING.cameraDist * this.zoom;

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

    // ---- speed ----
    let targetSpeed = 0;
    if (input.forward) targetSpeed = cruise;
    if (lungeActive) targetSpeed = cruise * (1.2 + TUNING.lungePower * 0.5);
    else if (this._wasCharging) targetSpeed = cruise * 0.4;

    const accel = targetSpeed > this.speed ? 6 : 3.5;
    this.speed += (targetSpeed - this.speed) * Math.min(1, accel * dt);
    if (!input.forward && !lungeActive && !this._wasCharging) {
      this.speed = Math.max(0, this.speed - cruise * 0.5 * dt);
    }

    // ---- orientation ----
    const fwd = this.forwardVector();
    const whalePitch = THREE.MathUtils.clamp(this.aimPitch, -0.7, 0.7);
    const targetRoll = THREE.MathUtils.clamp(-input.lookX * 0.9, -0.5, 0.5);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 4);

    _euler.set(whalePitch, this.aimYaw, this.roll, 'YXZ');
    _targetQ.setFromEuler(_euler);
    this.whale.group.quaternion.slerp(_targetQ, Math.min(1, dt * turnSpeed));

    // ---- movement ----
    const moveDir = fwd.clone();
    this.position.addScaledVector(moveDir, this.speed * dt);

    // explicit rise/dive (pitch already contributes via moveDir above)
    const vyTarget = (input.ascend ? 7 : 0) + (input.descend ? -7 : 0);
    this.velocity.y += (vyTarget - this.velocity.y) * Math.min(1, dt * 5);
    this.position.y += this.velocity.y * dt;

    // clamp bounds
    this.position.y = THREE.MathUtils.clamp(this.position.y, this.bounds.minY, this.bounds.maxY);
    const horiz = Math.hypot(this.position.x, this.position.z);
    if (horiz > this.bounds.radius) {
      const k = this.bounds.radius / horiz;
      this.position.x *= k;
      this.position.z *= k;
    }

    this.whale.group.position.copy(this.position);

    // ---- camera ----
    this._updateCamera(1 - Math.pow(0.001, dt));

    // ---- state for whale mesh + game ----
    this.state.speed = this.speed / cruise;
    this.state.turn = THREE.MathUtils.clamp(-input.lookX * 4, -1, 1);
    this.state.pitch = whalePitch;
    this.state.feeding = (input.forward || lungeActive) ? 1 : 0;
    this.state.lunge = lungeActive ? this.lungePower : 0;
    this.state.lungeCharge = this._wasCharging ? this.lungeCharge : 0;
    this.state.time += dt;
    this.state.forward = input.forward ? 1 : 0;
    this.state.isLunging = lungeActive;

    this.whale.update(dt, this.state);
  }

  get mouthPosition() {
    this.whale.group.updateMatrixWorld(true);
    const local = this.whale.mouthPosition;
    return local.clone().applyMatrix4(this.whale.group.matrixWorld);
  }

  get forwardDir() {
    return this.forwardVector();
  }
}
