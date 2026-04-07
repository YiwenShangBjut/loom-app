import type {
  AnchorPoint, LoomOutline, LoomShape, Point,
  RenderThread, UnderCrossing, BridgeSegment,
} from '../physics/types';
import { MATERIAL_TEXTURE_PRESETS, type MaterialTextureId } from '../rendering/materialTextures';
import { commitStiffness } from '../rendering/commitStiffness';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Finger must enter this radius around an anchor to snap. */
const SNAP_RADIUS = 14; // px

/** Minimum content-space length from last anchor to a free end for open-tail commits. */
const MIN_OPEN_TAIL_LEN = 8;

/**
 * Safety pad for the loom boundary:
 * if the pointer is near the hoop border, treat it as "inside loom" so
 * it triggers wrap instead of panning the canvas.
 *
 * This value is in content-space pixels.
 */
const HOOP_EDGE_SAFE_PAD = 10; // px

function pointInTriangle(p: Point, v0: Point, v1: Point, v2: Point): boolean {
  const sign = (q: Point, a: Point, b: Point) =>
    (q.x - b.x) * (a.y - b.y) - (a.x - b.x) * (q.y - b.y);
  const d1 = sign(p, v0, v1);
  const d2 = sign(p, v1, v2);
  const d3 = sign(p, v2, v0);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function distPointToSegment(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby || 1;
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * abx;
  const qy = a.y + t * aby;
  return Math.hypot(p.x - qx, p.y - qy);
}

/**
 * After snapping, the finger must travel at least this far before another
 * snap can fire. Must be < anchor spacing (SPOKE_PITCH ~16) to allow snapping to next anchor.
 */
const EXIT_RADIUS = 12; // px

/**
 * Target distance from an anchor at which the approach / departure tangent
 * points are placed. The actual radius is capped adaptively so adjacent arcs
 * on closely-spaced anchors cannot overlap each other.
 */
const WRAP_R = 12; // px

/**
 * Minimum |cross-product| of consecutive direction vectors below which a
 * bend is treated as a straight pass and no arc is generated.
 */
const MIN_CROSS = 0.12;

/**
 * Thread hit-test tolerance in SCREEN px.
 * Final radius = clamp(threadHalfWidth + EXTRA, MIN, MAX), then converted to
 * content-space by dividing zoom scale.
 *
 * Using a tighter radius avoids selecting nearby threads after zooming in.
 */
const HIT_THREAD_EXTRA_PX = 4;
const HIT_THREAD_MIN_PX = 8;
const HIT_THREAD_MAX_PX = 16;

/**
 * When pressing on a committed thread (even near an anchor), we defer wrap
 * to allow long-press-to-edit. If the user moves beyond this threshold,
 * we start the wrap gesture instead. Must match LoomCanvas LONG_PRESS_MOVE_THRESHOLD_PX.
 */
const DEFERRED_MOVE_THRESHOLD_PX = 14;

/** Create：空白处「细笔」模式 — 约 2px 宽（RopeRenderer 用 lineWidth×2 为条带宽度），颜色 #221915 */
const BLANK_THIN_PEN_LINE_WIDTH = 1;
const BLANK_THIN_PEN_COLOR = 0x221915;

// ── Internal types ────────────────────────────────────────────────────────────

interface CommittedThread {
  path:         AnchorPoint[];
  /** Content-space polyline for freehand strokes; when set (length ≥ 2), `path` is empty. */
  freehandPoints?: Point[] | undefined;
  /** Loose end inside the hoop (not on an anchor), after the last snapped anchor. */
  openTail?: Point | undefined;
  underIndices: number[];
  textureId:    MaterialTextureId;
  lineWidth:    number;
  color:        number;
  gradientColor?: number;
  opacity:      number; // 0..1, stored at commit time
  stiffness:    number; // 0..1, lower = softer (more sag), stored at commit time
  /** Optional user-facing label for long-press edit / saved creation metadata. */
  name?:        string;
}

type HistoryAction =
  | { type: 'add'; thread: CommittedThread }
  | { type: 'delete'; thread: CommittedThread; index: number }
  /** Swapped `committed[lowerIndex]` with `committed[lowerIndex + 1]`. */
  | { type: 'reorder'; lowerIndex: number }
  /** Moved one thread from `fromIndex` to `toIndex` (indices before the move). */
  | { type: 'reorderMove'; fromIndex: number; toIndex: number };

interface ExpandResult {
  points:  Point[];
  bridges: BridgeSegment[];
}

// ── WrapController ────────────────────────────────────────────────────────────

/**
 * Manages the loom-wrapping interaction.
 *
 * Gesture lifecycle
 * ─────────────────
 *   Press  near anchor → snap; start thread from that anchor
 *   Drag              → live preview; auto-snap to anchors entering SNAP_RADIUS
 *   Release           → commit thread (≥ 2 anchors); thread persists on loom
 *
 * Over / under (baked at commit time)
 * ────────────────────────────────────
 *   A global visit counter tracks how many times each anchor has been visited.
 *     Even count → OVER  the spoke — thread curves around peg + bridge on top
 *     Odd  count → UNDER the spoke — thread straight-through + spoke overlay
 *   Counts increment on commit, so each thread's stamp never changes later.
 *
 * Path expansion (expandPath)
 * ────────────────────────────
 *   For each interior anchor in a committed thread:
 *
 *     OVER  → path includes the anchor (line bends at peg). A short wrap
 *             line at the peg is collected as a BridgeSegment (length ≈ lineWidth).
 *     UNDER → before · anchor · after  (straight-through; overlay covers it)
 *
 *   "before" = anchor − dir_in  × WRAP_R   (approach tangent point)
 *   "after"  = anchor + dir_out × WRAP_R   (departure tangent point)
 *
 *   OVER wrap line: at spoke anchors — perpendicular to the spoke (tangent
 *   to the hoop); at rim/center — along the radius (on the hoop).
 */
export interface WrapControllerOptions {
  /** Line width (px); wrap line length ≈ this. */
  lineWidth?: number;
  /** Transform canvas pixel coords to content (loom) space; used when canvas is zoomed. */
  contentTransform?: (canvasX: number, canvasY: number) => Point;
  /** Called when pointer down and no anchor snap (e.g. tap on empty or on a line). */
  onPointerDownNoSnap?: (contentPoint: Point, e: PointerEvent) => void;
  /** Called when pointerdown snaps to an anchor and a new wrap gesture is about to start. */
  onWrapStart?: () => void;
  /** Returns current loom zoom scale (1 = no zoom). Used to keep hit-testing stable when zooming. */
  getZoomScale?: () => number;
  /** When true, read stiffness from commitStiffness module at commit time (used by LoomCanvas). */
  useCommitStiffnessFromModule?: boolean;
  /** When true, never start wrap gestures; all pointer down goes to onPointerDownNoSnap (view-only, pan only). */
  readOnly?: boolean;
  /** When false, disable starting wrap gestures but keep pointerdown passthrough callbacks. */
  wrapEnabled?: boolean;
  /**
   * Called after committed thread data changes (new stroke, undo/redo, delete, material/name edit).
   * Not called from {@link WrapController.setCommittedThreads} (restore/load) to avoid overwriting UI context.
   */
  onCommittedThreadsChange?: () => void;
}

/** Params of one committed thread for the materials popup. */
export interface ThreadParams {
  textureId: MaterialTextureId;
  lineWidth: number;
  color: number;
  gradientColor?: number;
  opacity: number;
  stiffness: number;
}

export class WrapController {
  private canvas:  HTMLCanvasElement;
  private anchors: AnchorPoint[];
  private loomShape: LoomShape;
  private contentTransform: ((canvasX: number, canvasY: number) => Point) | undefined;
  private onPointerDownNoSnap: ((contentPoint: Point, e: PointerEvent) => void) | undefined;
  private onWrapStart: (() => void) | undefined;
  private getZoomScale: (() => number) | undefined;
  private useCommitStiffnessFromModule: boolean;
  private readOnly: boolean;
  private wrapEnabled: boolean;
  private onCommittedThreadsChange: (() => void) | undefined;
  /** Loom center (from center anchor) for radial wrap lines. */
  private center:   Point;
  /** Half-length of wrap line (≈ lineWidth / 2 so total length ≈ lineWidth). */
  private wrapHalf: number;
  /** Precomputed rim radius used to build active-thread "rim stitches". */
  private rimRadius = 0;
  /** Precomputed average rim anchor spacing chord length. */
  private rimChordLen = 0;

  private committed:   CommittedThread[] = [];
  private undoStack:   HistoryAction[] = [];
  private redoStack:   HistoryAction[] = [];
  private active:      AnchorPoint[]     = [];
  private preview:     Point | null      = null;
  private isDragging                     = false;
  private lastSnapPos: Point | null      = null;
  /** Active pointers on canvas; multi-touch should zoom/pan only, never draw. */
  private activePointerIds = new Set<number>();

  /** When user presses on a committed thread near an anchor, we defer wrap to allow long-press edit. */
  private deferredSnapStart: {
    snap: AnchorPoint;
    pointerId: number;
    startCanvas: Point;
  } | null = null;

  /** Current material when committing (set from materials panel). */
  private currentTextureId: MaterialTextureId = 'none';
  private currentLineWidth = 3;
  private currentColor = 0xe8d5b7;
  private currentGradientColor: number | undefined;
  private currentOpacity = 1;
  private currentStiffness = 0.6;

  /** How many times each anchor has been visited across all committed threads. */
  private visitCounts = new Map<number, number>();

  /** Live preview while drawing a freehand stroke (content space). */
  private freehandDraft: Point[] | null = null;
  /** When true, blank-canvas doodles use fixed thin pen instead of current material. */
  private blankCanvasThinPen = false;

  setCurrentMaterial(
    textureId: MaterialTextureId,
    lineWidth: number,
    color: number,
    opacity01 = 1,
    stiffness?: number,
    gradientColor?: number
  ): void {
    this.currentTextureId = textureId;
    this.currentLineWidth = lineWidth;
    this.currentColor = color;
    this.currentGradientColor = gradientColor;
    this.currentOpacity = Math.max(0, Math.min(1, opacity01));
    this.currentStiffness =
      stiffness != null
        ? Math.max(0, Math.min(1, stiffness))
        : (MATERIAL_TEXTURE_PRESETS[textureId]?.stiffness ?? 0.6);
    this.wrapHalf = Math.max(1, lineWidth / 2);
  }

  /** Create 页：空白处细笔涂鸦开关（与当前材质面板无关）。 */
  setBlankCanvasThinPen(enabled: boolean): void {
    this.blankCanvasThinPen = enabled;
  }

  /** Live freehand preview while dragging on empty canvas (content space). */
  setFreehandDraft(points: Point[] | null): void {
    if (points == null || points.length === 0) this.freehandDraft = null;
    else this.freehandDraft = points.map((p) => ({ x: p.x, y: p.y }));
  }

  commitFreehandStroke(points: Point[]): void {
    if (points.length < 2) return;
    const raw = this.useCommitStiffnessFromModule ? commitStiffness.current : undefined;
    const baseStiffness =
      this.useCommitStiffnessFromModule && typeof raw === 'number' && Number.isFinite(raw)
        ? Math.max(0, Math.min(1, raw))
        : this.currentStiffness;

    const thin = this.blankCanvasThinPen;
    const stiffness = thin ? 1 : baseStiffness;
    const thread: CommittedThread = thin
      ? {
          path: [],
          freehandPoints: points.map((p) => ({ x: p.x, y: p.y })),
          underIndices: [],
          textureId: 'none',
          lineWidth: BLANK_THIN_PEN_LINE_WIDTH,
          color: BLANK_THIN_PEN_COLOR,
          opacity: 1,
          stiffness,
        }
      : {
          path: [],
          freehandPoints: points.map((p) => ({ x: p.x, y: p.y })),
          underIndices: [],
          textureId: this.currentTextureId,
          lineWidth: this.currentLineWidth,
          color: this.currentColor,
          ...(this.currentGradientColor != null ? { gradientColor: this.currentGradientColor } : {}),
          opacity: this.currentOpacity,
          stiffness,
        };
    this.committed.push(thread);
    this.undoStack.push({ type: 'add', thread });
    this.redoStack = [];
    this.freehandDraft = null;
    this.notifyCommittedThreadsChange();
  }

  getCommittedFreehandPoints(index: number): Point[] | null {
    const ct = this.committed[index];
    if (!ct?.freehandPoints || ct.freehandPoints.length < 2) return null;
    return ct.freehandPoints.map((p) => ({ x: p.x, y: p.y }));
  }

  getCommittedOpenTail(index: number): Point | null {
    const t = this.committed[index]?.openTail;
    if (!t) return null;
    return { x: t.x, y: t.y };
  }

  /**
   * Maps a committed-thread index to {@link ThreadSagManager} rope index.
   * Freehand threads are not in the sag list → returns null.
   */
  getSagRopeIndexForCommittedThread(committedIndex: number): number | null {
    if (committedIndex < 0 || committedIndex >= this.committed.length) return null;
    let sagIdx = 0;
    for (let j = 0; j < this.committed.length; j++) {
      const ct = this.committed[j];
      const isFreehand = ct.freehandPoints != null && ct.freehandPoints.length >= 2;
      if (j === committedIndex) return isFreehand ? null : sagIdx;
      if (!isFreehand) sagIdx++;
    }
    return null;
  }

  private onDown:   (e: PointerEvent) => void;
  private onMove:   (e: PointerEvent) => void;
  private onUp:     (e: PointerEvent) => void;

  constructor(canvas: HTMLCanvasElement, anchors: AnchorPoint[], options: WrapControllerOptions = {}) {
    this.canvas  = canvas;
    this.anchors = anchors;
    this.loomShape = 'circle';
    this.contentTransform = options.contentTransform;
    this.onPointerDownNoSnap = options.onPointerDownNoSnap;
    this.onWrapStart = options.onWrapStart;
    this.getZoomScale = options.getZoomScale;
    this.useCommitStiffnessFromModule = options.useCommitStiffnessFromModule ?? false;
    this.readOnly = options.readOnly ?? false;
    this.wrapEnabled = options.wrapEnabled ?? true;
    this.onCommittedThreadsChange = options.onCommittedThreadsChange;
    const lw = options.lineWidth ?? 3;
    this.wrapHalf = Math.max(1, lw / 2);
    const centerAnchor = anchors.find(a => a.type === 'center');
    this.center = centerAnchor
      ? { x: centerAnchor.x, y: centerAnchor.y }
      : { x: 0, y: 0 };

    // Precompute rim geometry for active-thread rendering (rim stitches, exit zones).
    this.recomputeRimMetrics();

    this.onDown = this.handleDown.bind(this);
    this.onMove = this.handleMove.bind(this);
    this.onUp   = this.handleUp.bind(this);

    canvas.addEventListener('pointerdown',   this.onDown);
    canvas.addEventListener('pointermove',   this.onMove);
    canvas.addEventListener('pointerup',     this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    canvas.style.touchAction = 'none';
  }

  setWrapEnabled(enabled: boolean): void {
    this.wrapEnabled = enabled;
    if (!enabled) this.deferredSnapStart = null;
  }

  /**
   * Swap anchor graph (e.g. circle ↔ triangle) while threads are empty.
   * Caller must pass anchors from {@link LoomRenderer.getAnchorPoints} after {@link LoomRenderer.setLoomShape}.
   */
  /** Pan / hit-test in content space (same rule as wrap gestures). */
  isOutsideLoomContent(pt: Point): boolean {
    return this.isOutsideLoom(pt);
  }

  replaceAnchors(anchors: AnchorPoint[], outline: LoomOutline): void {
    this.anchors = anchors;
    this.loomShape = outline.kind;
    const centerAnchor = anchors.find((a) => a.type === 'center');
    this.center = centerAnchor ? { x: centerAnchor.x, y: centerAnchor.y } : { x: 0, y: 0 };
    this.recomputeRimMetrics();
    this.active = [];
    this.preview = null;
    this.isDragging = false;
    this.lastSnapPos = null;
    this.deferredSnapStart = null;
  }

  /** Call after anchor coordinates change in place (e.g. window resize). */
  syncRimMetricsFromAnchors(): void {
    this.recomputeRimMetrics();
  }

  private recomputeRimMetrics(): void {
    const rimAnchors = this.anchors.filter((a) => a.type === 'rim');
    if (rimAnchors.length === 0) {
      this.rimRadius = 0;
      this.rimChordLen = 0;
      return;
    }
    this.rimRadius = Math.max(...rimAnchors.map((a) => Math.hypot(a.x - this.center.x, a.y - this.center.y)));
    if (this.loomShape === 'circle') {
      const angles = rimAnchors
        .map((a) => Math.atan2(a.y - this.center.y, a.x - this.center.x))
        .sort((a, b) => a - b);
      if (angles.length >= 2) {
        const diffs: number[] = [];
        for (let i = 0; i < angles.length; i++) {
          const a0 = angles[i];
          const a1 = angles[(i + 1) % angles.length];
          const d = (a1 - a0 + Math.PI * 2) % (Math.PI * 2);
          diffs.push(d);
        }
        diffs.sort((a, b) => a - b);
        const stepRad = diffs[Math.floor(diffs.length / 2)] ?? (Math.PI * 2) / 24;
        this.rimChordLen = 2 * this.rimRadius * Math.sin(stepRad / 2);
      }
    } else {
      const n = rimAnchors.length;
      const chords: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = rimAnchors[i]!;
        const b = rimAnchors[(i + 1) % n]!;
        chords.push(Math.hypot(a.x - b.x, a.y - b.y));
      }
      chords.sort((x, y) => x - y);
      this.rimChordLen = chords[Math.floor(chords.length / 2)] ?? 8;
    }
  }

  private notifyCommittedThreadsChange(): void {
    this.onCommittedThreadsChange?.();
  }

  /**
   * When dragging along the circular hoop border, render the rim wrap as a
   * stitched ring made of short inward-pointing segments ("竖短线").
   *
   * We draw these as `bridges` so the existing RopeRenderer top-layer
   * overlay draws the segments above the rope.
   */
  private buildActiveRimStitchBridges(rimRun: AnchorPoint[]): BridgeSegment[] {
    if (rimRun.length === 0) return [];
    if (!Number.isFinite(this.rimChordLen) || this.rimChordLen <= 0) return [];

    // Segment length (short "stitches"): keep them clearly discrete while
    // still reading as connected along the hoop.
    const segLen = Math.max(this.wrapHalf * 1.6, this.rimChordLen * 0.35);
    const bridges: BridgeSegment[] = [];

    for (const a of rimRun) {
      let nx: number;
      let ny: number;
      if (a.rimOutwardNx != null && a.rimOutwardNy != null) {
        nx = a.rimOutwardNx;
        ny = a.rimOutwardNy;
      } else {
        const dx = a.x - this.center.x;
        const dy = a.y - this.center.y;
        const d = Math.hypot(dx, dy) || 1;
        nx = dx / d;
        ny = dy / d;
      }

      // Inward from the rim anchor (opposite of outward normal).
      bridges.push({
        x1: a.x - nx * segLen,
        y1: a.y - ny * segLen,
        x2: a.x,
        y2: a.y,
      });
    }

    return bridges;
  }

  /**
   * While dragging along spokes, show small "stitch" segments at each
   * active spoke anchor. These segments are drawn perpendicular to the
   * spoke axis (tangent to the hoop), matching the over/peg-wrap look.
   */
  private buildActiveSpokeStitchBridges(spokeRun: AnchorPoint[]): BridgeSegment[] {
    if (spokeRun.length === 0) return [];

    // Keep them short and discrete (closer to the "stitch" look).
    // Use inward-from-anchor stubs, consistent with rim stitches.
    const segLen = Math.max(this.wrapHalf * 0.8, 2);
    const bridges: BridgeSegment[] = [];

    for (const a of spokeRun) {
      if (a.type !== 'spoke') continue;
      if (a.spokeAngle == null) continue;

      // Radial direction along the spoke axis.
      // spokeAngle is the outward radial direction angle.
      const outX = Math.cos(a.spokeAngle);
      const outY = Math.sin(a.spokeAngle);

      bridges.push({
        // inward stub: start closer to center, end at the anchor
        x1: a.x - outX * segLen,
        y1: a.y - outY * segLen,
        x2: a.x,
        y2: a.y,
      });
    }

    return bridges;
  }

  // ── Coordinate transform ──────────────────────────────────────────────────
  // Map pointer from CSS rect to canvas buffer (stage) coordinates so snap and rope share the same space.
  // With resolution=1, canvas.width === rect.width so 1:1.

  private toCanvas(e: PointerEvent): Point {
    const rect   = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top)  * scaleY;
    if (this.contentTransform) return this.contentTransform(x, y);
    return { x, y };
  }

  private isOutsideLoom(pt: Point): boolean {
    if (this.loomShape === 'triangle') {
      const a0 = this.anchors[161];
      const a1 = this.anchors[177];
      const a2 = this.anchors[193];
      if (!a0 || !a1 || !a2) return false;
      const v0 = { x: a0.x, y: a0.y };
      const v1 = { x: a1.x, y: a1.y };
      const v2 = { x: a2.x, y: a2.y };
      if (pointInTriangle(pt, v0, v1, v2)) return false;
      const d = Math.min(
        distPointToSegment(pt, v0, v1),
        distPointToSegment(pt, v1, v2),
        distPointToSegment(pt, v2, v0),
      );
      return d > HOOP_EDGE_SAFE_PAD;
    }
    const rimAnchors = this.anchors.filter((a) => a.type === 'rim');
    if (!rimAnchors.length) return false;
    const rimRadius = Math.max(...rimAnchors.map((a) => Math.hypot(a.x - this.center.x, a.y - this.center.y)));
    const d = Math.hypot(pt.x - this.center.x, pt.y - this.center.y);
    return d > rimRadius + HOOP_EDGE_SAFE_PAD;
  }

  // ── Snap detection ────────────────────────────────────────────────────────

  private nearest(pt: Point, radius: number): AnchorPoint | null {
    let best: AnchorPoint | null = null;
    let bestD = radius;
    for (const a of this.anchors) {
      const d = Math.hypot(a.x - pt.x, a.y - pt.y);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  /** True if both anchors are on the same spoke (same spokeAngle). */
  private sameSpoke(a: AnchorPoint, b: AnchorPoint): boolean {
    return (
      a.type === 'spoke' &&
      b.type === 'spoke' &&
      a.spokeAngle != null &&
      b.spokeAngle != null &&
      a.spokeAngle === b.spokeAngle
    );
  }

  // ── Pointer handlers ──────────────────────────────────────────────────────

  private handleDown(e: PointerEvent): void {
    this.activePointerIds.add(e.pointerId);
    const pt   = this.toCanvas(e);
    if (this.activePointerIds.size > 1) {
      // Two-finger gesture: disable any pending/active wrap interaction.
      this.isDragging = false;
      this.active = [];
      this.preview = null;
      this.lastSnapPos = null;
      this.deferredSnapStart = null;
      this.onPointerDownNoSnap?.(pt, e);
      return;
    }
    if (this.readOnly || !this.wrapEnabled) {
      this.onPointerDownNoSnap?.(pt, e);
      return;
    }
    if (this.isOutsideLoom(pt)) {
      // Don't start wrap gestures outside the loom hoop.
      // Caller can interpret it as canvas panning.
      this.onPointerDownNoSnap?.(pt, e);
      return;
    }
    const snap = this.nearest(pt, SNAP_RADIUS);
    if (!snap) {
      this.onPointerDownNoSnap?.(pt, e);
      return;
    }

    // If user pressed on a committed thread, defer wrap to allow long-press-to-edit.
    // If they move beyond threshold, we'll start the wrap in handleMove.
    const threadIndex = this.getThreadAtPoint(pt.x, pt.y);
    if (threadIndex != null) {
      this.deferredSnapStart = {
        snap,
        pointerId: e.pointerId,
        startCanvas: pt,
      };
      this.onPointerDownNoSnap?.(pt, e);
      return;
    }

    // This down is a wrap gesture (snapped to anchor).
    this.onWrapStart?.();

    this.isDragging  = true;
    this.active      = [snap];
    this.preview     = { x: snap.x, y: snap.y };
    this.lastSnapPos = snap;
    this.canvas.setPointerCapture(e.pointerId);
  }

  private handleMove(e: PointerEvent): void {
    if (this.activePointerIds.size > 1) {
      // While multi-touch is active, do not preview or extend drawing gestures.
      this.isDragging = false;
      this.active = [];
      this.preview = null;
      this.lastSnapPos = null;
      this.deferredSnapStart = null;
      return;
    }
    if (!this.isDragging) {
      const def = this.deferredSnapStart;
      if (def && e.pointerId === def.pointerId) {
        if (!this.wrapEnabled) {
          this.deferredSnapStart = null;
          return;
        }
        const pt = this.toCanvas(e);
        const zoom = this.getZoomScale?.() ?? 1;
        const threshold = DEFERRED_MOVE_THRESHOLD_PX / Math.max(0.0001, zoom);
        const dist = Math.hypot(pt.x - def.startCanvas.x, pt.y - def.startCanvas.y);
        if (dist > threshold) {
          this.deferredSnapStart = null;
          this.onWrapStart?.();
          this.isDragging = true;
          this.active = [def.snap];
          this.preview = { x: def.snap.x, y: def.snap.y };
          this.lastSnapPos = def.snap;
          this.canvas.setPointerCapture(e.pointerId);
          // Fall through to normal move handling with current pt
        } else {
          return;
        }
      } else {
        return;
      }
    }
    const pt = this.toCanvas(e);
    this.preview = pt;

    // Exit-zone guard: must travel EXIT_RADIUS from last snap before next fires
    if (this.lastSnapPos) {
      const d = Math.hypot(pt.x - this.lastSnapPos.x, pt.y - this.lastSnapPos.y);
      if (d < EXIT_RADIUS) return;
    }

    const snap = this.nearest(pt, SNAP_RADIUS);
    if (!snap) return;
    const last = this.active[this.active.length - 1];
    if (snap.id === last.id) return; // same anchor
    // Avoid consecutive anchors on the same spoke (would look like double wrap on one peg)
    if (this.sameSpoke(last, snap)) return;

    this.active.push(snap);
    this.preview     = { x: snap.x, y: snap.y };
    this.lastSnapPos = snap;
  }

  private openTailFromPreview(tailCandidate: Point | null): Point | undefined {
    if (!tailCandidate || this.active.length === 0) return undefined;
    if (this.isOutsideLoom(tailCandidate)) return undefined;
    const lastA = this.active[this.active.length - 1];
    const snapped = this.nearest(tailCandidate, SNAP_RADIUS);
    if (snapped && snapped.id === lastA.id) return undefined;
    const d = Math.hypot(tailCandidate.x - lastA.x, tailCandidate.y - lastA.y);
    if (d < MIN_OPEN_TAIL_LEN) return undefined;
    return { x: tailCandidate.x, y: tailCandidate.y };
  }

  private handleUp(e: PointerEvent): void {
    this.activePointerIds.delete(e.pointerId);
    if (!this.isDragging) {
      if (this.deferredSnapStart && e.pointerId === this.deferredSnapStart.pointerId) {
        this.deferredSnapStart = null;
      }
      return;
    }
    const previewSnap = this.preview ? { x: this.preview.x, y: this.preview.y } : null;
    this.isDragging = false;
    this.preview    = null;

    const openTail = this.openTailFromPreview(previewSnap);

    if (this.active.length >= 2) {
      const thread = this.buildCommitted([...this.active], openTail);
      this.committed.push(thread);
      this.undoStack.push({ type: 'add', thread });
      this.redoStack = [];
      this.notifyCommittedThreadsChange();
    } else if (this.active.length === 1 && openTail) {
      const thread = this.buildCommitted([...this.active], openTail);
      this.committed.push(thread);
      this.undoStack.push({ type: 'add', thread });
      this.redoStack = [];
      this.notifyCommittedThreadsChange();
    }
    this.active      = [];
    this.lastSnapPos = null;
  }

  // ── Over / under stamping ─────────────────────────────────────────────────

  private buildCommitted(path: AnchorPoint[], openTail?: Point): CommittedThread {
    const underIndices: number[] = [];
    for (let i = 0; i < path.length; i++) {
      const a     = path[i];
      const count = this.visitCounts.get(a.id) ?? 0;
      // Force all crossings to be rendered as OVER.
      // Still update visitCounts so undo/redo maintains consistent history,
      // but never record UNDER indices.
      this.visitCounts.set(a.id, count + 1);
    }
    const raw = this.useCommitStiffnessFromModule ? commitStiffness.current : undefined;
    const stiffness =
      this.useCommitStiffnessFromModule &&
      typeof raw === 'number' &&
      Number.isFinite(raw)
        ? Math.max(0, Math.min(1, raw))
        : this.currentStiffness;
    return {
      path,
      ...(openTail ? { openTail } : {}),
      underIndices,
      textureId: this.currentTextureId,
      lineWidth: this.currentLineWidth,
      color: this.currentColor,
      ...(this.currentGradientColor != null ? { gradientColor: this.currentGradientColor } : {}),
      opacity: this.currentOpacity,
      stiffness,
    };
  }

  // ── Path expansion ────────────────────────────────────────────────────────

  /**
   * Expands an anchor path into a richer point array for Catmull-Rom rendering,
   * and collects bridge segments for the topmost rendering layer.
   *
   * Arc-peak formula (degenerate-free):
   *   The peak is offset from the midpoint of the before→after chord,
   *   perpendicular to that chord (90°-CW rotation of the bridge vector),
   *   on the side determined by the sign of the cross product.
   *   This avoids the collapse that occurs when dir_out ≅ perp(dir_in).
   */
  private expandPath(path: AnchorPoint[], underSet: Set<number>, threadLineWidth?: number): ExpandResult {
    if (path.length < 2) return { points: [...path], bridges: [] };
    void threadLineWidth;
    const points:  Point[]         = [];
    const bridges: BridgeSegment[] = [];
    // Force all peg crossings to use the same OVER-shaped control-point expansion.
    // (We keep the felt texture behavior in RopeRenderer; only the wrap geometry is forced.)
    const roundEndsOnly = false;

    // `underSet` 保留给 API；当前不在此生成 bridge 叠线（避免与整条线阴影重复）。
    void underSet;
    for (let i = 0; i < path.length; i++) {
      const curr = path[i];

      if (i === 0) {
        if (roundEndsOnly && path.length >= 2) {
          const next = path[1];
          const dx = next.x - curr.x;
          const dy = next.y - curr.y;
          const len = Math.hypot(dx, dy) || 1;
          points.push({ x: curr.x - (dx / len) * WRAP_R, y: curr.y - (dy / len) * WRAP_R });
        } else {
          points.push(curr);
        }
        continue;
      }
      if (i === path.length - 1) {
        if (!roundEndsOnly) points.push(curr);
        else if (path.length >= 2) {
          const prev = path[i - 1];
          const dx = curr.x - prev.x;
          const dy = curr.y - prev.y;
          const len = Math.hypot(dx, dy) || 1;
          points.push({ x: curr.x + (dx / len) * WRAP_R, y: curr.y + (dy / len) * WRAP_R });
        } else {
          points.push(curr);
        }
        continue;
      }

      const prev = path[i - 1];
      const next = path[i + 1];

      // Incoming unit vector
      const dil = Math.hypot(curr.x - prev.x, curr.y - prev.y) || 1;
      const ix   = (curr.x - prev.x) / dil;
      const iy   = (curr.y - prev.y) / dil;

      // Outgoing unit vector
      const dol = Math.hypot(next.x - curr.x, next.y - curr.y) || 1;
      const ox   = (next.x - curr.x) / dol;
      const oy   = (next.y - curr.y) / dol;

      // Cross product — determines which side the thread wraps
      const cross = ix * oy - iy * ox;

      // Negligible bend: straight pass-through, no arc
      if (Math.abs(cross) < MIN_CROSS) {
        points.push(curr);
        continue;
      }

      // For non-negligible bends, soften the peak by using smaller
      // approach/departure tangent offsets.
      // (Using full `WRAP_R` often creates concave dips on both sides,
      // causing poor visual continuity with adjacent segments.)
      const smoothR = Math.max(1, WRAP_R * 0.35);
      const before: Point = { x: curr.x - ix * smoothR, y: curr.y - iy * smoothR };
      const after: Point = { x: curr.x + ox * smoothR, y: curr.y + oy * smoothR };

      points.push(before, curr, after);
    }

    return { points, bridges };
  }

  // ── Public query ──────────────────────────────────────────────────────────

  /**
   * Returns all threads to render this frame.
   * Committed threads have pre-expanded paths and collected bridges.
   * The active (in-progress) thread uses raw positions — no expansion yet.
   */
  getRenderThreads(): RenderThread[] {
    const result: RenderThread[] = [];

    for (const ct of this.committed) {
      if (ct.freehandPoints && ct.freehandPoints.length >= 2) {
        result.push({
          points: ct.freehandPoints.map((p) => ({ x: p.x, y: p.y })),
          isActive: false,
          underCrossings: [],
          bridges: [],
          textureId: ct.textureId,
          lineWidth: ct.lineWidth,
          color: ct.color,
          ...(ct.gradientColor != null ? { gradientColor: ct.gradientColor } : {}),
          opacity: ct.opacity,
          stiffness: ct.stiffness,
          skipSag: true,
        });
        continue;
      }

      const underSet = new Set(ct.underIndices.map(i => ct.path[i].id));

      const underCrossings: UnderCrossing[] = ct.underIndices
        .filter(i => ct.path[i].type === 'spoke')
        .map(i => {
          const a = ct.path[i];
          return { x: a.x, y: a.y, spokeAngle: a.spokeAngle! };
        });

      const { points: ep, bridges } = this.expandPath(ct.path, underSet, ct.lineWidth);
      let points = ep.map((p) => ({ x: p.x, y: p.y }));
      if (ct.openTail) {
        points = [...points, { x: ct.openTail.x, y: ct.openTail.y }];
      }
      const ropeCaps = ct.openTail
        ? ({ wrapStart: true, wrapEnd: false } as const)
        : undefined;

      result.push({
        points,
        isActive: false,
        underCrossings,
        bridges,
        textureId: ct.textureId,
        lineWidth: ct.lineWidth,
        color: ct.color,
        gradientColor: ct.gradientColor,
        opacity: ct.opacity,
        stiffness: ct.stiffness,
        ...(ropeCaps ? { ropeCaps } : {}),
      });
    }

    if (this.freehandDraft && this.freehandDraft.length >= 1) {
      if (this.blankCanvasThinPen) {
        result.push({
          points: this.freehandDraft.map((p) => ({ x: p.x, y: p.y })),
          isActive: true,
          underCrossings: [],
          bridges: [],
          textureId: 'none',
          lineWidth: BLANK_THIN_PEN_LINE_WIDTH,
          color: BLANK_THIN_PEN_COLOR,
          opacity: 1,
          stiffness: 1,
          skipSag: true,
        });
      } else {
        result.push({
          points: this.freehandDraft.map((p) => ({ x: p.x, y: p.y })),
          isActive: true,
          underCrossings: [],
          bridges: [],
          textureId: this.currentTextureId,
          lineWidth: this.currentLineWidth,
          color: this.currentColor,
          gradientColor: this.currentGradientColor,
          opacity: this.currentOpacity,
          stiffness: this.currentStiffness,
          skipSag: true,
        });
      }
    }

    // Active thread: raw anchors + live preview point, no expansion
    if (this.active.length > 0) {
      const pts: Point[] = this.preview
        ? [...this.active, this.preview]
        : [...this.active];

      // Stitched overlay while dragging:
      // - if dragging on the hoop rim → rim radial "stitches"
      // - if dragging on spokes → spoke tangent "stitches"
      const last = this.active[this.active.length - 1];

      // Use current pointer (preview) to decide whether we're currently on rim or spoke.
      // This makes the "active stitches" follow the user's gesture even if the last snap
      // anchor is a different type.
      const focusPt = this.preview ?? last;
      const curAnchor = this.nearest(focusPt, SNAP_RADIUS);

      let bridges: BridgeSegment[] = [];
      if (curAnchor?.type === 'rim') {
        const rimRun: AnchorPoint[] = [];
        // Take the trailing contiguous rim anchors (in order they were snapped).
        for (let i = this.active.length - 1; i >= 0; i--) {
          const a = this.active[i];
          if (a.type !== 'rim') break;
          rimRun.unshift(a);
        }
        bridges = this.buildActiveRimStitchBridges(rimRun.length > 0 ? rimRun : [curAnchor]);
      } else if (curAnchor?.type === 'spoke') {
        const spokeRun: AnchorPoint[] = [];
        for (let i = this.active.length - 1; i >= 0; i--) {
          const a = this.active[i];
          if (a.type !== 'spoke') break;
          spokeRun.unshift(a);
        }
        bridges = this.buildActiveSpokeStitchBridges(spokeRun.length > 0 ? spokeRun : [curAnchor]);
      }
      result.push({
        points: pts,
        isActive: true,
        underCrossings: [],
        bridges,
        textureId: this.currentTextureId,
        lineWidth: this.currentLineWidth,
        color: this.currentColor,
        gradientColor: this.currentGradientColor,
        opacity: this.currentOpacity,
        stiffness: this.currentStiffness,
        ...(this.preview ? { ropeCaps: { wrapStart: true, wrapEnd: false } as const } : {}),
      });
    }

    return result;
  }

  reset(): void {
    this.committed   = [];
    this.undoStack   = [];
    this.redoStack   = [];
    this.active      = [];
    this.preview     = null;
    this.isDragging  = false;
    this.lastSnapPos = null;
    this.deferredSnapStart = null;
    this.freehandDraft = null;
    this.visitCounts.clear();
    this.notifyCommittedThreadsChange();
  }

  /** Remove the last committed thread; used for undo. */
  undo(): void {
    const action = this.undoStack.pop();
    if (!action) return;

    if (action.type === 'add') {
      const idx = this.committed.lastIndexOf(action.thread);
      if (idx >= 0) {
        this.committed.splice(idx, 1);
      }
      for (const a of action.thread.path) {
        const c = this.visitCounts.get(a.id) ?? 0;
        this.visitCounts.set(a.id, Math.max(0, c - 1));
      }
    } else if (action.type === 'delete') {
      const clampedIndex = Math.max(0, Math.min(action.index, this.committed.length));
      this.committed.splice(clampedIndex, 0, action.thread);
      for (const a of action.thread.path) {
        const c = this.visitCounts.get(a.id) ?? 0;
        this.visitCounts.set(a.id, c + 1);
      }
    } else if (action.type === 'reorder') {
      const i = action.lowerIndex;
      if (i >= 0 && i < this.committed.length - 1) {
        const a = this.committed[i];
        this.committed[i] = this.committed[i + 1]!;
        this.committed[i + 1] = a;
      }
    } else if (action.type === 'reorderMove') {
      const { fromIndex, toIndex } = action;
      if (fromIndex >= 0 && toIndex >= 0 && fromIndex < this.committed.length && toIndex < this.committed.length) {
        const [t] = this.committed.splice(toIndex, 1);
        this.committed.splice(fromIndex, 0, t);
      }
    }

    this.redoStack.push(action);
    this.notifyCommittedThreadsChange();
  }

  /** Restore the last undone thread; used for redo. */
  redo(): void {
    const action = this.redoStack.pop();
    if (!action) return;

    if (action.type === 'add') {
      this.committed.push(action.thread);
      for (const a of action.thread.path) {
        const c = this.visitCounts.get(a.id) ?? 0;
        this.visitCounts.set(a.id, c + 1);
      }
    } else if (action.type === 'delete') {
      const idx = this.committed.indexOf(action.thread);
      if (idx >= 0) {
        this.committed.splice(idx, 1);
      } else if (action.index >= 0 && action.index < this.committed.length) {
        this.committed.splice(action.index, 1);
      }
      for (const a of action.thread.path) {
        const c = this.visitCounts.get(a.id) ?? 0;
        this.visitCounts.set(a.id, Math.max(0, c - 1));
      }
    } else if (action.type === 'reorder') {
      const i = action.lowerIndex;
      if (i >= 0 && i < this.committed.length - 1) {
        const a = this.committed[i];
        this.committed[i] = this.committed[i + 1]!;
        this.committed[i + 1] = a;
      }
    } else if (action.type === 'reorderMove') {
      const { fromIndex, toIndex } = action;
      if (fromIndex >= 0 && toIndex >= 0 && fromIndex < this.committed.length && toIndex < this.committed.length) {
        const [t] = this.committed.splice(fromIndex, 1);
        this.committed.splice(toIndex, 0, t);
      }
    }

    this.undoStack.push(action);
    this.notifyCommittedThreadsChange();
  }

  /** Delete a committed thread by index. */
  deleteThread(index: number): void {
    const t = this.committed[index];
    if (!t) return;

    this.committed.splice(index, 1);

    for (const a of t.path) {
      const c = this.visitCounts.get(a.id) ?? 0;
      this.visitCounts.set(a.id, Math.max(0, c - 1));
    }

    this.undoStack.push({ type: 'delete', thread: t, index });
    // Deletion is a new operation, so redo history becomes invalid.
    this.redoStack = [];

    // Cancel any in-progress gesture to avoid mixing states.
    this.active = [];
    this.preview = null;
    this.isDragging = false;
    this.lastSnapPos = null;
    this.notifyCommittedThreadsChange();
  }

  /**
   * Paint order: later index draws on top. Move this thread one step toward the top.
   */
  bringThreadForward(index: number): boolean {
    if (index < 0 || index >= this.committed.length - 1) return false;
    const t = this.committed[index];
    this.committed[index] = this.committed[index + 1]!;
    this.committed[index + 1] = t;
    this.undoStack.push({ type: 'reorder', lowerIndex: index });
    this.redoStack = [];
    this.notifyCommittedThreadsChange();
    return true;
  }

  /**
   * Move this thread one step toward the bottom (under the previous stroke).
   */
  sendThreadBackward(index: number): boolean {
    if (index <= 0 || index >= this.committed.length) return false;
    const lowerIndex = index - 1;
    const t = this.committed[lowerIndex]!;
    this.committed[lowerIndex] = this.committed[lowerIndex + 1]!;
    this.committed[lowerIndex + 1] = t;
    this.undoStack.push({ type: 'reorder', lowerIndex });
    this.redoStack = [];
    this.notifyCommittedThreadsChange();
    return true;
  }

  /** Highest z: last paint index. */
  bringThreadToTop(index: number): boolean {
    const n = this.committed.length;
    if (index < 0 || index >= n - 1) return false;
    const toIndex = n - 1;
    const [t] = this.committed.splice(index, 1);
    this.committed.splice(toIndex, 0, t);
    this.undoStack.push({ type: 'reorderMove', fromIndex: index, toIndex });
    this.redoStack = [];
    this.notifyCommittedThreadsChange();
    return true;
  }

  /** Lowest z: first paint index. */
  sendThreadToBottom(index: number): boolean {
    if (index <= 0 || index >= this.committed.length) return false;
    const [t] = this.committed.splice(index, 1);
    this.committed.splice(0, 0, t);
    this.undoStack.push({ type: 'reorderMove', fromIndex: index, toIndex: 0 });
    this.redoStack = [];
    this.notifyCommittedThreadsChange();
    return true;
  }

  /**
   * Get committed thread wrap path as anchor IDs.
   * These IDs are mapped to the current LoomRenderer anchors on restore.
   */
  getThreadAnchorIds(index: number): number[] | null {
    const ct = this.committed[index];
    if (!ct) return null;
    if (ct.freehandPoints && ct.freehandPoints.length >= 2) return [];
    return ct.path.map((a) => a.id);
  }

  /**
   * Restore committed threads from persisted anchor paths + material params.
   * Used to reload the last Create canvas state.
   */
  setCommittedThreads(threads: Array<{
    anchorIds: number[];
    polyline?: Point[];
    openTail?: Point;
    textureId: MaterialTextureId;
    lineWidth: number;
    color: number;
    gradientColor?: number;
    opacity: number;
    stiffness: number;
    name?: string;
  }>): void {
    const idToAnchor = new Map<number, AnchorPoint>();
    for (const a of this.anchors) idToAnchor.set(a.id, a);

    const nextCommitted: CommittedThread[] = [];
    for (const t of threads) {
      const poly =
        t.polyline && Array.isArray(t.polyline) && t.polyline.length >= 2
          ? t.polyline.map((p) => ({ x: p.x, y: p.y }))
          : null;
      const path = t.anchorIds
        .map((id) => idToAnchor.get(id) ?? null)
        .filter((a): a is AnchorPoint => a != null);

      if (poly && path.length < 2) {
        nextCommitted.push({
          path: [],
          freehandPoints: poly,
          underIndices: [],
          textureId: t.textureId,
          lineWidth: Math.max(0.1, t.lineWidth),
          color: t.color,
          ...(t.gradientColor != null ? { gradientColor: t.gradientColor } : {}),
          opacity: Math.max(0, Math.min(1, t.opacity)),
          stiffness: Math.max(0, Math.min(1, t.stiffness)),
          ...(typeof t.name === 'string' && t.name.trim() ? { name: t.name.trim().slice(0, 50) } : {}),
        });
        continue;
      }

      const openTailPersist =
        t.openTail != null && typeof t.openTail.x === 'number' && typeof t.openTail.y === 'number'
          ? { x: t.openTail.x, y: t.openTail.y }
          : undefined;

      if (path.length >= 2) {
        nextCommitted.push({
          path,
          underIndices: [],
          ...(openTailPersist ? { openTail: openTailPersist } : {}),
          textureId: t.textureId,
          lineWidth: Math.max(0.1, t.lineWidth),
          color: t.color,
          ...(t.gradientColor != null ? { gradientColor: t.gradientColor } : {}),
          opacity: Math.max(0, Math.min(1, t.opacity)),
          stiffness: Math.max(0, Math.min(1, t.stiffness)),
          ...(typeof t.name === 'string' && t.name.trim() ? { name: t.name.trim().slice(0, 50) } : {}),
        });
      } else if (path.length === 1 && openTailPersist) {
        nextCommitted.push({
          path,
          underIndices: [],
          openTail: openTailPersist,
          textureId: t.textureId,
          lineWidth: Math.max(0.1, t.lineWidth),
          color: t.color,
          ...(t.gradientColor != null ? { gradientColor: t.gradientColor } : {}),
          opacity: Math.max(0, Math.min(1, t.opacity)),
          stiffness: Math.max(0, Math.min(1, t.stiffness)),
          ...(typeof t.name === 'string' && t.name.trim() ? { name: t.name.trim().slice(0, 50) } : {}),
        });
      }
    }

    this.committed = nextCommitted;
    // Re-seed undo so restored lines/freehand doodles can still be undone after load/save reload.
    this.undoStack = nextCommitted.map((thread) => ({ type: 'add' as const, thread }));
    this.redoStack = [];

    // Clear any in-progress gesture state.
    this.active = [];
    this.preview = null;
    this.isDragging = false;
    this.lastSnapPos = null;
    this.freehandDraft = null;

    // Rebuild anchor visit counts so future undo/redo keeps consistent history.
    this.visitCounts.clear();
    for (const ct of this.committed) {
      for (const a of ct.path) {
        const c = this.visitCounts.get(a.id) ?? 0;
        this.visitCounts.set(a.id, c + 1);
      }
    }
  }

  /** Distance from point (px, py) to segment (ax,ay)-(bx,by). */
  private pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    return Math.hypot(px - qx, py - qy);
  }

  /**
   * If the content-space point is near a committed thread path, return its index (topmost first).
   * Otherwise return null.
   */
  getThreadAtPoint(contentX: number, contentY: number): number | null {
    const zoom = this.getZoomScale?.() ?? 1;
    let bestIndex: number | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let i = this.committed.length - 1; i >= 0; i--) {
      const ct = this.committed[i];
      // Compute per-thread hit radius in content-space from screen-space tolerance.
      const threadHalfWidthScreen = (ct.lineWidth * Math.max(0.0001, zoom)) / 2;
      const hitRadiusScreen = Math.max(
        HIT_THREAD_MIN_PX,
        Math.min(HIT_THREAD_MAX_PX, threadHalfWidthScreen + HIT_THREAD_EXTRA_PX)
      );
      const hitRadius = hitRadiusScreen / Math.max(0.0001, zoom);
      if (ct.freehandPoints && ct.freehandPoints.length >= 2) {
        const points = ct.freehandPoints;
        for (let j = 0; j < points.length - 1; j++) {
          const d = this.pointToSegmentDist(
            contentX, contentY,
            points[j].x, points[j].y,
            points[j + 1].x, points[j + 1].y,
          );
          if (d > hitRadius) continue;
          if (d < bestDist - 1e-6 || (Math.abs(d - bestDist) <= 1e-6 && (bestIndex == null || i > bestIndex))) {
            bestDist = d;
            bestIndex = i;
          }
        }
        continue;
      }
      const underSet = new Set(ct.underIndices.map((j) => ct.path[j].id));
      const { points } = this.expandPath(ct.path, underSet, ct.lineWidth);
      for (let j = 0; j < points.length - 1; j++) {
        const d = this.pointToSegmentDist(
          contentX, contentY,
          points[j].x, points[j].y,
          points[j + 1].x, points[j + 1].y
        );
        if (d > hitRadius) continue;
        // Prefer geometrically closest thread. When distances are effectively equal,
        // keep the topmost one (higher index / later committed).
        if (d < bestDist - 1e-6 || (Math.abs(d - bestDist) <= 1e-6 && (bestIndex == null || i > bestIndex))) {
          bestDist = d;
          bestIndex = i;
        }
      }
      if (ct.openTail && points.length >= 1) {
        const last = points[points.length - 1];
        const d = this.pointToSegmentDist(
          contentX, contentY,
          last.x, last.y,
          ct.openTail.x, ct.openTail.y,
        );
        if (d <= hitRadius && (d < bestDist - 1e-6 || (Math.abs(d - bestDist) <= 1e-6 && (bestIndex == null || i > bestIndex)))) {
          bestDist = d;
          bestIndex = i;
        }
      }
    }
    return bestIndex;
  }

  /** Get params of a committed thread for the materials popup. */
  getCommittedThreadCount(): number {
    return this.committed.length;
  }

  /** Get params of a committed thread for the materials popup. */
  getThreadParams(index: number): ThreadParams | null {
    const ct = this.committed[index];
    if (!ct) return null;
    return {
      textureId: ct.textureId,
      lineWidth: ct.lineWidth,
      color: ct.color,
      gradientColor: ct.gradientColor,
      opacity: ct.opacity,
      stiffness: ct.stiffness,
    };
  }

  /** Midpoint of a thread's path in content space (for positioning popup). */
  getThreadContentMidpoint(index: number): Point | null {
    const ct = this.committed[index];
    if (!ct) return null;
    if (ct.freehandPoints && ct.freehandPoints.length >= 2) {
      const points = ct.freehandPoints;
      let mx = 0;
      let my = 0;
      for (const p of points) {
        mx += p.x;
        my += p.y;
      }
      return { x: mx / points.length, y: my / points.length };
    }
    const underSet = new Set(ct.underIndices.map((j) => ct.path[j].id));
    const { points: ep } = this.expandPath(ct.path, underSet, ct.lineWidth);
    const points = ct.openTail ? [...ep, ct.openTail] : ep;
    if (points.length === 0) return null;
    let mx = 0;
    let my = 0;
    for (const p of points) {
      mx += p.x;
      my += p.y;
    }
    return { x: mx / points.length, y: my / points.length };
  }

  /** Bounds of a thread's expanded path in content space (for popup positioning). */
  getThreadContentBounds(index: number): { minY: number; maxY: number } | null {
    const ct = this.committed[index];
    if (!ct) return null;
    if (ct.freehandPoints && ct.freehandPoints.length >= 2) {
      const points = ct.freehandPoints;
      let minY = Number.POSITIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const p of points) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return { minY, maxY };
    }
    const underSet = new Set(ct.underIndices.map((j) => ct.path[j].id));
    const { points: ep2 } = this.expandPath(ct.path, underSet, ct.lineWidth);
    const points = ct.openTail ? [...ep2, ct.openTail] : ep2;
    if (points.length === 0) return null;

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of points) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minY, maxY };
  }

  /** Update a committed thread's material. */
  setThreadMaterial(index: number, params: Partial<ThreadParams>): void {
    const ct = this.committed[index];
    if (!ct) return;
    if (params.textureId != null) ct.textureId = params.textureId;
    if (params.lineWidth != null) ct.lineWidth = params.lineWidth;
    if (params.color != null) ct.color = params.color;
    if (Object.prototype.hasOwnProperty.call(params, 'gradientColor')) ct.gradientColor = params.gradientColor;
    if (params.opacity != null) ct.opacity = params.opacity;
    if (params.stiffness != null) ct.stiffness = Math.max(0, Math.min(1, params.stiffness));
    this.notifyCommittedThreadsChange();
  }

  /** Optional display name for long-press property panel / export. */
  getThreadName(index: number): string | undefined {
    const ct = this.committed[index];
    return ct?.name;
  }

  setThreadName(index: number, name: string): void {
    const ct = this.committed[index];
    if (!ct) return;
    const t = name.trim().slice(0, 50);
    if (!t) delete ct.name;
    else ct.name = t;
    this.notifyCommittedThreadsChange();
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown',   this.onDown);
    this.canvas.removeEventListener('pointermove',   this.onMove);
    this.canvas.removeEventListener('pointerup',     this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
    this.activePointerIds.clear();
  }
}
