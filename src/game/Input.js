export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.buttons = { left: false, right: false };
    this._lookX = 0;
    this._lookY = 0;
    this._wheel = 0;
    this.pointerLocked = false;
    this._dragging = false;
    this._lastX = 0;
    this._lastY = 0;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.buttons.left = true;
      if (e.button === 2) this.buttons.right = true;
      if (!this.pointerLocked && e.button === 0) {
        this._dragging = true;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.buttons.left = false; this._dragging = false; }
      if (e.button === 2) this.buttons.right = false;
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      this._dragging = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) {
        this._lookX += e.movementX;
        this._lookY += e.movementY;
      } else if (this._dragging) {
        this._lookX += e.clientX - this._lastX;
        this._lookY += e.clientY - this._lastY;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._wheel += e.deltaY * 0.01;
    }, { passive: false });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  lock() {
    try {
      if (this.canvas.requestPointerLock) {
        const p = this.canvas.requestPointerLock();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) {
      // pointer lock unavailable (e.g. headless) — drag-to-look still works
    }
  }

  key(code) {
    return this.keys.has(code);
  }

  frame() {
    const input = {
      lookX: this._lookX,
      lookY: this._lookY,
      zoom: this._wheel,
      forward: this.buttons.left || this.key('KeyW') || this.key('ArrowUp'),
      ascend: this.key('Space'),
      descend: this.key('ShiftLeft') || this.key('ShiftRight') || this.key('ControlLeft') || this.key('ControlRight'),
      lunge: this.buttons.right,
    };
    this._lookX = 0;
    this._lookY = 0;
    this._wheel = 0;
    return input;
  }

  clearLook() {
    this._lookX = 0;
    this._lookY = 0;
    this._wheel = 0;
  }

  reset() {
    this.keys.clear();
    this.buttons.left = false;
    this.buttons.right = false;
    this._lookX = 0;
    this._lookY = 0;
    this._wheel = 0;
    this._dragging = false;
  }
}
