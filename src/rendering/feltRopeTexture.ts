import { Texture } from 'pixi.js';
import { BITMAP_TONE_FELT, applyBitmapNeutralizeAndBrighten } from './materialTextureBitmaps';
import { MATERIAL_TEXTURE_PRESETS } from './materialTextures';

/**
 * Felt rope texture: prefer bitmap pattern, fallback to procedural.
 * Target look:
 * - Chaotic interwoven fibre brush strokes
 * - Multi-directional wool flow (not strict linear yarn)
 * - Soft matte body with subtle depth
 */
const FELT_PATTERN_SRC = './textures/felt-pattern.png';
const FELT_STRIP_W = 64;
const FELT_STRIP_H = 128;
const FELT_BRIGHTNESS_LIFT = 34;
const FELT_GAMMA = 0.9;
const FELT_CONTRAST = 0.98;
const FELT_BLACK_CRUSH = 1.12;

/** 0..1：靠线两侧边缘（旋转 90° 后，按条带 Y 方向）纹理更“实”的强度 */
const FELT_EDGE_OPACITY_STRENGTH = 0.4;

let cachedFeltBitmap: Texture | null = null;
let cachedFeltBitmapRev = -1;
let feltPatternLoadStarted = false;
let cachedFeltFallback: Texture | null = null;
let cachedFeltFuzzy: Texture | null = null;
const FELT_BITMAP_LAYOUT_REV = 2;

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
 * Brighten felt texture slightly so tint result is closer to other materials.
 * We apply a mild gamma lift + reduced contrast + constant brightness offset.
 */
function applyFeltBrightnessFilter(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const normalized = data[i + c] / 255;
      const gammaLifted = Math.pow(normalized, FELT_GAMMA) * 255;
      const contrasted = (gammaLifted - 128) * FELT_CONTRAST + 128;
      const lifted = contrasted + FELT_BRIGHTNESS_LIFT;
      data[i + c] = clampByte(applyBlackCrush(lifted, FELT_BLACK_CRUSH));
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * 沿条带高度（Y 方向，已相对上一版旋转 90°）提高不透明度感：
 * - 边缘略提高对比度（毛流更“吃色”），中心保持接近原样
 * - 边缘 alpha 略抬升（中心可极轻压低，整体仍以 RGB 为主，避免透底穿帮）
 */
function applyFeltEdgeOpacityEmphasis(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const s = Math.max(0, Math.min(1, FELT_EDGE_OPACITY_STRENGTH));
  if (s <= 0) return;

  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const contrastBoost = 1 + 0.34 * s; // 边缘相对中心的对比增强
  const centerAlpha = 1 - 0.045 * s; // 中心 alpha 极轻降低
  const edgeAlpha = 1 + 0.08 * s; // 边缘 alpha 略抬

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const ny = h <= 1 ? 0.5 : y / (h - 1);
      const edge = smooth01(Math.abs(ny - 0.5) * 2); // 0 中心 → 1 上下两侧
      const mult = 1 + (contrastBoost - 1) * edge;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const v = data[i + c];
        data[i + c] = clampByte(128 + (v - 128) * mult);
      }
      const aMul = centerAlpha + (edgeAlpha - centerAlpha) * edge;
      data[i + 3] = clampByte(data[i + 3] * aMul);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function smooth01(x: number): number {
  return x * x * (3 - 2 * x);
}

/**
 * Deterministic pseudo-random (stable texture every render).
 */
function seeded01(seed: number): number {
  const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return v - Math.floor(v);
}

/**
 * Build felt body using many short semi-transparent strokes with varying direction,
 * creating a tangled 2D wool-flow impression.
 */
function drawFeltProceduralStrip(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);

  // Base matte body.
  ctx.fillStyle = '#efeae2';
  ctx.fillRect(0, 0, w, h);

  // Subtle width-wise body modulation so center is slightly fuller than edges.
  for (let x = 0; x < w; x += 1) {
    const nx = x / (w - 1);
    const edge = Math.abs(nx - 0.5) * 2;
    const centerWeight = 1 - smooth01(edge);
    const a = 0.025 + centerWeight * 0.03;
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(x, 0, 1, h);
  }

  // Interwoven fibre brush strokes: multiple directional groups.
  // Mostly vertical-ish flow, plus diagonal counter-flow to feel tangled.
  const groups = [
    { angle: Math.PI * 0.48, alpha: 0.12, count: 760, lenMin: 4.5, lenMax: 12.5, width: 0.55 },
    { angle: Math.PI * 0.53, alpha: 0.1, count: 680, lenMin: 4.0, lenMax: 11.0, width: 0.5 },
    { angle: Math.PI * 0.35, alpha: 0.085, count: 460, lenMin: 3.0, lenMax: 9.5, width: 0.45 },
    { angle: Math.PI * 0.65, alpha: 0.085, count: 460, lenMin: 3.0, lenMax: 9.5, width: 0.45 },
  ];

  groups.forEach((g, gi) => {
    ctx.lineCap = 'round';
    ctx.lineWidth = g.width;
    for (let i = 0; i < g.count; i += 1) {
      const s = gi * 10000 + i * 17.13;
      const x = seeded01(s + 1.2) * w;
      const y = seeded01(s + 9.5) * h;
      const jitter = (seeded01(s + 21.7) - 0.5) * 0.55; // angle micro-jitter
      const len = g.lenMin + seeded01(s + 33.1) * (g.lenMax - g.lenMin);
      const dx = Math.cos(g.angle + jitter) * len;
      const dy = Math.sin(g.angle + jitter) * len;
      const localAlpha = g.alpha * (0.7 + seeded01(s + 41.9) * 0.6);
      const dark = seeded01(s + 58.8) > 0.36;
      ctx.strokeStyle = dark
        ? `rgba(0,0,0,${localAlpha})`
        : `rgba(255,255,255,${localAlpha * 0.52})`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dx, y + dy);
      ctx.stroke();
    }
  });

  // Mid-frequency wool-flow ribbons so the texture reads at normal zoom.
  for (let y = 0; y < h; y += 1) {
    const t = y / h;
    const a = 0.045 + 0.045 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 4.3));
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    ctx.fillRect(0, y, w, 1);
  }

  // Tiny clustered tufts to avoid overly uniform flow.
  for (let i = 0; i < 260; i += 1) {
    const s = i * 31.27;
    const cx = seeded01(s + 2) * w;
    const cy = seeded01(s + 7) * h;
    const spokes = 3 + Math.floor(seeded01(s + 12) * 3);
    for (let k = 0; k < spokes; k += 1) {
      const a = seeded01(s + 20 + k * 3.1) * Math.PI * 2;
      const len = 1.2 + seeded01(s + 29 + k * 5.9) * 2.5;
      ctx.strokeStyle = `rgba(0,0,0,${0.06 + seeded01(s + 39 + k * 1.7) * 0.04})`;
      ctx.lineWidth = 0.28;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.stroke();
    }
  }

  // Fine grain to increase textile realism after tinting.
  for (let i = 0; i < 920; i += 1) {
    const s = i * 13.73;
    const x = seeded01(s + 3.2) * w;
    const y = seeded01(s + 7.1) * h;
    const bright = seeded01(s + 12.9) > 0.48;
    const a = 0.01 + seeded01(s + 18.4) * 0.03;
    const r = 0.22 + seeded01(s + 27.5) * 0.38;
    ctx.fillStyle = bright ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Apply felt inner-shadow from preset so panel tuning affects felt body. */
function applyFeltInnerShadow(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const shadow = MATERIAL_TEXTURE_PRESETS.felt.innerShadow;
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

/** Halo: center near 100% opacity (line color), smooth fade to transparent at edges. */
function drawFeltFuzzyStrip(ctx: CanvasRenderingContext2D): void {
  const W = FELT_STRIP_W;
  const H = FELT_STRIP_H;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.25)');
  g.addColorStop(0.38, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.46, 'rgba(255,255,255,0.98)');
  g.addColorStop(0.5, 'rgba(255,255,255,1)');
  g.addColorStop(0.54, 'rgba(255,255,255,0.98)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** Procedural felt strip texture (stable, no loading). */
function createFeltProceduralTexture(): Texture {
  const canvas = makeCanvas(FELT_STRIP_W, FELT_STRIP_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawFeltProceduralStrip(ctx, FELT_STRIP_W, FELT_STRIP_H);
  applyFeltBrightnessFilter(ctx, FELT_STRIP_W, FELT_STRIP_H);
  applyFeltEdgeOpacityEmphasis(ctx, FELT_STRIP_W, FELT_STRIP_H);
  applyFeltInnerShadow(ctx, FELT_STRIP_W, FELT_STRIP_H);
  return Texture.from({ resource: canvas });
}

/**
 * Build felt texture from bitmap.
 * Requirement: image long side maps to rope thickness direction (UV.v -> texture height).
 */
function createFeltTextureFromPattern(img: HTMLImageElement): Texture | null {
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (nw <= 0 || nh <= 0) return null;

  // Ensure long side is mapped to texture height (V).
  const longSide = Math.max(nw, nh);
  const shortSide = Math.min(nw, nh);
  const canvas = makeCanvas(shortSide, longSide);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (nh >= nw) {
    // Already portrait: width=short, height=long.
    ctx.drawImage(img, 0, 0, nw, nh, 0, 0, shortSide, longSide);
  } else {
    // Landscape: rotate 90° so long side becomes height (V).
    ctx.save();
    ctx.translate(shortSide, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, 0, 0, nw, nh, 0, 0, nw, nh);
    ctx.restore();
  }

  applyBitmapNeutralizeAndBrighten(ctx, shortSide, longSide, BITMAP_TONE_FELT);
  applyFeltBrightnessFilter(ctx, shortSide, longSide);
  applyFeltEdgeOpacityEmphasis(ctx, shortSide, longSide);
  applyFeltInnerShadow(ctx, shortSide, longSide);
  const tex = Texture.from({ resource: canvas });
  if (tex.source?.style) tex.source.style.addressMode = 'repeat';
  return tex;
}

function scheduleFeltPatternLoad(): void {
  if (feltPatternLoadStarted || typeof window === 'undefined') return;
  feltPatternLoadStarted = true;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const tex = createFeltTextureFromPattern(img);
    if (!tex) return;
    cachedFeltBitmap = tex;
    cachedFeltBitmapRev = FELT_BITMAP_LAYOUT_REV;
    const old = cachedFeltFallback;
    cachedFeltFallback = null;
    requestAnimationFrame(() => old?.destroy(true));
  };
  img.onerror = () => {
    // Keep procedural fallback.
  };
  img.src = FELT_PATTERN_SRC;
}

export function getFeltRopeTexture(): Texture {
  if (cachedFeltBitmap && cachedFeltBitmapRev !== FELT_BITMAP_LAYOUT_REV) {
    cachedFeltBitmap.destroy(true);
    cachedFeltBitmap = null;
    cachedFeltBitmapRev = -1;
    feltPatternLoadStarted = false;
  }
  if (cachedFeltBitmap) return cachedFeltBitmap;
  scheduleFeltPatternLoad();
  if (!cachedFeltFallback) {
    cachedFeltFallback = createFeltProceduralTexture();
    if (cachedFeltFallback.source?.style) cachedFeltFallback.source.style.addressMode = 'repeat';
  }
  return cachedFeltFallback;
}

export function getFeltRopeFuzzyTexture(): Texture {
  if (cachedFeltFuzzy) return cachedFeltFuzzy;
  const canvas = makeCanvas(FELT_STRIP_W, FELT_STRIP_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawFeltFuzzyStrip(ctx);
  cachedFeltFuzzy = Texture.from({ resource: canvas });
  if (cachedFeltFuzzy.source?.style) cachedFeltFuzzy.source.style.addressMode = 'repeat';
  return cachedFeltFuzzy;
}
