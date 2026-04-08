import { Application, Container, Graphics } from 'pixi.js';
import type { ColorSource } from 'pixi.js';
import type { AnchorPoint, LoomOutline, LoomShape, Point } from '../physics/types';

export interface LoomRendererOptions {
  background?: ColorSource;
}

/** Loom 圆心在视图高度上的比例（0 为顶部；原 0.36，增大则整体下移）。 */
const LOOM_CENTER_Y_FRAC = 0.42;

/** Match circle: 1 + 8*20 + 48 = 209. Triangle: 1 + 53 + 53 + 54 + 48 = 209. */
const ANCHOR_COUNT = 209;
const TRI_SPOKE_STEPS = [53, 53, 54] as const;

function dashStrokeLine(
  g: Graphics,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  DASH: number,
  GAP: number,
  color: number,
  width: number,
  alpha: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  let t = 0;
  let draw = true;
  while (t < len) {
    const seg = Math.min(draw ? DASH : GAP, len - t);
    if (draw) {
      g.moveTo(x0 + ux * t, y0 + uy * t)
        .lineTo(x0 + ux * (t + seg), y0 + uy * (t + seg))
        .stroke({ color, width, alpha });
    }
    t += seg;
    draw = !draw;
  }
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Outward unit normal of edge a→b for a CCW polygon; `inside` is any interior point. */
function edgeOutwardNormal(a: Point, b: Point, inside: Point): { nx: number; ny: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let nx = dy;
  let ny = -dx;
  const nlen = Math.hypot(nx, ny) || 1;
  nx /= nlen;
  ny /= nlen;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const vx = inside.x - mx;
  const vy = inside.y - my;
  if (nx * vx + ny * vy > 0) {
    nx = -nx;
    ny = -ny;
  }
  return { nx, ny };
}

function avgUnitNormals(
  n1: { nx: number; ny: number },
  n2: { nx: number; ny: number },
): { nx: number; ny: number } {
  let nx = n1.nx + n2.nx;
  let ny = n1.ny + n2.ny;
  const len = Math.hypot(nx, ny) || 1;
  return { nx: nx / len, ny: ny / len };
}

function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby || 1;
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * abx, y: a.y + t * aby };
}

/**
 * LoomRenderer draws a circular embroidery-hoop loom and exposes:
 *  - `app`               — the PixiJS Application (for other renderers)
 *  - `getAnchorPoints()` — dense snap targets along all spokes and the rim
 *
 * Anchor layout (no dots drawn):
 *   · Centre (1)
 *   · Along each of 8 spokes: Math.round(innerR / SPOKE_PITCH) evenly-spaced
 *     points from centre outward, including the spoke tip on the rim
 *   · Rim: RIM_COUNT evenly-spaced points along the hoop (starting at top)
 *
 * PixiJS 8 / _cancelResize bug fix: _ready flag ensures app.destroy() is only
 * called after app.init() has fully completed.
 */
export class LoomRenderer {
  private _app: Application | null = null;
  private _ready = false;
  /** Stage background layer so extract(stage) includes background color. */
  private _bgGfx: Graphics | null = null;
  private _bgColor: ColorSource = 0xffffff;
  /** Zoom + pan container; content is its child so pinch zoom affects both loom and ropes. */
  private _zoomContainer: Container | null = null;
  /** Single container for loom + ropes so both use the same coordinate system. */
  private _content: Container | null = null;
  private frameGfx: Graphics | null = null;
  private _anchorPoints: AnchorPoint[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private _resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** View size used for loom and anchors (single source of truth). */
  private _viewWidth = 0;
  private _viewHeight = 0;
  private _loomShape: LoomShape = 'circle';
  /** Last hoop radius (circle) or circumradius to triangle vertices — for outline / export hints. */
  private _loomInnerR = 0;
  /** Detect resize vs shape change for in-place anchor updates. */
  private _lastDrawLoomShape: LoomShape | null = null;

  /** Target distance between anchor points along a spoke (logical px). Smaller = more snap points. */
  /** Fixed spoke steps per spoke so anchor count is stable across resize (update in place). */
  private static readonly SPOKE_STEPS = 20;
  /** Fixed rim anchor count so anchor count is stable across resize. */
  private static readonly RIM_COUNT = 48;

  get app(): Application {
    if (!this._app) throw new Error('LoomRenderer not initialised');
    return this._app;
  }

  getAnchorPoints(): AnchorPoint[] {
    return this._anchorPoints;
  }

  getLoomShape(): LoomShape {
    return this._loomShape;
  }

  setLoomShape(shape: LoomShape, force = false): void {
    if (!force && this._loomShape === shape) return;
    this._loomShape = shape;
    this.drawLoom();
  }

  /** Outline for hit-testing / pan guard; call after drawLoom. */
  getLoomOutline(): LoomOutline {
    const c = this.getLoomCenterContent();
    if (this._loomShape === 'circle') {
      return { kind: 'circle', rimRadius: this._loomInnerR };
    }
    const anchors = this._anchorPoints;
    if (anchors.length < 194) {
      return { kind: 'triangle', v0: { ...c }, v1: { ...c }, v2: { ...c } };
    }
    const v0 = anchors[161]!;
    const v1 = anchors[177]!;
    const v2 = anchors[193]!;
    return {
      kind: 'triangle',
      v0: { x: v0.x, y: v0.y },
      v1: { x: v1.x, y: v1.y },
      v2: { x: v2.x, y: v2.y },
    };
  }

  /** Container that holds loom graphics; add rope/bridge here so coords match. */
  getContentContainer(): Container {
    if (!this._content) throw new Error('LoomRenderer not initialised');
    return this._content;
  }

  /** Zoom container (scale + position); used for pinch. */
  getZoomContainer(): Container {
    if (!this._zoomContainer) throw new Error('LoomRenderer not initialised');
    return this._zoomContainer;
  }

  /** Current scale (1 = no zoom). */
  getZoomScale(): number {
    return this._zoomContainer?.scale.x ?? 1;
  }

  /** Update the renderer clear / canvas background (Pixi BackgroundSystem). */
  setCanvasBackground(color: ColorSource): void {
    if (!this._app || !this._ready) return;
    this._bgColor = color;
    this._redrawBackground();
    this._app.renderer.background.color = color;
    // Ticker may be stopped (idle); still need one frame so the clear colour appears immediately.
    this._app.render();
  }

  /** Loom center in content space (for label positioning). */
  getLoomCenterContent(): { x: number; y: number } {
    if (this._viewWidth <= 0 || this._viewHeight <= 0) return { x: 0, y: 0 };
    return { x: this._viewWidth / 2, y: this._viewHeight * LOOM_CENTER_Y_FRAC };
  }

  /** Loom inner radius in content space (circle radius / triangle circumradius). */
  getLoomInnerRadiusContent(): number {
    return this._loomInnerR;
  }

  /**
   * Zoom so that the point at (canvasX, canvasY) stays under the cursor/finger.
   * @param canvasX Canvas-space X of the zoom anchor (cursor/finger)
   * @param canvasY Canvas-space Y of the zoom anchor
   * @param newScale Target scale (clamped 1..3)
   */
  zoomAt(canvasX: number, canvasY: number, newScale: number): void {
    if (!this._zoomContainer) return;
    // In Create page we only allow zooming back to the original size (scale=1),
    // not smaller than that.
    const s = Math.max(1, Math.min(3, newScale));
    const { x: cx, y: cy } = this.getContentCoords(canvasX, canvasY);
    const panX = canvasX - cx * s;
    const panY = canvasY - cy * s;
    this._zoomContainer.position.set(panX, panY);
    this._zoomContainer.scale.set(s);
  }

  /**
   * Pan (translate) the zoom container in canvas pixel coordinates.
   * This keeps the current scale unchanged.
   */
  panBy(canvasDx: number, canvasDy: number): void {
    if (!this._zoomContainer) return;
    this._zoomContainer.position.x += canvasDx;
    this._zoomContainer.position.y += canvasDy;
  }

  /** Reset view transform to default framing (no pan, scale=1). */
  resetViewTransform(): void {
    if (!this._zoomContainer) return;
    this._zoomContainer.position.set(0, 0);
    this._zoomContainer.scale.set(1);
  }

  /**
   * Convert canvas pixel coordinates to content (loom) space.
   * Required for correct hit-test when zoomed/panned.
   */
  getContentCoords(canvasX: number, canvasY: number): { x: number; y: number } {
    const z = this._zoomContainer;
    if (!z) return { x: canvasX, y: canvasY };
    const s = z.scale.x;
    const panX = z.position.x;
    const panY = z.position.y;
    return {
      x: (canvasX - panX) / s,
      y: (canvasY - panY) / s,
    };
  }

  /** Convert content (loom) coordinates to canvas pixel coordinates. */
  getCanvasCoords(contentX: number, contentY: number): { x: number; y: number } {
    const z = this._zoomContainer;
    if (!z) return { x: contentX, y: contentY };
    const s = z.scale.x;
    const panX = z.position.x;
    const panY = z.position.y;
    return {
      x: panX + contentX * s,
      y: panY + contentY * s,
    };
  }

  async init(container: HTMLElement, options: LoomRendererOptions = {}): Promise<void> {
    const { background = 0xffffff } = options;
    this._bgColor = background;
    const w = container.clientWidth  || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    this._app = new Application();
    await this._app.init({
      width: w,
      height: h,
      background,
      antialias: true,
      resolution: 1,
      autoDensity: true,
    });

    if (!this._app) return; // destroyed mid-init

    this._ready = true;
    this._bgGfx = new Graphics();
    this._zoomContainer = new Container();
    this._zoomContainer.pivot.set(0, 0);
    this._zoomContainer.position.set(0, 0);
    this._zoomContainer.scale.set(1);
    this._content = new Container();
    this._zoomContainer.addChild(this._content);
    this._app.stage.addChild(this._bgGfx);
    this._app.stage.addChild(this._zoomContainer);
    container.appendChild(this._app.canvas);
    this._resizeView(container.clientWidth || w, container.clientHeight || h);
    this.drawLoom();

    const RESIZE_DEBOUNCE_MS = 150;
    this.resizeObserver = new ResizeObserver(() => {
      if (!this._app) return;
      this._resizeTimer && clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        if (Math.abs(w - this._viewWidth) < 1 && Math.abs(h - this._viewHeight) < 1) return;
        this._resizeView(w, h);
        this.drawLoom();
      }, RESIZE_DEBOUNCE_MS);
    });
    this.resizeObserver.observe(container);
  }

  /** Resize renderer and store view size from args (single source of truth). */
  private _resizeView(w: number, h: number): void {
    if (!this._app || w <= 0 || h <= 0) return;
    this._viewWidth = w;
    this._viewHeight = h;
    this._app.renderer.resize(w, h, 1);
    this._redrawBackground();
  }

  private _redrawBackground(): void {
    if (!this._bgGfx || this._viewWidth <= 0 || this._viewHeight <= 0) return;
    this._bgGfx.clear();
    this._bgGfx.rect(0, 0, this._viewWidth, this._viewHeight).fill(this._bgColor);
  }

  private drawLoom(): void {
    if (!this._app || this._viewWidth <= 0 || this._viewHeight <= 0) return;
    const width = this._viewWidth;
    const height = this._viewHeight;

    if (this.frameGfx) {
      this.frameGfx.clear();
    } else {
      this.frameGfx = new Graphics();
      this._content!.addChild(this.frameGfx);
    }

    const g = this.frameGfx;
    const cx = width / 2;
    const cy = height * LOOM_CENTER_Y_FRAC;
    const EDGE_SAFE_PAD = Math.max(8, Math.min(width, height) * 0.02);
    const byBase = Math.min(width, height) * 0.42;
    const byTop = cy - EDGE_SAFE_PAD;
    const byBottom = height - cy - EDGE_SAFE_PAD;
    const byLeft = cx - EDGE_SAFE_PAD;
    const byRight = width - cx - EDGE_SAFE_PAD;
    const innerR = Math.max(1, Math.min(byBase, byTop, byBottom, byLeft, byRight));
    this._loomInnerR = innerR;

    const spokeColor = 0x9090aa;
    const spokeWidth = 1.2;
    const spokeAlpha = 0.65;
    const DASH = 7;
    const GAP = 5;

    let anchors: AnchorPoint[];

    if (this._loomShape === 'circle') {
      g.circle(cx, cy, innerR).stroke({
        color: spokeColor,
        width: spokeWidth + 1,
        alpha: spokeAlpha,
      });

      const SPOKE_COUNT = 8;
      for (let s = 0; s < SPOKE_COUNT; s++) {
        const angle = (s / SPOKE_COUNT) * Math.PI * 2 - Math.PI / 2;
        const ex = cx + Math.cos(angle) * innerR;
        const ey = cy + Math.sin(angle) * innerR;
        dashStrokeLine(g, cx, cy, ex, ey, DASH, GAP, spokeColor, spokeWidth, spokeAlpha);
      }

      anchors = [];
      let id = 0;
      anchors.push({ id: id++, x: cx, y: cy, type: 'center' });
      const spokeSteps = LoomRenderer.SPOKE_STEPS;
      for (let s = 0; s < SPOKE_COUNT; s++) {
        const angle = (s / SPOKE_COUNT) * Math.PI * 2 - Math.PI / 2;
        for (let step = 1; step <= spokeSteps; step++) {
          const t = step / spokeSteps;
          anchors.push({
            id: id++,
            x: cx + Math.cos(angle) * innerR * t,
            y: cy + Math.sin(angle) * innerR * t,
            type: 'spoke',
            spokeAngle: angle,
          });
        }
      }
      const rimStepRad = (2 * Math.PI) / LoomRenderer.RIM_COUNT;
      for (let k = 0; k < LoomRenderer.RIM_COUNT; k++) {
        const angle = k * rimStepRad - Math.PI / 2;
        anchors.push({
          id: id++,
          x: cx + Math.cos(angle) * innerR,
          y: cy + Math.sin(angle) * innerR,
          type: 'rim',
        });
      }
    } else {
      // Equilateral triangle: vertices on circle radius innerR; altitudes from corners to opposite sides.
      const angles = [-Math.PI / 2, -Math.PI / 2 + (2 * Math.PI) / 3, -Math.PI / 2 + (4 * Math.PI) / 3];
      const V: Point[] = angles.map((th) => ({
        x: cx + innerR * Math.cos(th),
        y: cy + innerR * Math.sin(th),
      }));
      const [V0, V1, V2] = V;
      const G: Point = { x: (V0.x + V1.x + V2.x) / 3, y: (V0.y + V1.y + V2.y) / 3 };

      const feet: Point[] = [
        closestPointOnSegment(V0, V1, V2),
        closestPointOnSegment(V1, V2, V0),
        closestPointOnSegment(V2, V0, V1),
      ];

      g.moveTo(V0.x, V0.y).lineTo(V1.x, V1.y).lineTo(V2.x, V2.y).closePath().stroke({
        color: spokeColor,
        width: spokeWidth + 1,
        alpha: spokeAlpha,
      });

      for (let k = 0; k < 3; k++) {
        dashStrokeLine(g, V[k]!.x, V[k]!.y, feet[k]!.x, feet[k]!.y, DASH, GAP, spokeColor, spokeWidth, spokeAlpha);
      }

      const n01 = edgeOutwardNormal(V0, V1, G);
      const n12 = edgeOutwardNormal(V1, V2, G);
      const n20 = edgeOutwardNormal(V2, V0, G);
      const nV0 = avgUnitNormals(n20, n01);
      const nV1 = avgUnitNormals(n01, n12);
      const nV2 = avgUnitNormals(n12, n20);

      anchors = [];
      let id = 0;
      anchors.push({ id: id++, x: G.x, y: G.y, type: 'center' });

      const verts = [V0, V1, V2];
      for (let vi = 0; vi < 3; vi++) {
        const Va = verts[vi]!;
        const F = feet[vi]!;
        const steps = TRI_SPOKE_STEPS[vi]!;
        const ang = Math.atan2(F.y - Va.y, F.x - Va.x);
        for (let step = 1; step <= steps; step++) {
          const t = step / steps;
          const p = lerpPoint(Va, F, t);
          anchors.push({
            id: id++,
            x: p.x,
            y: p.y,
            type: 'spoke',
            spokeAngle: ang,
          });
        }
      }

      const pushCorner = (p: Point, n: { nx: number; ny: number }) => {
        anchors.push({
          id: id++,
          x: p.x,
          y: p.y,
          type: 'rim',
          rimOutwardNx: n.nx,
          rimOutwardNy: n.ny,
        });
      };
      const pushEdgeInterior = (a: Point, b: Point) => {
        for (let j = 1; j <= 15; j++) {
          const t = j / 16;
          const p = lerpPoint(a, b, t);
          const en = edgeOutwardNormal(a, b, G);
          anchors.push({
            id: id++,
            x: p.x,
            y: p.y,
            type: 'rim',
            rimOutwardNx: en.nx,
            rimOutwardNy: en.ny,
          });
        }
      };

      pushCorner(V0, nV0);
      pushEdgeInterior(V0, V1);
      pushCorner(V1, nV1);
      pushEdgeInterior(V1, V2);
      pushCorner(V2, nV2);
      pushEdgeInterior(V2, V0);
    }

    const sameLayout =
      this._anchorPoints.length === ANCHOR_COUNT && this._lastDrawLoomShape === this._loomShape;
    this._lastDrawLoomShape = this._loomShape;

    if (sameLayout) {
      for (let i = 0; i < anchors.length; i++) {
        const dst = this._anchorPoints[i]!;
        const src = anchors[i]!;
        dst.x = src.x;
        dst.y = src.y;
        dst.type = src.type;
        if (src.type === 'spoke' && src.spokeAngle != null) {
          dst.spokeAngle = src.spokeAngle;
        } else {
          delete dst.spokeAngle;
        }
        if (src.type === 'rim' && src.rimOutwardNx != null && src.rimOutwardNy != null) {
          dst.rimOutwardNx = src.rimOutwardNx;
          dst.rimOutwardNy = src.rimOutwardNy;
        } else {
          delete dst.rimOutwardNx;
          delete dst.rimOutwardNy;
        }
      }
    } else {
      this._anchorPoints = anchors;
    }
  }

  destroy(): void {
    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this._zoomContainer = null;
    this._content = null;
    this._bgGfx = null;
    if (this._ready) {
      this._app?.destroy(true, { children: true });
    }
    this._app = null;
    this._ready = false;
    this.frameGfx = null;
    this._anchorPoints = [];
  }
}
