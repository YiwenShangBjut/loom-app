import type { RopePhysics } from '../physics/RopePhysics';

/**
 * DragController listens to pointer events on the canvas element and
 * translates them into physics drag calls.
 *
 * It handles both mouse and touch via the unified PointerEvent API so
 * the same code works on Android WebView and desktop browsers.
 *
 * No PixiJS or Matter.js imports here — it only calls the public
 * drag API on RopePhysics.
 */
export class DragController {
  private canvas: HTMLCanvasElement;
  private physics: RopePhysics;
  private active = false;

  // Bound handlers stored so removeEventListener can match them
  private onPointerDown: (e: PointerEvent) => void;
  private onPointerMove: (e: PointerEvent) => void;
  private onPointerUp:   (e: PointerEvent) => void;

  constructor(canvas: HTMLCanvasElement, physics: RopePhysics) {
    this.canvas = canvas;
    this.physics = physics;

    this.onPointerDown = this.handleDown.bind(this);
    this.onPointerMove = this.handleMove.bind(this);
    this.onPointerUp   = this.handleUp.bind(this);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup',   this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);

    // Prevent default touch scroll so dragging the rope doesn't scroll the page
    canvas.style.touchAction = 'none';
  }

  private canvasPoint(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    // Account for devicePixelRatio scaling applied by PixiJS autoDensity
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (e.clientX - rect.left) * (this.canvas.width  / rect.width  / dpr),
      y: (e.clientY - rect.top)  * (this.canvas.height / rect.height / dpr),
    };
  }

  private handleDown(e: PointerEvent): void {
    const { x, y } = this.canvasPoint(e);
    this.physics.startDrag(x, y);
    this.active = true;
    this.canvas.setPointerCapture(e.pointerId);
  }

  private handleMove(e: PointerEvent): void {
    if (!this.active) return;
    const { x, y } = this.canvasPoint(e);
    this.physics.moveDrag(x, y);
  }

  private handleUp(_e: PointerEvent): void {
    if (!this.active) return;
    this.physics.endDrag();
    this.active = false;
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown',   this.onPointerDown);
    this.canvas.removeEventListener('pointermove',   this.onPointerMove);
    this.canvas.removeEventListener('pointerup',     this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
  }
}
