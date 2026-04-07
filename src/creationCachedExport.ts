import type { LoomCanvasHandle } from './components/LoomCanvas';
import { composeCanvasWithStoryBubbles, nextExportFrame } from './creationExportCompose';
import type { SavedCreation, SavedCreationThread } from './savedCreation';

/** Create 页 Freehand 细笔（与 WrapController 一致） */
const FREEHAND_THIN_PEN_COLOR = 0x221915;

function isFreehandThinPenStroke(t: SavedCreationThread): boolean {
  if (!t.polyline || t.polyline.length < 2) return false;
  const n = t.anchorIds?.length ?? 0;
  if (n >= 1) return false;
  return t.textureId === 'none' && t.color === FREEHAND_THIN_PEN_COLOR && t.lineWidth <= 1.5;
}

function isWeaveOnLoomStroke(t: SavedCreationThread): boolean {
  const n = t.anchorIds?.length ?? 0;
  if (n >= 2) return true;
  if (n === 1 && t.openTail) return true;
  return false;
}

/** 卡片栈 / Gallery：仅 peg 上的编织（含 open tail），不含空白处涂鸦 */
export function filterSavedCreationForCardPreview(creation: SavedCreation): SavedCreation {
  const kept: SavedCreationThread[] = [];
  const keptNames: string[] = [];
  const names = creation.threadNames;
  for (let i = 0; i < creation.threads.length; i++) {
    const t = creation.threads[i]!;
    if (isWeaveOnLoomStroke(t)) {
      kept.push(t);
      if (names && i < names.length) keptNames.push(names[i]!);
    }
  }
  return {
    ...creation,
    threads: kept,
    ...(names ? { threadNames: keptNames } : {}),
  };
}

/**
 * 详情顶图：织机创作 + loom 外材质涂鸦，不含 Freehand 细笔。
 */
export function filterSavedCreationForDetailFlat(creation: SavedCreation): SavedCreation {
  const kept: SavedCreationThread[] = [];
  const keptNames: string[] = [];
  const names = creation.threadNames;
  for (let i = 0; i < creation.threads.length; i++) {
    const t = creation.threads[i]!;
    if (!isFreehandThinPenStroke(t)) {
      kept.push(t);
      if (names && i < names.length) keptNames.push(names[i]!);
    }
  }
  return {
    ...creation,
    threads: kept,
    ...(names ? { threadNames: keptNames } : {}),
  };
}

/** 离屏构图目标（内容框比例），先裁再缩放到展示尺寸 */
export const CREATION_CARD_PREVIEW_W = 320;
export const CREATION_CARD_PREVIEW_H = 280;

/**
 * 与 `.creation-card-preview-inner` 一致；高度按 320:280 同比例，letterbox 进此尺寸可无左右留白，
 * 避免 4:3 框里按高度缩放导致内容只占 ~206px 宽、看起来像横向压扁。
 */
export const CREATION_CARD_STACK_DISPLAY_W = 240;
export const CREATION_CARD_STACK_DISPLAY_H = Math.round(
  (CREATION_CARD_STACK_DISPLAY_W * CREATION_CARD_PREVIEW_H) / CREATION_CARD_PREVIEW_W,
);

/** 详情页两张导出图边长（与 CreationDetailView 一致） */
export const CREATION_DETAIL_EXPORT_PX = 900;

/** 预览正方形半边长（内容空间）= rim 半径 + 该 buffer（px） */
export const LOOM_PREVIEW_SQUARE_RIM_BUFFER_CONTENT_PX = 18;
/** Card/Gallery preview: force scope slightly to bottom-right. */
export const CARD_PREVIEW_SCOPE_OFFSET_X_FRAC = -0.1;
export const CARD_PREVIEW_SCOPE_OFFSET_Y_FRAC = -0.15;

/**
 * My Creation 预览：以 loom 圆心为中心的正方形裁切（边长 = 2×halfSidePx，对应内容空间 rimRadius + buffer）。
 */
export type LoomPreviewSquareCanvasParams = { cx: number; cy: number; halfSidePx: number };

/** 将源图裁成以 (cx,cy) 为中心、边长 2×halfSidePx 的正方形，再 letterbox 到目标尺寸。 */
export function cropCanvasToLoomCenterSquare(
  srcCanvas: HTMLCanvasElement,
  params: LoomPreviewSquareCanvasParams,
  outW: number,
  outH: number,
  offsetXFrac = 0,
  offsetYFrac = 0,
): HTMLCanvasElement {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const r = Math.max(1, params.halfSidePx);
  const d = Math.max(2, Math.ceil(2 * r));
  const x0 = params.cx - r + offsetXFrac * d;
  const y0 = params.cy - r + offsetYFrac * d;

  const slice = document.createElement('canvas');
  slice.width = d;
  slice.height = d;
  const ctx = slice.getContext('2d');
  if (!ctx) return letterboxCanvasToFit(srcCanvas, outW, outH);

  const srcLeft = Math.max(0, Math.floor(x0));
  const srcTop = Math.max(0, Math.floor(y0));
  const srcRight = Math.min(sw, Math.ceil(x0 + d));
  const srcBottom = Math.min(sh, Math.ceil(y0 + d));
  const srcW = Math.max(0, srcRight - srcLeft);
  const srcH = Math.max(0, srcBottom - srcTop);
  const dstX = srcLeft - x0;
  const dstY = srcTop - y0;
  if (srcW > 0 && srcH > 0) {
    ctx.drawImage(srcCanvas, srcLeft, srcTop, srcW, srcH, dstX, dstY, srcW, srcH);
  }

  return letterboxCanvasToFit(slice, outW, outH);
}

/** Fallback: crop a centered square region from source canvas, then letterbox. */
export function cropCanvasCenterSquare(
  srcCanvas: HTMLCanvasElement,
  outW: number,
  outH: number,
  offsetXFrac = 0,
  offsetYFrac = 0,
): HTMLCanvasElement {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  if (sw <= 0 || sh <= 0) return letterboxCanvasToFit(srcCanvas, outW, outH);
  const d = Math.max(2, Math.min(sw, sh));
  const x0 = Math.floor((sw - d) / 2 + offsetXFrac * d);
  const y0 = Math.floor((sh - d) / 2 + offsetYFrac * d);
  const slice = document.createElement('canvas');
  slice.width = d;
  slice.height = d;
  const ctx = slice.getContext('2d');
  if (!ctx) return letterboxCanvasToFit(srcCanvas, outW, outH);
  ctx.drawImage(srcCanvas, x0, y0, d, d, 0, 0, d, d);
  return letterboxCanvasToFit(slice, outW, outH);
}

/**
 * 按非白像素得到内容包围盒，扩边后**按原宽高比**从源画布裁一块矩形（不强行套 outW:outH），
 * 再 `letterboxCanvasToFit` 等比装入目标尺寸。避免「先按比例裁源图 + 取整」导致裁切框比内容矮/窄而上下被吃掉。
 */
export function cropToContent(
  srcCanvas: HTMLCanvasElement,
  outW: number,
  outH: number,
  focusYBias = 0.5,
): HTMLCanvasElement {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;

  const fallback = () => {
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext('2d');
    if (!ctx) return out;
    ctx.drawImage(srcCanvas, 0, 0, sw, sh, 0, 0, outW, outH);
    return out;
  };

  const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

  try {
    const ctxSrc = srcCanvas.getContext('2d');
    if (!ctxSrc) return fallback();

    const step = Math.max(2, Math.floor(Math.min(sw, sh) / 280));
    const img = ctxSrc.getImageData(0, 0, sw, sh);
    const data = img?.data;
    if (!data) return fallback();

    const isNearWhite = (r: number, g: number, b: number): boolean => r > 250 && g > 250 && b > 250;

    let minX = sw;
    let minY = sh;
    let maxX = 0;
    let maxY = 0;
    let found = false;

    for (let y = 0; y < sh; y += step) {
      for (let x = 0; x < sw; x += step) {
        const i = (y * sw + x) * 4;
        const a = data[i + 3];
        if (a < 10) continue;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (isNearWhite(r, g, b)) continue;
        found = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (!found) return fallback();

    const coarseMinY = minY;
    const strideX = Math.max(2, Math.floor(sw / 320));
    topRefine: for (let y = 0; y < coarseMinY; y += 1) {
      for (let x = 0; x < sw; x += strideX) {
        const i = (y * sw + x) * 4;
        const a = data[i + 3];
        if (a < 10) continue;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (isNearWhite(r, g, b)) continue;
        minY = y;
        break topRefine;
      }
    }

    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const padX = Math.max(18, Math.round(contentW * 0.18));
    const baseY = Math.max(24, Math.round(contentH * 0.26));
    const skewY = Math.round(contentH * 0.12);
    const t = clamp01(focusYBias);
    const padTop = baseY + Math.round((1 - t) * skewY);
    const padBottom = baseY + Math.round(t * skewY);

    const ex0 = Math.max(0, minX - padX);
    const ex1 = Math.min(sw, maxX + padX + 1);
    const ey0 = Math.max(0, minY - padTop);
    const ey1 = Math.min(sh, maxY + padBottom + 1);

    const cw = Math.max(1, ex1 - ex0);
    const ch = Math.max(1, ey1 - ey0);

    const slice = document.createElement('canvas');
    slice.width = cw;
    slice.height = ch;
    const sctx = slice.getContext('2d');
    if (!sctx) return fallback();
    sctx.drawImage(srcCanvas, ex0, ey0, cw, ch, 0, 0, cw, ch);

    return letterboxCanvasToFit(slice, outW, outH);
  } catch {
    return fallback();
  }
}

/**
 * 与 CSS object-fit: contain 一致：等比缩放后居中，留白填底色。
 */
export function letterboxCanvasToFit(
  src: HTMLCanvasElement,
  outW: number,
  outH: number,
  background = '#ffffff',
): HTMLCanvasElement {
  const scale = Math.min(outW / src.width, outH / src.height);
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) return out;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, outW, outH);
  const dx = Math.floor((outW - dw) / 2);
  const dy = Math.floor((outH - dh) / 2);
  ctx.drawImage(src, 0, 0, src.width, src.height, dx, dy, dw, dh);
  return out;
}

/**
 * 离开 Create 时生成三种 PNG（各快照对应不同笔迹子集）：
 * - cardPreview：仅织机 peg 创作 → 卡片栈 / Gallery；loom 中心正方形裁切
 * - detailFlat：织机 + loom 外材质涂鸦，不含 Freehand 细笔 → 详情第一张
 * - detailBubbles：全部笔迹叠故事气泡 → 详情第二张
 */
export async function buildCreationCachedExportDataUrls(
  loom: LoomCanvasHandle,
  creation: SavedCreation,
): Promise<{ cardPreview: string; detailFlat: string; detailBubbles: string } | null> {
  const cardCreation = filterSavedCreationForCardPreview(creation);
  const flatCreation = filterSavedCreationForDetailFlat(creation);
  const settleFrames = 48;

  async function snapshotAfterLoad(c: SavedCreation): Promise<HTMLCanvasElement | null> {
    loom.resetExportView();
    const ok = loom.tryLoadCreation(c);
    if (!ok) return null;
    loom.resetExportView();
    loom.wakeExportTicker();
    for (let i = 0; i < settleFrames; i++) await nextExportFrame();
    return loom.getExportSnapshotCanvas();
  }

  try {
    const canvasCard = await snapshotAfterLoad(cardCreation);
    const canvasFlat = await snapshotAfterLoad(flatCreation);
    const canvasFull = await snapshotAfterLoad(creation);
    if (!canvasCard || !canvasFlat || !canvasFull) return null;

    const square = loom.getLoomPreviewSquareCanvasParams();
    const croppedCard = square
      ? cropCanvasToLoomCenterSquare(
          canvasCard,
          square,
          CREATION_CARD_PREVIEW_W,
          CREATION_CARD_PREVIEW_H,
          CARD_PREVIEW_SCOPE_OFFSET_X_FRAC,
          CARD_PREVIEW_SCOPE_OFFSET_Y_FRAC,
        )
      : cropCanvasCenterSquare(
          canvasCard,
          CREATION_CARD_PREVIEW_W,
          CREATION_CARD_PREVIEW_H,
          CARD_PREVIEW_SCOPE_OFFSET_X_FRAC,
          CARD_PREVIEW_SCOPE_OFFSET_Y_FRAC,
        );
    const cardSized = letterboxCanvasToFit(
      croppedCard,
      CREATION_CARD_STACK_DISPLAY_W,
      CREATION_CARD_STACK_DISPLAY_H,
    );
    const cardPreview = cardSized.toDataURL('image/png', 0.92);

    const detailFlat = cropToContent(
      canvasFlat,
      CREATION_DETAIL_EXPORT_PX,
      CREATION_DETAIL_EXPORT_PX,
      0.5,
    ).toDataURL('image/png', 0.92);

    const composed = composeCanvasWithStoryBubbles(canvasFull, loom, creation);
    const detailBubbles = cropToContent(
      composed,
      CREATION_DETAIL_EXPORT_PX,
      CREATION_DETAIL_EXPORT_PX,
      0.5,
    ).toDataURL('image/png', 0.92);

    return { cardPreview, detailFlat, detailBubbles };
  } finally {
    loom.tryLoadCreation(creation);
    loom.resetExportView();
    loom.wakeExportTicker();
    for (let i = 0; i < 12; i++) await nextExportFrame();
  }
}
