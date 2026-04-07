import { BlurFilter, Container, Mesh, RopeGeometry, Texture, type BlurFilterOptions } from 'pixi.js';
import type { Application } from 'pixi.js';
import type { RenderThread, Point } from '../physics/types';
import type { MaterialTextureId } from '../rendering/materialTextures';
import { getMaterialTexture, getMaterialTextureUScale } from '../rendering/materialTextureBitmaps';
import { DEFAULT_TINT, MATERIAL_TEXTURE_PRESETS } from '../rendering/materialTextures';
import { getWoolRopeTexture, getWoolRopeFuzzyTexture } from '../rendering/woolRopeTexture';
import { getChenillePlushTexture, getChenilleTubeTexture } from '../rendering/chenilleRopeTexture';
import { getSteelSheenTexture } from '../rendering/steelRopeTexture';
import { getFeltRopeTexture, getFeltRopeFuzzyTexture } from '../rendering/feltRopeTexture';
import { getHaloStripTexture, HALO_STRIP_CONFIG } from '../rendering/haloStripTexture';

/**
 * Global GPU resource leak detector.
 * Tracks BlurFilter and RopeGeometry create/destroy counts so you can verify
 * that the fix is working: (created - destroyed) should stay near zero once
 * the scene is steady. Read in console: window.__loomStats
 */
export const loomStats = {
  filterCreated: 0,
  filterDestroyed: 0,
  geometryCreated: 0,
  geometryDestroyed: 0,
  /** Items queued for destruction but not yet processed (2-frame delay buffer). */
  pendingCount: 0,
  /** Items in the incremental destroy queue (waiting for budget slots). */
  queueCount: 0,
  get filterLive() { return this.filterCreated - this.filterDestroyed; },
  get geometryLive() { return this.geometryCreated - this.geometryDestroyed; },
};
(window as unknown as Record<string, unknown>).__loomStats = loomStats;

/** Tracked constructor wrappers — keep counts accurate without cluttering call sites. */
const _BlurFilter = BlurFilter;
const _RopeGeometry = RopeGeometry;
function mkBlurFilter(opts?: BlurFilterOptions): BlurFilter {
  loomStats.filterCreated++;
  return new _BlurFilter(opts);
}
function mkRopeGeometry(opts: ConstructorParameters<typeof RopeGeometry>[0]): RopeGeometry {
  loomStats.geometryCreated++;
  return new _RopeGeometry(opts);
}

/** Stretch/shrink UV.u without changing rope geometry thickness. */
function scaleRopeGeometryU(geometry: RopeGeometry, uScale = 1): RopeGeometry {
  if (Math.abs(uScale - 1) < 1e-6) return geometry;
  const uvBuffer = geometry.getBuffer('aUV');
  const uvs = uvBuffer.data as Float32Array;
  for (let i = 0; i < uvs.length; i += 2) uvs[i] *= uScale;
  uvBuffer.update();
  return geometry;
}

/** Scale UV.v around center (0.5) without changing rope geometry width. */
function scaleRopeGeometryVCentered(geometry: RopeGeometry, vScale = 1): RopeGeometry {
  if (Math.abs(vScale - 1) < 1e-6) return geometry;
  const uvBuffer = geometry.getBuffer('aUV');
  const uvs = uvBuffer.data as Float32Array;
  for (let i = 1; i < uvs.length; i += 2) {
    uvs[i] = 0.5 + (uvs[i] - 0.5) * vScale;
  }
  uvBuffer.update();
  return geometry;
}

/**
 * 接地影（Drop shadow）设计稿：offset (2, 3) px、blur 8、spread 0、#000 @ 15%。
 * 等价 CSS：`box-shadow: 2px 3px 8px 0 rgba(0, 0, 0, 0.15)`。
 * 与画布缩放一致：`× zoom × (canvasW / 720)`。
 */
const GROUND_SHADOW_OFFSET_X = 2;
const GROUND_SHADOW_OFFSET_Y = 3;
const GROUND_SHADOW_BLUR_PX = 8;
const GROUND_SHADOW_ALPHA = 0.15;

function ropeCapPlane(t: RenderThread): { capStart: boolean; capEnd: boolean } {
  if (t.skipSag) return { capStart: false, capEnd: false };
  return {
    capStart: t.ropeCaps?.wrapStart !== false,
    capEnd: t.ropeCaps?.wrapEnd !== false,
  };
}

/** Add semicircle caps at path ends for rounded appearance. roundness 0 = sharp, 1 = full round. */
function addRoundedCaps(
  pts: Point[],
  lineWidth: number,
  roundness: number,
  capStart = true,
  capEnd = true,
): Point[] {
  const copy = () => pts.map((p) => ({ x: p.x, y: p.y }));
  if (pts.length < 2) return copy();
  if (roundness <= 0 || (!capStart && !capEnd)) return copy();
  const r = lineWidth * 0.6 * roundness;
  const segments = Math.max(3, Math.round(6 * roundness));
  const out: Point[] = [];

  const p0 = pts[0];
  const p1 = pts[1];
  let dx = p1.x - p0.x;
  let dy = p1.y - p0.y;
  let len = Math.hypot(dx, dy) || 1;
  const dirX = -dx / len;
  const dirY = -dy / len;
  const perpX = -dirY;
  const perpY = dirX;

  if (capStart) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = Math.PI * 0.5 * (1 - 2 * t);
      out.push({
        x: p0.x + r * (Math.cos(angle) * dirX + Math.sin(angle) * perpX),
        y: p0.y + r * (Math.cos(angle) * dirY + Math.sin(angle) * perpY),
      });
    }
  } else {
    out.push({ x: p0.x, y: p0.y });
  }

  const pn = pts[pts.length - 1];
  const pn1 = pts[pts.length - 2];
  dx = pn.x - pn1.x;
  dy = pn.y - pn1.y;
  len = Math.hypot(dx, dy) || 1;
  const dirXn = dx / len;
  const dirYn = dy / len;
  const perpXn = -dirYn;
  const perpYn = dirXn;

  if (capEnd) {
    for (let i = 1; i < pts.length - 1; i++) {
      out.push({ x: pts[i].x, y: pts[i].y });
    }
    for (let i = 1; i <= segments; i++) {
      const tt = i / segments;
      const angle = -Math.PI * 0.5 + Math.PI * tt;
      out.push({
        x: pn.x + r * (Math.cos(angle) * dirXn + Math.sin(angle) * perpXn),
        y: pn.y + r * (Math.cos(angle) * dirYn + Math.sin(angle) * perpYn),
      });
    }
  } else {
    for (let i = 1; i < pts.length; i++) {
      out.push({ x: pts[i].x, y: pts[i].y });
    }
  }

  return out;
}

/**
 * Felt ends: smaller radius (less bulge) but more segments (rounder feel).
 * We can't fully reuse `addRoundedCaps()` because its radius and segment count
 * are coupled to `roundness`, making ends either too bulgy or not round enough.
 */
function addFeltCaps(
  pts: Point[],
  lineWidth: number,
  capStart = true,
  capEnd = true,
): Point[] {
  const copy = () => pts.map((p) => ({ x: p.x, y: p.y }));
  if (pts.length < 2) return copy();
  if (!capStart && !capEnd) return copy();
  // Radius ratio tuned for subtle thickness reveal at the ends.
  const r = lineWidth * 0.10;
  const segments = 10;

  const out: Point[] = [];

  const p0 = pts[0];
  const p1 = pts[1];
  let dx = p1.x - p0.x;
  let dy = p1.y - p0.y;
  let len = Math.hypot(dx, dy) || 1;
  const dirX = -dx / len;
  const dirY = -dy / len;
  const perpX = -dirY;
  const perpY = dirX;

  if (capStart) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = Math.PI * 0.5 * (1 - 2 * t);
      out.push({
        x: p0.x + r * (Math.cos(angle) * dirX + Math.sin(angle) * perpX),
        y: p0.y + r * (Math.cos(angle) * dirY + Math.sin(angle) * perpY),
      });
    }
  } else {
    out.push({ x: p0.x, y: p0.y });
  }

  const pn = pts[pts.length - 1];
  const pn1 = pts[pts.length - 2];
  dx = pn.x - pn1.x;
  dy = pn.y - pn1.y;
  len = Math.hypot(dx, dy) || 1;
  const dirXn = dx / len;
  const dirYn = dy / len;
  const perpXn = -dirYn;
  const perpYn = dirXn;

  if (capEnd) {
    for (let i = 1; i < pts.length - 1; i++) {
      out.push({ x: pts[i].x, y: pts[i].y });
    }
    for (let i = 1; i <= segments; i++) {
      const tt = i / segments;
      const angle = -Math.PI * 0.5 + Math.PI * tt;
      out.push({
        x: pn.x + r * (Math.cos(angle) * dirXn + Math.sin(angle) * perpXn),
        y: pn.y + r * (Math.cos(angle) * dirYn + Math.sin(angle) * perpYn),
      });
    }
  } else {
    for (let i = 1; i < pts.length; i++) {
      out.push({ x: pts[i].x, y: pts[i].y });
    }
  }

  return out;
}

/** 空白处涂鸦：复制路径点，不做端点圆弧帽/毛边抖动，避免“缠绕”感。 */
function freehandStrokePoints(t: RenderThread): Point[] {
  return t.points.map((p) => ({ x: p.x, y: p.y }));
}

/** Small irregularity for wool: stable per-point offset perpendicular to path, so fibres don't look perfectly straight. */
function addWoolJitter(pts: Point[], amount: number): Point[] {
  if (pts.length < 3 || amount <= 0) return pts;
  const out: Point[] = [{ ...pts[0] }];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const perpX = -dy / len;
    const perpY = dx / len;
    const j = amount * (Math.sin(i * 0.7) * 0.6 + Math.cos(i * 0.5) * 0.4);
    out.push({ x: p.x + perpX * j, y: p.y + perpY * j });
  }
  out.push({ ...pts[pts.length - 1] });
  return out;
}

/** Slight organic thickness variation for wool (stable per-thread index). */
function woolThicknessScale(threadIndex: number): number {
  const t = Math.sin(threadIndex * 1.3) * 0.5 + 0.5;
  return 0.92 + t * 0.16;
}

/** Chenille should feel thicker and more tube-like. */
function chenilleThicknessScale(threadIndex: number): number {
  const t = Math.sin(threadIndex * 0.9) * 0.5 + 0.5;
  return 1.12 + t * 0.10;
}

function gradientSamples(pts: Point[], sampleCount: number): Point[] {
  if (pts.length < 2) return pts.map((p) => ({ x: p.x, y: p.y }));
  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segLens.push(l);
    total += l;
  }
  if (total <= 1e-6) return [pts[0], pts[pts.length - 1]].map((p) => ({ x: p.x, y: p.y }));
  const count = Math.max(2, sampleCount);
  const out: Point[] = [];
  let segIdx = 0;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const target = (i / (count - 1)) * total;
    while (segIdx < segLens.length - 1 && acc + segLens[segIdx] < target) {
      acc += segLens[segIdx];
      segIdx++;
    }
    const p0 = pts[segIdx];
    const p1 = pts[segIdx + 1];
    const seg = Math.max(1e-6, segLens[segIdx]);
    const lt = Math.max(0, Math.min(1, (target - acc) / seg));
    out.push({
      x: p0.x + (p1.x - p0.x) * lt,
      y: p0.y + (p1.y - p0.y) * lt,
    });
  }
  return out;
}

const ROPE_GRADIENT_TEX_W = 256;
const ROPE_GRADIENT_TEX_H = 32;
const ROPE_GRADIENT_TEX_CACHE_MAX = 96;
/** 沿路径渐变：1×256 纹理缓存（键为起止 tint） */
const ropeGradientTextureCache = new Map<string, Texture>();

function tintToRgb(tint: number): { r: number; g: number; b: number } {
  const n = Math.max(0, Math.min(0xffffff, tint >>> 0));
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function ropeGradientCacheKey(a: number, b: number): string {
  return `${a}-${b}`;
}

function touchRopeGradientCache(key: string, tex: Texture): void {
  ropeGradientTextureCache.delete(key);
  ropeGradientTextureCache.set(key, tex);
}

function getOrCreateRopeGradientTexture(startTint: number, endTint: number): Texture {
  const key = ropeGradientCacheKey(startTint, endTint);
  const existing = ropeGradientTextureCache.get(key);
  if (existing && !existing.destroyed) {
    touchRopeGradientCache(key, existing);
    return existing;
  }
  if (existing?.destroyed) ropeGradientTextureCache.delete(key);

  while (ropeGradientTextureCache.size >= ROPE_GRADIENT_TEX_CACHE_MAX) {
    const oldest = ropeGradientTextureCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const victim = ropeGradientTextureCache.get(oldest);
    victim?.destroy(true);
    ropeGradientTextureCache.delete(oldest);
  }

  const c0 = tintToRgb(startTint);
  const c1 = tintToRgb(endTint);
  const canvas = document.createElement('canvas');
  canvas.width = ROPE_GRADIENT_TEX_W;
  canvas.height = ROPE_GRADIENT_TEX_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return Texture.WHITE;
  }
  // Horizontal = color gradient; Vertical = soft alpha mask to preserve plush/fuzzy edges.
  const g = ctx.createLinearGradient(0, 0, ROPE_GRADIENT_TEX_W, 0);
  g.addColorStop(0, `rgb(${c0.r},${c0.g},${c0.b})`);
  g.addColorStop(1, `rgb(${c1.r},${c1.g},${c1.b})`);
  for (let y = 0; y < ROPE_GRADIENT_TEX_H; y++) {
    const v = y / Math.max(1, ROPE_GRADIENT_TEX_H - 1); // 0..1 across width direction (rope UV.v)
    // Bell-like alpha: center strongest, edges soft; tuned to keep texture edge fade visible.
    const bell = Math.pow(Math.sin(Math.PI * v), 1.15);
    const a = Math.max(0, Math.min(1, bell));
    ctx.globalAlpha = a;
    ctx.fillStyle = g;
    ctx.fillRect(0, y, ROPE_GRADIENT_TEX_W, 1);
  }
  ctx.globalAlpha = 1;

  const tex = Texture.from({ resource: canvas });
  if (tex.source?.style) {
    tex.source.style.addressMode = 'clamp-to-edge';
  }
  ropeGradientTextureCache.set(key, tex);
  return tex;
}

/** 场景销毁时释放渐变贴图缓存，避免热重载 / 多次建画布泄漏 */
export function clearRopeGradientTextureCache(): void {
  for (const tex of ropeGradientTextureCache.values()) {
    tex.destroy(true);
  }
  ropeGradientTextureCache.clear();
}

/**
 * RopeRenderer draws all loom threads each frame with material texture.
 * Add to the same container as the loom so rope and loom share the same coordinate system.
 */
export class RopeRenderer {
  private threadContainer: Container;
  private pendingDestroyBatches: Array<unknown[]> = [];
  private destroyQueue: unknown[] = [];
  // Each thread can produce ~4–6 render objects (shadow + halo + mesh + bridges).
  // With up to 80 threads the queue can grow by ~480 items/frame; use a higher
  // budget so the queue never accumulates across frames and causes memory pressure.
  private readonly destroyPerFrameBudget = 600;

  constructor(_app: Application, contentContainer: Container) {
    this.threadContainer = new Container();
    contentContainer.addChild(this.threadContainer);
  }

  /**
   * Recursively destroy filters and geometry on a display object before calling
   * destroy() on it, and keep the loomStats counters accurate.
   *
   * PixiJS 8 behaviour this must work around:
   *   1. Container.destroy({ children: true }) does NOT destroy `filters` entries.
   *      BlurFilter holds a WebGL framebuffer / off-screen render texture that
   *      only gets freed by an explicit filter.destroy() call.
   *   2. PixiJS 8 Mesh.destroy() DOES call geometry.destroy() internally, so the
   *      GPU buffers are freed.  However it uses the public `geometry` property
   *      (not `_geometry` from PixiJS 7), so our explicit call in step 2 is needed
   *      solely to increment loomStats.geometryDestroyed for leak detection.
   *      The destroy() call is idempotent — PixiJS checks the `destroyed` flag.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static destroyWithFilters(obj: any): void {
    if (!obj || obj.destroyed) return;
    // 1. Destroy filters (BlurFilter holds GPU framebuffers)
    if (Array.isArray(obj.filters)) {
      for (const f of obj.filters) {
        if (f && !f.destroyed && typeof f.destroy === 'function') {
          f.destroy();
          loomStats.filterDestroyed++;
        }
      }
      obj.filters = null;
    }
    // 2. Destroy geometry GPU buffers.
    //    PixiJS 8 Mesh exposes geometry as the public property `geometry`
    //    (not `_geometry` which was the PixiJS 7 convention). We check both
    //    so this works regardless of which PixiJS 8 build is in use.
    const geom = obj.geometry ?? obj._geometry;
    if (geom && !geom.destroyed && typeof geom.destroy === 'function') {
      geom.destroy();
      loomStats.geometryDestroyed++;
    }
    // 3. Recurse into children so nested containers get the same treatment.
    //    Snapshot the array first: calling destroyWithFilters(ch) triggers
    //    ch.destroy() → removeFromParent() which mutates obj.children in
    //    place. A for-of over the live array would skip elements as they shift.
    if (Array.isArray(obj.children) && obj.children.length > 0) {
      for (const ch of [...obj.children]) RopeRenderer.destroyWithFilters(ch);
    }
    if (typeof obj.destroy === 'function') obj.destroy({ children: true });
  }

  private destroyBatch(batch: unknown[] | undefined): void {
    if (!batch || batch.length === 0) return;
    for (const child of batch) {
      RopeRenderer.destroyWithFilters(child);
    }
  }

  // Avoid long GC/teardown spikes during drag by spreading destroy work across frames.
  private flushDestroyQueue(maxCount: number): void {
    let n = 0;
    while (n < maxCount && this.destroyQueue.length > 0) {
      const child = this.destroyQueue.shift();
      RopeRenderer.destroyWithFilters(child);
      n++;
    }
  }

  /**
   * @param selectedIndex Committed thread index to highlight (e.g. selected for editing).
   * @param zoomScale Canvas 缩放比例（1=无缩放）。
   * @param canvasWidth 画布显示宽度（px），用于按画布尺寸缩放 blur，使 Creation 详情页与 Create 页视觉一致。
   *                    不传则按 720 计算。
   */
  update(
    threads: RenderThread[],
    selectedIndex?: number | null,
    zoomScale?: number,
    canvasWidth?: number,
    enablePostFilters = true
  ): void {
    const zoom = zoomScale ?? 1;
    const canvasRefW = canvasWidth ?? 720;
    // Keep 2-frame delay to avoid filter resource race, then enqueue old children for
    // incremental destruction (prevents mid-drag stalls from bulk destroy).
    while (this.pendingDestroyBatches.length > 2) {
      const batch = this.pendingDestroyBatches.shift();
      if (batch && batch.length > 0) this.destroyQueue.push(...batch);
    }
    const oldChildren = this.threadContainer.removeChildren();
    if (oldChildren.length > 0) {
      this.pendingDestroyBatches.push(oldChildren as unknown[]);
    }
    this.flushDestroyQueue(this.destroyPerFrameBudget);
    // Keep live counters up to date so MemoryIndicator can distinguish "buffered
    // but will be destroyed soon" from "truly stuck / leaking".
    loomStats.pendingCount = this.pendingDestroyBatches.reduce((s, b) => s + b.length, 0);
    loomStats.queueCount = this.destroyQueue.length;

    // 发光纹理每帧创建一次（haloStripTexture 不缓存），供所有线程复用
    let haloTex: ReturnType<typeof getHaloStripTexture> | null = null;

    threads.forEach((t, threadIndex) => {
      if (t.points.length < 2) return;
      const tid = (t.textureId ?? 'none') as MaterialTextureId;
      const preset = MATERIAL_TEXTURE_PRESETS[tid];
      let lineWidth = t.lineWidth ?? preset?.lineWidth ?? 3;
      const roundness = preset?.endRoundness ?? 0.5;
      const p0 = t.points[0];
      const baseAlpha = t.isActive ? 0.55 : 1.0;
      let alpha = baseAlpha * (t.opacity ?? 1);
      // softness degree: 0 = stiff, 1 = soft (stiffness stored per thread; lower = softer)
      // edgeBlur01 控制发光强度：0 时无发光，1 时最强（由材质面板的 softness 滑块决定）
      const stiffness01 = t.stiffness ?? preset?.stiffness ?? 0.6;
      const softness01 = Math.max(0, Math.min(1, 1 - stiffness01));
      const edgeBlur01 = softness01;
      /**
       * 发光/羽化效果：先画带 alpha 渐变的 halo 底层，再叠加 BlurFilter，最后画清晰主线。
       * 可调参数见下方注释。
       */
      const drawBlurHalo = (args: {
        baseWidth: number;
        localPoints: Point[];
        textureScale: number;
        tint: number;
        strengthScale?: number;
      }): void => {
        if (!enablePostFilters) return;
        if (edgeBlur01 <= 0.001 && !HALO_STRIP_CONFIG.forceShow) return;
        const strengthScale = Math.max(0, args.strengthScale ?? 1);
        const edgeBlur = edgeBlur01 * strengthScale;

        if (!haloTex) {
          haloTex = getHaloStripTexture();
          if (haloTex.source?.style) haloTex.source.style.addressMode = 'repeat';
        }
        // 发光层宽度 = 主线宽 × (1 + 扩展比例)
        const haloWidth = args.baseWidth * (1 + edgeBlur * 0.8);

        // 模糊强度：softness 最强 1.5*zoom，最弱 0.1*zoom；× (width/720) 使小画布（如 Creation 详情）blur 减弱
        const blurStrength = (0.1 + edgeBlur * 1.4) * zoom * (canvasRefW / 720);

        const blurContainer = new Container();
        blurContainer.position.set(p0.x, p0.y);

        const geomHalo = mkRopeGeometry({
          width: haloWidth,
          points: args.localPoints,
          textureScale: args.textureScale,
        });
        const haloMesh = new Mesh({ texture: haloTex!, geometry: geomHalo });
        haloMesh.position.set(0, 0);
        haloMesh.pivot.set(0, 0);
        haloMesh.tint = args.tint;
        // 使用 HALO_STRIP_CONFIG.edgeAlpha 调节发光亮度，确认配置生效
        haloMesh.alpha = alpha * (0.4 + HALO_STRIP_CONFIG.edgeAlpha * 0.6) * Math.min(1, 0.72 + strengthScale * 0.28);
        blurContainer.addChild(haloMesh);

        const glowBlurFilter = mkBlurFilter({ strength: blurStrength, quality: 4 });
        glowBlurFilter.padding = 32 * zoom; // 随缩放增加，避免模糊被裁剪
        blurContainer.filters = [glowBlurFilter];

        this.threadContainer.addChild(blurContainer);
      };
      const isSelected = !t.isActive && threadIndex === selectedIndex;
      const bridges = t.bridges ?? [];
      /** 与主线 mesh.tint 一致，长按选中高亮随线材颜色变化 */
      const selectionHighlightTint = t.color ?? DEFAULT_TINT;

      /** 编辑选中：主线下方同色柔影，不叠色盖住线本身 */
      const addSelectionHighlightShadow = (args: { localPoints: Point[]; stripWidth: number; textureScale: number }): void => {
        if (!isSelected) return;
        if (!enablePostFilters) return;
        const dy = Math.max(2, args.stripWidth * 0.11);
        const shadowPts = args.localPoints.map((p) => ({ x: p.x, y: p.y + dy }));
        if (!haloTex) {
          haloTex = getHaloStripTexture();
          if (haloTex.source?.style) haloTex.source.style.addressMode = 'repeat';
        }
        const blurStrength = (0.5 + 0.45 * zoom) * (canvasRefW / 720);
        const blurPad = 22 * zoom;

        const softGeom = mkRopeGeometry({
          width: args.stripWidth * 1.5,
          points: shadowPts,
          textureScale: args.textureScale,
        });
        const softMesh = new Mesh({ texture: haloTex, geometry: softGeom });
        softMesh.position.set(0, 0);
        softMesh.pivot.set(0, 0);
        softMesh.tint = selectionHighlightTint;
        softMesh.alpha = Math.min(0.4, alpha * 0.44);
        const softWrap = new Container();
        softWrap.position.set(p0.x, p0.y);
        softWrap.addChild(softMesh);
        const softBlur = mkBlurFilter({ strength: blurStrength, quality: 3 });
        softBlur.padding = blurPad;
        softWrap.filters = [softBlur];
        this.threadContainer.addChild(softWrap);

        const coreGeom = mkRopeGeometry({
          width: args.stripWidth * 1.12,
          points: shadowPts,
          textureScale: args.textureScale,
        });
        const coreMesh = new Mesh({ texture: haloTex, geometry: coreGeom });
        coreMesh.position.set(p0.x, p0.y);
        coreMesh.pivot.set(0, 0);
        coreMesh.tint = selectionHighlightTint;
        coreMesh.alpha = Math.min(0.34, alpha * 0.38);
        this.threadContainer.addChild(coreMesh);
      };

      /**
       * 整条线接地影（Drop shadow）。应在 drawBlurHalo 之前绘制，使光晕叠在阴影之上。
       * 全材质统一为文件顶部 GROUND_SHADOW_* 设计常量（spread 0 = 与线条同宽）。
       */
      const drawGroundShadow = (args: {
        localPoints: Point[];
        stripWidth: number;
        textureScale: number;
      }): void => {
        // 空白处涂鸦：无下垂、无接地影，仅保留材质主线外观。
        if (t.skipSag) return;
        if (!enablePostFilters) return;
        if (args.localPoints.length < 2) return;
        if (!haloTex) {
          haloTex = getHaloStripTexture();
          if (haloTex.source?.style) haloTex.source.style.addressMode = 'repeat';
        }
        const pxScale = zoom * (canvasRefW / 720);
        const dx = GROUND_SHADOW_OFFSET_X * pxScale;
        const dy = GROUND_SHADOW_OFFSET_Y * pxScale;
        const shadowPts = args.localPoints.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        const blurStrength = GROUND_SHADOW_BLUR_PX * pxScale;
        const blurPad = Math.ceil(GROUND_SHADOW_BLUR_PX * pxScale * 2) + 16;

        const geom = mkRopeGeometry({
          width: args.stripWidth,
          points: shadowPts,
          textureScale: args.textureScale,
        });
        const mesh = new Mesh({ texture: haloTex, geometry: geom });
        mesh.position.set(0, 0);
        mesh.pivot.set(0, 0);
        mesh.tint = 0x000000;
        mesh.alpha = Math.min(1, GROUND_SHADOW_ALPHA * alpha);
        const wrap = new Container();
        wrap.position.set(p0.x, p0.y);
        wrap.addChild(mesh);
        const groundBlur = mkBlurFilter({ strength: blurStrength, quality: 4 });
        groundBlur.padding = blurPad;
        wrap.filters = [groundBlur];
        this.threadContainer.addChild(wrap);
      };

      const drawBridgeSegments = (params: {
        texture: unknown;
        width: number;
        textureScale: number;
        uScale?: number;
        vScale?: number;
        tint: number;
        alphaMul?: number;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blendMode?: any;
      }): void => {
        if (bridges.length === 0) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const style = (params.texture as any)?.source?.style;
        if (style) style.addressMode = 'repeat';

        const segAlpha = alpha * (params.alphaMul ?? 0.98);
        for (const b of bridges) {
          const localPoints = [
            { x: b.x1 - p0.x, y: b.y1 - p0.y },
            { x: b.x2 - p0.x, y: b.y2 - p0.y },
          ];

          const geom = scaleRopeGeometryVCentered(
            scaleRopeGeometryU(
              mkRopeGeometry({
                width: params.width,
                points: localPoints,
                textureScale: params.textureScale,
              }),
              params.uScale ?? 1,
            ),
            params.vScale ?? 1,
          );
          const mesh = new Mesh({ texture: params.texture as any, geometry: geom });
          mesh.position.set(p0.x, p0.y);
          mesh.pivot.set(0, 0);
          mesh.tint = params.tint;
          mesh.alpha = segAlpha;
          if (params.blendMode) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (mesh as any).blendMode = params.blendMode;
          }
          this.threadContainer.addChild(mesh);
        }
      };
      const startTint = t.color ?? DEFAULT_TINT;
      const gradientEndTint = t.gradientColor;
      const hasGradient = gradientEndTint != null && gradientEndTint !== startTint;
      const drawGradientStrip = (params: {
        texture: unknown;
        width: number;
        points: Point[];
        textureScale: number;
        patternUScale?: number;
        patternVScale?: number;
        alphaMul?: number;
      }): boolean => {
        if (!hasGradient || params.points.length < 2) return false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const style = (params.texture as any)?.source?.style;
        if (style) style.addressMode = 'repeat';
        let totalLen = 0;
        for (let i = 0; i < params.points.length - 1; i++) {
          totalLen += Math.hypot(
            params.points[i + 1].x - params.points[i].x,
            params.points[i + 1].y - params.points[i].y,
          );
        }
        /**
         * 原先：多段短 Rope + 每段单色 tint → 弯折处既有色阶断层，又有段缝。
         * 现在：一根连续 Rope；textureScale=0 时 UV.u 沿路径 0→1，底层水平渐变贴图 +
         * 上层材质 multiply，使颜色沿弧长平滑、几何连续。
         */
        const pxAlong = 2.8;
        const pointCount = Math.min(180, Math.max(16, Math.ceil(totalLen / pxAlong)));
        const sampled = gradientSamples(params.points, pointCount);
        const localPts = sampled.map((p) => ({ x: p.x - p0.x, y: p.y - p0.y }));
        const geomColor = mkRopeGeometry({
          width: params.width,
          points: localPts,
          textureScale: 0,
        });
        const geomPattern = scaleRopeGeometryVCentered(
          scaleRopeGeometryU(
            mkRopeGeometry({
              width: params.width,
              points: localPts,
              textureScale: params.textureScale,
            }),
            params.patternUScale ?? 1,
          ),
          params.patternVScale ?? 1,
        );
        const gradTex = getOrCreateRopeGradientTexture(startTint, gradientEndTint!);
        const segAlpha = alpha * (params.alphaMul ?? 1);

        // Put gradient as base first.
        const colorMesh = new Mesh({ texture: gradTex, geometry: geomColor });
        colorMesh.position.set(p0.x, p0.y);
        colorMesh.pivot.set(0, 0);
        colorMesh.tint = 0xffffff;
        colorMesh.alpha = segAlpha;
        this.threadContainer.addChild(colorMesh);

        // Then multiply material details on top. This avoids curved inner-side over-darkening
        // caused by multiply-ing the color layer itself in high-curvature areas.
        const patternMesh = new Mesh({ texture: params.texture as any, geometry: geomPattern });
        patternMesh.position.set(p0.x, p0.y);
        patternMesh.pivot.set(0, 0);
        patternMesh.tint = 0xffffff;
        patternMesh.alpha = Math.min(1, segAlpha * 0.96);
        patternMesh.blendMode = 'multiply';
        this.threadContainer.addChild(patternMesh);
        return true;
      };
      if (tid === 'wool') {
        const woolPatternUScale = 0.4;
        lineWidth *= woolThicknessScale(threadIndex);
        const { capStart: cs, capEnd: ce } = ropeCapPlane(t);
        let pts: Point[];
        if (t.skipSag) {
          pts = freehandStrokePoints(t);
        } else {
          pts = addWoolJitter(addRoundedCaps(t.points, lineWidth, roundness, cs, ce), 0.9);
        }
        const localPoints = pts.map((p) => ({ x: p.x - p0.x, y: p.y - p0.y }));
        const width = lineWidth * 2;
        const fuzzyWidth = width * (1 + edgeBlur01 * 0.20); // keep within ~20% line width

        const woolTex = getWoolRopeTexture();
        const fuzzyTex = getWoolRopeFuzzyTexture();
        if (woolTex.source?.style) woolTex.source.style.addressMode = 'repeat';
        if (fuzzyTex.source?.style) fuzzyTex.source.style.addressMode = 'repeat';

        drawGroundShadow({ localPoints, stripWidth: width, textureScale: 0.5 });
        addSelectionHighlightShadow({ localPoints, stripWidth: width, textureScale: 0.5 });

        const geomFuzzy = mkRopeGeometry({
          width: fuzzyWidth,
          points: localPoints,
          textureScale: 0.5,
        });
        const fuzzyRope = new Mesh({ texture: fuzzyTex, geometry: geomFuzzy });
        fuzzyRope.position.set(p0.x, p0.y);
        fuzzyRope.pivot.set(0, 0);
        const tint = startTint;
        fuzzyRope.tint = tint;
        fuzzyRope.alpha = Math.min(1, alpha * edgeBlur01 * 1.1);
        this.threadContainer.addChild(fuzzyRope);

        const geom = mkRopeGeometry({
          width,
          points: localPoints,
          textureScale: 0.5,
        });
        scaleRopeGeometryU(geom, woolPatternUScale);
        if (!drawGradientStrip({
          texture: woolTex,
          width,
          points: pts,
          textureScale: 0.5,
          patternUScale: woolPatternUScale,
        })) {
          const rope = new Mesh({ texture: woolTex, geometry: geom });
          rope.position.set(p0.x, p0.y);
          rope.pivot.set(0, 0);
          rope.tint = tint;
          rope.alpha = alpha;
          this.threadContainer.addChild(rope);
        }

        drawBridgeSegments({
          texture: woolTex,
          width,
          textureScale: 0.5,
          uScale: woolPatternUScale,
          tint,
          alphaMul: 1,
        });
        return;
      }

      if (tid === 'chenille') {
        lineWidth *= chenilleThicknessScale(threadIndex);
        const tint = startTint;
        const { capStart: cs, capEnd: ce } = ropeCapPlane(t);
        const pts = t.skipSag
          ? freehandStrokePoints(t)
          : addRoundedCaps(t.points, lineWidth, 1, cs, ce); // very round ends
        const localPoints = pts.map((p) => ({ x: p.x - p0.x, y: p.y - p0.y }));
        const width = lineWidth * 2.3; // more volumetric than wool

        const tubeTex = getChenilleTubeTexture();
        const plushTex = getChenillePlushTexture();

        drawGroundShadow({ localPoints, stripWidth: width, textureScale: 0.6 });
        drawBlurHalo({
          baseWidth: width,
          localPoints,
          textureScale: 0.6,
          tint,
        });

        addSelectionHighlightShadow({ localPoints, stripWidth: width, textureScale: 0.6 });

        // Underlay: tube shading, slightly wider for soft volume
        const geomUnder = mkRopeGeometry({ width: width * 1.12, points: localPoints, textureScale: 0.6 });
        const under = new Mesh({ texture: tubeTex, geometry: geomUnder });
        under.position.set(p0.x, p0.y);
        under.pivot.set(0, 0);
        under.tint = tint;
        under.alpha = alpha * 0.9;
        this.threadContainer.addChild(under);

        // Top: plush surface (non-directional), no fuzz halo
        const geomTop = mkRopeGeometry({ width, points: localPoints, textureScale: 0.6 });
        if (!drawGradientStrip({ texture: plushTex, width, points: pts, textureScale: 0.6 })) {
          const top = new Mesh({ texture: plushTex, geometry: geomTop });
          top.position.set(p0.x, p0.y);
          top.pivot.set(0, 0);
          top.tint = tint;
          top.alpha = alpha;
          this.threadContainer.addChild(top);
        }

        drawBridgeSegments({
          texture: plushTex,
          width,
          textureScale: 0.6,
          tint,
          alphaMul: 1,
        });
        return;
      }

      if (tid === 'thread') {
        const tint = startTint;
        const { capStart: cs, capEnd: ce } = ropeCapPlane(t);
        const pts = t.skipSag
          ? freehandStrokePoints(t)
          : addRoundedCaps(t.points, lineWidth, 0.45, cs, ce);
        const localPoints = pts.map((p) => ({ x: p.x - p0.x, y: p.y - p0.y }));
        const width = lineWidth * 2;

        const tex = getMaterialTexture('thread');
        // Thread bitmap looks too dense along path at native ratio; stretch U to reduce compression.
        const threadPatternUScale = getMaterialTextureUScale('thread') * 0.36;
        if (tex.source?.style) tex.source.style.addressMode = 'repeat';
        drawGroundShadow({ localPoints, stripWidth: width, textureScale: 0.55 });
        drawBlurHalo({
          baseWidth: width,
          localPoints,
          textureScale: 0.55,
          tint,
        });

        addSelectionHighlightShadow({ localPoints, stripWidth: width, textureScale: 0.55 });

        const geom = scaleRopeGeometryU(
          mkRopeGeometry({ width, points: localPoints, textureScale: 0.55 }),
          threadPatternUScale,
        );
        if (!drawGradientStrip({
          texture: tex,
          width,
          points: pts,
          textureScale: 0.55,
          patternUScale: threadPatternUScale,
        })) {
          const rope = new Mesh({ texture: tex, geometry: geom });
          rope.position.set(p0.x, p0.y);
          rope.pivot.set(0, 0);
          rope.tint = tint;
          rope.alpha = alpha;
          this.threadContainer.addChild(rope);
        }

        drawBridgeSegments({
          texture: tex,
          width,
          textureScale: 0.55,
          uScale: threadPatternUScale,
          tint,
          alphaMul: 1,
        });
        return;
      }

      if (tid === 'steel') {
        const steelTextureScale = 1;
        // Noticeable mapping: texture height is larger than rope thickness.
        // Across rope width, sample centered 78% of V so bitmap reads larger than line thickness.
        const steelPatternVScale = 0.78;
        const tint = startTint;
        const { capStart: cs, capEnd: ce } = ropeCapPlane(t);
        const pts = t.skipSag
          ? freehandStrokePoints(t)
          : addRoundedCaps(t.points, lineWidth, 0, cs, ce); // sharp ends
        const localPoints = pts.map((p) => ({ x: p.x - p0.x, y: p.y - p0.y }));
        const width = lineWidth * 2;

        // Base: brushed / faceted steel strip + inner shadow volume
        const baseTex = getMaterialTexture('steel');
        const steelPatternUScale = getMaterialTextureUScale('steel');
        if (baseTex.source.style) baseTex.source.style.addressMode = 'repeat';

        drawGroundShadow({ localPoints, stripWidth: width, textureScale: steelTextureScale });
        drawBlurHalo({
          baseWidth: width,
          localPoints,
          textureScale: steelTextureScale,
          tint,
        });

        addSelectionHighlightShadow({ localPoints, stripWidth: width, textureScale: steelTextureScale });

        const geom = scaleRopeGeometryVCentered(
          scaleRopeGeometryU(
            mkRopeGeometry({ width, points: localPoints, textureScale: steelTextureScale }),
            steelPatternUScale,
          ),
          steelPatternVScale,
        );
        if (!drawGradientStrip({
          texture: baseTex,
          width,
          points: pts,
          textureScale: steelTextureScale,
          patternUScale: steelPatternUScale,
          patternVScale: steelPatternVScale,
        })) {
          const base = new Mesh({ texture: baseTex, geometry: geom });
          base.position.set(p0.x, p0.y);
          base.pivot.set(0, 0);
          base.tint = tint;
          base.alpha = alpha;
          this.threadContainer.addChild(base);
        }

        // Highlight overlay: strong specular streaks
        const sheenTex = getSteelSheenTexture();
        const geomSheen = scaleRopeGeometryVCentered(
          mkRopeGeometry({
            width: width * 1.02,
            points: localPoints,
            textureScale: steelTextureScale,
          }),
          steelPatternVScale,
        );
        const sheen = new Mesh({ texture: sheenTex, geometry: geomSheen });
        sheen.position.set(p0.x, p0.y);
        sheen.pivot.set(0, 0);
        sheen.tint = 0xffffff;
        sheen.alpha = alpha * 0.85;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sheen as any).blendMode = 'add';
        this.threadContainer.addChild(sheen);

        drawBridgeSegments({
          texture: baseTex,
          width,
          textureScale: steelTextureScale,
          uScale: steelPatternUScale,
          vScale: steelPatternVScale,
          tint,
          alphaMul: 1,
        });
        drawBridgeSegments({
          texture: sheenTex,
          width: width * 1.02,
          textureScale: steelTextureScale,
          vScale: steelPatternVScale,
          tint: 0xffffff,
          alphaMul: 0.85,
          blendMode: 'add',
        });
        return;
      }

      if (tid === 'felt') {
        const tint = startTint;
        const { capStart: cs, capEnd: ce } = ropeCapPlane(t);
        const pts = t.skipSag ? freehandStrokePoints(t) : addFeltCaps(t.points, lineWidth, cs, ce);
        const localPoints = pts.map((p) => ({ x: p.x - p0.x, y: p.y - p0.y }));
        const width = lineWidth * 2;

        const fuzzyTex = getFeltRopeFuzzyTexture();
        const feltTex = getFeltRopeTexture();
        if (fuzzyTex.source?.style) fuzzyTex.source.style.addressMode = 'repeat';
        if (feltTex.source?.style) feltTex.source.style.addressMode = 'repeat';

        drawGroundShadow({ localPoints, stripWidth: width, textureScale: 0.5 });
        drawBlurHalo({
          baseWidth: width,
          localPoints,
          textureScale: 0.5,
          tint,
          strengthScale: 0.38,
        });

        addSelectionHighlightShadow({ localPoints, stripWidth: width, textureScale: 0.5 });

        const geom = mkRopeGeometry({
          width,
          points: localPoints,
          textureScale: 0.5,
        });
        if (!drawGradientStrip({ texture: feltTex, width, points: pts, textureScale: 0.5 })) {
          const rope = new Mesh({ texture: feltTex, geometry: geom });
          rope.position.set(p0.x, p0.y);
          rope.pivot.set(0, 0);
          rope.tint = tint;
          rope.alpha = alpha;
          this.threadContainer.addChild(rope);
        }

        drawBridgeSegments({
          texture: feltTex,
          width,
          textureScale: 0.5,
          tint,
          alphaMul: 1,
        });
        return;
      }

      const texture = getMaterialTexture(tid);
      // rope bitmap pattern is visually dense; reduce UV.u frequency to avoid horizontal over-compression.
      const patternUScale = tid === 'rope' ? 0.32 : 1;
      const { capStart: cs, capEnd: ce } = ropeCapPlane(t);
      const pts = t.skipSag
        ? freehandStrokePoints(t)
        : addRoundedCaps(t.points, lineWidth, roundness, cs, ce);
      const localPoints = pts.map((p) => ({ x: p.x - p0.x, y: p.y - p0.y }));

      const baseWidth = lineWidth * 2;
      drawGroundShadow({ localPoints, stripWidth: baseWidth, textureScale: 0.5 });
      drawBlurHalo({
        baseWidth,
        localPoints,
        textureScale: 0.5,
        tint: startTint,
      });

      addSelectionHighlightShadow({ localPoints, stripWidth: baseWidth, textureScale: 0.5 });

      const geometry = scaleRopeGeometryU(
        mkRopeGeometry({
          width: baseWidth,
          points: localPoints,
          textureScale: 0.5,
        }),
        patternUScale,
      );
      if (texture.source?.style) texture.source.style.addressMode = 'repeat';

      if (!drawGradientStrip({
        texture,
        width: baseWidth,
        points: pts,
        textureScale: 0.5,
        patternUScale,
      })) {
        const rope = new Mesh({ texture, geometry });
        rope.position.set(p0.x, p0.y);
        rope.pivot.set(0, 0);
        rope.tint = startTint;
        rope.alpha = alpha;
        this.threadContainer.addChild(rope);
      }

      drawBridgeSegments({
        texture,
        width: lineWidth * 2,
        textureScale: 0.5,
        uScale: patternUScale,
        tint: startTint,
        alphaMul: 1,
      });
    });
  }

  destroy(): void {
    this.destroyBatch(this.threadContainer.removeChildren() as unknown[]);
    while (this.pendingDestroyBatches.length > 0) {
      const batch = this.pendingDestroyBatches.shift();
      if (batch && batch.length > 0) this.destroyQueue.push(...batch);
    }
    this.flushDestroyQueue(Number.MAX_SAFE_INTEGER);
    this.threadContainer.destroy({ children: true });
    clearRopeGradientTextureCache();
  }
}
