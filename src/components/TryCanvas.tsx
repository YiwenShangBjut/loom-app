import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Application, Container } from 'pixi.js';
import { RopeRenderer } from '../canvas/RopeRenderer';
import type { Point, RenderThread } from '../physics/types';
import type { MaterialTextureId } from '../rendering/materialTextures';
import { MATERIAL_TEXTURE_PRESETS } from '../rendering/materialTextures';

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function hexToTint(hex: string): number {
  const s = hex.replace(/^#/, '');
  if (s.length !== 6) return 0xd8d4cc;
  return parseInt(s, 16);
}

function thicknessToScale(v: number): number {
  const n = clamp(v / 100, 0, 1);
  return 0.5 + n * 1.5;
}


function toRenderThread(
  points: Point[],
  textureId: MaterialTextureId,
  lineWidth: number,
  color: number,
  stiffness: number,
): RenderThread {
  return {
    points: [...points],
    isActive: false,
    underCrossings: [],
    bridges: [],
    textureId,
    lineWidth,
    color,
    stiffness,
  };
}

function cloneRenderThreadForHistory(t: RenderThread): RenderThread {
  return {
    ...t,
    points: t.points.map((p) => ({ x: p.x, y: p.y })),
    underCrossings: [...t.underCrossings],
    bridges: [...t.bridges],
  };
}

export type TryCanvasHandle = {
  undo: () => void;
  redo: () => void;
};

/** 第一条线动画结束时传给父组件的数据，用于保存为笔刷 */
export interface FirstCreationData {
  points: Point[];
  textureId: MaterialTextureId;
  strokeStyle: string;
  lineWidth: number;
  thickness: number;
}

/** 编辑弹框打开时，用这些值覆盖画布上第一条线的显示 */
export interface EditOverrides {
  textureId: MaterialTextureId;
  strokeStyle: string;
  thickness: number;
  opacity: number;
  softness: number;
}

export interface TryCanvasProps {
  enabled: boolean;
  panOnly?: boolean;
  editOverrides?: EditOverrides;
  textureId: MaterialTextureId;
  strokeStyle: string;
  thickness: number;
  opacity01: number;
  softness01: number;
  onFirstCreationComplete?: (data: FirstCreationData) => void;
  onStrokeSettled?: (data: FirstCreationData, isFirst: boolean) => void;
  clearTrigger?: number;
  selectedCommittedIndex?: number | null;
}

const TryCanvasInner = forwardRef<TryCanvasHandle, TryCanvasProps>(function TryCanvasInner(props, ref) {
  const {
    enabled,
    panOnly = false,
    editOverrides,
    textureId,
    strokeStyle,
    thickness,
    softness01,
    onFirstCreationComplete,
    onStrokeSettled,
    clearTrigger = 0,
    selectedCommittedIndex = null,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const ropeRef = useRef<RopeRenderer | null>(null);
  const contentRef = useRef<Container | null>(null);
  const panStateRef = useRef<{
    startClientX: number;
    startClientY: number;
    startContentX: number;
    startContentY: number;
    pointerId: number;
  } | null>(null);
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  /** panOnly 下用于区分触摸：松掉一指后不再用剩余单指恢复平移。 */
  const touchPointerIdsRef = useRef<Set<number>>(new Set());
  const pinchStateRef = useRef<{
    startDistance: number;
    startScale: number;
    worldCenterX: number;
    worldCenterY: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const settleCallbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const softness01Ref = useRef(softness01);
  const editOverridesRef = useRef(editOverrides);
  const selectedCommittedIndexRef = useRef(selectedCommittedIndex);

  const currentPointsRef = useRef<Point[]>([]);
  const strokesRef = useRef<RenderThread[]>([]);
  const redoStrokesRef = useRef<RenderThread[]>([]);
  const isDrawingRef = useRef(false);

  const lineWidth = MATERIAL_TEXTURE_PRESETS[textureId]?.lineWidth ?? 3;
  const scale = thicknessToScale(thickness);
  const resolvedLineWidth = lineWidth * scale;
  const tint = hexToTint(strokeStyle);

  /** softness01: 0 = stiff, 1 = soft -> stiffness01 = 1 - softness01 */
  function softness01ToStiffness01(s01: number): number {
    const s = Math.max(0, Math.min(1, s01));
    return 1 - s;
  }

  const drawFrame = useCallback(() => {
    const rope = ropeRef.current;
    if (!rope) return;
    const softnessClamped01 = Math.max(0, Math.min(1, softness01));
    const stiffnessForRender = softness01ToStiffness01(softnessClamped01);

    // Keep committed stroke stiffness unchanged; softness slider should only affect new/current stroke.
    // IMPORTANT: clone committed strokes so draft path rendering never mutates strokesRef.current.
    let threads: RenderThread[] = [...strokesRef.current];

    // 编辑弹框打开时，用 editOverrides 覆盖第一条线的材质显示（从 ref 读取，避免 drawFrame 因父组件重渲染而重建）
    const ov = editOverridesRef.current;
    if (ov && threads.length > 0) {
      const overrideLineWidth =
        (MATERIAL_TEXTURE_PRESETS[ov.textureId]?.lineWidth ?? 3) *
        (0.5 + Math.max(0, Math.min(1, ov.thickness / 100)) * 1.5);
      threads[0] = {
        ...threads[0],
        textureId: ov.textureId,
        lineWidth: overrideLineWidth,
        color: hexToTint(ov.strokeStyle),
        opacity: Math.max(0.1, Math.min(1, ov.opacity / 100)),
        stiffness: 1 - Math.max(0, Math.min(1, ov.softness / 100)),
      };
    }

    const draftPoints = currentPointsRef.current;
    if (draftPoints.length >= 2) {
      threads.push(
        toRenderThread(draftPoints, textureId, resolvedLineWidth, tint, stiffnessForRender)
      );
    }
    const cw = containerRef.current?.clientWidth ?? 720;
    rope.update(threads, selectedCommittedIndexRef.current ?? undefined, 1, cw);
  }, [textureId, resolvedLineWidth, tint, softness01]);

  const scheduleRedraw = useCallback(() => {
    if (drawRafRef.current != null) return;
    drawRafRef.current = requestAnimationFrame(() => {
      drawRafRef.current = null;
      drawFrame();
    });
  }, [drawFrame]);

  const scheduleRedrawRef = useRef(scheduleRedraw);
  scheduleRedrawRef.current = scheduleRedraw;

  useImperativeHandle(ref, () => ({
    undo: () => {
      if (strokesRef.current.length === 0) return;
      const last = strokesRef.current.pop()!;
      redoStrokesRef.current.push(cloneRenderThreadForHistory(last));
      scheduleRedrawRef.current();
    },
    redo: () => {
      if (redoStrokesRef.current.length === 0) return;
      const t = redoStrokesRef.current.pop()!;
      strokesRef.current.push(cloneRenderThreadForHistory(t));
      scheduleRedrawRef.current();
    },
  }), []);

  useEffect(() => {
    scheduleRedraw();
  }, [scheduleRedraw]);

  useEffect(() => {
    softness01Ref.current = softness01;
  }, [softness01]);

  useEffect(() => {
    editOverridesRef.current = editOverrides;
    selectedCommittedIndexRef.current = selectedCommittedIndex;
    scheduleRedraw();
  }, [editOverrides, selectedCommittedIndex, scheduleRedraw]);

  useEffect(() => {
    if (clearTrigger === 0) return;
    if (settleCallbackTimeoutRef.current) {
      clearTimeout(settleCallbackTimeoutRef.current);
      settleCallbackTimeoutRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    strokesRef.current = [];
    redoStrokesRef.current = [];
    currentPointsRef.current = [];
    const rope = ropeRef.current;
    if (rope) rope.update([], selectedCommittedIndexRef.current ?? undefined);
    const content = contentRef.current;
    if (content) {
      content.x = 0;
      content.y = 0;
      content.scale.set(1, 1);
    }
    activePointersRef.current.clear();
    touchPointerIdsRef.current.clear();
    pinchStateRef.current = null;
    panStateRef.current = null;
    scheduleRedraw();
  }, [clearTrigger, selectedCommittedIndex, scheduleRedraw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    mountedRef.current = true;
    let app: Application | null = null;
    let rope: RopeRenderer | null = null;

    (async () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      app = new Application();
      await app.init({
        width: w,
        height: h,
        background: 0xffffff,
        antialias: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        autoDensity: true,
      });
      if (!mountedRef.current || !app) return;

      const content = new Container();
      app.stage.addChild(content);
      contentRef.current = content;
      rope = new RopeRenderer(app, content);
      container.appendChild(app.canvas as HTMLCanvasElement);
      appRef.current = app;
      ropeRef.current = rope;

      const ro = new ResizeObserver(() => {
        if (!mountedRef.current || !app || !container) return;
        try {
          const cw = container.clientWidth || 1;
          const ch = container.clientHeight || 1;
          if (typeof app.renderer.resize === 'function') {
            app.renderer.resize(cw, ch, 1);
          }
        } catch {
          // ignore after unmount/destroy
        }
      });
      ro.observe(container);

      rope.update(strokesRef.current, selectedCommittedIndexRef.current ?? undefined, 1, container.clientWidth || 720);

      return () => {
        ro.disconnect();
      };
    })();

    return () => {
      mountedRef.current = false;
      if (settleCallbackTimeoutRef.current) {
        clearTimeout(settleCallbackTimeoutRef.current);
        settleCallbackTimeoutRef.current = null;
      }
      if (drawRafRef.current) {
        cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      ropeRef.current = null;
      contentRef.current = null;
      rope?.destroy();
      const canvasEl = app?.canvas ?? null;
      app?.destroy();
      appRef.current = null;
      if (container && canvasEl) {
        try {
          container.removeChild(canvasEl as HTMLCanvasElement);
        } catch {
          // ignore
        }
      }
    };
  }, [enabled]);

  function toLocalPoint(e: React.PointerEvent): Point {
    const container = containerRef.current;
    if (!container) return { x: 0, y: 0 };
    const r = container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function commitStrokeWithoutSag(base: Point[]) {
    if (base.length < 2) {
      if (base.length === 1) {
        const stiffness = softness01ToStiffness01(Math.max(0, Math.min(1, softness01)));
        redoStrokesRef.current = [];
        strokesRef.current.push(
          toRenderThread(base, textureId, resolvedLineWidth, tint, stiffness)
        );
        scheduleRedraw();
      }
      return;
    }

    const softnessClamped01 = Math.max(0, Math.min(1, softness01));
    const stiffness = softness01ToStiffness01(softnessClamped01);
    const thread = toRenderThread(base, textureId, resolvedLineWidth, tint, stiffness);
    const s01 = Math.max(0, Math.min(1, softness01Ref.current));
    thread.stiffness = softness01ToStiffness01(s01);
    redoStrokesRef.current = [];
    const wasFirstCreation = strokesRef.current.length === 0;
    strokesRef.current.push(thread);
    scheduleRedraw();
    const data: FirstCreationData = {
      points: [...thread.points],
      textureId,
      strokeStyle,
      lineWidth: resolvedLineWidth,
      thickness,
    };
    const PROMPT_DELAY_MS = 900;
    settleCallbackTimeoutRef.current = setTimeout(() => {
      settleCallbackTimeoutRef.current = null;
      if (onStrokeSettled) {
        onStrokeSettled(data, wasFirstCreation);
      } else if (wasFirstCreation && onFirstCreationComplete) {
        onFirstCreationComplete(data);
      }
    }, PROMPT_DELAY_MS);
  }

  return (
    <div
      ref={containerRef}
      className={`try-canvas ${panOnly ? 'try-canvas-pan' : ''}`}
      onPointerDown={(e) => {
        if (!enabled || !ropeRef.current) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (panOnly) {
          const content = contentRef.current;
          if (!content) return;
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          if (e.pointerType === 'touch') {
            touchPointerIdsRef.current.add(e.pointerId);
          }
          activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const pointers = Array.from(activePointersRef.current.values());
          if (pointers.length >= 2) {
            const p0 = pointers[0];
            const p1 = pointers[1];
            const startDistance = Math.max(1, distance(p0, p1));
            const centerClientX = (p0.x + p1.x) / 2;
            const centerClientY = (p0.y + p1.y) / 2;
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const centerLocalX = centerClientX - rect.left;
            const centerLocalY = centerClientY - rect.top;
            const startScale = content.scale.x || 1;
            pinchStateRef.current = {
              startDistance,
              startScale,
              worldCenterX: (centerLocalX - content.x) / startScale,
              worldCenterY: (centerLocalY - content.y) / startScale,
            };
            panStateRef.current = null;
          } else if (e.pointerType !== 'touch') {
            panStateRef.current = {
              startClientX: e.clientX,
              startClientY: e.clientY,
              startContentX: content.x,
              startContentY: content.y,
              pointerId: e.pointerId,
            };
          } else {
            panStateRef.current = null;
          }
          return;
        }
        isDrawingRef.current = true;
        redoStrokesRef.current = [];
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        const p = toLocalPoint(e);
        currentPointsRef.current = [p];
        scheduleRedraw();
      }}
      onPointerMove={(e) => {
        if (!enabled) return;
        if (panOnly) {
          const content = contentRef.current;
          if (!content) return;
          if (activePointersRef.current.has(e.pointerId)) {
            activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          }
          const pointers = Array.from(activePointersRef.current.values());
          if (pointers.length >= 2) {
            if (!pinchStateRef.current) {
              const p0 = pointers[0];
              const p1 = pointers[1];
              const startDistance = Math.max(1, distance(p0, p1));
              const centerClientX = (p0.x + p1.x) / 2;
              const centerClientY = (p0.y + p1.y) / 2;
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              const centerLocalX = centerClientX - rect.left;
              const centerLocalY = centerClientY - rect.top;
              const startScale = content.scale.x || 1;
              pinchStateRef.current = {
                startDistance,
                startScale,
                worldCenterX: (centerLocalX - content.x) / startScale,
                worldCenterY: (centerLocalY - content.y) / startScale,
              };
            }
            const pinch = pinchStateRef.current;
            if (!pinch) return;
            const p0 = pointers[0];
            const p1 = pointers[1];
            const currentDistance = Math.max(1, distance(p0, p1));
            const centerClientX = (p0.x + p1.x) / 2;
            const centerClientY = (p0.y + p1.y) / 2;
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const centerLocalX = centerClientX - rect.left;
            const centerLocalY = centerClientY - rect.top;
            const nextScale = clamp((pinch.startScale * currentDistance) / pinch.startDistance, 0.6, 3.5);
            content.scale.set(nextScale, nextScale);
            content.x = centerLocalX - pinch.worldCenterX * nextScale;
            content.y = centerLocalY - pinch.worldCenterY * nextScale;
            return;
          }
          pinchStateRef.current = null;
          const s = panStateRef.current;
          if (!s || s.pointerId !== e.pointerId) return;
          const dx = e.clientX - s.startClientX;
          const dy = e.clientY - s.startClientY;
          content.x = s.startContentX + dx;
          content.y = s.startContentY + dy;
          return;
        }
        if (!isDrawingRef.current) return;
        const p = toLocalPoint(e);
        const prev = currentPointsRef.current;
        const last = prev[prev.length - 1];
        const dx = p.x - last.x;
        const dy = p.y - last.y;
        if (dx * dx + dy * dy < 2) return;
        prev.push(p);
        currentPointsRef.current = prev;
        scheduleRedraw();
      }}
      onPointerUp={(e) => {
        if (!enabled) return;
        if (panOnly) {
          activePointersRef.current.delete(e.pointerId);
          if (e.pointerType === 'touch') {
            touchPointerIdsRef.current.delete(e.pointerId);
          }
          const s = panStateRef.current;
          if (s && s.pointerId === e.pointerId) {
            panStateRef.current = null;
          }
          pinchStateRef.current = null;
          const remaining = Array.from(activePointersRef.current.entries());
          const content = contentRef.current;
          if (remaining.length === 1 && content) {
            const [pointerId, p] = remaining[0];
            if (!touchPointerIdsRef.current.has(pointerId)) {
              panStateRef.current = {
                startClientX: p.x,
                startClientY: p.y,
                startContentX: content.x,
                startContentY: content.y,
                pointerId,
              };
            }
          }
          (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
          return;
        }
        isDrawingRef.current = false;
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
        const base = [...currentPointsRef.current];
        currentPointsRef.current = [];
        scheduleRedraw();
        commitStrokeWithoutSag(base);
      }}
      onPointerCancel={(e) => {
        if (panOnly) {
          activePointersRef.current.delete(e.pointerId);
          if (e.pointerType === 'touch') {
            touchPointerIdsRef.current.delete(e.pointerId);
          }
          pinchStateRef.current = null;
          const s = panStateRef.current;
          if (s && s.pointerId === e.pointerId) panStateRef.current = null;
          try {
            (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
          } catch {
            // ignore release errors
          }
          return;
        }
        isDrawingRef.current = false;
        currentPointsRef.current = [];
        scheduleRedraw();
      }}
      onWheel={(e) => {
        if (!panOnly) return;
        const content = contentRef.current;
        const container = containerRef.current;
        if (!content || !container) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const currentScale = content.scale.x || 1;
        const worldX = (px - content.x) / currentScale;
        const worldY = (py - content.y) / currentScale;
        const zoomFactor = Math.exp(-e.deltaY * 0.0015);
        const nextScale = clamp(currentScale * zoomFactor, 0.6, 3.5);
        content.scale.set(nextScale, nextScale);
        content.x = px - worldX * nextScale;
        content.y = py - worldY * nextScale;
      }}
    />
  );
});

export const TryCanvas = memo(TryCanvasInner);
