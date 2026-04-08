import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoomCanvas, type LoomCanvasHandle } from './LoomCanvas';
import type { SavedCreation } from '../savedCreation';
import {
  CREATION_CARD_PREVIEW_H,
  CREATION_CARD_PREVIEW_W,
  CARD_PREVIEW_SCOPE_OFFSET_X_FRAC,
  CARD_PREVIEW_SCOPE_OFFSET_Y_FRAC,
  CREATION_CARD_STACK_DISPLAY_H,
  CREATION_CARD_STACK_DISPLAY_W,
  CREATION_DETAIL_EXPORT_PX,
  cropCanvasCenterSquare,
  cropCanvasToLoomCenterSquare,
  cropToContent,
  filterSavedCreationForCardPreview,
  letterboxCanvasToFit,
} from '../creationCachedExport';
import {
  CARD_PREVIEW_LAYOUT_VERSION,
  getSavedCreationsForAdmin,
  SAVED_CREATIONS_UPDATED_EVENT,
  saveLastCreation,
  startNewProject,
  updateSavedCreationDisplayName,
} from '../savedCreation';
import { MATERIAL_TEXTURE_PRESETS, type MaterialTextureId } from '../rendering/materialTextures';
import { MemoryIndicator } from './MemoryIndicator';
import placeholderJan2026 from '../assets/creation-placeholder-jan-2026.png';
import placeholderFeb2026 from '../assets/creation-placeholder-feb-2026.png';

import './CreatePage.css';
import './CreationPage.css';

const iconSize = 14;

function IconBack() {
  return (
    <svg
      width={iconSize}
      height={iconSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M19 12H5" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function tintToHex(tint: number): string {
  const n = Math.max(0, Math.min(0xffffff, Math.round(tint)));
  return '#' + n.toString(16).padStart(6, '0');
}

/** Same content width as Create page canvas area (100vw - 2 * 24/720). */
const DETAIL_CANVAS_WIDTH = '100%';
const DETAIL_IMAGE_DEFAULT_OFFSET_Y = 24;
const STORIES_IMAGE_DEFAULT_OFFSET_Y = 56;
/** Fallback ring layout only; thread-anchored labels use y from canvas fractions. */
const STORIES_BUBBLES_RING_OFFSET_Y = -36;
const DETAIL_IMAGE_MIN_SCALE = 1;
const DETAIL_IMAGE_MAX_SCALE = 3;

type AndroidBridgeLike = {
  savePngToGallery?: (base64Data: string, filename: string) => string;
};

function sanitizeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function splitBubbleLines(name: string): string[] {
  return name.match(/.{1,20}/g) ?? [name];
}

async function savePngDataUrlWithAndroidFallback(dataUrl: string, filename: string): Promise<void> {
  const safeName = sanitizeFilename(filename);
  const bridge = (window as unknown as { AndroidBridge?: AndroidBridgeLike }).AndroidBridge;
  if (bridge?.savePngToGallery) {
    const raw = bridge.savePngToGallery(dataUrl, safeName);
    let parsed: { ok?: boolean; message?: string } | null = null;
    try {
      parsed = JSON.parse(raw) as { ok?: boolean; message?: string };
    } catch {
      parsed = null;
    }
    if (!parsed?.ok) {
      throw new Error(parsed?.message || '保存到安卓相册失败');
    }
    return;
  }

  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const CreationExportedImage = memo(function CreationExportedImage(props: {
  creation: SavedCreation;
  outWidth: number;
  outHeight: number;
  imageClassName: string;
  imageStyle?: React.CSSProperties;
  hiddenHostClassName?: string;
  trimTopAndBottom?: boolean;
  focusYBias?: number;
  cropMode?: 'content' | 'full';
  onPngUrlChange?: (url: string | null) => void;
  /** Card stack：使用离开 Create 时缓存的无气泡卡片图。 */
  useStoredExportPreview?: boolean;
}) {
  const {
    creation,
    outWidth,
    outHeight,
    imageClassName,
    imageStyle,
    hiddenHostClassName = 'creation-card-export-host',
    trimTopAndBottom = true,
    focusYBias = 0.5,
    cropMode = 'content',
    onPngUrlChange,
    useStoredExportPreview = false,
  } = props;
  const loomRef = useRef<LoomCanvasHandle | null>(null);
  const exportHostRef = useRef<HTMLDivElement | null>(null);
  const cachedExport =
    useStoredExportPreview &&
    creation.cardPreviewLayoutVersion === CARD_PREVIEW_LAYOUT_VERSION &&
    creation.cachedCardPreviewPngDataUrl
      ? creation.cachedCardPreviewPngDataUrl
      : undefined;
  const [pngUrl, setPngUrl] = useState<string | null>(() => cachedExport ?? null);

  const textureId: MaterialTextureId = creation.ui?.textureId ?? 'none';
  const previewBackgroundHex = creation.ui?.canvasBackgroundHex ?? '#ffffff';
  const colorHex = creation.ui?.colorHex ?? tintToHex(MATERIAL_TEXTURE_PRESETS[textureId].color);
  const thickness = creation.ui?.thickness ?? 35;
  const opacity = creation.ui?.opacity ?? 100;
  const softness = creation.ui?.softness ?? (1 - MATERIAL_TEXTURE_PRESETS[textureId].stiffness) * 100;

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  useEffect(() => {
    if (cachedExport) {
      setPngUrl(cachedExport);
      onPngUrlChange?.(cachedExport);
      return;
    }
  }, [cachedExport, onPngUrlChange]);

  useEffect(() => {
    if (cachedExport) return;

    let cancelled = false;

    const run = async () => {
      setPngUrl(null);
      onPngUrlChange?.(null);

      // Wait for LoomCanvas to mount (needed when creation changed and we previously had pngUrl).
      for (let i = 0; i < 60; i += 1) {
        if (cancelled) return;
        await nextFrame();
        if (exportHostRef.current && loomRef.current) break;
      }

      for (let i = 0; i < 120; i += 1) {
        if (cancelled) return;
        const loom = loomRef.current;
        if (!loom) {
          await nextFrame();
          continue;
        }
        const savedShape = creation.ui?.loomShape === 'triangle' ? 'triangle' : 'circle';
        loom.setLoomShape(savedShape, true);
        const ok = loom.tryLoadCreation(creation);
        if (ok) break;
        await nextFrame();
      }

      for (let i = 0; i < 40; i += 1) {
        if (cancelled) return;
        await nextFrame();
      }

      const host = exportHostRef.current;
      const loom = loomRef.current;
      const canvas =
        loom?.getExportSnapshotCanvas() ??
        (host?.querySelector('canvas') as HTMLCanvasElement | null);
      if (!host || !canvas || canvas.width === 0 || canvas.height === 0) return;

      const useLoomSquareCrop =
        cropMode !== 'full' &&
        outWidth === CREATION_CARD_PREVIEW_W &&
        outHeight === CREATION_CARD_PREVIEW_H;

      try {
        const square = useLoomSquareCrop ? loom?.getLoomPreviewSquareCanvasParams() ?? null : null;
        const cropped =
          cropMode === 'full'
            ? (() => {
                const full = document.createElement('canvas');
                full.width = outWidth;
                full.height = outHeight;
                const ctx = full.getContext('2d');
                if (!ctx) return full;
                ctx.fillStyle = previewBackgroundHex;
                ctx.fillRect(0, 0, outWidth, outHeight);
                ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, outWidth, outHeight);
                return full;
              })()
            : square
              ? cropCanvasToLoomCenterSquare(
                  canvas,
                  square,
                  outWidth,
                  outHeight,
                  CARD_PREVIEW_SCOPE_OFFSET_X_FRAC,
                  CARD_PREVIEW_SCOPE_OFFSET_Y_FRAC,
                )
            : (useLoomSquareCrop
              ? cropCanvasCenterSquare(
                  canvas,
                  outWidth,
                  outHeight,
                  CARD_PREVIEW_SCOPE_OFFSET_X_FRAC,
                  CARD_PREVIEW_SCOPE_OFFSET_Y_FRAC,
                )
              : cropToContent(canvas, outWidth, outHeight, focusYBias));
        if (!trimTopAndBottom) {
          // Detail header image should show full exported content without extra post-scale/crop.
          const url = cropped.toDataURL('image/png');
          if (!cancelled) {
            setPngUrl(url);
            onPngUrlChange?.(url);
          }
          return;
        }
        // 卡片：与缓存导出一致，letterbox 到 240×210（与 320:280 同比例），避免 4:3 框里显窄
        if (outWidth === CREATION_CARD_PREVIEW_W && outHeight === CREATION_CARD_PREVIEW_H) {
          const cardSized = letterboxCanvasToFit(
            cropped,
            CREATION_CARD_STACK_DISPLAY_W,
            CREATION_CARD_STACK_DISPLAY_H,
          );
          const url = cardSized.toDataURL('image/png');
          if (!cancelled) {
            setPngUrl(url);
            onPngUrlChange?.(url);
          }
          return;
        }
        const topCutFrac = 0.05;
        const bottomCutFrac = 0.30;
        const topCutPx = Math.max(0, Math.round(cropped.height * topCutFrac));
        const keepPx = Math.max(1, Math.round(cropped.height * (1 - topCutFrac - bottomCutFrac)));
        const cutCanvas = document.createElement('canvas');
        cutCanvas.width = cropped.width;
        cutCanvas.height = keepPx;
        const cutCtx = cutCanvas.getContext('2d');
        if (!cutCtx) return;
        cutCtx.drawImage(
          cropped,
          0,
          topCutPx,
          cropped.width,
          keepPx,
          0,
          0,
          cutCanvas.width,
          cutCanvas.height,
        );

        const url = cutCanvas.toDataURL('image/png');
        if (!cancelled) {
          setPngUrl(url);
          onPngUrlChange?.(url);
        }
      } catch {
        const square = useLoomSquareCrop ? loom?.getLoomPreviewSquareCanvasParams() ?? null : null;
        const fallback =
          cropMode === 'full'
            ? (() => {
                const full = document.createElement('canvas');
                full.width = outWidth;
                full.height = outHeight;
                const ctx = full.getContext('2d');
                if (!ctx) return full;
                ctx.fillStyle = previewBackgroundHex;
                ctx.fillRect(0, 0, outWidth, outHeight);
                ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, outWidth, outHeight);
                return full;
              })()
            : square
              ? cropCanvasToLoomCenterSquare(
                  canvas,
                  square,
                  outWidth,
                  outHeight,
                  CARD_PREVIEW_SCOPE_OFFSET_X_FRAC,
                  CARD_PREVIEW_SCOPE_OFFSET_Y_FRAC,
                )
            : (useLoomSquareCrop
              ? cropCanvasCenterSquare(
                  canvas,
                  outWidth,
                  outHeight,
                  CARD_PREVIEW_SCOPE_OFFSET_X_FRAC,
                  CARD_PREVIEW_SCOPE_OFFSET_Y_FRAC,
                )
              : cropToContent(canvas, outWidth, outHeight, focusYBias));
        if (!trimTopAndBottom) {
          const url = fallback.toDataURL('image/png');
          if (!cancelled) {
            setPngUrl(url);
            onPngUrlChange?.(url);
          }
          return;
        }
        if (outWidth === CREATION_CARD_PREVIEW_W && outHeight === CREATION_CARD_PREVIEW_H) {
          const cardSized = letterboxCanvasToFit(
            fallback,
            CREATION_CARD_STACK_DISPLAY_W,
            CREATION_CARD_STACK_DISPLAY_H,
          );
          const url = cardSized.toDataURL('image/png');
          if (!cancelled) {
            setPngUrl(url);
            onPngUrlChange?.(url);
          }
          return;
        }
        const topCutFrac = 0.05;
        const bottomCutFrac = 0.30;
        const topCutPx = Math.max(0, Math.round(fallback.height * topCutFrac));
        const keepPx = Math.max(1, Math.round(fallback.height * (1 - topCutFrac - bottomCutFrac)));
        const cutCanvas = document.createElement('canvas');
        cutCanvas.width = fallback.width;
        cutCanvas.height = keepPx;
        const cutCtx = cutCanvas.getContext('2d');
        if (!cutCtx) return;
        cutCtx.drawImage(
          fallback,
          0,
          topCutPx,
          fallback.width,
          keepPx,
          0,
          0,
          cutCanvas.width,
          cutCanvas.height,
        );
        const url = cutCanvas.toDataURL('image/png');
        if (!cancelled) {
          setPngUrl(url);
          onPngUrlChange?.(url);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [cachedExport, creation, outWidth, outHeight, trimTopAndBottom, focusYBias, cropMode, onPngUrlChange]);

  if (cachedExport) {
    return <img className={imageClassName} style={imageStyle} src={cachedExport} alt="" />;
  }

  return (
    <>
      {pngUrl ? (
        <img className={imageClassName} style={imageStyle} src={pngUrl} alt="" />
      ) : (
        <div className={`${imageClassName} creation-export-loading`} style={imageStyle} aria-label="Loading image">
          <span className="creation-export-loading-spinner" aria-hidden />
        </div>
      )}
      {!pngUrl && (
        <div ref={exportHostRef} className={hiddenHostClassName} aria-hidden>
          <LoomCanvas
            ref={loomRef}
            textureId={textureId}
            canvasBackground={previewBackgroundHex}
            color={colorHex}
            thickness={thickness}
            opacity={opacity}
            softness={softness}
            skipIdleOnInit
          />
        </div>
      )}
    </>
  );
});

const CreationPreview = memo(function CreationPreview(props: { creation: SavedCreation }) {
  const { creation } = props;
  const cachedOk =
    creation.cachedCardPreviewPngDataUrl &&
    creation.cardPreviewLayoutVersion === CARD_PREVIEW_LAYOUT_VERSION;
  return (
    <div className="creation-card-preview-inner" aria-hidden>
      {cachedOk ? (
        <img className="creation-card-preview-img" src={creation.cachedCardPreviewPngDataUrl} alt="" />
      ) : (
        <CreationExportedImage
          creation={filterSavedCreationForCardPreview(creation)}
          outWidth={CREATION_CARD_PREVIEW_W}
          outHeight={CREATION_CARD_PREVIEW_H}
          imageClassName="creation-card-preview-img"
          trimTopAndBottom
        />
      )}
    </div>
  );
});

type DeckCard =
  | {
      kind: 'creation';
      id: string;
      creation: SavedCreation;
    }
  | {
      kind: 'cta';
      id: string;
      title: string;
      subtitle: string;
      monthLabel: string;
      previewSrc: string;
    }
  | {
      kind: 'guide';
      id: string;
      title: string;
      subtitle: string;
      monthLabel: string;
      previewSrc: string;
    };

const MAX_VISIBLE = 4;
const SWIPE_THRESHOLD_PX = 50;

function buildDeckFromSavedCreations(saved: SavedCreation[]): DeckCard[] {
  const n = saved.length;
  return [
    ...saved.map((creation, index): DeckCard => ({
      kind: 'creation',
      id: `creation-${creation.savedAt}-${index}`,
      creation,
    })),
    {
      kind: 'guide',
      id: 'creation-guide',
      title: 'Swipe the cards',
      subtitle: 'Your latest work stays on top. Swiping rotates the stack.',
      monthLabel: 'Feb 2026',
      previewSrc: placeholderFeb2026,
    },
    {
      kind: 'cta',
      id: 'creation-cta',
      title: n > 0 ? 'Start a new project' : 'Create your first project',
      subtitle: '',
      monthLabel: 'Jan 2026',
      previewSrc: placeholderJan2026,
    },
  ];
}

function getCardMonthLabel(card: DeckCard): string {
  if (card.kind === 'creation') {
    return new Date(card.creation.savedAt).toLocaleString('en-US', { month: 'short', year: 'numeric' });
  }
  return card.monthLabel;
}

const CreationDetailView = memo(function CreationDetailView(props: {
  creation: SavedCreation;
  onCreationRenamed?: (next: SavedCreation) => void;
  onEditCreation?: (creation: SavedCreation) => void;
}) {
  const { creation, onCreationRenamed, onEditCreation } = props;
  /** 离屏 Loom 导出的无气泡详情图（无 `cachedDetailFlatPngDataUrl` 时使用） */
  const [liveFlatUrl, setLiveFlatUrl] = useState<string | null>(null);
  const [isSavingToAlbum, setIsSavingToAlbum] = useState(false);
  const [saveDoneFlash, setSaveDoneFlash] = useState(false);
  const detailImageDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  const detailImagePinchRef = useRef<{
    startDistance: number;
    startScale: number;
  } | null>(null);
  /** 双指中点（client 坐标），用于触摸平移 */
  const detailImageTwoFingerMidRef = useRef<{ x: number; y: number } | null>(null);
  const storiesWrapRef = useRef<HTMLDivElement | null>(null);
  const storiesImageDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  const storiesImagePinchRef = useRef<{
    startDistance: number;
    startScale: number;
  } | null>(null);
  const storiesImageTwoFingerMidRef = useRef<{ x: number; y: number } | null>(null);
  const [detailImageOffset, setDetailImageOffset] = useState({ x: 0, y: DETAIL_IMAGE_DEFAULT_OFFSET_Y });
  const [detailImageScale, setDetailImageScale] = useState(1);
  const [detailImageDragging, setDetailImageDragging] = useState(false);
  const [storiesImageOffset, setStoriesImageOffset] = useState({ x: 0, y: STORIES_IMAGE_DEFAULT_OFFSET_Y });
  const [storiesImageScale, setStoriesImageScale] = useState(1);
  const [storiesImageDragging, setStoriesImageDragging] = useState(false);
  const [storiesSize, setStoriesSize] = useState({ width: 0, height: 0 });
  const [bubbleOffsets, setBubbleOffsets] = useState<Record<number, { x: number; y: number }>>({});

  const dateLabel = useMemo(
    () =>
      new Date(creation.savedAt).toLocaleString('en-US', {
        month: 'long',
        year: 'numeric',
      }),
    [creation.savedAt]
  );

  useEffect(() => {
    setDetailImageOffset({ x: 0, y: DETAIL_IMAGE_DEFAULT_OFFSET_Y });
    setDetailImageScale(1);
    detailImageDragRef.current = null;
    detailImagePinchRef.current = null;
    detailImageTwoFingerMidRef.current = null;
    setDetailImageDragging(false);
    setStoriesImageOffset({ x: 0, y: STORIES_IMAGE_DEFAULT_OFFSET_Y });
    setStoriesImageScale(1);
    storiesImageDragRef.current = null;
    storiesImagePinchRef.current = null;
    storiesImageTwoFingerMidRef.current = null;
    setStoriesImageDragging(false);
    setBubbleOffsets({});
    setLiveFlatUrl(null);
    setIsSavingToAlbum(false);
    setSaveDoneFlash(false);
  }, [creation.savedAt]);

  const threadNames = useMemo(
    () =>
      creation.threadNames ??
      (Array.isArray(creation.threads) ? creation.threads.map((_, i) => `Line ${i + 1}`) : []),
    [creation.threadNames, creation.threads]
  );
  const indicesToShow = useMemo(
    () =>
      threadNames
        .map((name, i) => ({ name, i }))
        .filter(({ name }) => !/^Line \d+$/.test(name)),
    [threadNames]
  );
  const storiesBubbles = useMemo(() => {
    const n = indicesToShow.length;
    if (n === 0) return [];
    const startAngle = -Math.PI / 2;
    const radiusPercent = 44;
    return indicesToShow.map(({ name, i }, idx) => {
      const angle = startAngle + (Math.PI * 2 * idx) / n;
      return {
        name,
        threadIndex: i,
        leftPercent: 50 + Math.cos(angle) * radiusPercent,
        topPercent: 50 + Math.sin(angle) * radiusPercent,
      };
    });
  }, [indicesToShow]);

  const flatDisplayUrl = creation.cachedDetailFlatPngDataUrl ?? liveFlatUrl;
  const storiesBgUrl =
    creation.cachedDetailBubblesPngDataUrl ?? liveFlatUrl ?? creation.cachedDetailFlatPngDataUrl ?? null;
  const showDomStoryBubbles = !creation.cachedDetailBubblesPngDataUrl && storiesBubbles.length > 0;
  const detailBackgroundHex = creation.ui?.canvasBackgroundHex ?? '#ffffff';

  const buildDetailExportWithBubbles = useCallback(async (): Promise<string | null> => {
    if (!flatDisplayUrl) return null;
    const outSize = CREATION_DETAIL_EXPORT_PX;
    const baseImage = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('base image load failed'));
      img.src = flatDisplayUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return flatDisplayUrl;
    ctx.drawImage(baseImage, 0, 0, outSize, outSize);

    const scaleX = storiesSize.width > 0 ? outSize / storiesSize.width : 1;
    const scaleY = storiesSize.height > 0 ? outSize / storiesSize.height : 1;

    const drawRoundedRect = (x: number, y: number, w: number, h: number, r: number) => {
      const radius = Math.max(0, Math.min(r, w / 2, h / 2));
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();
    };

    ctx.font = '500 10px Inter, "Noto Sans", sans-serif';
    ctx.textBaseline = 'top';
    for (const [i, bubble] of storiesBubbles.entries()) {
      const lines = splitBubbleLines(bubble.name);
      const maxLineLen = lines.reduce((m, line) => Math.max(m, line.length), 0);
      const bubbleW = Math.min(20 * 10 * 0.62 + 16, maxLineLen * 10 * 0.62 + 16);
      const bubbleH = Math.min(72, lines.length * 10 * 1.25 + 8);
      const ox = (bubbleOffsets[i]?.x ?? 0) * scaleX;
      const oy = (bubbleOffsets[i]?.y ?? 0) * scaleY;

      let centerX: number;
      let centerY: number;
      centerX = ((bubble as { leftPercent: number }).leftPercent / 100) * outSize + ox;
      centerY = ((bubble as { topPercent: number }).topPercent / 100) * outSize + STORIES_BUBBLES_RING_OFFSET_Y + oy;

      const x = centerX - bubbleW / 2;
      const y = centerY - bubbleH / 2;
      ctx.fillStyle = 'rgba(128, 64, 128, 0.65)';
      drawRoundedRect(x, y, bubbleW, bubbleH, 6);

      ctx.fillStyle = '#ffffff';
      const textX = x + 8;
      let textY = y + 4;
      for (const line of lines) {
        ctx.fillText(line, textX, textY, bubbleW - 16);
        textY += 12.5;
      }
    }

    return canvas.toDataURL('image/png');
  }, [bubbleOffsets, flatDisplayUrl, storiesBubbles, storiesSize.height, storiesSize.width]);

  const handleSaveToAlbum = useCallback(async () => {
    if ((!flatDisplayUrl && !creation.cachedDetailBubblesPngDataUrl) || isSavingToAlbum) return;
    setIsSavingToAlbum(true);
    try {
      const iso = new Date(creation.savedAt).toISOString().replace(/[:]/g, '-');
      const filename = `my-creation-${iso}.png`;
      if (creation.cachedDetailBubblesPngDataUrl && !showDomStoryBubbles) {
        await savePngDataUrlWithAndroidFallback(creation.cachedDetailBubblesPngDataUrl, filename);
      } else {
        const exportUrl = await buildDetailExportWithBubbles();
        await savePngDataUrlWithAndroidFallback(exportUrl ?? flatDisplayUrl!, filename);
      }
      setSaveDoneFlash(true);
      window.setTimeout(() => setSaveDoneFlash(false), 1200);
    } finally {
      setIsSavingToAlbum(false);
    }
  }, [
    buildDetailExportWithBubbles,
    creation.cachedDetailBubblesPngDataUrl,
    creation.savedAt,
    flatDisplayUrl,
    isSavingToAlbum,
    showDomStoryBubbles,
  ]);

  const handleNameIt = useCallback(() => {
    const initial = creation.displayName ?? '';
    const name = window.prompt('Name your creation', initial);
    if (name === null) return;
    const next = updateSavedCreationDisplayName(creation.savedAt, name);
    if (next) onCreationRenamed?.(next);
  }, [creation.displayName, creation.savedAt, onCreationRenamed]);

  useEffect(() => {
    const el = storiesWrapRef.current;
    if (!el) return;
    const update = () => setStoriesSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onDetailImagePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'touch') return;
    detailImageDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: detailImageOffset.x,
      baseY: detailImageOffset.y,
    };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    setDetailImageDragging(true);
  }, [detailImageOffset.x, detailImageOffset.y]);

  const onDetailImagePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dragState = detailImageDragRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    setDetailImageOffset({
      x: dragState.baseX + dx,
      y: dragState.baseY + dy,
    });
  }, []);

  const onDetailImagePointerEndLike = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dragState = detailImageDragRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    detailImageDragRef.current = null;
    setDetailImageDragging(false);
  }, []);

  const onDetailImageWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.cancelable) e.preventDefault();
    const zoomDelta = -e.deltaY * 0.0018;
    setDetailImageScale((prev) =>
      Math.max(DETAIL_IMAGE_MIN_SCALE, Math.min(DETAIL_IMAGE_MAX_SCALE, prev * (1 + zoomDelta)))
    );
  }, []);

  const onDetailImageTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 2) return;
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    detailImageTwoFingerMidRef.current = null;
    detailImagePinchRef.current = {
      startDistance: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
      startScale: detailImageScale,
    };
  }, [detailImageScale]);

  const onDetailImageTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 2) return;
    const pinch = detailImagePinchRef.current;
    if (!pinch || pinch.startDistance <= 0) return;
    if (e.cancelable) e.preventDefault();
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    const midX = (t0.clientX + t1.clientX) / 2;
    const midY = (t0.clientY + t1.clientY) / 2;
    const prevMid = detailImageTwoFingerMidRef.current;
    if (prevMid) {
      setDetailImageOffset((o) => ({
        x: o.x + (midX - prevMid.x),
        y: o.y + (midY - prevMid.y),
      }));
    }
    detailImageTwoFingerMidRef.current = { x: midX, y: midY };
    const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    const nextScale = pinch.startScale * (dist / pinch.startDistance);
    setDetailImageScale(Math.max(DETAIL_IMAGE_MIN_SCALE, Math.min(DETAIL_IMAGE_MAX_SCALE, nextScale)));
  }, []);

  const onDetailImageTouchEnd = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      detailImagePinchRef.current = null;
      detailImageTwoFingerMidRef.current = null;
    }
  }, []);

  const onStoriesImagePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'touch') return;
    storiesImageDragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: storiesImageOffset.x,
      baseY: storiesImageOffset.y,
    };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    setStoriesImageDragging(true);
  }, [storiesImageOffset.x, storiesImageOffset.y]);

  const onStoriesImagePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dragState = storiesImageDragRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    setStoriesImageOffset({
      x: dragState.baseX + dx,
      y: dragState.baseY + dy,
    });
  }, []);

  const onStoriesImagePointerEndLike = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const dragState = storiesImageDragRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    storiesImageDragRef.current = null;
    setStoriesImageDragging(false);
  }, []);

  const onStoriesImageWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.cancelable) e.preventDefault();
    const zoomDelta = -e.deltaY * 0.0018;
    setStoriesImageScale((prev) =>
      Math.max(DETAIL_IMAGE_MIN_SCALE, Math.min(DETAIL_IMAGE_MAX_SCALE, prev * (1 + zoomDelta)))
    );
  }, []);

  const onStoriesImageTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 2) return;
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    storiesImageTwoFingerMidRef.current = null;
    storiesImagePinchRef.current = {
      startDistance: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
      startScale: storiesImageScale,
    };
  }, [storiesImageScale]);

  const onStoriesImageTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 2) return;
    const pinch = storiesImagePinchRef.current;
    if (!pinch || pinch.startDistance <= 0) return;
    if (e.cancelable) e.preventDefault();
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    const midX = (t0.clientX + t1.clientX) / 2;
    const midY = (t0.clientY + t1.clientY) / 2;
    const prevMid = storiesImageTwoFingerMidRef.current;
    if (prevMid) {
      setStoriesImageOffset((o) => ({
        x: o.x + (midX - prevMid.x),
        y: o.y + (midY - prevMid.y),
      }));
    }
    storiesImageTwoFingerMidRef.current = { x: midX, y: midY };
    const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    const nextScale = pinch.startScale * (dist / pinch.startDistance);
    setStoriesImageScale(Math.max(DETAIL_IMAGE_MIN_SCALE, Math.min(DETAIL_IMAGE_MAX_SCALE, nextScale)));
  }, []);

  const onStoriesImageTouchEnd = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      storiesImagePinchRef.current = null;
      storiesImageTwoFingerMidRef.current = null;
    }
  }, []);

  const onBubblePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, bubbleIndex: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    const target = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;
    const base = bubbleOffsets[bubbleIndex] ?? { x: 0, y: 0 };
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      setBubbleOffsets((prev) => ({
        ...prev,
        [bubbleIndex]: { x: base.x + dx, y: base.y + dy },
      }));
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onEnd);
      target.removeEventListener('pointercancel', onEnd);
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onEnd);
    target.addEventListener('pointercancel', onEnd);
  }, [bubbleOffsets]);

  return (
    <div className="creation-detail-view">
      <div className="creation-detail-date">{dateLabel}</div>
      <div
        className={`creation-detail-canvas-wrap creation-detail-canvas-wrap--draggable${detailImageDragging ? ' is-dragging' : ''}`}
        style={{ width: DETAIL_CANVAS_WIDTH, background: detailBackgroundHex }}
        onPointerDown={onDetailImagePointerDown}
        onPointerMove={onDetailImagePointerMove}
        onPointerUp={onDetailImagePointerEndLike}
        onPointerCancel={onDetailImagePointerEndLike}
        onWheel={onDetailImageWheel}
        onTouchStart={onDetailImageTouchStart}
        onTouchMove={onDetailImageTouchMove}
        onTouchEnd={onDetailImageTouchEnd}
        onTouchCancel={onDetailImageTouchEnd}
      >
        {!creation.cachedDetailFlatPngDataUrl ? (
          <CreationExportedImage
            creation={creation}
            outWidth={CREATION_DETAIL_EXPORT_PX}
            outHeight={CREATION_DETAIL_EXPORT_PX}
            imageClassName="creation-detail-hidden-img"
            imageStyle={{ display: 'none' }}
            hiddenHostClassName="creation-detail-export-host"
            trimTopAndBottom={false}
            onPngUrlChange={setLiveFlatUrl}
          />
        ) : null}
        {flatDisplayUrl ? (
          <img
            className="creation-detail-static-img"
            style={{
              transform: `translate(${detailImageOffset.x}px, ${detailImageOffset.y}px) scale(${detailImageScale})`,
              transformOrigin: 'center center',
              transition: detailImageDragging ? 'none' : 'transform 120ms ease-out',
            }}
            src={flatDisplayUrl}
            alt=""
          />
        ) : (
          <div
            className="creation-detail-static-img creation-export-loading"
            style={{
              background: detailBackgroundHex,
              transform: `translate(${detailImageOffset.x}px, ${detailImageOffset.y}px) scale(${detailImageScale})`,
              transformOrigin: 'center center',
              transition: detailImageDragging ? 'none' : 'transform 120ms ease-out',
            }}
            aria-label="Loading image"
          >
            <span className="creation-export-loading-spinner" aria-hidden />
          </div>
        )}
      </div>
      <div className="creation-detail-actions-row">
        <button
          type="button"
          className="creation-detail-save-btn"
          onClick={() => { void handleSaveToAlbum(); }}
          disabled={(!flatDisplayUrl && !creation.cachedDetailBubblesPngDataUrl) || isSavingToAlbum}
        >
          {isSavingToAlbum ? 'Saving...' : saveDoneFlash ? 'Saved' : 'Save to album'}
        </button>
        <button type="button" className="creation-detail-name-btn" onClick={handleNameIt}>
          Name it
        </button>
      </div>
      <h2 className="creation-detail-stories-title">Stories Behind Materials</h2>
      <div
        className={`creation-detail-stories-wrap creation-detail-canvas-wrap--draggable${storiesImageDragging ? ' is-dragging' : ''}`}
        ref={storiesWrapRef}
        style={{ width: DETAIL_CANVAS_WIDTH, background: detailBackgroundHex }}
        onPointerDown={onStoriesImagePointerDown}
        onPointerMove={onStoriesImagePointerMove}
        onPointerUp={onStoriesImagePointerEndLike}
        onPointerCancel={onStoriesImagePointerEndLike}
        onWheel={onStoriesImageWheel}
        onTouchStart={onStoriesImageTouchStart}
        onTouchMove={onStoriesImageTouchMove}
        onTouchEnd={onStoriesImageTouchEnd}
        onTouchCancel={onStoriesImageTouchEnd}
      >
        <div
          className="creation-detail-stories-pan-layer"
          style={{
            transform: `translate(${storiesImageOffset.x}px, ${storiesImageOffset.y}px) scale(${storiesImageScale})`,
            transformOrigin: 'center center',
            transition: storiesImageDragging ? 'none' : 'transform 120ms ease-out',
          }}
        >
          {storiesBgUrl ? (
            <img className="creation-detail-stories-img" src={storiesBgUrl} alt="" />
          ) : null}
          {showDomStoryBubbles
            ? storiesBubbles.map((bubble, i) => {
            const lines = splitBubbleLines(bubble.name);
            const maxLineLen = lines.reduce((m, line) => Math.max(m, line.length), 0);
            const estW = Math.min(20 * 10 * 0.62 + 16, maxLineLen * 10 * 0.62 + 16);
            const estH = Math.min(72, lines.length * 10 * 1.25 + 8);
            const halfW = estW / 2;
            const halfH = estH / 2;
            const ox = bubbleOffsets[i]?.x ?? 0;
            const oy = bubbleOffsets[i]?.y ?? 0;
            const rawX = (storiesSize.width * (bubble as { leftPercent: number }).leftPercent) / 100 + ox;
            const rawY =
              (storiesSize.height * (bubble as { topPercent: number }).topPercent) / 100
              + STORIES_BUBBLES_RING_OFFSET_Y
              + oy;
            const left = storiesSize.width > 0
              ? Math.max(halfW + 4, Math.min(storiesSize.width - halfW - 4, rawX))
              : rawX;
            const top = storiesSize.height > 0
              ? Math.max(halfH + 4, Math.min(storiesSize.height - halfH - 4, rawY))
              : rawY;
            return (
              <div
                key={bubble.threadIndex}
                className="creation-detail-label-outer"
                style={{
                  left: `${left}px`,
                  top: `${top}px`,
                  transform: 'translate(-50%, -50%)',
                }}
                onPointerDown={(e) => onBubblePointerDown(e, i)}
              >
                <span className="creation-detail-label">
                  {lines.join('\n')}
                </span>
              </div>
            );
          })
            : null}
        </div>
      </div>
      <button
        type="button"
        className="creation-detail-edit-btn"
        onClick={() => onEditCreation?.(creation)}
      >
        Edit your creation
      </button>
    </div>
  );
});

export function CreationPage() {
  const navigate = useNavigate();

  const [deck, setDeck] = useState<DeckCard[]>(() => {
    const saved = getSavedCreationsForAdmin().slice().sort((a, b) => b.savedAt - a.savedAt);
    return buildDeckFromSavedCreations(saved);
  });

  const [galleryView, setGalleryView] = useState(false);
  const [shareSheetOpen, setShareSheetOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [selectedCreation, setSelectedCreation] = useState<{ creation: SavedCreation; depth: number } | null>(null);
  const detailScrollWrapRef = useRef<HTMLDivElement | null>(null);
  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const touchIdRef = useRef<number | null>(null);
  const justSwipeRef = useRef(false);
  const [detailScrollTop, setDetailScrollTop] = useState(0);
  const [detailViewportHeight, setDetailViewportHeight] = useState(1);
  const [detailScrollHeight, setDetailScrollHeight] = useState(1);
  const detailScrollbarDragRef = useRef<{ pointerId: number; startClientY: number; startScrollTop: number } | null>(
    null,
  );

  const creations = useMemo(
    () =>
      deck
        .filter((card): card is Extract<DeckCard, { kind: 'creation' }> => card.kind === 'creation')
        .map((card) => card.creation),
    [deck],
  );
  const galleryItems = useMemo(
    () =>
      creations.map((creation, index) => ({
        id: `creation-${creation.savedAt}-${index}`,
        creation,
      })),
    [creations],
  );

  const shareUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const { origin, pathname } = window.location;
    return `${origin}${pathname}#/creation`;
  }, []);

  const shareBlurb = 'My menstrual art from Loom — explore yours.';

  useEffect(() => {
    const refreshFromStorage = () => {
      const saved = getSavedCreationsForAdmin().slice().sort((a, b) => b.savedAt - a.savedAt);
      setDeck(buildDeckFromSavedCreations(saved));
      setSelectedCreation((prev) => {
        if (!prev) return prev;
        const next = saved.find((c) => c.savedAt === prev.creation.savedAt);
        return next ? { ...prev, creation: next } : null;
      });
    };
    window.addEventListener(SAVED_CREATIONS_UPDATED_EVENT, refreshFromStorage);
    return () => window.removeEventListener(SAVED_CREATIONS_UPDATED_EVENT, refreshFromStorage);
  }, []);

  useEffect(() => {
    if (!shareSheetOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShareSheetOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prev;
    };
  }, [shareSheetOpen]);

  const canNativeShare =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const handleNativeShare = useCallback(async () => {
    if (!shareUrl || !canNativeShare) return;
    try {
      await navigator.share({ title: 'Loom', text: shareBlurb, url: shareUrl });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
    setShareSheetOpen(false);
  }, [shareUrl, shareBlurb, canNativeShare]);

  const handleCopyShareLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = shareUrl;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        /* ignore */
      }
    }
    setShareSheetOpen(false);
  }, [shareUrl]);

  const openShareTwitter = useCallback(() => {
    if (!shareUrl) return;
    const u = encodeURIComponent(shareUrl);
    const t = encodeURIComponent(shareBlurb);
    window.open(`https://twitter.com/intent/tweet?text=${t}&url=${u}`, '_blank', 'noopener,noreferrer');
    setShareSheetOpen(false);
  }, [shareUrl, shareBlurb]);

  const openShareFacebook = useCallback(() => {
    if (!shareUrl) return;
    window.open(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
      '_blank',
      'noopener,noreferrer',
    );
    setShareSheetOpen(false);
  }, [shareUrl]);

  const openShareWhatsApp = useCallback(() => {
    if (!shareUrl) return;
    const msg = encodeURIComponent(`${shareBlurb}\n${shareUrl}`);
    window.open(`https://wa.me/?text=${msg}`, '_blank', 'noopener,noreferrer');
    setShareSheetOpen(false);
  }, [shareUrl, shareBlurb]);

  const handleBackFromDetail = useCallback(() => {
    if (!selectedCreation) {
      navigate('/');
      return;
    }
    const { depth } = selectedCreation;
    setSelectedCreation(null);
    if (depth > 0) {
      setDeck((prev) => [...prev.slice(depth), ...prev.slice(0, depth)]);
    }
  }, [selectedCreation, navigate]);

  const handleCreationRenamed = useCallback((next: SavedCreation) => {
    setSelectedCreation((s) =>
      s && s.creation.savedAt === next.savedAt ? { ...s, creation: next } : s,
    );
    setDeck((prev) =>
      prev.map((card) =>
        card.kind === 'creation' && card.creation.savedAt === next.savedAt ? { ...card, creation: next } : card,
      ),
    );
  }, []);

  const handleEditCreation = useCallback((creation: SavedCreation) => {
    startNewProject();
    saveLastCreation({
      displayName: creation.displayName,
      threads: creation.threads,
      threadNames: creation.threadNames,
      ui: creation.ui,
      cachedCardPreviewPngDataUrl: creation.cachedCardPreviewPngDataUrl,
      cachedDetailFlatPngDataUrl: creation.cachedDetailFlatPngDataUrl,
      cachedDetailBubblesPngDataUrl: creation.cachedDetailBubblesPngDataUrl,
      cardPreviewLayoutVersion: creation.cardPreviewLayoutVersion,
    });
    navigate('/create');
  }, [navigate]);

  const rotateForward = useCallback(() => {
    setDeck((prev) => {
      if (prev.length <= 1) return prev;
      return [...prev.slice(1), prev[0]];
    });
  }, []);

  const rotateBackward = useCallback(() => {
    setDeck((prev) => {
      if (prev.length <= 1) return prev;
      return [prev[prev.length - 1], ...prev.slice(0, prev.length - 1)];
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    pointerIdRef.current = e.pointerId;
    try {
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    } catch {
      // Some mobile browsers may throw here; keep swipe interaction working.
    }
    setDragging(true);
    setDragX(0);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      if (pointerIdRef.current == null || e.pointerId !== pointerIdRef.current) return;
      if (startXRef.current == null || startYRef.current == null) return;

      const dx = e.clientX - startXRef.current;
      const dy = e.clientY - startYRef.current;

      if (Math.abs(dx) < Math.abs(dy) * 1.2) {
        setDragX(0);
        return;
      }
      setDragX(dx);
    },
    [dragging],
  );

  const onPointerEndLike = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (pointerIdRef.current == null || e.pointerId !== pointerIdRef.current) return;
      if (startXRef.current == null || startYRef.current == null) return;

      const dx = e.clientX - startXRef.current;
      const dy = e.clientY - startYRef.current;

      const horizontalEnough = Math.abs(dx) >= Math.abs(dy) * 1.2;
      const swipe = horizontalEnough && Math.abs(dx) >= SWIPE_THRESHOLD_PX;
      if (swipe) {
        justSwipeRef.current = true;
        rotateForward();
      }

      startXRef.current = null;
      startYRef.current = null;
      pointerIdRef.current = null;
      setDragging(false);
      setDragX(0);
    },
    [rotateForward],
  );

  const onTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    touchIdRef.current = touch.identifier;
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    setDragging(true);
    setDragX(0);
  }, []);

  const onTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (!dragging) return;
      if (touchIdRef.current == null || startXRef.current == null || startYRef.current == null) return;
      const touch = Array.from(e.touches).find((t) => t.identifier === touchIdRef.current);
      if (!touch) return;

      const dx = touch.clientX - startXRef.current;
      const dy = touch.clientY - startYRef.current;
      if (Math.abs(dx) < Math.abs(dy) * 1.2) {
        setDragX(0);
        return;
      }
      if (e.cancelable) e.preventDefault();
      setDragX(dx);
    },
    [dragging],
  );

  const onTouchEndLike = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (touchIdRef.current == null || startXRef.current == null || startYRef.current == null) return;
      const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchIdRef.current);
      if (!touch) return;

      const dx = touch.clientX - startXRef.current;
      const dy = touch.clientY - startYRef.current;
      const horizontalEnough = Math.abs(dx) >= Math.abs(dy) * 1.2;
      const swipe = horizontalEnough && Math.abs(dx) >= SWIPE_THRESHOLD_PX;
      if (swipe) {
        justSwipeRef.current = true;
        rotateForward();
      }

      touchIdRef.current = null;
      startXRef.current = null;
      startYRef.current = null;
      setDragging(false);
      setDragX(0);
    },
    [rotateForward],
  );

  const visible = useMemo(() => deck.slice(0, MAX_VISIBLE), [deck]);
  const topCardDateLabel = useMemo(() => {
    const top = visible[0];
    return top ? getCardMonthLabel(top) : '';
  }, [visible]);
  const detailHasOverflow = selectedCreation != null && detailScrollHeight > detailViewportHeight + 1;
  const detailMaxScroll = Math.max(0, detailScrollHeight - detailViewportHeight);
  const detailThumbHeight = detailHasOverflow
    ? Math.max(48, (detailViewportHeight / detailScrollHeight) * detailViewportHeight)
    : 0;
  const detailTrackTravel = Math.max(1, detailViewportHeight - detailThumbHeight);
  const detailThumbTop = detailHasOverflow && detailMaxScroll > 0 ? (detailScrollTop / detailMaxScroll) * detailTrackTravel : 0;

  useEffect(() => {
    if (!selectedCreation) return;
    const el = detailScrollWrapRef.current;
    if (!el) return;
    const updateMetrics = () => {
      setDetailScrollTop(el.scrollTop);
      setDetailViewportHeight(el.clientHeight || 1);
      setDetailScrollHeight(el.scrollHeight || 1);
    };
    updateMetrics();
    el.addEventListener('scroll', updateMetrics, { passive: true });
    const ro = new ResizeObserver(updateMetrics);
    ro.observe(el);
    const firstChild = el.firstElementChild;
    if (firstChild instanceof HTMLElement) ro.observe(firstChild);
    window.addEventListener('resize', updateMetrics);
    return () => {
      el.removeEventListener('scroll', updateMetrics);
      ro.disconnect();
      window.removeEventListener('resize', updateMetrics);
    };
  }, [selectedCreation]);

  const onDetailScrollbarThumbPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!detailHasOverflow) return;
    detailScrollbarDragRef.current = {
      pointerId: e.pointerId,
      startClientY: e.clientY,
      startScrollTop: detailScrollTop,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    e.preventDefault();
  }, [detailHasOverflow, detailScrollTop]);

  const onDetailScrollbarThumbPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = detailScrollbarDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const el = detailScrollWrapRef.current;
    if (!el || detailTrackTravel <= 0) return;
    const deltaY = e.clientY - drag.startClientY;
    const scrollDelta = (deltaY / detailTrackTravel) * Math.max(1, detailMaxScroll);
    el.scrollTop = Math.max(0, Math.min(detailMaxScroll, drag.startScrollTop + scrollDelta));
    e.preventDefault();
  }, [detailMaxScroll, detailTrackTravel]);

  const onDetailScrollbarThumbPointerEnd = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = detailScrollbarDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    detailScrollbarDragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, []);

  return (
    <div className="create-page creation-page">
      <MemoryIndicator />
      <header className="create-topbar creation-topbar">
        <div className="topbar-row">
          <button type="button" className="icon-btn" aria-label="返回" onClick={handleBackFromDetail}>
            <IconBack />
          </button>
          <h1 className="topbar-title">My Creation</h1>
        </div>
        {!selectedCreation && (
          <div className="creation-subtitle">
            {galleryView ? 'My menstrual Art Gallery' : 'My Past Menstrual Creations'}
          </div>
        )}
      </header>

      <div
        ref={detailScrollWrapRef}
        className={`create-canvas-wrapper creation-canvas-wrapper${selectedCreation ? ' creation-canvas-wrapper--detail' : ''}`}
      >
        <main
          className={`create-canvas-area creation-canvas-area${selectedCreation ? ' creation-canvas-area--detail' : ''}`}
        >
          {selectedCreation ? (
            <CreationDetailView
              creation={selectedCreation.creation}
              onCreationRenamed={handleCreationRenamed}
              onEditCreation={handleEditCreation}
            />
          ) : galleryView ? (
            <>
              <div className="creation-gallery-content">
                <section className="creation-gallery-grid" aria-label="My creations gallery">
                  {galleryItems.length === 0 ? (
                    <div
                      className="creation-gallery-card creation-gallery-empty-placeholder"
                      role="status"
                      aria-label="No saved creations yet"
                    >
                      <p className="creation-gallery-empty-placeholder-text">Create your menstrual story now!</p>
                    </div>
                  ) : (
                    galleryItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="creation-gallery-card"
                        onClick={() => setSelectedCreation({ creation: item.creation, depth: 0 })}
                        aria-label={`Open creation ${new Date(item.creation.savedAt).toLocaleDateString()}`}
                      >
                        <CreationPreview creation={item.creation} />
                      </button>
                    ))
                  )}
                </section>
              </div>
              <div className="creation-gallery-footer-actions" role="toolbar" aria-label="Browse and share">
                <button type="button" className="creation-gallery-footer-btn" onClick={() => navigate('/community')}>
                  Browse Creations
                </button>
                <button type="button" className="creation-gallery-footer-btn" onClick={() => setShareSheetOpen(true)}>
                  Share your work
                </button>
              </div>
            </>
          ) : (
            <div className="creation-stack-wrap">
              <div className="creation-date">{topCardDateLabel}</div>
              <div className="creation-stack-controls">
                <button
                  type="button"
                  className="creation-stack-nav creation-stack-nav--left"
                  aria-label="Previous creation card"
                  onClick={rotateBackward}
                >
                  &#8249;
                </button>
                <div
                  className="creation-stack"
                  role="group"
                  aria-label="Creation card stack"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerEndLike}
                  onPointerCancel={onPointerEndLike}
                  onPointerLeave={onPointerEndLike}
                  onTouchStart={onTouchStart}
                  onTouchMove={onTouchMove}
                  onTouchEnd={onTouchEndLike}
                  onTouchCancel={onTouchEndLike}
                >
                  {visible.map((card, depth) => {
                    const isTop = depth === 0;
                    const style = isTop ? ({ ['--drag-x']: `${dragX}px` } as React.CSSProperties) : undefined;

                    return (
                      <div
                        key={card.id}
                        className="creation-stack-card"
                        data-depth={depth}
                        data-dragging={isTop && dragging ? 'true' : 'false'}
                        style={style}
                      >
                        {card.kind === 'creation' ? (
                          <div
                            className="creation-card-inner creation-card-inner--clickable"
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (justSwipeRef.current) {
                                justSwipeRef.current = false;
                                return;
                              }
                              setSelectedCreation({ creation: card.creation, depth });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setSelectedCreation({ creation: card.creation, depth });
                              }
                            }}
                          >
                            <div className="creation-card-preview">
                              <CreationPreview creation={card.creation} />
                            </div>
                            <div className="creation-card-meta">
                              <div className="creation-card-title">
                                {new Date(card.creation.savedAt).toLocaleDateString(undefined, {
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric',
                                })}
                              </div>
                              <div className="creation-card-subtitle">
                                {card.creation.threads?.length ?? 0} lines
                              </div>
                            </div>
                          </div>
                        ) : card.kind === 'cta' ? (
                          <div className="creation-card-inner">
                            <div className="creation-card-preview">
                              <div className="creation-card-preview-inner">
                                <img className="creation-card-preview-img" src={card.previewSrc} alt="" />
                              </div>
                            </div>
                            <div className="creation-card-meta">
                              <div className="creation-card-title">{card.monthLabel}</div>
                              {card.subtitle ? (
                                <div className="creation-card-subtitle">{card.subtitle}</div>
                              ) : null}
                            </div>
                          </div>
                        ) : (
                          <div className="creation-card-inner">
                            <div className="creation-card-preview">
                              <div className="creation-card-preview-inner">
                                <img className="creation-card-preview-img" src={card.previewSrc} alt="" />
                              </div>
                            </div>
                            <div className="creation-card-meta">
                              <div className="creation-card-title">{card.monthLabel}</div>
                              <div className="creation-card-subtitle">{card.subtitle}</div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="creation-stack-nav creation-stack-nav--right"
                  aria-label="Next creation card"
                  onClick={rotateForward}
                >
                  &#8250;
                </button>
              </div>
              <button type="button" className="creation-try-gallery-btn" onClick={() => setGalleryView(true)}>
                Try Gallery View
              </button>
            </div>
          )}
        </main>
        {detailHasOverflow ? (
          <div className="creation-detail-scrollbar" aria-hidden>
            <button
              type="button"
              className="creation-detail-scrollbar-thumb"
              style={{ height: `${detailThumbHeight}px`, transform: `translateY(${detailThumbTop}px)` }}
              tabIndex={-1}
              onPointerDown={onDetailScrollbarThumbPointerDown}
              onPointerMove={onDetailScrollbarThumbPointerMove}
              onPointerUp={onDetailScrollbarThumbPointerEnd}
              onPointerCancel={onDetailScrollbarThumbPointerEnd}
            />
          </div>
        ) : null}
      </div>

      {shareSheetOpen ? (
        <div className="creation-share-sheet-root" role="presentation">
          <button
            type="button"
            className="creation-share-sheet-backdrop"
            aria-label="Close share"
            onClick={() => setShareSheetOpen(false)}
          />
          <div
            className="creation-share-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="creation-share-sheet-title"
          >
            <div className="creation-share-sheet-handle" aria-hidden />
            <h2 id="creation-share-sheet-title" className="creation-share-sheet-title">
              Share your work
            </h2>
            <p className="creation-share-sheet-hint">Share a link to My Creation or pick a channel.</p>
            <div className="creation-share-sheet-actions">
              {canNativeShare ? (
                <button type="button" className="creation-share-sheet-action" onClick={handleNativeShare}>
                  Share via…
                </button>
              ) : null}
              <button type="button" className="creation-share-sheet-action" onClick={handleCopyShareLink}>
                Copy link
              </button>
              <button type="button" className="creation-share-sheet-action" onClick={openShareTwitter}>
                X (Twitter)
              </button>
              <button type="button" className="creation-share-sheet-action" onClick={openShareFacebook}>
                Facebook
              </button>
              <button type="button" className="creation-share-sheet-action" onClick={openShareWhatsApp}>
                WhatsApp
              </button>
            </div>
            <button type="button" className="creation-share-sheet-cancel" onClick={() => setShareSheetOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

