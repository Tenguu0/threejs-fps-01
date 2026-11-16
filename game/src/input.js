// DUSTLINE input — keyboard state, mouse-look deltas and pointer lock.
// The game polls this every fixed step; nothing here knows about rounds.
export class Input {
  constructor() {
    this.keys = new Set();
    this.lookDX = 0;
    this.lookDY = 0;
    this.firing = false;
    this.locked = false;
    this.onKeyDown = null; // (code) => void, set by main.js for one-shot keys
    this.onLockChange = null;
    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.lookDX += e.movementX || 0;
      this.lookDY += e.movementY || 0;
    };
    this._onMouseDown = (e) => {
      if (e.button === 0) this.firing = true;
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.firing = false;
    };
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      // Keep arrows/space from scrolling the page while playing.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
      this.keys.add(e.code);
      if (this.onKeyDown) this.onKeyDown(e.code);
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    };
    this._onBlur = () => {
      this.keys.clear();
      this.firing = false;
    };
  }

  attach(canvas) {
    this.canvas = canvas;
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mousedown', this._onMouseDown);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('pointerlockchange', this._onLockChange);
    window.addEventListener('blur', this._onBlur);
  }

  requestLock() {
    if (!this.canvas || this.locked) return;
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch {
      // Pointer lock unavailable (headless capture) — mouse look just stays off.
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // Consume accumulated mouse movement for this step; returns { dx, dy }.
  consumeLook() {
    const out = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return out;
  }

  get forward() {
    return this.keys.has('KeyW') || this.keys.has('ArrowUp');
  }
  get back() {
    return this.keys.has('KeyS') || this.keys.has('ArrowDown');
  }
  get left() {
    return this.keys.has('KeyA') || this.keys.has('ArrowLeft');
  }
  get right() {
    return this.keys.has('KeyD') || this.keys.has('ArrowRight');
  }
  get crouch() {
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyC');
  }
  get slow() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }
  get interact() {
    return this.keys.has('KeyE');
  }
}
