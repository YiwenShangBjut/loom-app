import { Texture } from 'pixi.js';
import type { MaterialTextureId } from './materialTextures';
import { MATERIAL_TEXTURE_PRESETS } from './materialTextures';

const TEX_W = 128;
const TEX_H = 32;
const ROPE_PATTERN_SRC = './textures/rope-pattern.png';
const STEEL_PATTERN_SRC = './textures/wire-pattern.png';
const THREAD_PATTERN_SRC = './textures/thread-pattern.png';
const THREAD_PATTERN_FALLBACK_SRC = './textures/thread-pattern.jpg';

const cache: Partial<Record<MaterialTextureId, Texture>> = {};
let ropePatternLoadStarted = false;
let steelPatternLoadStarted = false;
let threadPatternLoadStarted = false;
const materialPatternUScale: Partial<Record<MaterialTextureId, number>> = {};

/** 去色后提亮：`gain` 缩放亮度，`lift` 直加（0–255）。rope / wire(steel) 更亮。 */
export type BitmapNeutralTone = { gain: number; lift: number };
const BITMAP_TONE_ROPE: BitmapNeutralTone = { gain: 1.14, lift: 50 };
const BITMAP_TONE_STEEL: BitmapNeutralTone = { gain: 1.16, lift: 44 };
const BITMAP_TONE_THREAD: BitmapNeutralTone = { gain: 1.05, lift: 26 };
/** yarn / felt 在各自模块引用 */
export const BITMAP_TONE_YARN: BitmapNeutralTone = { gain: 1, lift: 0 };
export const BITMAP_TONE_FELT: BitmapNeutralTone = { gain: 1, lift: 0 };

/**
 * Inner shadow pass to recover rope volume:
 * darken upper/lower edges and slightly lift center highlight.
 */
function applyInnerShadow(
  ctx: CanvasRenderingContext2D,
  config: {
    strength: number;
    edgeAlpha: number;
    edgeInnerAlpha: number;
    highlightAlpha: number;
    edgeOuterStop: number;
    edgeInnerStop: number;
    highlightOuterStop: number;
  },
  width = TEX_W,
  height = TEX_H,
): void {
  const s = Math.max(0, Math.min(1, config.strength));
  if (s <= 0) return;
  const edgeOuterStop = Math.max(0, Math.min(0.5, config.edgeOuterStop));
  const edgeInnerStop = Math.max(edgeOuterStop, Math.min(0.5, config.edgeInnerStop));
  const highlightOuterStop = Math.max(0, Math.min(0.5, config.highlightOuterStop));

  const edge = ctx.createLinearGradient(0, 0, 0, height);
  edge.addColorStop(edgeOuterStop, `rgba(0,0,0,${config.edgeAlpha * s})`);
  edge.addColorStop(edgeInnerStop, `rgba(0,0,0,${config.edgeInnerAlpha * s})`);
  edge.addColorStop(0.5, 'rgba(0,0,0,0)');
  edge.addColorStop(1 - edgeInnerStop, `rgba(0,0,0,${config.edgeInnerAlpha * s})`);
  edge.addColorStop(1 - edgeOuterStop, `rgba(0,0,0,${config.edgeAlpha * s})`);
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, width, height);

  const midHighlight = ctx.createLinearGradient(0, 0, 0, height);
  midHighlight.addColorStop(0, 'rgba(255,255,255,0)');
  midHighlight.addColorStop(highlightOuterStop, 'rgba(255,255,255,0)');
  midHighlight.addColorStop(0.5, `rgba(255,255,255,${config.highlightAlpha * s})`);
  midHighlight.addColorStop(1 - highlightOuterStop, 'rgba(255,255,255,0)');
  midHighlight.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = midHighlight;
  ctx.fillRect(0, 0, width, height);
}

function makeCanvas(width = TEX_W, height = TEX_H): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** 去饱和并按材质单独提亮（再叠加 innerShadow 等）。 */
export function applyBitmapNeutralizeAndBrighten(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tone: BitmapNeutralTone,
): void {
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  const gain = tone.gain;
  const lift = tone.lift;
  for (let i = 0; i < data.length; i += 4) {
    const luma = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    const y = Math.max(0, Math.min(255, luma * gain + lift));
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
}

function drawNone(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  for (let x = 0; x < TEX_W; x += 4) ctx.fillRect(x, 0, 1, TEX_H);
}

function drawWool(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  for (let i = 0; i < 220; i++) {
    const x = (i * 17.3) % TEX_W;
    const y = (i * 7 + 11) % TEX_H;
    ctx.beginPath();
    ctx.arc(x, y, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawThread(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  ctx.strokeStyle = 'rgba(0,0,0,0.14)';
  ctx.lineWidth = 0.8;
  for (let x = 0; x < TEX_W; x += 6) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TEX_H);
    ctx.stroke();
  }
}

function drawChenille(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  for (let i = 0; i < 180; i++) {
    const x = (i * 13) % TEX_W;
    const y = (i * 5 + 3) % TEX_H;
    ctx.fillRect(x, y, 2.2, 2.2);
  }
}

function drawFelt(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#f5f2ed';
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let i = 0; i < 260; i++) {
    const x = (i * 19.7) % TEX_W;
    const y = (i * 8 + 5) % TEX_H;
    ctx.beginPath();
    ctx.arc(x, y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * 程序化扭绳条带（可平铺沿绳长方向），不使用 `rope.png` 示意图。
 * 偏粗硬麻/尼龙绳：螺旋股线 + 低对比纤维噪点。
 */
function drawRope(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#ebe6df';
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // 轴向股线：两族反向斜纹，暗示 S/Z 扭结
  ctx.strokeStyle = 'rgba(55,48,40,0.14)';
  ctx.lineWidth = 1.1;
  for (let x0 = -TEX_H; x0 < TEX_W + TEX_H; x0 += 7) {
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0 + TEX_H * 0.48, TEX_H);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(55,48,40,0.10)';
  ctx.lineWidth = 0.75;
  for (let x0 = -TEX_H + 3.2; x0 < TEX_W + TEX_H; x0 += 7) {
    ctx.beginPath();
    ctx.moveTo(x0, TEX_H);
    ctx.lineTo(x0 - TEX_H * 0.38, 0);
    ctx.stroke();
  }

  // 沿绳长的微弱周期起伏（股距）
  ctx.fillStyle = 'rgba(0,0,0,0.045)';
  for (let x = 0; x < TEX_W; x++) {
    const t = x / TEX_W;
    const a = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 5.5);
    ctx.globalAlpha = a * 0.35;
    ctx.fillRect(x, 0, 1, TEX_H);
  }
  ctx.globalAlpha = 1;

  // 粗纤维噪点
  ctx.fillStyle = 'rgba(40,35,30,0.11)';
  for (let i = 0; i < 200; i++) {
    const x = (i * 21.7 + 3) % TEX_W;
    const y = (i * 5.9 + 7) % TEX_H;
    ctx.fillRect(x, y, 1.1, 1.1);
  }

  // 微弱截面明暗（与 innerShadow 叠加前打底）
  const vol = ctx.createLinearGradient(0, 0, 0, TEX_H);
  vol.addColorStop(0, 'rgba(0,0,0,0.08)');
  vol.addColorStop(0.45, 'rgba(255,255,255,0.04)');
  vol.addColorStop(0.55, 'rgba(255,255,255,0.04)');
  vol.addColorStop(1, 'rgba(0,0,0,0.09)');
  ctx.fillStyle = vol;
  ctx.fillRect(0, 0, TEX_W, TEX_H);
}

function drawSteel(ctx: CanvasRenderingContext2D): void {
  // 冷灰底 + 可平铺拉丝/微刻面纹样（沿绳长重复），读作机加工硬金属
  const base = ctx.createLinearGradient(0, 0, 0, TEX_H);
  base.addColorStop(0, '#8e939e');
  base.addColorStop(0.48, '#c4c8d2');
  base.addColorStop(0.52, '#d8dce6');
  base.addColorStop(1, '#8a8f9a');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, TEX_W, TEX_H);

  // 斜向拉丝（暗线）
  ctx.strokeStyle = 'rgba(25,30,40,0.35)';
  ctx.lineWidth = 0.65;
  for (let x0 = -TEX_H; x0 < TEX_W + TEX_H; x0 += 5) {
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0 + TEX_H * 0.55, TEX_H);
    ctx.stroke();
  }
  // 斜向高光丝（错位）
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 0.45;
  for (let x0 = -TEX_H + 2.5; x0 < TEX_W + TEX_H; x0 += 5) {
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0 + TEX_H * 0.55, TEX_H);
    ctx.stroke();
  }

  // 细交叉刻痕（低对比，增加硬度/切削感）
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 0.5;
  for (let x0 = -8; x0 < TEX_W + 8; x0 += 11) {
    ctx.beginPath();
    ctx.moveTo(x0, TEX_H);
    ctx.lineTo(x0 + 9, 0);
    ctx.stroke();
  }

  // 轴向微带：暗示圆柱反光带（与 innerShadow 叠加后更立体）
  const band = ctx.createLinearGradient(0, 0, 0, TEX_H);
  band.addColorStop(0, 'rgba(0,0,0,0.18)');
  band.addColorStop(0.35, 'rgba(255,255,255,0)');
  band.addColorStop(0.5, 'rgba(255,255,255,0.14)');
  band.addColorStop(0.65, 'rgba(255,255,255,0)');
  band.addColorStop(1, 'rgba(0,0,0,0.2)');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, TEX_W, TEX_H);
}

const drawers: Record<MaterialTextureId, (ctx: CanvasRenderingContext2D) => void> = {
  none: drawNone,
  wool: drawWool,
  thread: drawThread,
  chenille: drawChenille,
  felt: drawFelt,
  steel: drawSteel,
  rope: drawRope,
};

function createRopeTextureFromPattern(img: HTMLImageElement): Texture | null {
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (nw <= 0 || nh <= 0) return null;

  // Keep source orientation:
  // - image width maps to U (along rope path, repeat)
  // - image height maps to V (across rope thickness)
  const canvas = makeCanvas(nw, nh);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, nw, nh, 0, 0, nw, nh);
  applyBitmapNeutralizeAndBrighten(ctx, nw, nh, BITMAP_TONE_ROPE);
  applyInnerShadow(ctx, MATERIAL_TEXTURE_PRESETS.rope.innerShadow, nw, nh);
  return Texture.from({ resource: canvas });
}

function scheduleRopePatternLoad(): void {
  if (ropePatternLoadStarted || typeof window === 'undefined') return;
  ropePatternLoadStarted = true;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const tex = createRopeTextureFromPattern(img);
    if (!tex) return;
    const old = cache.rope;
    cache.rope = tex;
    requestAnimationFrame(() => old?.destroy(true));
  };
  img.onerror = () => {
    // Keep procedural fallback.
  };
  img.src = ROPE_PATTERN_SRC;
}

function createSteelTextureFromPattern(img: HTMLImageElement): Texture | null {
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (nw <= 0 || nh <= 0) return null;

  // Keep source orientation:
  // - image width maps to U (along rope path, repeat)
  // - image height maps to V (across rope thickness)
  const canvas = makeCanvas(nw, nh);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, nw, nh, 0, 0, nw, nh);
  applyBitmapNeutralizeAndBrighten(ctx, nw, nh, BITMAP_TONE_STEEL);
  applyInnerShadow(ctx, MATERIAL_TEXTURE_PRESETS.steel.innerShadow, nw, nh);
  // Keep along-path period proportional to bitmap aspect: period ~= thickness * (W / H).
  materialPatternUScale.steel = Math.max(0.08, Math.min(1, nh / nw));
  return Texture.from({ resource: canvas });
}

function scheduleSteelPatternLoad(): void {
  if (steelPatternLoadStarted || typeof window === 'undefined') return;
  steelPatternLoadStarted = true;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const tex = createSteelTextureFromPattern(img);
    if (!tex) return;
    const old = cache.steel;
    cache.steel = tex;
    requestAnimationFrame(() => old?.destroy(true));
  };
  img.onerror = () => {
    // Keep procedural fallback.
  };
  img.src = STEEL_PATTERN_SRC;
}

function createThreadTextureFromPattern(img: HTMLImageElement): Texture | null {
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (nw <= 0 || nh <= 0) return null;

  // Keep source orientation:
  // - image width maps to U (along rope path, repeat)
  // - image height maps to V (across rope thickness)
  const canvas = makeCanvas(nw, nh);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, nw, nh, 0, 0, nw, nh);
  applyBitmapNeutralizeAndBrighten(ctx, nw, nh, BITMAP_TONE_THREAD);
  applyInnerShadow(ctx, MATERIAL_TEXTURE_PRESETS.thread.innerShadow, nw, nh);
  // Preserve along-path aspect so the bitmap does not look horizontally compressed.
  materialPatternUScale.thread = Math.max(0.08, Math.min(1, nh / nw));
  return Texture.from({ resource: canvas });
}

function scheduleThreadPatternLoad(): void {
  if (threadPatternLoadStarted || typeof window === 'undefined') return;
  threadPatternLoadStarted = true;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const tex = createThreadTextureFromPattern(img);
    if (!tex) return;
    const old = cache.thread;
    cache.thread = tex;
    requestAnimationFrame(() => old?.destroy(true));
  };
  img.onerror = () => {
    // Fallback for current asset set where only .jpg exists.
    const fallback = new Image();
    fallback.decoding = 'async';
    fallback.onload = () => {
      const tex = createThreadTextureFromPattern(fallback);
      if (!tex) return;
      const old = cache.thread;
      cache.thread = tex;
      requestAnimationFrame(() => old?.destroy(true));
    };
    fallback.onerror = () => {
      // Keep procedural fallback.
    };
    fallback.src = THREAD_PATTERN_FALLBACK_SRC;
  };
  img.src = THREAD_PATTERN_SRC;
}

export function getMaterialTexture(id: MaterialTextureId): Texture {
  let tex = cache[id];
  if (tex) return tex;
  if (id === 'rope') scheduleRopePatternLoad();
  if (id === 'steel') scheduleSteelPatternLoad();
  if (id === 'thread') scheduleThreadPatternLoad();
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  (drawers[id] ?? drawNone)(ctx);
  applyInnerShadow(ctx, MATERIAL_TEXTURE_PRESETS[id].innerShadow);
  tex = Texture.from({ resource: canvas });
  cache[id] = tex;
  return tex;
}

export function getMaterialTextureUScale(id: MaterialTextureId): number {
  return materialPatternUScale[id] ?? 1;
}

export const MATERIAL_TEXTURE_HEIGHT = TEX_H;
