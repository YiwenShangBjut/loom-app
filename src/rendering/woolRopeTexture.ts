import { Texture } from 'pixi.js';
import { BITMAP_TONE_YARN, applyBitmapNeutralizeAndBrighten } from './materialTextureBitmaps';
import { MATERIAL_TEXTURE_PRESETS } from './materialTextures';

/**
 * Yarn (wool) line: `yarn-pattern.jpg` mapped for Pixi RopeGeometry:
 * - 图源先顺时针旋转 90° 再写入纹理（与仅用 drawImage 缩放不同，正方形图也会明显变向）
 * - Texture X (U) 沿绳、Texture Y (V) 跨线宽
 */
const YARN_PATTERN_SRC = './textures/yarn-pattern.jpg';

/** 贴图布局变更时递增，用于丢弃旧 GPU 纹理（避免 HMR/缓存仍用上一版方向） */
const YARN_BITMAP_LAYOUT_REV = 3;

const WOOL_STRIP_W = 32;
const WOOL_STRIP_H = 128;
const WOOL_BRIGHTNESS_LIFT = 30;
const WOOL_GAMMA = 0.9;
const WOOL_CONTRAST = 0.92;
const WOOL_BLACK_CRUSH = 2;

let cachedWoolBitmap: Texture | null = null;
let cachedWoolBitmapRev = -1;
let cachedWoolPlaceholder: Texture | null = null;
let yarnPatternLoadStarted = false;
let cachedWoolFuzzy: Texture | null = null;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, v));
}

function applyBlackCrush(value: number, blackCrush: number): number {
  if (blackCrush <= 1 || value >= 128) return value;
  return value - (128 - value) * (blackCrush - 1);
}

/**
 * Brighten wool texture slightly so tint result does not appear too dark.
 * Same approach as felt: mild gamma lift + reduced contrast + brightness offset.
 */
function applyWoolBrightnessFilter(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const normalized = data[i + c] / 255;
      const gammaLifted = Math.pow(normalized, WOOL_GAMMA) * 255;
      const contrasted = (gammaLifted - 128) * WOOL_CONTRAST + 128;
      const lifted = contrasted + WOOL_BRIGHTNESS_LIFT;
      data[i + c] = clampByte(applyBlackCrush(lifted, WOOL_BLACK_CRUSH));
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Procedural wool structure:
 * - subtle spun-yarn micro texture (not sweater-like pattern)
 * - fine longitudinal fibres
 * - very soft twist hint + grain
 */
function drawWoolProceduralStrip(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#efeae2';
  ctx.fillRect(0, 0, w, h);

  // Low-frequency body variation so texture remains visible after tinting.
  for (let y = 0; y < h; y += 1) {
    const t = y / h;
    const a = 0.03 + 0.04 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 3.5));
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    ctx.fillRect(0, y, w, 1);
  }

  // Longitudinal twist hint (continuous on Y).
  const center = w * 0.5;
  const amp = w * 0.1;
  const cycles = 6;
  for (let y = 0; y <= h; y += 1) {
    const phase = (y / h) * Math.PI * 2 * cycles;
    const x1 = center + Math.sin(phase) * amp;
    const x2 = center + Math.sin(phase + Math.PI) * amp;
    ctx.fillStyle = 'rgba(0,0,0,0.09)';
    ctx.fillRect(x1 - 1.05, y, 2.1, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x2 - 0.85, y, 1.7, 1);
  }

  // Fine fibres mainly along yarn direction (slightly tilted).
  ctx.strokeStyle = 'rgba(0,0,0,0.07)';
  ctx.lineWidth = 0.42;
  for (let x = -6; x < w + 6; x += 1.5) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 2.8, h);
    ctx.stroke();
  }

  // Small random fibre hairs.
  ctx.strokeStyle = 'rgba(0,0,0,0.045)';
  ctx.lineWidth = 0.3;
  for (let i = 0; i < 340; i++) {
    const x = (i * 7.31) % w;
    const y = (i * 12.67 + 3) % h;
    const dx = ((i % 7) - 3) * 0.35;
    const dy = 0.9 + ((i * 0.41) % 10) * 0.08;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx, Math.min(h, y + dy));
    ctx.stroke();
  }

  // Soft grain noise.
  for (let i = 0; i < 320; i++) {
    const x = (i * 11.7) % w;
    const y = (i * 17.9 + 5) % h;
    const r = 0.26 + ((i * 0.37) % 10) / 55;
    const a = 0.02 + ((i * 0.91) % 10) / 240;
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Apply wool inner-shadow from material preset so config tuning takes effect. */
function applyWoolInnerShadow(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const shadow = MATERIAL_TEXTURE_PRESETS.wool.innerShadow;
  const s = Math.max(0, Math.min(1, shadow.strength));
  if (s <= 0) return;

  const edgeOuterStop = Math.max(0, Math.min(0.5, shadow.edgeOuterStop));
  const edgeInnerStop = Math.max(edgeOuterStop, Math.min(0.5, shadow.edgeInnerStop));
  const highlightOuterStop = Math.max(0, Math.min(0.5, shadow.highlightOuterStop));

  const edge = ctx.createLinearGradient(0, 0, 0, h);
  edge.addColorStop(edgeOuterStop, `rgba(0,0,0,${shadow.edgeAlpha * s})`);
  edge.addColorStop(edgeInnerStop, `rgba(0,0,0,${shadow.edgeInnerAlpha * s})`);
  edge.addColorStop(0.5, 'rgba(0,0,0,0)');
  edge.addColorStop(1 - edgeInnerStop, `rgba(0,0,0,${shadow.edgeInnerAlpha * s})`);
  edge.addColorStop(1 - edgeOuterStop, `rgba(0,0,0,${shadow.edgeAlpha * s})`);
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);

  const midHighlight = ctx.createLinearGradient(0, 0, 0, h);
  midHighlight.addColorStop(0, 'rgba(255,255,255,0)');
  midHighlight.addColorStop(highlightOuterStop, 'rgba(255,255,255,0)');
  midHighlight.addColorStop(0.5, `rgba(255,255,255,${shadow.highlightAlpha * s})`);
  midHighlight.addColorStop(1 - highlightOuterStop, 'rgba(255,255,255,0)');
  midHighlight.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = midHighlight;
  ctx.fillRect(0, 0, w, h);
}

/** Soft strip for fuzzy under-layer: feathered edge (soft at left/right). */
function drawWoolFuzzyStrip(ctx: CanvasRenderingContext2D): void {
  const W = WOOL_STRIP_W;
  const H = WOOL_STRIP_H;
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.12)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.2)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function createWoolPlaceholderTexture(): Texture {
  const canvas = makeCanvas(WOOL_STRIP_W, WOOL_STRIP_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawWoolProceduralStrip(ctx, WOOL_STRIP_W, WOOL_STRIP_H);
  applyWoolBrightnessFilter(ctx, WOOL_STRIP_W, WOOL_STRIP_H);
  applyWoolInnerShadow(ctx, WOOL_STRIP_W, WOOL_STRIP_H);
  return Texture.from({ resource: canvas });
}

/**
 * 将图源顺时针旋转 90° 画入 nh×nw 画布（原图 nw×nh → 纹理宽 nh、高 nw）。
 */
function createWoolTextureFromYarnPattern(img: HTMLImageElement): Texture {
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (nw <= 0 || nh <= 0) {
    return createWoolPlaceholderTexture();
  }

  const canvas = makeCanvas(nh, nw);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');

  ctx.save();
  ctx.translate(nh, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, 0, 0);
  ctx.restore();

  applyBitmapNeutralizeAndBrighten(ctx, nh, nw, BITMAP_TONE_YARN);
  applyWoolBrightnessFilter(ctx, nh, nw);
  applyWoolInnerShadow(ctx, nh, nw);
  const tex = Texture.from({ resource: canvas });
  if (tex.source?.style) tex.source.style.addressMode = 'repeat';
  return tex;
}

function scheduleYarnPatternLoad(): void {
  if (yarnPatternLoadStarted) return;
  yarnPatternLoadStarted = true;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    try {
      const tex = createWoolTextureFromYarnPattern(img);
      cachedWoolBitmap = tex;
      cachedWoolBitmapRev = YARN_BITMAP_LAYOUT_REV;
      const ph = cachedWoolPlaceholder;
      cachedWoolPlaceholder = null;
      requestAnimationFrame(() => {
        ph?.destroy(true);
      });
    } catch {
      /* keep procedural placeholder if painting fails */
    }
  };
  img.onerror = () => {
    /* keep procedural placeholder */
  };
  img.src = YARN_PATTERN_SRC;
}

if (typeof window !== 'undefined') scheduleYarnPatternLoad();

export function getWoolRopeTexture(): Texture {
  if (cachedWoolBitmap && cachedWoolBitmapRev !== YARN_BITMAP_LAYOUT_REV) {
    cachedWoolBitmap.destroy(true);
    cachedWoolBitmap = null;
    cachedWoolBitmapRev = -1;
    yarnPatternLoadStarted = false;
  }
  if (cachedWoolBitmap) return cachedWoolBitmap;
  scheduleYarnPatternLoad();
  if (!cachedWoolPlaceholder) {
    cachedWoolPlaceholder = createWoolPlaceholderTexture();
    if (cachedWoolPlaceholder.source?.style) cachedWoolPlaceholder.source.style.addressMode = 'repeat';
  }
  return cachedWoolPlaceholder;
}

export function getWoolRopeFuzzyTexture(): Texture {
  if (cachedWoolFuzzy) return cachedWoolFuzzy;
  const canvas = makeCanvas(WOOL_STRIP_W, WOOL_STRIP_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawWoolFuzzyStrip(ctx);
  cachedWoolFuzzy = Texture.from({ resource: canvas });
  if (cachedWoolFuzzy.source?.style) cachedWoolFuzzy.source.style.addressMode = 'repeat';
  return cachedWoolFuzzy;
}

export const WOOL_STRIP_WIDTH = WOOL_STRIP_W;
export const WOOL_STRIP_HEIGHT = WOOL_STRIP_H;
