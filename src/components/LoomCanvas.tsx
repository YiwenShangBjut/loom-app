import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react';
import { LoomRenderer } from '../canvas/LoomRenderer';
import { RopeRenderer } from '../canvas/RopeRenderer';
import { WrapController, type ThreadParams } from '../interaction/WrapController';
import { ThreadSagManager } from '../physics/ThreadSag';
import { MATERIAL_TEXTURE_PRESETS } from '../rendering/materialTextures';
import type { MaterialTextureId } from '../rendering/materialTextures';
import { commitStiffness } from '../rendering/commitStiffness';
import type { LoomShape, Point } from '../physics/types';
import type { SavedCreation } from '../savedCreation';
import { LOOM_PREVIEW_SQUARE_RIM_BUFFER_CONTENT_PX } from '../creationCachedExport';

/** Content-space offset from thread rim toward loom outer edge — story labels sit outside the weave. */
const THREAD_STORY_BUBBLE_OUTWARD_CONTENT = 72;

export interface LoomCanvasHandle {
  reset(): void;
  undo(): void;
  redo(): void;
  getCommittedThreadCount(): number;
  getThreadAtPoint(contentX: number, contentY: number): number | null;
  getThreadParams(index: number): ThreadParams | null;
  getThreadAnchorIds(index: number): number[] | null;
  /** Get current sagged points for a committed thread (canvas-space pixels). */
  getThreadSaggedPoints(index: number): Point[] | null;
  /** Persisted content-space polyline for freehand strokes; null if weave-only thread. */
  getThreadFreehandPolyline(index: number): Point[] | null;
  /** Open end in content space after last anchor (weave tail into blank area). */
  getThreadOpenTail(index: number): Point | null;
  setThreadMaterial(index: number, params: Partial<ThreadParams>): void;
  getThreadName(index: number): string | undefined;
  setThreadName(index: number, name: string): void;
  getThreadClientMidpoint(index: number): { x: number; y: number } | null;
  /** 线条最边缘点（距 loom 中心最远）在 client 坐标，气泡偏移到该点外侧 */
  getThreadClientEdgePoint(index: number): { x: number; y: number } | null;
  /** Same outward offset as edge labels, as fractions of canvas width/height (matches exported PNG layout). */
  getThreadBubbleCanvasFraction(index: number): { x: number; y: number } | null;
  getThreadClientBottom(index: number): number | null;
  deleteThread(index: number): void;
  /** Later index draws on top. Move one step toward the front (above the next stroke). */
  bringThreadForward(index: number): boolean;
  /** Move one step toward the back (under the previous stroke). */
  sendThreadBackward(index: number): boolean;
  /** Move to top of stack (drawn last / on top). */
  bringThreadToTop(index: number): boolean;
  /** Move to bottom of stack (drawn first / underneath). */
  sendThreadToBottom(index: number): boolean;
  /** Restore committed threads. Returns false if canvas internals not ready yet. */
  tryLoadCreation(creation: SavedCreation): boolean;
  /**
   * PNG 导出用：通过 Pixi extract 渲染到 2D 位图。不要对 WebGL 视图 canvas 直接 toDataURL/drawImage，否则常为黑块。
   */
  getExportSnapshotCanvas(): HTMLCanvasElement | null;
  /** 离开 Create 等多帧导出前：从 idle 唤醒 ticker，保证 tryLoadCreation 后能渲染。 */
  wakeExportTicker(): void;
  /** 导出前重置到默认视图（zoom=1, pan=0），避免裁切偏移。 */
  resetExportView(): void;
  /** Pixi 画布清除色 #rrggbb（离屏导出 worker 等与 UI 画布分离时使用）。 */
  setCanvasBackgroundHex(hex: string): void;
  /** My Creation 预览：圆心 + (rim 半径+content buffer) 映射到画布后的正方形半边长（px） */
  getLoomPreviewSquareCanvasParams(): { cx: number; cy: number; halfSidePx: number } | null;
  getLoomShape(): LoomShape;
  /** Toggle hoop geometry; `force` redraws even if shape unchanged (e.g. after reset). */
  setLoomShape(shape: LoomShape, force?: boolean): void;
}

export interface LoomCanvasProps {
  textureId?: MaterialTextureId;
  /** Hex color for new and existing threads (e.g. '#f09595'). Applied to rope tint. */
  color?: string;
  /** Optional second hex color. When set, rope uses along-path gradient start->end. */
  gradientColor?: string;
  /** 0..100 thickness slider value from materials panel. */
  thickness?: number;
  /** 0..100 opacity slider; 0 = fully opaque, 100 = most transparent. */
  opacity?: number;
  /** 0..100 softness slider; 0 = stiff, 100 = soft. Only affects current/new stroke. */
  softness?: number;
  /** When pointer down doesn't snap and user short-taps empty space. */
  onTapCanvas?: (contentPoint: { x: number; y: number }) => void;
  /** When user long-presses a committed thread (>= 2s). */
  onLongPressThread?: (contentPoint: { x: number; y: number }, threadIndex: number) => void;
  /** When pointerdown snaps to an anchor and the wrap gesture is about to start. */
  onWrapStart?: () => void;
  /** After committed threads change (not fired when loading a saved creation). */
  onCommittedThreadsChange?: () => void;
  /** Committed thread index to highlight (e.g. selected for editing). */
  selectedThreadIndex?: number | null;
  /** When true, canvas is view-only: no wrap/edit, only pan (drag) to move view. */
  readOnly?: boolean;
  /** When false, temporary no-brush mode: block new wraps. */
  materialEnabled?: boolean;
  /**
   * Create：打开时仅在空白处涂鸦为固定 2px #221915（none 材质）；关闭时用当前材质与渐变。
   */
  blankCanvasThinPen?: boolean;
  /** Pause internal ticker updates without destroying the canvas instance. */
  paused?: boolean;
  /** When true, do not schedule idle on init (e.g. offscreen export canvas that must run until export completes). */
  skipIdleOnInit?: boolean;
  /** When true, never wake from idle (Creation page: always idle, ticker stays stopped after initial settle). */
  alwaysIdle?: boolean;
  /** Pixi view background (#rrggbb); can be updated after mount. */
  canvasBackground?: string;
  /** Create freehand eraser mode: only erase freehand black thin strokes. */
  freehandEraserEnabled?: boolean;
}

/** Parse hex string to Pixi tint number (0xRRGGBB). */
function hexToTint(hex: string): number {
  const s = hex.replace(/^#/, '');
  if (s.length !== 6) return 0xe8d5b7;
  return parseInt(s, 16);
}

/** Map 0..100 thickness slider to a line width multiplier. Wider range for more visible variation. */
function thicknessToScale(v: number | undefined): number {
  const t = v == null ? 35 : v;
  const n = clamp01(t / 100);
  // 0 → 0.35x (thinner), 100 → 2.8x (thicker)
  return 0.35 + n * 2.45;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** Eraser brush diameter as a fraction of design width 1280px (56px circle). */
const ERASER_DIAMETER_FRAC = 56 / 1280;

type CanvasSeg = { ax: number; ay: number; bx: number; by: number };

function segmentCircleBoundaryTs(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ox: number,
  oy: number,
  r: number,
): number[] {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - ox;
  const fy = ay - oy;
  const a = dx * dx + dy * dy;
  if (a < 1e-14) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  const out: number[] = [];
  for (const t of [t1, t2]) {
    if (t > 1e-5 && t < 1 - 1e-5) out.push(t);
  }
  return out.sort((u, v) => u - v);
}

function edgeOutsideFragments(ax: number, ay: number, bx: number, by: number, ox: number, oy: number, r: number): CanvasSeg[] {
  let ts = [0, ...segmentCircleBoundaryTs(ax, ay, bx, by, ox, oy, r), 1];
  const uniq: number[] = [];
  for (const t of ts.sort((a, b) => a - b)) {
    if (uniq.length === 0 || Math.abs(t - uniq[uniq.length - 1]!) > 1e-7) uniq.push(t);
  }
  ts = uniq;
  const fr: CanvasSeg[] = [];
  const r2 = r * r;
  for (let k = 0; k < ts.length - 1; k++) {
    const t0 = ts[k]!;
    const t1 = ts[k + 1]!;
    const mt = (t0 + t1) / 2;
    const mx = ax + (bx - ax) * mt;
    const my = ay + (by - ay) * mt;
    const ddx = mx - ox;
    const ddy = my - oy;
    if (ddx * ddx + ddy * ddy <= r2) continue;
    fr.push({
      ax: ax + (bx - ax) * t0,
      ay: ay + (by - ay) * t0,
      bx: ax + (bx - ax) * t1,
      by: ay + (by - ay) * t1,
    });
  }
  return fr;
}

function mergeFragmentsToPolylines(frags: CanvasSeg[]): Point[][] {
  if (frags.length === 0) return [];
  const polys: Point[][] = [];
  let current: Point[] = [
    { x: frags[0]!.ax, y: frags[0]!.ay },
    { x: frags[0]!.bx, y: frags[0]!.by },
  ];
  for (let i = 1; i < frags.length; i++) {
    const f = frags[i]!;
    const last = current[current.length - 1]!;
    const first = { x: f.ax, y: f.ay };
    if (Math.hypot(last.x - first.x, last.y - first.y) < 0.5) {
      current.push({ x: f.bx, y: f.by });
    } else {
      if (current.length >= 2) polys.push(current);
      current = [{ x: f.ax, y: f.ay }, { x: f.bx, y: f.by }];
    }
  }
  if (current.length >= 2) polys.push(current);
  return polys;
}

function clipFreehandCanvasPolyline(
  pts: Array<{ x: number; y: number }>,
  ox: number,
  oy: number,
  r: number,
): Point[][] {
  if (pts.length < 2) return [];
  const allFrags: CanvasSeg[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const A = pts[i]!;
    const B = pts[i + 1]!;
    allFrags.push(...edgeOutsideFragments(A.x, A.y, B.x, B.y, ox, oy, r));
  }
  return mergeFragmentsToPolylines(allFrags);
}

function eraseFreehandThreadsWithCircle(
  loom: { getCanvasCoords: (x: number, y: number) => Point; getContentCoords: (x: number, y: number) => Point },
  wrap: WrapController,
  isErasable: (threadIndex: number) => boolean,
  canvasX: number,
  canvasY: number,
  radiusCanvas: number,
): boolean {
  let changed = false;
  const n = wrap.getCommittedThreadCount();
  for (let i = n - 1; i >= 0; i--) {
    if (!isErasable(i)) continue;
    const fh = wrap.getCommittedFreehandPoints(i);
    if (!fh || fh.length < 2) continue;
    const canvasPts = fh.map((p) => loom.getCanvasCoords(p.x, p.y));
    const pieces = clipFreehandCanvasPolyline(canvasPts, canvasX, canvasY, radiusCanvas);
    const contentPieces = pieces.map((poly) => poly.map((p) => loom.getContentCoords(p.x, p.y)));
    if (contentPieces.length === 1 && contentPieces[0]!.length === fh.length) {
      let same = true;
      for (let k = 0; k < fh.length; k++) {
        const a = contentPieces[0]![k]!;
        const b = fh[k]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-3) {
          same = false;
          break;
        }
      }
      if (same) continue;
    }
    wrap.replaceErasableFreehandWithPolylines(i, contentPieces);
    changed = true;
  }
  return changed;
}

/**
 * LoomCanvas wires: LoomRenderer, WrapController, ThreadSagManager, RopeRenderer.
 * Material (texture, thickness, color) comes from props and is applied when committing.
 * Exposes reset / undo / redo via ref.
 */
/** Softness 0..100 → stiffness 0..1 (0 = soft, 1 = stiff). */
function softnessToStiffness(softness: number | undefined): number {
  const s = softness == null ? 50 : Math.max(0, Math.min(100, softness));
  return 1 - s / 100;
}

const FREEHAND_THIN_PEN_COLOR = 0x221915;

const LoomCanvasInner = forwardRef<LoomCanvasHandle, LoomCanvasProps>(function LoomCanvas(
  {
    textureId = 'none',
    color,
    gradientColor,
    thickness,
    opacity = 100,
    softness,
    onTapCanvas,
    onLongPressThread,
    onWrapStart,
    onCommittedThreadsChange,
    selectedThreadIndex = null,
    readOnly = false,
    materialEnabled = true,
    blankCanvasThinPen = false,
    paused = false,
    skipIdleOnInit = false,
    alwaysIdle = false,
    canvasBackground = '#ffffff',
    freehandEraserEnabled = false,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textureIdRef = useRef(textureId);
  const colorRef = useRef(color);
  const gradientColorRef = useRef(gradientColor);
  const thicknessRef = useRef<number | undefined>(thickness);
  const opacityRef = useRef(opacity);
  const wrapRef = useRef<WrapController | null>(null);
  const sagRef = useRef<ThreadSagManager | null>(null);
  const loomRef = useRef<LoomRenderer | null>(null);
  const onTapCanvasRef = useRef(onTapCanvas);
  const onLongPressThreadRef = useRef(onLongPressThread);
  const onWrapStartRef = useRef(onWrapStart);
  const onCommittedThreadsChangeRef = useRef(onCommittedThreadsChange);
  const selectedThreadIndexRef = useRef(selectedThreadIndex);
  const materialEnabledRef = useRef(materialEnabled);
  const blankCanvasThinPenRef = useRef(blankCanvasThinPen);
  const pausedRef = useRef(paused);
  const canvasBackgroundRef = useRef(canvasBackground);
  const freehandEraserEnabledRef = useRef(freehandEraserEnabled);
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const eraserBrushRef = useRef<HTMLDivElement | null>(null);
  const lastSagStiffnessesRef = useRef<string | null>(null);
  const frameTickRef = useRef(0);
  const isIdleRef = useRef(false);
  const activePointersRef = useRef<Set<number | string>>(new Set());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alwaysIdleRef = useRef(alwaysIdle);
  alwaysIdleRef.current = alwaysIdle;
  textureIdRef.current = textureId;
  colorRef.current = color;
  gradientColorRef.current = gradientColor;
  thicknessRef.current = thickness;
  opacityRef.current = opacity;
  onTapCanvasRef.current = onTapCanvas;
  onLongPressThreadRef.current = onLongPressThread;
  onWrapStartRef.current = onWrapStart;
  onCommittedThreadsChangeRef.current = onCommittedThreadsChange;
  commitStiffness.current = softnessToStiffness(softness);
  selectedThreadIndexRef.current = selectedThreadIndex;
  materialEnabledRef.current = materialEnabled;
  blankCanvasThinPenRef.current = blankCanvasThinPen;
  pausedRef.current = paused;
  canvasBackgroundRef.current = canvasBackground;
  freehandEraserEnabledRef.current = freehandEraserEnabled;

  /**
   * Hit-test committed threads against rendered (sagged) geometry.
   * @param allowLooseHit when true (default), fall back to a looser radius for long-press / fat-finger.
   *   When false, only strict hits count — use so freehand is not blocked near gradient/thick strokes.
   */
  const getRenderedThreadAtPoint = (
    contentX: number,
    contentY: number,
    opts?: { allowLooseHit?: boolean },
  ): number | null => {
    const allowLooseHit = opts?.allowLooseHit ?? true;
    const sag = sagRef.current;
    const wrap = wrapRef.current;
    const loom = loomRef.current;
    if (!wrap) return null;

    const count = wrap.getCommittedThreadCount();
    const zoom = Math.max(0.0001, loom?.getZoomScale() ?? 1);
    let bestStrictIndex: number | null = null;
    let bestStrictDist = Number.POSITIVE_INFINITY;
    let bestLooseIndex: number | null = null;
    let bestLooseDist = Number.POSITIVE_INFINITY;
    let hasAnySaggedPath = false;

    if (sag) {
      for (let i = count - 1; i >= 0; i--) {
        const fh = wrap.getCommittedFreehandPoints(i);
        let points: Point[] | null =
          fh && fh.length >= 2 ? fh : null;
        if (points == null) {
          const si = wrap.getSagRopeIndexForCommittedThread(i);
          if (si == null) continue;
          points = sag.getSaggedPoints(si);
        }
        if (!points || points.length < 2) continue;
        hasAnySaggedPath = true;

        // Screen-space hit tolerance:
        // keep it close to the visible rope width to avoid selecting nearby threads.
        const lineWidth = wrap.getThreadParams(i)?.lineWidth ?? 3;
        const threadHalfWidthScreen = (lineWidth * zoom) / 2;
        const strictRadiusScreen = Math.max(5, Math.min(12, threadHalfWidthScreen + 1.5));
        // Second-pass tolerance so long-press is still discoverable when finger is not pixel-perfect.
        const looseRadiusScreen = Math.max(strictRadiusScreen, Math.min(16, strictRadiusScreen + 3));
        const strictRadius = strictRadiusScreen / zoom;
        const looseRadius = looseRadiusScreen / zoom;

        for (let j = 0; j < points.length - 1; j++) {
          const d = pointToSegmentDist(
            contentX, contentY,
            points[j].x, points[j].y,
            points[j + 1].x, points[j + 1].y,
          );
          if (d <= strictRadius) {
            if (
              d < bestStrictDist - 1e-6 ||
              (Math.abs(d - bestStrictDist) <= 1e-6 && (bestStrictIndex == null || i > bestStrictIndex))
            ) {
              bestStrictDist = d;
              bestStrictIndex = i;
            }
          } else if (d <= looseRadius) {
            if (
              d < bestLooseDist - 1e-6 ||
              (Math.abs(d - bestLooseDist) <= 1e-6 && (bestLooseIndex == null || i > bestLooseIndex))
            ) {
              bestLooseDist = d;
              bestLooseIndex = i;
            }
          }
        }
      }
    }

    // When per-thread paths exist (sag or freehand), trust only that hit-test (matches what user sees).
    if (hasAnySaggedPath) {
      return allowLooseHit ? (bestStrictIndex ?? bestLooseIndex) : bestStrictIndex;
    }
    // Startup fallback before sag ropes are created.
    return wrap.getThreadAtPoint(contentX, contentY);
  };

  useImperativeHandle(ref, () => ({
    reset() {
      wrapRef.current?.reset();
      const loom = loomRef.current;
      const wrap = wrapRef.current;
      if (loom && wrap) {
        loom.setLoomShape('circle', true);
        wrap.replaceAnchors(loom.getAnchorPoints(), loom.getLoomOutline());
      }
      lastSagStiffnessesRef.current = null;
      sagRef.current?.setPaths([], []);
      isIdleRef.current = false;
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    },
    undo() {
      wrapRef.current?.undo();
      // Reorder (and rare same-length mutations) can keep sag rope count + stiffness
      // signature identical while committed index → rope mapping must change.
      lastSagStiffnessesRef.current = null;
    },
    redo() {
      wrapRef.current?.redo();
      lastSagStiffnessesRef.current = null;
    },
    getCommittedThreadCount() {
      return wrapRef.current?.getCommittedThreadCount() ?? 0;
    },
    getLoomShape() {
      return loomRef.current?.getLoomShape() ?? 'circle';
    },
    setLoomShape(shape: LoomShape, force = false) {
      const loom = loomRef.current;
      const wrap = wrapRef.current;
      if (!loom || !wrap) return;
      loom.setLoomShape(shape, force);
      wrap.replaceAnchors(loom.getAnchorPoints(), loom.getLoomOutline());
      lastSagStiffnessesRef.current = null;
    },
    getThreadAtPoint(contentX: number, contentY: number) {
      return getRenderedThreadAtPoint(contentX, contentY);
    },
    getThreadParams(index: number) {
      return wrapRef.current?.getThreadParams(index) ?? null;
    },
    getThreadAnchorIds(index: number) {
      return wrapRef.current?.getThreadAnchorIds(index) ?? null;
    },
    getThreadSaggedPoints(index: number) {
      const wrap = wrapRef.current;
      const sag = sagRef.current;
      const loom = loomRef.current;
      if (!wrap || !loom) return null;
      const fh = wrap.getCommittedFreehandPoints(index);
      if (fh && fh.length >= 2) {
        return fh.map((p) => loom.getCanvasCoords(p.x, p.y));
      }
      if (!sag) return null;
      const si = wrap.getSagRopeIndexForCommittedThread(index);
      if (si == null) return null;
      const ptsContent = sag.getSaggedPoints(si);
      if (!ptsContent) return null;
      return ptsContent.map((p) => loom.getCanvasCoords(p.x, p.y));
    },
    getThreadFreehandPolyline(index: number) {
      return wrapRef.current?.getCommittedFreehandPoints(index) ?? null;
    },
    getThreadOpenTail(index: number) {
      return wrapRef.current?.getCommittedOpenTail(index) ?? null;
    },
    tryLoadCreation(creation: SavedCreation) {
      if (!wrapRef.current || !sagRef.current) return false;
      const threads = creation?.threads;
      if (!Array.isArray(threads)) return false;
      isIdleRef.current = false;
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      wrapRef.current.setCommittedThreads(
        threads.map((t, i) => ({
          anchorIds: Array.isArray(t.anchorIds) ? t.anchorIds : [],
          polyline:
            Array.isArray(t.polyline) && t.polyline.length >= 2
              ? t.polyline.map((p) => ({ x: p.x, y: p.y }))
              : undefined,
          openTail:
            t.openTail != null && typeof t.openTail.x === 'number' && typeof t.openTail.y === 'number'
              ? { x: t.openTail.x, y: t.openTail.y }
              : undefined,
          textureId: t.textureId,
          lineWidth: t.lineWidth,
          color: t.color,
          gradientColor: t.gradientColor,
          opacity: t.opacity,
          stiffness: t.stiffness,
          name: creation.threadNames?.[i],
        })),
      );
      // Clear sag ropes; next ticker will re-create based on new committed threads.
      sagRef.current.setPaths([], []);
      return true;
    },
    setThreadMaterial(index: number, params: Partial<ThreadParams>) {
      wrapRef.current?.setThreadMaterial(index, params);
    },
    getThreadName(index: number) {
      return wrapRef.current?.getThreadName(index);
    },
    setThreadName(index: number, name: string) {
      wrapRef.current?.setThreadName(index, name);
    },
    getThreadClientMidpoint(index: number) {
      const wrap = wrapRef.current;
      const loom = loomRef.current;
      if (!wrap || !loom) return null;
      const mid = wrap.getThreadContentMidpoint(index);
      if (!mid) return null;
      const { x: cx, y: cy } = loom.getCanvasCoords(mid.x, mid.y);
      const canvasEl = containerRef.current?.querySelector('canvas');
      if (!canvasEl) return null;
      const rect = canvasEl.getBoundingClientRect();
      return {
        x: rect.left + (cx / (canvasEl as HTMLCanvasElement).width) * rect.width,
        y: rect.top + (cy / (canvasEl as HTMLCanvasElement).height) * rect.height,
      };
    },
    /** 线条最边缘点（距 loom 中心最远）在 client 坐标，气泡偏移到该点外侧 */
    getThreadClientEdgePoint(index: number) {
      const wrap = wrapRef.current;
      const sag = sagRef.current;
      const loom = loomRef.current;
      if (!wrap || !loom) return null;
      let pts: Point[] | null = wrap.getCommittedFreehandPoints(index);
      if ((!pts || pts.length < 2) && sag) {
        const si = wrap.getSagRopeIndexForCommittedThread(index);
        if (si != null) pts = sag.getSaggedPoints(si);
      }
      if (!pts || pts.length === 0) return null;
      const center = loom.getLoomCenterContent();
      let best = pts[0];
      let bestDist = 0;
      for (const p of pts) {
        const d = (p.x - center.x) ** 2 + (p.y - center.y) ** 2;
        if (d > bestDist) {
          bestDist = d;
          best = p;
        }
      }
      const dx = best.x - center.x;
      const dy = best.y - center.y;
      const len = Math.hypot(dx, dy) || 1;
      const bubbleContent = {
        x: best.x + (dx / len) * THREAD_STORY_BUBBLE_OUTWARD_CONTENT,
        y: best.y + (dy / len) * THREAD_STORY_BUBBLE_OUTWARD_CONTENT,
      };
      const { x: cx, y: cy } = loom.getCanvasCoords(bubbleContent.x, bubbleContent.y);
      const canvasEl = containerRef.current?.querySelector('canvas');
      if (!canvasEl) return null;
      const rect = canvasEl.getBoundingClientRect();
      return {
        x: rect.left + (cx / (canvasEl as HTMLCanvasElement).width) * rect.width,
        y: rect.top + (cy / (canvasEl as HTMLCanvasElement).height) * rect.height,
      };
    },
    getThreadBubbleCanvasFraction(index: number) {
      const wrap = wrapRef.current;
      const sag = sagRef.current;
      const loom = loomRef.current;
      if (!wrap || !loom) return null;
      let pts: Point[] | null = wrap.getCommittedFreehandPoints(index);
      if ((!pts || pts.length < 2) && sag) {
        const si = wrap.getSagRopeIndexForCommittedThread(index);
        if (si != null) pts = sag.getSaggedPoints(si);
      }
      if (!pts || pts.length === 0) return null;
      const center = loom.getLoomCenterContent();
      let best = pts[0];
      let bestDist = 0;
      for (const p of pts) {
        const d = (p.x - center.x) ** 2 + (p.y - center.y) ** 2;
        if (d > bestDist) {
          bestDist = d;
          best = p;
        }
      }
      const dx = best.x - center.x;
      const dy = best.y - center.y;
      const len = Math.hypot(dx, dy) || 1;
      const bubbleContent = {
        x: best.x + (dx / len) * THREAD_STORY_BUBBLE_OUTWARD_CONTENT,
        y: best.y + (dy / len) * THREAD_STORY_BUBBLE_OUTWARD_CONTENT,
      };
      const { x: cx, y: cy } = loom.getCanvasCoords(bubbleContent.x, bubbleContent.y);
      const canvasEl = containerRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
      if (!canvasEl || canvasEl.width <= 0 || canvasEl.height <= 0) return null;
      return { x: cx / canvasEl.width, y: cy / canvasEl.height };
    },
    getThreadClientBottom(index: number) {
      const wrap = wrapRef.current;
      const loom = loomRef.current;
      if (!wrap || !loom) return null;
      const b = wrap.getThreadContentBounds(index);
      if (!b) return null;
      // Mapping from contentY to canvasY is independent of x.
      const { y: cy } = loom.getCanvasCoords(0, b.maxY);
      const canvasEl = containerRef.current?.querySelector('canvas');
      if (!canvasEl) return null;
      const rect = canvasEl.getBoundingClientRect();
      return rect.top + (cy / (canvasEl as HTMLCanvasElement).height) * rect.height;
    },
    deleteThread(index: number) {
      wrapRef.current?.deleteThread(index);
    },
    bringThreadForward(index: number) {
      const ok = wrapRef.current?.bringThreadForward(index) ?? false;
      if (ok) lastSagStiffnessesRef.current = null;
      return ok;
    },
    sendThreadBackward(index: number) {
      const ok = wrapRef.current?.sendThreadBackward(index) ?? false;
      if (ok) lastSagStiffnessesRef.current = null;
      return ok;
    },
    bringThreadToTop(index: number) {
      const ok = wrapRef.current?.bringThreadToTop(index) ?? false;
      if (ok) lastSagStiffnessesRef.current = null;
      return ok;
    },
    sendThreadToBottom(index: number) {
      const ok = wrapRef.current?.sendThreadToBottom(index) ?? false;
      if (ok) lastSagStiffnessesRef.current = null;
      return ok;
    },
    getExportSnapshotCanvas() {
      const loom = loomRef.current;
      if (!loom) return null;
      try {
        const app = loom.app;
        const extracted = app.renderer.extract.canvas({ target: app.stage });
        if (extracted instanceof HTMLCanvasElement) return extracted;
        if (typeof OffscreenCanvas !== 'undefined' && extracted instanceof OffscreenCanvas) {
          const out = document.createElement('canvas');
          out.width = extracted.width;
          out.height = extracted.height;
          const ctx = out.getContext('2d');
          if (!ctx) return null;
          ctx.drawImage(extracted, 0, 0);
          return out;
        }
        return extracted as unknown as HTMLCanvasElement;
      } catch {
        return null;
      }
    },
    wakeExportTicker() {
      if (alwaysIdleRef.current) return;
      const loom = loomRef.current;
      if (pausedRef.current || !loom) return;
      isIdleRef.current = false;
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      loom.app.ticker.start();
    },
    resetExportView() {
      loomRef.current?.resetViewTransform();
    },
    setCanvasBackgroundHex(hex: string) {
      canvasBackgroundRef.current = hex;
      loomRef.current?.setCanvasBackground(hex);
    },
    getLoomPreviewSquareCanvasParams() {
      const loom = loomRef.current;
      if (!loom) return null;
      const anchors = loom.getAnchorPoints();
      const center = anchors.find((a) => a.type === 'center');
      const rimAnchors = anchors.filter((a) => a.type === 'rim');
      if (!center || rimAnchors.length === 0) return null;
      const rimRadius = Math.max(...rimAnchors.map((a) => Math.hypot(a.x - center.x, a.y - center.y)));
      const rContent = rimRadius + LOOM_PREVIEW_SQUARE_RIM_BUFFER_CONTENT_PX;
      const cc = loom.getCanvasCoords(center.x, center.y);
      const edge = loom.getCanvasCoords(center.x + rContent, center.y);
      const halfSidePx = Math.hypot(edge.x - cc.x, edge.y - cc.y);
      if (!Number.isFinite(cc.x) || !Number.isFinite(cc.y) || !Number.isFinite(halfSidePx)) return null;
      if (halfSidePx < 2) return null;
      return { cx: cc.x, cy: cc.y, halfSidePx };
    },
  }), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const loom = new LoomRenderer();
    let rope: RopeRenderer | null = null;
    let wrap: WrapController | null = null;
    let sag: ThreadSagManager | null = null;
    let running = true;
    let removePinchListeners: (() => void) | null = null;
    let removePanListeners: (() => void) | null = null;
    let removeDocumentPointerGestureFlush: (() => void) | null = null;
    let canvasEl: HTMLCanvasElement | null = null;
    let onContextMenu: ((e: MouseEvent) => void) | null = null;
    let onDblClick: ((e: MouseEvent) => void) | null = null;
    let onWake: () => void = () => {};
    let onVisibilityChange: () => void = () => {};
    let onPointerDown: (e: PointerEvent) => void = () => {};
    let onTouchStartIdle: (e: TouchEvent) => void = () => {};
    let onPointerUp: (e: PointerEvent) => void = () => {};
    let onTouchEndIdle: (e: TouchEvent) => void = () => {};

    (async () => {
      await loom.init(container, { background: canvasBackgroundRef.current });
      if (!running) return;
      loomRef.current = loom;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (!running) return;

      const preset = MATERIAL_TEXTURE_PRESETS.none;
      canvasEl = loom.app.canvas;
      canvasElementRef.current = canvasEl;
      canvasEl.style.cursor = freehandEraserEnabledRef.current ? 'crosshair' : '';

      onContextMenu = (e: MouseEvent) => {
        // Desktop: "long press" on trackpad/mouse can trigger native context menu.
        // We disable it on this canvas so long-press-to-edit doesn't look like right-click.
        e.preventDefault();
        e.stopPropagation();
      };
      canvasEl!.addEventListener('contextmenu', onContextMenu);

      const IDLE_DELAY_MS = alwaysIdle ? 4000 : 2000;
      const wakeFromIdle = () => {
        if (alwaysIdle) return;
        isIdleRef.current = false;
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current);
          idleTimerRef.current = null;
        }
        if (!pausedRef.current) loom.app.ticker.start();
      };
      const scheduleIdle = () => {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => {
          idleTimerRef.current = null;
          isIdleRef.current = true;
          loom.app.ticker.stop();
        }, IDLE_DELAY_MS);
      };
      onWake = () => wakeFromIdle();
      onPointerDown = (e: PointerEvent) => {
        activePointersRef.current.add(e.pointerId);
        wakeFromIdle();
      };
      onPointerUp = (e: PointerEvent) => {
        activePointersRef.current.delete(e.pointerId);
        if (activePointersRef.current.size === 0) scheduleIdle();
      };
      onTouchStartIdle = (e: TouchEvent) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
          activePointersRef.current.add(`t${e.changedTouches[i].identifier}`);
        }
        wakeFromIdle();
      };
      onTouchEndIdle = (e: TouchEvent) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
          activePointersRef.current.delete(`t${e.changedTouches[i].identifier}`);
        }
        if (activePointersRef.current.size === 0) scheduleIdle();
      };
      onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          isIdleRef.current = true;
          loom.app.ticker.stop();
        } else if (!alwaysIdle) {
          wakeFromIdle();
        }
      };
      canvasEl!.addEventListener('pointerdown', onPointerDown, { passive: true });
      canvasEl!.addEventListener('touchstart', onTouchStartIdle, { passive: true });
      canvasEl!.addEventListener('wheel', onWake, { passive: true });
      container.addEventListener('pointerdown', onPointerDown, { passive: true });
      container.addEventListener('touchstart', onTouchStartIdle, { passive: true });
      document.addEventListener('pointerup', onPointerUp, { passive: true });
      document.addEventListener('pointerleave', onPointerUp, { passive: true });
      document.addEventListener('pointercancel', onPointerUp, { passive: true });
      document.addEventListener('touchend', onTouchEndIdle, { passive: true });
      document.addEventListener('touchcancel', onTouchEndIdle, { passive: true });
      document.addEventListener('visibilitychange', onVisibilityChange);

      // Enter idle after delay when no pointers are down (e.g. Creation page: user just viewing, never touches).
      // Skip for offscreen export canvas which must run until export completes.
      if (!skipIdleOnInit && activePointersRef.current.size === 0) scheduleIdle();

      // Convert CSS client coords to canvas-space pixels (Pixi autoDensity already reflected in canvas.width/height).
      const clientToCanvas = (clientX: number, clientY: number) => {
        const rect = canvasEl!.getBoundingClientRect();
        const scaleX = canvasEl!.width / rect.width;
        const scaleY = canvasEl!.height / rect.height;
        return {
          x: (clientX - rect.left) * scaleX,
          y: (clientY - rect.top) * scaleY,
        };
      };

      let isOutsideLoomImpl: (p: Point) => boolean = () => false;
      const isOutsideLoom = (contentPoint: { x: number; y: number }): boolean =>
        isOutsideLoomImpl(contentPoint);

      onDblClick = (e: MouseEvent) => {
        // Double click should open thread edit popup (desktop).
        // Prevent any browser default text selection / double-click behaviors.
        e.preventDefault();
        e.stopPropagation();

        // If button info exists, only react to primary (left) button.
        if (typeof e.button === 'number' && e.button !== 0) return;

        const canvasPt = clientToCanvas(e.clientX, e.clientY);
        const contentPt = loom.getContentCoords(canvasPt.x, canvasPt.y);
        const threadIndex = getRenderedThreadAtPoint(contentPt.x, contentPt.y);
        if (threadIndex == null) return;
        onLongPressThreadRef.current?.(contentPt, threadIndex);
      };
      canvasEl!.addEventListener('dblclick', onDblClick);

      const anchors = loom.getAnchorPoints();

      // Pan (drag) when pressing outside the loom hoop.
      let isPinching = false;
      let panCandidatePointerId: number | null = null;
      let panCandidateStartCanvas: { x: number; y: number } | null = null;
      let panCandidateContentPoint: { x: number; y: number } | null = null;
      let panLastCanvas: { x: number; y: number } | null = null;
      let panActive = false;

      /** Freehand doodle on empty canvas (Create); content space points. */
      let freehandPointerId: number | null = null;
      let freehandPoints: Point[] = [];
      let eraserPointerId: number | null = null;
      const pointersOnCanvas = new Set<number>();

      const isErasableFreehandThread = (threadIndex: number): boolean => {
        if (!wrap) return false;
        const fh = wrap.getCommittedFreehandPoints(threadIndex);
        if (!fh || fh.length < 2) return false;
        const params = wrap.getThreadParams(threadIndex);
        if (!params) return false;
        return params.textureId === 'none' && params.color === FREEHAND_THIN_PEN_COLOR;
      };

      const syncEraserBrushOverlay = (args: { clientX: number; clientY: number; active: boolean }) => {
        const brush = eraserBrushRef.current;
        const elContainer = containerRef.current;
        if (!brush || !elContainer) return;
        const w = elContainer.clientWidth;
        const d = ERASER_DIAMETER_FRAC * w;
        const rCss = d / 2;
        const rect = elContainer.getBoundingClientRect();
        if (!args.active || pointersOnCanvas.size > 1) {
          brush.style.display = 'none';
          return;
        }
        brush.style.display = 'block';
        brush.style.width = `${d}px`;
        brush.style.height = `${d}px`;
        brush.style.left = `${args.clientX - rect.left - rCss}px`;
        brush.style.top = `${args.clientY - rect.top - rCss}px`;
      };

      const eraseWithCircleAtClient = (clientX: number, clientY: number): boolean => {
        if (!wrap) return false;
        const c = clientToCanvas(clientX, clientY);
        const rad = (ERASER_DIAMETER_FRAC / 2) * canvasEl!.width;
        return eraseFreehandThreadsWithCircle(loom, wrap, isErasableFreehandThread, c.x, c.y, rad);
      };

      const cancelFreehand = () => {
        if (freehandPointerId != null && canvasEl) {
          try {
            canvasEl.releasePointerCapture(freehandPointerId);
          } catch {
            // ignore
          }
        }
        freehandPointerId = null;
        freehandPoints = [];
        wrap?.setFreehandDraft(null);
      };

      const cancelEraser = () => {
        syncEraserBrushOverlay({ clientX: 0, clientY: 0, active: false });
        if (eraserPointerId != null && canvasEl) {
          try {
            canvasEl.releasePointerCapture(eraserPointerId);
          } catch {
            // ignore
          }
        }
        wrap?.endEraserGesture();
        eraserPointerId = null;
      };

      const cancelPanCandidate = () => {
        panCandidatePointerId = null;
        panCandidateStartCanvas = null;
        panCandidateContentPoint = null;
        panLastCanvas = null;
        panActive = false;
      };

      // Long-press editing candidate when pointerdown doesn't snap to an anchor.
      // - Short tap: only trigger `onTapCanvas` for empty space (clear selection).
      // - Long press (500ms, small movement): trigger `onLongPressThread` if a thread is hit.
      const LONG_PRESS_MS = 500;
      // Desktop trackpad/mouse can jitter during "long press", so keep this generous.
      const LONG_PRESS_MOVE_THRESHOLD_PX = 14;
      let longPressCandidatePointerId: number | null = null;
      let longPressCandidateStartCanvas: { x: number; y: number } | null = null;
      let longPressCandidateContentPoint: { x: number; y: number } | null = null;
      let longPressTimer: ReturnType<typeof window.setTimeout> | null = null;
      let suppressNextPointerUpForId: number | null = null;

      let prevBodyUserSelect: string | null = null;
      let prevBodyTouchAction: string | null = null;

      const disableBodyTextSelection = () => {
        if (prevBodyUserSelect != null) return; // already disabled
        prevBodyUserSelect = document.body.style.userSelect;
        prevBodyTouchAction = document.body.style.touchAction;
        document.body.style.userSelect = 'none';
        document.body.style.touchAction = 'none';
      };

      const restoreBodyStyles = () => {
        if (prevBodyUserSelect == null) return;
        document.body.style.userSelect = prevBodyUserSelect ?? '';
        document.body.style.touchAction = prevBodyTouchAction ?? '';
        prevBodyUserSelect = null;
        prevBodyTouchAction = null;
      };

      const cancelLongPressCandidate = () => {
        if (longPressCandidatePointerId != null && canvasEl) {
          try {
            canvasEl.releasePointerCapture(longPressCandidatePointerId);
          } catch { /* ignore if already released */ }
        }
        longPressCandidatePointerId = null;
        longPressCandidateStartCanvas = null;
        longPressCandidateContentPoint = null;
        if (longPressTimer) clearTimeout(longPressTimer);
        longPressTimer = null;
        restoreBodyStyles();
      };

      const PAN_START_DISTANCE_PX = 3;

      const onPointerMovePan = (e: PointerEvent) => {
        if (isPinching) return;
        if (freehandPointerId != null) return;
        if (panCandidatePointerId == null || e.pointerId !== panCandidatePointerId) return;
        // 触摸设备上平移仅通过双指手势（touchmove 里处理），避免单指与绕线/长按抢手势。
        if (e.pointerType === 'touch') return;

        const curr = clientToCanvas(e.clientX, e.clientY);

        // Start panning only after movement beyond a small threshold.
        if (!panActive) {
          if (!panCandidateStartCanvas) return;
          const dist = Math.hypot(curr.x - panCandidateStartCanvas.x, curr.y - panCandidateStartCanvas.y);
          if (dist < PAN_START_DISTANCE_PX) return;
          panActive = true;
          panLastCanvas = curr;
          canvasEl!.setPointerCapture(panCandidatePointerId);
        }

        if (!panActive || !panLastCanvas) return;
        const dx = curr.x - panLastCanvas.x;
        const dy = curr.y - panLastCanvas.y;
        if (dx !== 0 || dy !== 0) loom.panBy(dx, dy);
        panLastCanvas = curr;
        e.preventDefault();
      };

      const onPointerMoveLongPress = (e: PointerEvent) => {
        if (isPinching) return;
        if (freehandPointerId != null) return;
        if (longPressCandidatePointerId == null || e.pointerId !== longPressCandidatePointerId) return;
        if (!longPressCandidateStartCanvas) return;

        const curr = clientToCanvas(e.clientX, e.clientY);
        const dist = Math.hypot(curr.x - longPressCandidateStartCanvas.x, curr.y - longPressCandidateStartCanvas.y);
        if (dist > LONG_PRESS_MOVE_THRESHOLD_PX) cancelLongPressCandidate();
      };

      const onPointerEndPan = (e: PointerEvent) => {
        if (freehandPointerId != null) return;
        if (panCandidatePointerId == null || e.pointerId !== panCandidatePointerId) return;

        const contentPoint = panCandidateContentPoint;
        const wasPanning = panActive;
        cancelPanCandidate();

        // Preserve original "tap empty" behavior when user doesn't actually drag.
        if (!wasPanning && contentPoint) onTapCanvasRef.current?.(contentPoint);
      };

      canvasEl!.addEventListener('pointermove', onPointerMovePan);
      canvasEl!.addEventListener('pointermove', onPointerMoveLongPress);
      canvasEl!.addEventListener('pointerup', onPointerEndPan);
      canvasEl!.addEventListener('pointercancel', onPointerEndPan);
      const onPointerEndLongPress = (e: PointerEvent) => {
        const isCandidateEnd = longPressCandidatePointerId != null && e.pointerId === longPressCandidatePointerId;
        const isSuppressed = suppressNextPointerUpForId != null && e.pointerId === suppressNextPointerUpForId;
        if (!isCandidateEnd && !isSuppressed) return;

        // Prevent long-press from producing a "click" that selects UI text.
        e.preventDefault();
        e.stopPropagation();

        if (isSuppressed) {
          suppressNextPointerUpForId = null;
          return;
        }

        const contentPoint = longPressCandidateContentPoint;
        cancelLongPressCandidate();
        if (!contentPoint) return;

        // Short tap: only "tap empty" behavior.
        const threadIndex = getRenderedThreadAtPoint(contentPoint.x, contentPoint.y);
        if (threadIndex == null) onTapCanvasRef.current?.(contentPoint);
      };
      canvasEl!.addEventListener('pointerup', onPointerEndLongPress);
      canvasEl!.addEventListener('pointercancel', onPointerEndLongPress);

      const onCanvasPointerDownCapture = (e: PointerEvent) => {
        pointersOnCanvas.add(e.pointerId);
        if (pointersOnCanvas.size > 1) {
          // Multi-touch should be zoom/pan only; cancel any drawing/edit gestures.
          cancelLongPressCandidate();
          cancelPanCandidate();
          cancelFreehand();
          cancelEraser();
        }
      };
      const onCanvasPointerUpCapture = (e: PointerEvent) => {
        pointersOnCanvas.delete(e.pointerId);
      };
      canvasEl!.addEventListener('pointerdown', onCanvasPointerDownCapture, { capture: true });
      canvasEl!.addEventListener('pointerup', onCanvasPointerUpCapture, { capture: true });
      canvasEl!.addEventListener('pointercancel', onCanvasPointerUpCapture, { capture: true });

      const onPointerMoveFreehand = (e: PointerEvent) => {
        if (freehandPointerId == null || e.pointerId !== freehandPointerId) return;
        if (isPinching) return;
        const c = clientToCanvas(e.clientX, e.clientY);
        const contentPt = loom.getContentCoords(c.x, c.y);
        const last = freehandPoints[freehandPoints.length - 1];
        const dx = contentPt.x - last.x;
        const dy = contentPt.y - last.y;
        const z = Math.max(0.0001, loom.getZoomScale());
        const minStep = 2 / z;
        if (dx * dx + dy * dy < minStep * minStep) return;
        freehandPoints.push(contentPt);
        wrap?.setFreehandDraft(freehandPoints);
        e.preventDefault();
      };

      const onPointerMoveEraser = (e: PointerEvent) => {
        if (eraserPointerId == null || e.pointerId !== eraserPointerId) return;
        if (isPinching) return;
        syncEraserBrushOverlay({ clientX: e.clientX, clientY: e.clientY, active: true });
        if (eraseWithCircleAtClient(e.clientX, e.clientY)) e.preventDefault();
      };

      const onPointerEndFreehand = (e: PointerEvent) => {
        if (freehandPointerId == null || e.pointerId !== freehandPointerId) return;
        try {
          canvasEl!.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        freehandPointerId = null;
        const pts = freehandPoints;
        freehandPoints = [];
        wrap?.setFreehandDraft(null);
        if (pts.length >= 2) {
          wrap?.commitFreehandStroke(pts);
        } else if (pts.length === 1) {
          onTapCanvasRef.current?.(pts[0]);
        }
      };

      const onPointerEndEraser = (e: PointerEvent) => {
        if (eraserPointerId == null || e.pointerId !== eraserPointerId) return;
        try {
          canvasEl!.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        syncEraserBrushOverlay({ clientX: 0, clientY: 0, active: false });
        wrap?.endEraserGesture();
        eraserPointerId = null;
      };

      canvasEl!.addEventListener('pointermove', onPointerMoveFreehand);
      canvasEl!.addEventListener('pointerup', onPointerEndFreehand);
      canvasEl!.addEventListener('pointercancel', onPointerEndFreehand);
      canvasEl!.addEventListener('pointermove', onPointerMoveEraser);
      canvasEl!.addEventListener('pointerup', onPointerEndEraser);
      canvasEl!.addEventListener('pointercancel', onPointerEndEraser);

      /**
       * After a long-press opens the edit UI, capture is released before pointerup; the user may
       * lift on a panel above the canvas. That pointerup never hits the canvas, so
       * pointersOnCanvas / suppressNextPointerUpForId / in-progress gestures could stick and
       * block the next draw or long-press (e.g. pointersOnCanvas.size > 1).
       */
      const onDocumentPointerEndCapture = (e: PointerEvent) => {
        const pid = e.pointerId;
        pointersOnCanvas.delete(pid);

        const rawTarget = e.target;
        const endedOnCanvas =
          !!canvasEl &&
          rawTarget != null &&
          typeof Node !== 'undefined' &&
          rawTarget instanceof Node &&
          canvasEl.contains(rawTarget);
        wrap?.onGlobalPointerEnd(pid, endedOnCanvas);

        if (suppressNextPointerUpForId === pid) {
          suppressNextPointerUpForId = null;
          e.preventDefault();
          return;
        }

        if (freehandPointerId === pid) {
          try {
            canvasEl!.releasePointerCapture(pid);
          } catch {
            // ignore
          }
          freehandPointerId = null;
          const pts = freehandPoints;
          freehandPoints = [];
          wrap?.setFreehandDraft(null);
          if (pts.length >= 2) wrap?.commitFreehandStroke(pts);
          else if (pts.length === 1) onTapCanvasRef.current?.(pts[0]);
          return;
        }

        if (eraserPointerId === pid) {
          try {
            canvasEl!.releasePointerCapture(pid);
          } catch {
            // ignore
          }
          syncEraserBrushOverlay({ clientX: 0, clientY: 0, active: false });
          wrap?.endEraserGesture();
          eraserPointerId = null;
          return;
        }

        if (panCandidatePointerId === pid) {
          if (freehandPointerId != null) return;
          const contentPoint = panCandidateContentPoint;
          const wasPanning = panActive;
          cancelPanCandidate();
          if (!wasPanning && contentPoint) onTapCanvasRef.current?.(contentPoint);
          return;
        }

        if (longPressCandidatePointerId === pid) {
          const timerPending = longPressTimer != null;
          const contentPoint = longPressCandidateContentPoint;
          cancelLongPressCandidate();
          if (timerPending && contentPoint) {
            const threadIndex = getRenderedThreadAtPoint(contentPoint.x, contentPoint.y);
            if (threadIndex == null) onTapCanvasRef.current?.(contentPoint);
          }
        }
      };

      document.addEventListener('pointerup', onDocumentPointerEndCapture, true);
      document.addEventListener('pointercancel', onDocumentPointerEndCapture, true);
      removeDocumentPointerGestureFlush = () => {
        document.removeEventListener('pointerup', onDocumentPointerEndCapture, true);
        document.removeEventListener('pointercancel', onDocumentPointerEndCapture, true);
      };

      removePanListeners = () => {
        canvasEl!.removeEventListener('pointerdown', onCanvasPointerDownCapture, { capture: true });
        canvasEl!.removeEventListener('pointerup', onCanvasPointerUpCapture, { capture: true });
        canvasEl!.removeEventListener('pointercancel', onCanvasPointerUpCapture, { capture: true });
        canvasEl!.removeEventListener('pointermove', onPointerMoveFreehand);
        canvasEl!.removeEventListener('pointerup', onPointerEndFreehand);
        canvasEl!.removeEventListener('pointercancel', onPointerEndFreehand);
        canvasEl!.removeEventListener('pointermove', onPointerMoveEraser);
        canvasEl!.removeEventListener('pointerup', onPointerEndEraser);
        canvasEl!.removeEventListener('pointercancel', onPointerEndEraser);
        canvasEl!.removeEventListener('pointermove', onPointerMovePan);
        canvasEl!.removeEventListener('pointermove', onPointerMoveLongPress);
        canvasEl!.removeEventListener('pointerup', onPointerEndPan);
        canvasEl!.removeEventListener('pointercancel', onPointerEndPan);
        canvasEl!.removeEventListener('pointerup', onPointerEndLongPress);
        canvasEl!.removeEventListener('pointercancel', onPointerEndLongPress);
      };

      rope = new RopeRenderer(loom.app, loom.getContentContainer());
      wrap = new WrapController(canvasEl!, anchors, {
        lineWidth: preset.lineWidth,
        contentTransform: (x, y) => loom.getContentCoords(x, y),
        onPointerDownNoSnap: (pt, e) => {
          if (isPinching) return;
          if (pointersOnCanvas.size > 1) return;

          if (!readOnly && materialEnabledRef.current) {
            if (freehandEraserEnabledRef.current) {
              if (e.pointerType === 'mouse' && e.button !== 0) return;
              cancelLongPressCandidate();
              cancelPanCandidate();
              cancelFreehand();
              cancelEraser();
              wrap!.beginEraserGesture();
              eraserPointerId = e.pointerId;
              canvasEl!.setPointerCapture(e.pointerId);
              syncEraserBrushOverlay({ clientX: e.clientX, clientY: e.clientY, active: true });
              if (eraseWithCircleAtClient(e.clientX, e.clientY)) e.preventDefault();
              return;
            }
            const threadHit = getRenderedThreadAtPoint(pt.x, pt.y, { allowLooseHit: false });
            // Start freehand only on empty space (strict hit). Loose hits still go to long-press edit.
            if (threadHit == null) {
              if (e.pointerType === 'mouse' && e.button !== 0) return;
              cancelLongPressCandidate();
              cancelPanCandidate();
              cancelFreehand();
              freehandPointerId = e.pointerId;
              freehandPoints = [{ x: pt.x, y: pt.y }];
              wrap!.setFreehandDraft(freehandPoints);
              canvasEl!.setPointerCapture(e.pointerId);
              return;
            }
          }

          if (isOutsideLoom(pt)) {
            panCandidatePointerId = e.pointerId;
            panCandidateStartCanvas = clientToCanvas(e.clientX, e.clientY);
            panCandidateContentPoint = pt;
            panLastCanvas = panCandidateStartCanvas;
            panActive = false;
            return;
          }

          const startLongPressOnThread = () => {
            cancelLongPressCandidate();
            e.preventDefault();
            e.stopPropagation();
            longPressCandidatePointerId = e.pointerId;
            longPressCandidateStartCanvas = clientToCanvas(e.clientX, e.clientY);
            longPressCandidateContentPoint = pt;
            disableBodyTextSelection();
            canvasEl!.setPointerCapture(e.pointerId);

            const pointerId0 = e.pointerId;
            const pt0 = pt;
            longPressTimer = window.setTimeout(() => {
              if (pointerId0 !== longPressCandidatePointerId) return;
              const threadIndex = getRenderedThreadAtPoint(pt0.x, pt0.y);
              if (threadIndex != null) {
                suppressNextPointerUpForId = pointerId0;
                onLongPressThreadRef.current?.(pt0, threadIndex);
              }
              cancelLongPressCandidate();
            }, LONG_PRESS_MS);
          };

          // readOnly：空白处仍平移；压在线上时长按可与 Create 页一样触发高亮（由父组件传 selectedThreadIndex）
          if (readOnly) {
            const hit = getRenderedThreadAtPoint(pt.x, pt.y);
            if (hit == null) {
              panCandidatePointerId = e.pointerId;
              panCandidateStartCanvas = clientToCanvas(e.clientX, e.clientY);
              panCandidateContentPoint = pt;
              panLastCanvas = panCandidateStartCanvas;
              panActive = false;
            } else {
              startLongPressOnThread();
            }
            return;
          }

          startLongPressOnThread();
        },
        onWrapStart: () => onWrapStartRef.current?.(),
        onCommittedThreadsChange: () => {
          // Panel edits (layer order, materials, etc.) don’t hit the canvas pointer handlers;
          // if we’re idle the ticker is stopped and ropes never repaint.
          wakeFromIdle();
          if (activePointersRef.current.size === 0) scheduleIdle();
          onCommittedThreadsChangeRef.current?.();
        },
        getZoomScale: () => loom.getZoomScale(),
        useCommitStiffnessFromModule: true,
        readOnly,
        wrapEnabled: materialEnabledRef.current,
      });
      sag = new ThreadSagManager({
        nodesPerSegment: 4,
        gravityY: 0.55,
        maxPhysicsVertices: 56,
      });
      wrapRef.current = wrap;
      sagRef.current = sag;
      isOutsideLoomImpl = (p) => wrap!.isOutsideLoomContent(p);

      let pinchScale0 = 1;
      let pinchDist0 = 0;
      /** 双指中点上一帧的 canvas 坐标；用于在缩放不变时仍能平移视图（zoomAt 同比例下不改变 pan）。 */
      let lastPinchCenterCanvas: { x: number; y: number } | null = null;
      const touchDistance = (a: Touch, b: Touch) =>
        Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      // 让 pinch 缩放更“灵敏”：指数 > 1 会放大比值的变化量
      const PINCH_SENSITIVITY_EXP = 1.15;
      const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length === 2) {
          isPinching = true;
          cancelPanCandidate();
          cancelLongPressCandidate();
          cancelFreehand();
          cancelEraser();
          pinchDist0 = touchDistance(e.touches[0], e.touches[1]);
          pinchScale0 = loom.getZoomScale();
          lastPinchCenterCanvas = null;
        }
      };
      const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          const center = clientToCanvas(
            (e.touches[0].clientX + e.touches[1].clientX) / 2,
            (e.touches[0].clientY + e.touches[1].clientY) / 2
          );
          if (lastPinchCenterCanvas != null) {
            loom.panBy(center.x - lastPinchCenterCanvas.x, center.y - lastPinchCenterCanvas.y);
          }
          const dist = touchDistance(e.touches[0], e.touches[1]);
          // Only allow zooming out back to original size (scale=1), not smaller.
          const ratio = pinchDist0 > 0 ? dist / pinchDist0 : 1;
          const s = Math.max(1, Math.min(3, pinchScale0 * Math.pow(ratio, PINCH_SENSITIVITY_EXP)));
          loom.zoomAt(center.x, center.y, s);
          lastPinchCenterCanvas = center;
        }
      };
      const onTouchEnd = (e: TouchEvent) => {
        if (e.touches.length === 2) {
          pinchDist0 = touchDistance(e.touches[0], e.touches[1]);
          pinchScale0 = loom.getZoomScale();
          lastPinchCenterCanvas = null;
        } else {
          // Pinch gesture ended (or was cancelled).
          isPinching = false;
          lastPinchCenterCanvas = null;
          cancelPanCandidate();
          cancelLongPressCandidate();
        }
      };
      canvasEl!.addEventListener('touchstart', onTouchStart, { passive: true });
      canvasEl!.addEventListener('touchmove', onTouchMove, { passive: false });
      canvasEl!.addEventListener('touchend', onTouchEnd, { passive: true });
      canvasEl!.addEventListener('touchcancel', onTouchEnd, { passive: true });

      // Trackpad / Ctrl+wheel zoom (desktop), anchor at cursor
      // 数值越大越灵敏（稍微提高）
      const ZOOM_SENSITIVITY = 0.003;
      const onWheel = (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const { x: canvasX, y: canvasY } = clientToCanvas(e.clientX, e.clientY);
          const delta = -e.deltaY * ZOOM_SENSITIVITY;
          const s = Math.max(1, Math.min(3, loom.getZoomScale() * (1 + delta)));
          loom.zoomAt(canvasX, canvasY, s);
        }
      };
      canvasEl!.addEventListener('wheel', onWheel, { passive: false });

      removePinchListeners = () => {
        canvasEl!.removeEventListener('touchstart', onTouchStart);
        canvasEl!.removeEventListener('touchmove', onTouchMove);
        canvasEl!.removeEventListener('touchend', onTouchEnd);
        canvasEl!.removeEventListener('touchcancel', onTouchEnd);
        canvasEl!.removeEventListener('wheel', onWheel);
      };

      loom.app.ticker.add((ticker) => {
        if (pausedRef.current) return;
        if (isIdleRef.current) return;

        const tid = textureIdRef.current;
        const mat = MATERIAL_TEXTURE_PRESETS[tid];
        const tint = colorRef.current != null ? hexToTint(colorRef.current) : mat.color;
        const gradientTint =
          gradientColorRef.current != null ? hexToTint(gradientColorRef.current) : undefined;
        const lw = mat.lineWidth * thicknessToScale(thicknessRef.current);
        const opacity01 = Math.max(0.1, Math.min(1, opacityRef.current / 100));
        const stiffness = commitStiffness.current;
        wrap!.setCurrentMaterial(tid, lw, tint, opacity01, stiffness, gradientTint);
        wrap!.setBlankCanvasThinPen(blankCanvasThinPenRef.current);
        wrap!.syncRimMetricsFromAnchors();

        const threads = wrap!.getRenderThreads();
        const committed = threads.filter((t) => !t.isActive);
        const committedCount = committed.length;

        // Adaptive quality in heavy scenes:
        // - reduce update cadence to cut CPU/memory churn
        // - disable expensive post-filters when thread count is high
        // This keeps drawing/localStorage behavior intact while improving runtime stability.
        frameTickRef.current += 1;
        const heavyFrameInterval = committedCount >= 80 ? 3 : committedCount >= 45 ? 2 : 1;
        const shouldRunHeavyPass = frameTickRef.current % heavyFrameInterval === 0;
        const enablePostFilters = !readOnly && committedCount < 60;

        // Steel softness is editable:
        // Let steel also participate in sag simulation so changing stiffness
        // (from the Materials "softness" slider) affects its curvature.
        const sagCommitted: typeof committed = [];
        const sagTextureIds: MaterialTextureId[] = [];
        const committedToSagIndex: number[] = [];
        for (let i = 0; i < committed.length; i++) {
          const ct = committed[i];
          if (ct.skipSag) {
            committedToSagIndex[i] = -1;
            continue;
          }
          const ctid = (ct.textureId ?? 'none') as MaterialTextureId;
          committedToSagIndex[i] = sagCommitted.length;
          sagCommitted.push(ct);
          sagTextureIds.push(ctid);
        }

        if (shouldRunHeavyPass) {
          const sagStiffnesses = sagCommitted.map(
            (t) => t.stiffness ?? MATERIAL_TEXTURE_PRESETS[(t.textureId ?? 'none') as MaterialTextureId].stiffness
          );
          // Round to 4 decimals to avoid floating-point drift triggering setPaths every frame
          const stiffnessesStr = JSON.stringify(sagStiffnesses.map((s) => Math.round(s * 10000) / 10000));
          if (
            sagCommitted.length !== sag!.getRopeCount() ||
            lastSagStiffnessesRef.current !== stiffnessesStr
          ) {
            sag!.setPaths(
              sagCommitted.map((t) => t.points),
              sagTextureIds,
              sagStiffnesses
            );
            lastSagStiffnessesRef.current = stiffnessesStr;
          }
        }
        if (shouldRunHeavyPass) {
          const rawDelta = ticker.deltaMS * heavyFrameInterval;
          const cappedDelta = Math.min(rawDelta, 50);
          sag!.step(cappedDelta);
        }

        for (let i = 0; i < committed.length; i++) {
          const si = committedToSagIndex[i];
          if (si < 0) continue;
          const pts = sag!.getSaggedPoints(si);
          if (pts) threads[i].points = pts;
        }

        const sel = selectedThreadIndexRef.current ?? undefined;
        if (shouldRunHeavyPass) {
          const threadsForRope = threads;
          const cw = containerRef.current?.clientWidth ?? 720;
          rope!.update(
            threadsForRope,
            sel,
            loom.getZoomScale(),
            cw,
            enablePostFilters
          );
        }
      });
    })();

    return () => {
      running = false;
      canvasElementRef.current = null;
      loomRef.current = null;
      wrapRef.current = null;
      sagRef.current = null;
      if (removePinchListeners) removePinchListeners();
      if (removePanListeners) removePanListeners();
      if (removeDocumentPointerGestureFlush) removeDocumentPointerGestureFlush();
      if (canvasEl) {
        canvasEl.removeEventListener('contextmenu', onContextMenu!);
        canvasEl.removeEventListener('pointerdown', onPointerDown);
        canvasEl.removeEventListener('touchstart', onTouchStartIdle);
        canvasEl.removeEventListener('wheel', onWake);
      }
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('touchstart', onTouchStartIdle);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointerleave', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      document.removeEventListener('touchend', onTouchEndIdle);
      document.removeEventListener('touchcancel', onTouchEndIdle);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      if (canvasEl && onDblClick) canvasEl.removeEventListener('dblclick', onDblClick);
      sag?.destroy();
      wrap?.destroy();
      rope?.destroy();
      loom.destroy();
    };
  }, []);

  useEffect(() => {
    loomRef.current?.setCanvasBackground(canvasBackground);
  }, [canvasBackground]);

  useEffect(() => {
    const canvas = canvasElementRef.current;
    if (!canvas) return;
    canvas.style.cursor = freehandEraserEnabled ? 'crosshair' : '';
  }, [freehandEraserEnabled]);

  useEffect(() => {
    wrapRef.current?.setWrapEnabled(materialEnabled);
  }, [materialEnabled]);

  useEffect(() => {
    const loom = loomRef.current;
    if (!loom) return;
    if (paused || isIdleRef.current) {
      loom.app.ticker.stop();
    } else {
      loom.app.ticker.start();
    }
  }, [paused]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <div
        ref={eraserBrushRef}
        aria-hidden
        style={{
          position: 'absolute',
          display: 'none',
          pointerEvents: 'none',
          borderRadius: '50%',
          boxSizing: 'border-box',
          boxShadow: '1px 2px 10px 8px rgba(0, 0, 0, 0.1)',
          border: '1px solid rgba(0, 0, 0, 0.12)',
          background: 'rgba(255, 255, 255, 0.12)',
          zIndex: 2,
        }}
      />
    </div>
  );
});

export const LoomCanvas = memo(LoomCanvasInner);
