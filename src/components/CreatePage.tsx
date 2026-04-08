import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useLocation, useNavigate, type BlockerFunction } from 'react-router-dom';
import { queueCreationExportForCache } from './CreationExportWorker';
import { LoomCanvas, type LoomCanvasHandle } from './LoomCanvas';
import { TextureSwatchIcon } from './TextureSwatchIcons';
import { ColourWheelPicker, type PickedColour } from './ColourWheelPicker';
import type { MaterialTextureId } from '../rendering/materialTextures';
import { MATERIAL_TEXTURE_PRESETS } from '../rendering/materialTextures';
import { commitStiffness } from '../rendering/commitStiffness';
import './CreatePage.css';
import './TryPage.css';
import { saveBrush, deleteBrush, getSavedBrushes, updateBrush, type SavedBrush } from '../savedBrushes';
import type { LoomShape } from '../physics/types';
import { getLastCreation, saveLastCreation, startNewProject } from '../savedCreation';
import { MemoryIndicator } from './MemoryIndicator';
import { MaterialEditNameRow } from './MaterialEditNameRow';
import { EditLinePreviewCanvas } from './EditLinePreviewCanvas';

/** Softness 0..100 → stiffness 0..1. */
function softnessToStiffness(softness: number): number {
  return Math.max(0, Math.min(1, 1 - softness / 100));
}

/** Stiffness 0..1 → softness 0..100. */
function stiffnessToSoftness(stiffness: number): number {
  return Math.max(0, Math.min(100, (1 - stiffness) * 100));
}

/** Pixi tint number to hex string. */
function colorToHex(n: number): string {
  const s = Math.max(0, Math.min(0xffffff, Math.round(n))).toString(16);
  return '#' + s.padStart(6, '0');
}

/** Derive 0..100 thickness from lineWidth and texture preset (inverse of thicknessToScale). */
function thicknessFromLineWidth(lineWidth: number, textureId: MaterialTextureId): number {
  const preset = MATERIAL_TEXTURE_PRESETS[textureId];
  const base = preset?.lineWidth ?? 3;
  const scale = lineWidth / base;
  const n = (scale - 0.35) / 2.45;
  return Math.max(0, Math.min(100, n * 100));
}

function thicknessToScale(t: number): number {
  const n = Math.max(0, Math.min(1, t / 100));
  return 0.35 + n * 2.45;
}

function hexToTint(hex: string): number {
  const s = hex.replace(/^#/, '');
  if (s.length !== 6) return 0xe8d5b7;
  return parseInt(s, 16);
}

function hexToTintOptional(hex?: string): number | undefined {
  if (!hex) return undefined;
  const s = hex.replace(/^#/, '');
  if (s.length !== 6) return undefined;
  return parseInt(s, 16);
}

function normalizeGradientHex(baseHex: string, gradientHex?: string): string | undefined {
  if (!gradientHex) return undefined;
  return baseHex.toLowerCase() === gradientHex.toLowerCase() ? undefined : gradientHex;
}

/** Colour 行示例圆：纯色一条，或渐变一条（不占满第一个调色盘按钮） */
type ColourSwatchEntry =
  | { kind: 'solid'; hex: string }
  | { kind: 'gradient'; start: string; end: string };

function swatchEntryKey(e: ColourSwatchEntry): string {
  if (e.kind === 'solid') return `s:${e.hex.toLowerCase()}`;
  return `g:${e.start.toLowerCase()}:${e.end.toLowerCase()}`;
}

function pushRecentSwatch(next: ColourSwatchEntry, recent: ColourSwatchEntry[], max = 6): ColourSwatchEntry[] {
  const k = swatchEntryKey(next);
  const cleaned = recent.filter((e) => swatchEntryKey(e) !== k);
  return [next, ...cleaned].slice(0, max);
}

function committedSwatchFromPicker(startHex: string, endHex: string): ColourSwatchEntry {
  const end = normalizeGradientHex(startHex, endHex);
  if (end === undefined) return { kind: 'solid', hex: startHex };
  return { kind: 'gradient', start: startHex, end };
}

function swatchBackgroundStyle(entry: ColourSwatchEntry): React.CSSProperties {
  if (entry.kind === 'solid') return { background: entry.hex };
  return { background: `linear-gradient(90deg, ${entry.start}, ${entry.end})` };
}

function hexToPickedColour(hex: string): PickedColour {
  const s = hex.replace(/^#/, '');
  if (s.length !== 6) {
    return { hex: DEFAULT_LINE_COLOUR, rgb: { r: 125, g: 211, b: 208 }, hsv: { h: 180, s: 0.41, v: 0.83 }, sectorIndex: 6, ringIndex: 2 };
  }
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return { hex, rgb: { r, g, b }, hsv: { h: 180, s: 0.41, v: 0.83 }, sectorIndex: 0, ringIndex: 2 };
}

function isClose(a: number, b: number, eps = 1e-3): boolean {
  return Math.abs(a - b) <= eps;
}

export interface EditThreadParams {
  textureId: MaterialTextureId;
  colorHex: string;
  gradientColorHex?: string;
  thickness: number;
  opacity: number;
  stiffness: number;
}

const iconSize = 14;

/** Five materials: None, Wool Yarn, Thread, Felt Wool, Steel Wire */
const TEXTURE_SWATCHES: { id: MaterialTextureId }[] = [
  { id: 'none' },
  { id: 'wool' },
  { id: 'thread' },
  { id: 'felt' },
  { id: 'steel' },
  { id: 'rope' },
];

const TEXTURE_LABELS: Record<MaterialTextureId, string> = {
  none: 'None',
  wool: 'Yarn',
  thread: 'Thread',
  chenille: 'Yarn',
  felt: 'Felt',
  steel: 'Wire',
  rope: 'Rope',
};

/** Create 页 Pixi 画布默认背景 */
const DEFAULT_CANVAS_BACKGROUND = '#ffffff';

/** 背景条：调色盘右侧 5 个预设（与首圆共 6 个圈） */
/** 画布背景预设：低饱和、偏白的淡色 */
const CANVAS_BACKGROUND_PRESETS = ['#ffffff', '#fff7f0', '#f0f7fc', '#f7f2fb', '#f2faf5'] as const;

function canvasBgMatchesPreset(canvasHex: string, presetHex: string): boolean {
  const a = normalizeSwatchHex(canvasHex);
  const b = normalizeSwatchHex(presetHex);
  if (!a || !b) return false;
  return a === b;
}

function isCanvasBgOnlyFromPresets(canvasHex: string): boolean {
  const n = normalizeSwatchHex(canvasHex);
  if (!n) return false;
  return CANVAS_BACKGROUND_PRESETS.some((p) => normalizeSwatchHex(p) === n);
}

/** 默认线条颜色，紧挨调色盘圆圈右侧展示并高亮 */
const DEFAULT_LINE_COLOUR = '#7dd3d0';

/** 默认颜色（调色盘右侧第一位）+ 5 个预设色相，共 6 个 */
const DEFAULT_COLOUR_SWATCHES = [DEFAULT_LINE_COLOUR, '#bf3939', '#bfbf39', '#39bf39', '#4a9fd6', '#3939bf'];

function defaultColourSwatches(): ColourSwatchEntry[] {
  return DEFAULT_COLOUR_SWATCHES.map((hex) => ({ kind: 'solid' as const, hex }));
}

const RECENT_COLOUR_SWATCHES_STORAGE_KEY = 'loom-create-recent-colour-swatches';
const RECENT_SWATCHES_MAX_STORE = 6;

function normalizeSwatchHex(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim());
  if (!m) return null;
  return `#${m[1].toLowerCase()}`;
}

function readStoredCanvasBackgroundHex(): string {
  try {
    const c = getLastCreation();
    const h = c?.ui?.canvasBackgroundHex;
    const n = h ? normalizeSwatchHex(h) : null;
    return n ?? DEFAULT_CANVAS_BACKGROUND;
  } catch {
    return DEFAULT_CANVAS_BACKGROUND;
  }
}

function parseStoredSwatches(raw: string | null): ColourSwatchEntry[] | null {
  if (raw == null || raw === '') return null;
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return null;
    const out: ColourSwatchEntry[] = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const kind = rec.kind;
      if (kind === 'solid') {
        const hex = normalizeSwatchHex(rec.hex);
        if (hex) out.push({ kind: 'solid', hex });
      } else if (kind === 'gradient') {
        const start = normalizeSwatchHex(rec.start);
        const end = normalizeSwatchHex(rec.end);
        if (start && end) {
          if (start.toLowerCase() === end.toLowerCase()) out.push({ kind: 'solid', hex: start });
          else out.push({ kind: 'gradient', start, end });
        }
      }
    }
    const dedup: ColourSwatchEntry[] = [];
    const seen = new Set<string>();
    for (const e of out) {
      const k = swatchEntryKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(e);
    }
    return dedup.length > 0 ? dedup.slice(0, RECENT_SWATCHES_MAX_STORE) : null;
  } catch {
    return null;
  }
}

function readRecentColourSwatchesFromStorage(): ColourSwatchEntry[] {
  try {
    const parsed = parseStoredSwatches(localStorage.getItem(RECENT_COLOUR_SWATCHES_STORAGE_KEY));
    if (parsed && parsed.length > 0) return parsed;
  } catch {
    /* ignore */
  }
  return defaultColourSwatches();
}

function persistRecentColourSwatches(list: ColourSwatchEntry[]): void {
  try {
    localStorage.setItem(
      RECENT_COLOUR_SWATCHES_STORAGE_KEY,
      JSON.stringify(list.slice(0, RECENT_SWATCHES_MAX_STORE)),
    );
  } catch {
    /* quota / private mode */
  }
}

function isMainSwatchSelected(entry: ColourSwatchEntry, sel: PickedColour, grad: PickedColour): boolean {
  const gEnd = normalizeGradientHex(sel.hex, grad.hex);
  if (entry.kind === 'solid') {
    return gEnd === undefined && sel.hex.toLowerCase() === entry.hex.toLowerCase();
  }
  return (
    gEnd != null &&
    sel.hex.toLowerCase() === entry.start.toLowerCase() &&
    grad.hex.toLowerCase() === entry.end.toLowerCase()
  );
}

function isEditThreadSwatchSelected(entry: ColourSwatchEntry, p: EditThreadParams): boolean {
  const gEnd = normalizeGradientHex(p.colorHex, p.gradientColorHex);
  if (entry.kind === 'solid') {
    return gEnd === undefined && p.colorHex.toLowerCase() === entry.hex.toLowerCase();
  }
  return (
    gEnd != null &&
    p.colorHex.toLowerCase() === entry.start.toLowerCase() &&
    (p.gradientColorHex ?? p.colorHex).toLowerCase() === entry.end.toLowerCase()
  );
}

function IconBack() {
  return (
    <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 12H5" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function IconUndo() {
  return (
    <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
  );
}

function IconRedo() {
  return (
    <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 7v6h-6" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
    </svg>
  );
}

const MATERIAL_PANEL_WIDTH = 260;
const EDIT_PANEL_OFFSET_Y = 16;

type ThreadPersistRow = {
  anchorIds: number[];
  polyline?: Array<{ x: number; y: number }>;
  openTail?: { x: number; y: number };
  textureId: MaterialTextureId;
  lineWidth: number;
  color: number;
  gradientColor?: number;
  opacity: number;
  stiffness: number;
};

function buildThreadPayloadFromLoom(loom: LoomCanvasHandle): {
  threads: ThreadPersistRow[];
  threadNames: string[];
} {
  const existing = getSavedBrushes();
  const threads: ThreadPersistRow[] = [];
  const threadNames: string[] = [];

  for (let i = 0; ; i++) {
    const params = loom.getThreadParams(i);
    if (!params) break;

    const anchorIds = loom.getThreadAnchorIds(i) ?? [];
    const freehandPoly = loom.getThreadFreehandPolyline(i);

    if (freehandPoly && freehandPoly.length >= 2) {
      threads.push({
        anchorIds: [],
        polyline: freehandPoly.map((p) => ({ x: p.x, y: p.y })),
        textureId: params.textureId,
        lineWidth: params.lineWidth,
        color: params.color,
        ...(params.gradientColor != null ? { gradientColor: params.gradientColor } : {}),
        opacity: params.opacity,
        stiffness: params.stiffness,
      });
    } else if (anchorIds.length >= 2) {
      const ot = loom.getThreadOpenTail(i);
      threads.push({
        anchorIds,
        ...(ot ? { openTail: { x: ot.x, y: ot.y } } : {}),
        textureId: params.textureId,
        lineWidth: params.lineWidth,
        color: params.color,
        ...(params.gradientColor != null ? { gradientColor: params.gradientColor } : {}),
        opacity: params.opacity,
        stiffness: params.stiffness,
      });
    } else if (anchorIds.length === 1) {
      const ot = loom.getThreadOpenTail(i);
      if (!ot) continue;
      threads.push({
        anchorIds,
        openTail: { x: ot.x, y: ot.y },
        textureId: params.textureId,
        lineWidth: params.lineWidth,
        color: params.color,
        ...(params.gradientColor != null ? { gradientColor: params.gradientColor } : {}),
        opacity: params.opacity,
        stiffness: params.stiffness,
      });
    } else {
      continue;
    }

    const points = loom.getThreadSaggedPoints(i);
    if (!points || points.length < 2) continue;

    const soft = stiffnessToSoftness(params.stiffness);
    const opacityVal = Math.round(params.opacity * 100);
    const strokeStyle = colorToHex(params.color);
    const gradientStrokeStyle = params.gradientColor != null ? colorToHex(params.gradientColor) : undefined;

    const storedLabel = loom.getThreadName(i)?.trim();
    if (storedLabel) {
      threadNames.push(storedLabel);
    } else {
      const matchedBrush = existing.find(
        (b) =>
          b.textureId === params.textureId &&
          b.strokeStyle.toLowerCase() === strokeStyle.toLowerCase() &&
          (b.gradientStrokeStyle?.toLowerCase() ?? '') === (gradientStrokeStyle?.toLowerCase() ?? '') &&
          Math.abs(b.lineWidth - params.lineWidth) < 1 &&
          Math.abs((b.opacity ?? 100) - opacityVal) <= 15 &&
          Math.abs((b.softness ?? 50) - soft) <= 20,
      );
      const defaultName = `Line ${i + 1}`;
      const isCustomName = matchedBrush && !/^Line \d+$/.test(matchedBrush.name);
      threadNames.push(isCustomName ? matchedBrush!.name : defaultName);
    }
  }

  return { threads, threadNames };
}

export function CreatePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [showFinalTutorial, setShowFinalTutorial] = useState<boolean>(() => Boolean((location.state as any)?.showFinalTutorial));

  const [showStartNewProjectModal, setShowStartNewProjectModal] = useState(false);
  useEffect(() => {
    if (!showStartNewProjectModal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowStartNewProjectModal(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showStartNewProjectModal]);

  useEffect(() => {
    setShowFinalTutorial(Boolean((location.state as any)?.showFinalTutorial));
  }, [location.state]);

  const loomRef = useRef<LoomCanvasHandle>(null);
  const createCanvasHostRef = useRef<HTMLElement | null>(null);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [selectedTexture, setSelectedTexture] = useState<MaterialTextureId>('none');
  const [selectedColour, setSelectedColour] = useState<PickedColour>({
    hex: DEFAULT_LINE_COLOUR,
    rgb: { r: 125, g: 211, b: 208 },
    hsv: { h: 180, s: 0.41, v: 0.83 },
    sectorIndex: 6,
    ringIndex: 2,
  });
  const [selectedGradientColour, setSelectedGradientColour] = useState<PickedColour>({
    hex: DEFAULT_LINE_COLOUR,
    rgb: { r: 125, g: 211, b: 208 },
    hsv: { h: 180, s: 0.41, v: 0.83 },
    sectorIndex: 6,
    ringIndex: 2,
  });
  const [colourPickerOpen, setColourPickerOpen] = useState(false);
  /** 空白处细笔模式：2px #221915；关闭则为当前材质涂鸦 */
  const [blankCanvasThinPen, setBlankCanvasThinPen] = useState(false);
  const [freehandEraserActive, setFreehandEraserActive] = useState(false);
  /** 与 LoomCanvas 织环形状同步；无线条时才可切换三角形/圆形 */
  const [createLoomShape, setCreateLoomShape] = useState<LoomShape>('circle');
  /** 与画布已提交线条数同步，用于 Switch Loom 禁用态 */
  const [, setCommittedThreadCount] = useState(0);
  const [canvasBackgroundHex, setCanvasBackgroundHex] = useState(readStoredCanvasBackgroundHex);
  const canvasBackgroundHexRef = useRef(canvasBackgroundHex);
  const [canvasBgPickerOpen, setCanvasBgPickerOpen] = useState(false);
  const [canvasBgPickerValue, setCanvasBgPickerValue] = useState<PickedColour>(() =>
    hexToPickedColour(readStoredCanvasBackgroundHex()),
  );
  const canvasBgPickerValueRef = useRef(canvasBgPickerValue);
  canvasBgPickerValueRef.current = canvasBgPickerValue;
  const [recentColourSwatches, setRecentColourSwatches] = useState<ColourSwatchEntry[]>(readRecentColourSwatchesFromStorage);

  useEffect(() => {
    canvasBackgroundHexRef.current = canvasBackgroundHex;
  }, [canvasBackgroundHex]);

  useEffect(() => {
    if (!blankCanvasThinPen) setFreehandEraserActive(false);
  }, [blankCanvasThinPen]);

  useEffect(() => {
    persistRecentColourSwatches(recentColourSwatches);
  }, [recentColourSwatches]);
  /** 默认即为 None 材质：给可用粗细/不透明度/柔软度，进入页面即可绘制 */
  const [thickness, setThickness] = useState(35);
  const [opacity, setOpacity] = useState(100);
  const [softness, setSoftness] = useState(
    () => (1 - (MATERIAL_TEXTURE_PRESETS.none?.stiffness ?? 0.6)) * 100,
  );

  const leaveCreateBlocker = useBlocker(
    useCallback<BlockerFunction>(
      ({ currentLocation, nextLocation }) =>
        currentLocation.pathname === '/create' && nextLocation.pathname !== '/create',
      [],
    ),
  );
  // Restore last Create canvas state so re-opening `/create` shows
  // the previously saved threads.
  useEffect(() => {
    const creation = getLastCreation();
    const shape: LoomShape = creation?.ui?.loomShape === 'triangle' ? 'triangle' : 'circle';
    setCreateLoomShape(shape);
    if (!creation) return;

    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      const loom = loomRef.current;
      if (!loom) {
        requestAnimationFrame(attempt);
        return;
      }
      loom.setLoomShape(shape, true);
      const ok = loom.tryLoadCreation(creation);
      if (ok) setCommittedThreadCount(loom.getCommittedThreadCount());
      if (!ok) requestAnimationFrame(attempt);
    };

    requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist current loom threads to localStorage (same payload as manual Save). */
  const persistCreatePageDraft = useCallback(
    (allowEmpty: boolean): boolean => {
      const loom = loomRef.current;
      if (!loom) return false;
      const actualLoomShape = loom.getLoomShape();

      const { threads, threadNames } = buildThreadPayloadFromLoom(loom);
      if (threads.length === 0 && !allowEmpty) return false;

      saveLastCreation({
        threads,
        threadNames,
        ui: {
          textureId: selectedTexture,
          colorHex: selectedColour.hex,
          gradientColorHex: normalizeGradientHex(selectedColour.hex, selectedGradientColour.hex),
          thickness,
          opacity,
          softness,
          canvasBackgroundHex: canvasBackgroundHexRef.current,
          loomShape: actualLoomShape,
        },
      });
      return true;
    },
    [
      selectedTexture,
      selectedColour.hex,
      selectedGradientColour.hex,
      thickness,
      opacity,
      softness,
      canvasBackgroundHex,
    ],
  );

  const autoSaveDebounceRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const suppressNextCommittedAutoSaveRef = useRef(false);

  const flushAutoSaveDraft = useCallback(() => {
    if (autoSaveDebounceRef.current) {
      clearTimeout(autoSaveDebounceRef.current);
      autoSaveDebounceRef.current = null;
    }
    persistCreatePageDraft(true);
  }, [persistCreatePageDraft]);

  const scheduleAutoSaveDraft = useCallback(() => {
    if (autoSaveDebounceRef.current) clearTimeout(autoSaveDebounceRef.current);
    autoSaveDebounceRef.current = window.setTimeout(() => {
      autoSaveDebounceRef.current = null;
      persistCreatePageDraft(true);
    }, 400);
  }, [persistCreatePageDraft]);

  const onCanvasCommittedThreadsChange = useCallback(() => {
    const count = loomRef.current?.getCommittedThreadCount() ?? 0;
    setCommittedThreadCount(count);
    if (suppressNextCommittedAutoSaveRef.current) {
      suppressNextCommittedAutoSaveRef.current = false;
      return;
    }
    scheduleAutoSaveDraft();
  }, [scheduleAutoSaveDraft]);

  /** 用户改画布背景时写入草稿（不依赖是否新画了线）。 */
  const commitCanvasBackgroundHex = useCallback(
    (hex: string) => {
      canvasBackgroundHexRef.current = hex;
      setCanvasBackgroundHex(hex);
      scheduleAutoSaveDraft();
    },
    [scheduleAutoSaveDraft],
  );

  useEffect(() => {
    if (!canvasBgPickerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        commitCanvasBackgroundHex(canvasBgPickerValueRef.current.hex);
        setCanvasBgPickerOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canvasBgPickerOpen, commitCanvasBackgroundHex]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushAutoSaveDraft();
    };
    window.addEventListener('pagehide', flushAutoSaveDraft);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flushAutoSaveDraft);
      document.removeEventListener('visibilitychange', onHidden);
      flushAutoSaveDraft();
    };
  }, [flushAutoSaveDraft]);

  // Leaving Create: flush draft, then unblock navigation immediately. PNG cache export runs on a
  // persistent off-screen LoomCanvas (see CreationExportWorker) so the visible canvas is not reloaded.
  useEffect(() => {
    if (leaveCreateBlocker.state !== 'blocked') return;

    flushAutoSaveDraft();
    const stored = getLastCreation();
    if (stored?.threads?.length) {
      queueCreationExportForCache(stored);
    }

    queueMicrotask(() => {
      leaveCreateBlocker.proceed?.();
    });
  }, [leaveCreateBlocker.state, flushAutoSaveDraft]);

  // My materials（用户自定义材质库）
  const [savedBrushesVersion, setSavedBrushesVersion] = useState(0);
  const savedBrushes = useMemo(() => {
    // `savedBrushesVersion` 只用于触发重新读取 localStorage；
    // 这里显式引用一下，避免 eslint/react-hooks 报 dependency 警告。
    void savedBrushesVersion;
    return getSavedBrushes();
  }, [savedBrushesVersion]);
  const defaultSelectedId = savedBrushes[0]?.id ?? null;
  const [myMaterialsOpen, setMyMaterialsOpen] = useState(false);
  const [selectedBrushId, setSelectedBrushId] = useState<string | null>(null);
  const [, setIsBrushTemporarilyDisabled] = useState(false);
  const effectiveSelectedId =
    selectedBrushId && savedBrushes.some((b) => b.id === selectedBrushId) ? selectedBrushId : defaultSelectedId;

  const [myEditPanelOpen, setMyEditPanelOpen] = useState(false);
  const [editingBrushId, setEditingBrushId] = useState<string | null>(null);
  const editingBrush = editingBrushId ? savedBrushes.find((b) => b.id === editingBrushId) : null;
  const [editingThreadIndices, setEditingThreadIndices] = useState<number[]>([]);

  const [editTextureId, setEditTextureId] = useState<MaterialTextureId>('none');
  const [editColour, setEditColour] = useState<PickedColour>({
    hex: DEFAULT_LINE_COLOUR,
    rgb: { r: 125, g: 211, b: 208 },
    hsv: { h: 180, s: 0.41, v: 0.83 },
    sectorIndex: 6,
    ringIndex: 2,
  });
  const [editGradientColour, setEditGradientColour] = useState<PickedColour>({
    hex: DEFAULT_LINE_COLOUR,
    rgb: { r: 125, g: 211, b: 208 },
    hsv: { h: 180, s: 0.41, v: 0.83 },
    sectorIndex: 6,
    ringIndex: 2,
  });
  const [editThickness, setEditThickness] = useState(35);
  const [editOpacity, setEditOpacity] = useState(100);
  const [editSoftness, setEditSoftness] = useState(() => (1 - (MATERIAL_TEXTURE_PRESETS['none']?.stiffness ?? 0.6)) * 100);
  const [editColourPickerOpen, setEditColourPickerOpen] = useState(false);

  const [selectedThreadIndexForDelete, setSelectedThreadIndexForDelete] = useState<number | null>(null);
  const [selectedThreadClientPos, setSelectedThreadClientPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedThreadClientBottomY, setSelectedThreadClientBottomY] = useState<number | null>(null);
  const [editThreadParams, setEditThreadParams] = useState<EditThreadParams | null>(null);

  // Selected thread edit panel (delete-thread) dragging position.
  const [deletePanelPos, setDeletePanelPos] = useState<{ left: number; top: number } | null>(null);
  const [deletePanelDragging, setDeletePanelDragging] = useState(false);
  const deletePanelRef = useRef<HTMLDivElement | null>(null);
  const deletePanelDragStateRef = useRef<{
    startClientX: number;
    startClientY: number;
    startLeft: number;
    startTop: number;
    pointerId: number;
  } | null>(null);
  const prevBodyStylesRef = useRef<{ userSelect: string; touchAction: string } | null>(null);

  const editThreadParamsRef = useRef<EditThreadParams | null>(null);
  useEffect(() => {
    editThreadParamsRef.current = editThreadParams;
  }, [editThreadParams]);

  const selectedColourRef = useRef(selectedColour);
  const selectedGradientColourRef = useRef(selectedGradientColour);
  useEffect(() => {
    selectedColourRef.current = selectedColour;
  }, [selectedColour]);
  useEffect(() => {
    selectedGradientColourRef.current = selectedGradientColour;
  }, [selectedGradientColour]);

  const editColourRef = useRef(editColour);
  const editGradientColourRef = useRef(editGradientColour);
  useEffect(() => {
    editColourRef.current = editColour;
  }, [editColour]);
  useEffect(() => {
    editGradientColourRef.current = editGradientColour;
  }, [editGradientColour]);

  useEffect(() => {
    if (!myEditPanelOpen || !editingBrushId) return;
    const brush = getSavedBrushes().find((b) => b.id === editingBrushId);
    if (!brush) return;
    setEditTextureId(brush.textureId);
    setEditColour(hexToPickedColour(brush.strokeStyle));
    setEditGradientColour(hexToPickedColour(brush.gradientStrokeStyle ?? brush.strokeStyle));
    setEditThickness(brush.thickness);
    setEditOpacity(brush.opacity);
    const defaultSoft = (1 - (MATERIAL_TEXTURE_PRESETS[brush.textureId]?.stiffness ?? 0.6)) * 100;
    setEditSoftness(brush.softness ?? defaultSoft);
  }, [myEditPanelOpen, editingBrushId]);

  useEffect(() => {
    if (!myEditPanelOpen || !editingBrush) {
      setEditingThreadIndices([]);
      return;
    }

    const loom = loomRef.current;
    if (!loom) {
      setEditingThreadIndices([]);
      return;
    }

    const count = loom.getCommittedThreadCount();
    const targetOpacity = Math.max(0, Math.min(1, editingBrush.opacity / 100));
    const defaultSoftness = (1 - (MATERIAL_TEXTURE_PRESETS[editingBrush.textureId]?.stiffness ?? 0.6)) * 100;
    const targetSoftness = editingBrush.softness ?? defaultSoftness;
    const targetStiffness = Math.max(0, Math.min(1, 1 - targetSoftness / 100));
    const brushGradHex = normalizeGradientHex(editingBrush.strokeStyle, editingBrush.gradientStrokeStyle);
    const expectedGradTint = brushGradHex != null ? hexToTint(brushGradHex) : undefined;
    const matched: number[] = [];

    for (let i = 0; i < count; i++) {
      const p = loom.getThreadParams(i);
      if (!p) continue;
      if (p.textureId !== editingBrush.textureId) continue;
      if (p.color !== hexToTint(editingBrush.strokeStyle)) continue;
      if (expectedGradTint === undefined) {
        if (p.gradientColor != null) continue;
      } else if (p.gradientColor !== expectedGradTint) continue;
      if (!isClose(p.opacity, targetOpacity, 0.02)) continue;
      if (!isClose(p.lineWidth, editingBrush.lineWidth, 0.08)) continue;
      if (!isClose(p.stiffness, targetStiffness, 0.04)) continue;
      matched.push(i);
    }

    setEditingThreadIndices(matched);
  }, [myEditPanelOpen, editingBrush]);

  useEffect(() => {
    if (!myEditPanelOpen || editingThreadIndices.length === 0) return;
    const lineWidth =
      (MATERIAL_TEXTURE_PRESETS[editTextureId]?.lineWidth ?? 3) *
      (0.5 + Math.max(0, Math.min(1, editThickness / 100)) * 1.5);
    const gradHex = normalizeGradientHex(editColour.hex, editGradientColour.hex);
    const next = {
      textureId: editTextureId,
      lineWidth,
      color: hexToTint(editColour.hex),
      gradientColor: gradHex != null ? hexToTint(gradHex) : undefined,
      opacity: Math.max(0, Math.min(1, editOpacity / 100)),
      stiffness: Math.max(0, Math.min(1, 1 - editSoftness / 100)),
    };

    for (const idx of editingThreadIndices) {
      loomRef.current?.setThreadMaterial(idx, next);
    }
  }, [
    myEditPanelOpen,
    editingThreadIndices,
    editTextureId,
    editColour.hex,
    editGradientColour.hex,
    editThickness,
    editOpacity,
    editSoftness,
  ]);

  const onTapCanvas = useCallback((contentPoint: { x: number; y: number }) => {
    // Clicking on a line should do nothing now (long-press is required).
    const threadIndex = loomRef.current?.getThreadAtPoint(contentPoint.x, contentPoint.y) ?? null;
    if (threadIndex != null) return;

    // Clicking empty space clears the current selected-thread edit popup.
    setSelectedThreadIndexForDelete(null);
    setSelectedThreadClientPos(null);
    setSelectedThreadClientBottomY(null);
    setEditThreadParams(null);
  }, []);

  const onLongPressThread = useCallback((contentPoint: { x: number; y: number }, hitThreadIndex: number) => {
    const fromHit = Number.isInteger(hitThreadIndex) ? hitThreadIndex : null;
    const fromPoint = loomRef.current?.getThreadAtPoint(contentPoint.x, contentPoint.y) ?? null;
    const threadIndex = fromHit ?? fromPoint;
    if (threadIndex == null) return;

    // Guard against stale/invalid index: re-resolve from point before giving up.
    let params = loomRef.current?.getThreadParams(threadIndex) ?? null;
    let pos = loomRef.current?.getThreadClientMidpoint(threadIndex) ?? null;
    let bottomY = loomRef.current?.getThreadClientBottom(threadIndex) ?? null;
    if (!params || !pos) {
      if (fromPoint == null) return;
      params = loomRef.current?.getThreadParams(fromPoint) ?? null;
      pos = loomRef.current?.getThreadClientMidpoint(fromPoint) ?? null;
      bottomY = loomRef.current?.getThreadClientBottom(fromPoint) ?? null;
      if (!params || !pos) return;
      setSelectedThreadIndexForDelete(fromPoint);
    } else {
      setSelectedThreadIndexForDelete(threadIndex);
    }
    if (!params || !pos) return;

    setSelectedThreadClientPos(pos);
    setSelectedThreadClientBottomY(bottomY);
    setEditThreadParams({
      textureId: params.textureId,
      colorHex: colorToHex(params.color),
      gradientColorHex: params.gradientColor != null ? colorToHex(params.gradientColor) : undefined,
      thickness: thicknessFromLineWidth(params.lineWidth, params.textureId),
      opacity: Math.round(params.opacity * 100),
      stiffness: params.stiffness,
    });
    setMaterialsOpen(false);
    setColourPickerOpen(false);
  }, []);

  const isDeletePanel =
    selectedThreadIndexForDelete != null &&
    selectedThreadClientPos != null &&
    selectedThreadClientBottomY != null;
  const layerReorderThreadCount =
    isDeletePanel && selectedThreadIndexForDelete != null
      ? (loomRef.current?.getCommittedThreadCount() ?? 0)
      : 0;
  const currentThreadLayerLabel =
    selectedThreadIndexForDelete != null && layerReorderThreadCount > 0
      ? `${selectedThreadIndexForDelete + 1}/${layerReorderThreadCount}`
      : '-/-';
  const showMainPanel = materialsOpen && !isDeletePanel;

  const closeDeletePanel = useCallback(() => {
    setSelectedThreadIndexForDelete(null);
    setSelectedThreadClientPos(null);
    setSelectedThreadClientBottomY(null);
    setEditThreadParams(null);
    setColourPickerOpen(false);
    setDeletePanelPos(null);
    setDeletePanelDragging(false);
  }, []);

  const resetUIAndCanvas = useCallback(() => {
    loomRef.current?.reset();
    setCreateLoomShape('circle');
    setCommittedThreadCount(0);

    // Clear all editor / popups that depend on canvas thread state.
    setMaterialsOpen(false);
    setColourPickerOpen(false);
    setMyMaterialsOpen(false);
    setMyEditPanelOpen(false);
    setEditingBrushId(null);
    closeDeletePanel();

    setCanvasBackgroundHex(DEFAULT_CANVAS_BACKGROUND);
    scheduleAutoSaveDraft();
  }, [closeDeletePanel, scheduleAutoSaveDraft]);

  const deleteSelectedThread = useCallback(() => {
    if (selectedThreadIndexForDelete == null) return;
    loomRef.current?.deleteThread(selectedThreadIndexForDelete);
    setSelectedThreadIndexForDelete(null);
    setSelectedThreadClientPos(null);
    setSelectedThreadClientBottomY(null);
    setEditThreadParams(null);
    setColourPickerOpen(false);
  }, [selectedThreadIndexForDelete]);

  const bringEditThreadForward = useCallback(() => {
    const idx = selectedThreadIndexForDelete;
    if (idx == null) return;
    if (loomRef.current?.bringThreadForward(idx)) {
      setSelectedThreadIndexForDelete(idx + 1);
    }
  }, [selectedThreadIndexForDelete]);

  const sendEditThreadBackward = useCallback(() => {
    const idx = selectedThreadIndexForDelete;
    if (idx == null) return;
    if (loomRef.current?.sendThreadBackward(idx)) {
      setSelectedThreadIndexForDelete(idx - 1);
    }
  }, [selectedThreadIndexForDelete]);

  const bringEditThreadToTop = useCallback(() => {
    const idx = selectedThreadIndexForDelete;
    if (idx == null) return;
    const n = loomRef.current?.getCommittedThreadCount() ?? 0;
    if (n < 2) return;
    if (loomRef.current?.bringThreadToTop(idx)) {
      setSelectedThreadIndexForDelete(n - 1);
    }
  }, [selectedThreadIndexForDelete]);

  const sendEditThreadToBottom = useCallback(() => {
    const idx = selectedThreadIndexForDelete;
    if (idx == null) return;
    if (loomRef.current?.sendThreadToBottom(idx)) {
      setSelectedThreadIndexForDelete(0);
    }
  }, [selectedThreadIndexForDelete]);

  const addMaterialFromSelectedThread = useCallback(() => {
    if (selectedThreadIndexForDelete == null) return;
    if (!editThreadParams) return;

    const idx = selectedThreadIndexForDelete;
    const points = loomRef.current?.getThreadSaggedPoints(idx) ?? null;
    if (!points || points.length < 2) return;

    const preset = MATERIAL_TEXTURE_PRESETS[editThreadParams.textureId];
    const baseLineWidth = preset?.lineWidth ?? 3;
    const lineWidth = baseLineWidth * thicknessToScale(editThreadParams.thickness);

    const softness = Math.max(0, Math.min(100, (1 - editThreadParams.stiffness) * 100));
    const storedName = loomRef.current?.getThreadName(idx)?.trim();
    const name = storedName?.slice(0, 50) || 'Untitled';

    const saved = saveBrush({
      points,
      textureId: editThreadParams.textureId,
      strokeStyle: editThreadParams.colorHex,
      gradientStrokeStyle: normalizeGradientHex(editThreadParams.colorHex, editThreadParams.gradientColorHex),
      lineWidth,
      thickness: editThreadParams.thickness,
      softness,
      opacity: editThreadParams.opacity,
      name,
    });
    setSavedBrushesVersion((v) => v + 1);

    setMyMaterialsOpen(true);
    setMyEditPanelOpen(false);
    setEditingBrushId(null);
    setSelectedBrushId(saved.id);

    setSelectedTexture(saved.textureId);
    setIsBrushTemporarilyDisabled(false);
    setSelectedColour(hexToPickedColour(saved.strokeStyle));
    setSelectedGradientColour(hexToPickedColour(saved.gradientStrokeStyle ?? saved.strokeStyle));
    setThickness(saved.thickness);
    setOpacity(saved.opacity);
    const defaultSoft = (1 - (MATERIAL_TEXTURE_PRESETS[saved.textureId]?.stiffness ?? 0.6)) * 100;
    setSoftness(saved.softness ?? defaultSoft);

    closeDeletePanel();
  }, [closeDeletePanel, editThreadParams, selectedThreadIndexForDelete]);

  const handleSelectBrush = useCallback(
    (brush: SavedBrush) => {
      setSelectedBrushId(brush.id);
      setSelectedTexture(brush.textureId);
      setIsBrushTemporarilyDisabled(false);
      setSelectedColour(hexToPickedColour(brush.strokeStyle));
      setSelectedGradientColour(hexToPickedColour(brush.gradientStrokeStyle ?? brush.strokeStyle));
      setThickness(thicknessFromLineWidth(brush.lineWidth, brush.textureId));
      setOpacity(brush.opacity);
      const defaultSoft = (1 - (MATERIAL_TEXTURE_PRESETS[brush.textureId]?.stiffness ?? 0.6)) * 100;
      setSoftness(brush.softness ?? defaultSoft);
    },
    []
  );

  function handleMyEditSave() {
    if (!editingBrushId || !editingBrush) return;
    const latestBrush = getSavedBrushes().find((b) => b.id === editingBrushId) ?? editingBrush;
    const lineWidth =
      (MATERIAL_TEXTURE_PRESETS[editTextureId]?.lineWidth ?? 3) *
      (0.5 + Math.max(0, Math.min(1, editThickness / 100)) * 1.5);

    const updated = updateBrush(editingBrushId, {
      name: latestBrush.name,
      textureId: editTextureId,
      strokeStyle: editColour.hex,
      gradientStrokeStyle: normalizeGradientHex(editColour.hex, editGradientColour.hex),
      lineWidth,
      thickness: editThickness,
      softness: editSoftness,
      opacity: editOpacity,
    });
    if (!updated) return;

    setSavedBrushesVersion((v) => v + 1);

    if (editingBrushId === effectiveSelectedId) {
      setSelectedTexture(updated.textureId);
      setIsBrushTemporarilyDisabled(false);
      setSelectedColour(hexToPickedColour(updated.strokeStyle));
      setSelectedGradientColour(hexToPickedColour(updated.gradientStrokeStyle ?? updated.strokeStyle));
      setThickness(thicknessFromLineWidth(updated.lineWidth, updated.textureId));
      setOpacity(updated.opacity);
      const defaultSoft =
        (1 - (MATERIAL_TEXTURE_PRESETS[updated.textureId]?.stiffness ?? 0.6)) * 100;
      setSoftness(updated.softness ?? defaultSoft);
    }

    setMyEditPanelOpen(false);
    setEditingBrushId(null);
  }

  function handleMyEditDelete() {
    if (!editingBrushId) return;
    const ok = deleteBrush(editingBrushId);
    if (!ok) return;
    setSavedBrushesVersion((v) => v + 1);

    setMyEditPanelOpen(false);
    setEditingBrushId(null);

    const remaining = getSavedBrushes();
    if (remaining.length === 0) {
      setSelectedBrushId(null);
      setSelectedTexture('none');
      setIsBrushTemporarilyDisabled(true);
      setSelectedColour(hexToPickedColour('#7dd3d0'));
      setSelectedGradientColour(hexToPickedColour('#7dd3d0'));
      setThickness(35);
      setOpacity(100);
      const defaultSoft = (1 - (MATERIAL_TEXTURE_PRESETS['none']?.stiffness ?? 0.6)) * 100;
      setSoftness(defaultSoft);
      return;
    }

    const next = remaining[0];
    setSelectedBrushId(next.id);
    setSelectedTexture(next.textureId);
    setIsBrushTemporarilyDisabled(false);
    setSelectedColour(hexToPickedColour(next.strokeStyle));
    setSelectedGradientColour(hexToPickedColour(next.gradientStrokeStyle ?? next.strokeStyle));
    setThickness(thicknessFromLineWidth(next.lineWidth, next.textureId));
    setOpacity(next.opacity);
    const defaultSoft = (1 - (MATERIAL_TEXTURE_PRESETS[next.textureId]?.stiffness ?? 0.6)) * 100;
    setSoftness(next.softness ?? defaultSoft);
  }

  // Apply edits immediately as user changes sliders/swatches.
  useEffect(() => {
    if (selectedThreadIndexForDelete == null || !editThreadParams) return;
    const preset = MATERIAL_TEXTURE_PRESETS[editThreadParams.textureId];
    const lineWidth = (preset?.lineWidth ?? 3) * thicknessToScale(editThreadParams.thickness);
    loomRef.current?.setThreadMaterial(selectedThreadIndexForDelete, {
      textureId: editThreadParams.textureId,
      lineWidth,
      color: hexToTint(editThreadParams.colorHex),
      gradientColor: hexToTintOptional(normalizeGradientHex(editThreadParams.colorHex, editThreadParams.gradientColorHex)),
      opacity: editThreadParams.opacity / 100,
      stiffness: editThreadParams.stiffness,
    });
  }, [selectedThreadIndexForDelete, editThreadParams]);

  // Initialize edit panel position when a new thread is selected.
  useEffect(() => {
    if (selectedThreadIndexForDelete == null || selectedThreadClientPos == null || selectedThreadClientBottomY == null) {
      return;
    }

    const left = Math.max(
      8,
      Math.min(window.innerWidth - MATERIAL_PANEL_WIDTH - 8, selectedThreadClientPos.x - MATERIAL_PANEL_WIDTH / 2),
    );
    const top = Math.max(8, Math.min(window.innerHeight - 420, selectedThreadClientBottomY + EDIT_PANEL_OFFSET_Y));
    setDeletePanelPos({ left, top });
  }, [selectedThreadIndexForDelete, selectedThreadClientPos, selectedThreadClientBottomY]);

  const handleDeletePanelDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!deletePanelPos) {
        // In practice deletePanelPos should always exist while open, but keep a fallback.
        if (
          selectedThreadClientPos == null ||
          selectedThreadClientBottomY == null ||
          selectedThreadIndexForDelete == null ||
          !editThreadParams
        ) {
          return;
        }
      }

      e.preventDefault();
      e.stopPropagation();

      const pos =
        deletePanelPos ??
        (selectedThreadClientPos && selectedThreadClientBottomY
          ? {
              left: Math.max(
                8,
                Math.min(window.innerWidth - MATERIAL_PANEL_WIDTH - 8, selectedThreadClientPos.x - MATERIAL_PANEL_WIDTH / 2),
              ),
              top: Math.max(8, Math.min(window.innerHeight - 420, selectedThreadClientBottomY + EDIT_PANEL_OFFSET_Y)),
            }
          : null);

      if (!pos) return;

      prevBodyStylesRef.current = {
        userSelect: document.body.style.userSelect,
        touchAction: document.body.style.touchAction,
      };
      document.body.style.userSelect = 'none';
      document.body.style.touchAction = 'none';

      deletePanelDragStateRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startLeft: pos.left,
        startTop: pos.top,
        pointerId: e.pointerId,
      };
      setDeletePanelDragging(true);

      // Capture pointer so we can receive move/up even if user leaves the handle area.
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [deletePanelPos, selectedThreadClientPos, selectedThreadClientBottomY, selectedThreadIndexForDelete, editThreadParams]
  );

  const handleDeletePanelDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = deletePanelDragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;

    e.preventDefault();

    const dx = e.clientX - s.startClientX;
    const dy = e.clientY - s.startClientY;

    const panelH = deletePanelRef.current?.offsetHeight ?? 420;
    const left = Math.max(8, Math.min(window.innerWidth - MATERIAL_PANEL_WIDTH - 8, s.startLeft + dx));
    const top = Math.max(8, Math.min(window.innerHeight - panelH - 8, s.startTop + dy));

    setDeletePanelPos({ left, top });
  }, []);

  const handleDeletePanelDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = deletePanelDragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;

    deletePanelDragStateRef.current = null;
    setDeletePanelDragging(false);

    const prev = prevBodyStylesRef.current;
    prevBodyStylesRef.current = null;
    document.body.style.userSelect = prev?.userSelect ?? '';
    document.body.style.touchAction = prev?.touchAction ?? '';
  }, []);

  return (
    <div className="create-page">
      <MemoryIndicator />
      {showStartNewProjectModal && (
        <div className="create-start-new-project-overlay" role="dialog" aria-modal="true" aria-labelledby="start-new-project-title">
          <div className="create-start-new-project-modal" role="document">
            <h2 id="start-new-project-title" className="create-start-new-project-title">
              Start a new project
            </h2>
            <p className="create-start-new-project-text">
              Make sure to save your creation before you go, so you don&apos;t lose it.
            </p>
            <div className="create-start-new-project-actions">
              <button
                type="button"
                className="create-start-new-project-btn create-start-new-project-btn-cancel"
                onClick={() => setShowStartNewProjectModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="create-start-new-project-btn create-start-new-project-btn-primary"
                onClick={() => {
                  setShowStartNewProjectModal(false);
                  startNewProject();
                  resetUIAndCanvas();
                }}
              >
                New creation
              </button>
            </div>
          </div>
        </div>
      )}
      {showFinalTutorial && (
        <div className="create-final-tutorial-overlay" role="dialog" aria-modal="true">
          <div className="create-final-tutorial-content">
            <p className="create-final-tutorial-text">
              Brilliant! You already know how to use materials to create menstrual data.
              {'\n'}
              Now let&apos;s start recording for real!
            </p>
            <div className="create-final-tutorial-actions">
              <button
                type="button"
                className="create-final-tutorial-btn"
                onClick={() => {
                  setShowFinalTutorial(false);
                  navigate('/');
                }}
              >
                Back to Home
              </button>
              <button
                type="button"
                className="create-final-tutorial-btn create-final-tutorial-btn-primary"
                onClick={() => setShowFinalTutorial(false)}
              >
                Get Started
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Top App Bar */}
      <header className="create-topbar">
        <div className="topbar-row">
          <button
            type="button"
            className="icon-btn"
            aria-label="返回"
            onClick={() => {
              navigate('/');
            }}
          >
            <IconBack />
          </button>
          <h1 className="topbar-title">Create</h1>
        </div>
        <div className="topbar-actions">
          <div className="topbar-actions-left">
            <button type="button" className="icon-btn icon-btn-history" aria-label="撤销" onClick={() => loomRef.current?.undo()}>
              <IconUndo />
            </button>
            <button type="button" className="icon-btn icon-btn-history" aria-label="重做" onClick={() => loomRef.current?.redo()}>
              <IconRedo />
            </button>
          </div>
          <div className="topbar-actions-right">
            <button
              type="button"
              className="topbar-btn topbar-btn-switch-loom"
              title={createLoomShape === 'circle' ? 'Switch to triangular loom' : 'Switch to circular loom'}
              onClick={() => {
                if (autoSaveDebounceRef.current) {
                  clearTimeout(autoSaveDebounceRef.current);
                  autoSaveDebounceRef.current = null;
                }
                suppressNextCommittedAutoSaveRef.current = true;
                loomRef.current?.reset();
                const next: LoomShape = createLoomShape === 'circle' ? 'triangle' : 'circle';
                setCreateLoomShape(next);
                setCommittedThreadCount(0);
                loomRef.current?.setLoomShape(next, true);
                closeDeletePanel();
              }}
            >
              Switch Loom
            </button>
            <button type="button" className="topbar-btn" onClick={() => setShowStartNewProjectModal(true)}>
              New project
            </button>
            <button
              type="button"
              className={`topbar-btn ${blankCanvasThinPen ? 'topbar-btn-freehand-active' : ''}`}
              onClick={() =>
                setBlankCanvasThinPen((v) => {
                  const next = !v;
                  if (!next) setFreehandEraserActive(false);
                  return next;
                })
              }
              aria-pressed={blankCanvasThinPen}
            >
              Freehand
            </button>
          </div>
        </div>
      </header>

      {/* Canvas + Bottom bar 一体容器：下方圆角，底边距 48/1280 */}
      <div className="create-canvas-wrapper">
        <main ref={createCanvasHostRef} className="create-canvas-area">
          <LoomCanvas
            ref={loomRef}
            canvasBackground={canvasBackgroundHex}
            textureId={selectedTexture}
            materialEnabled={!canvasBgPickerOpen}
            color={selectedColour.hex}
            gradientColor={normalizeGradientHex(selectedColour.hex, selectedGradientColour.hex)}
            thickness={thickness}
            opacity={opacity}
            softness={softness}
            blankCanvasThinPen={
              blankCanvasThinPen &&
              !myMaterialsOpen &&
              !myEditPanelOpen &&
              !showStartNewProjectModal &&
              !canvasBgPickerOpen
            }
            freehandEraserEnabled={
              blankCanvasThinPen &&
              freehandEraserActive &&
              !myMaterialsOpen &&
              !myEditPanelOpen &&
              !showStartNewProjectModal &&
              !canvasBgPickerOpen
            }
            onCommittedThreadsChange={onCanvasCommittedThreadsChange}
            onTapCanvas={
              !myMaterialsOpen && !myEditPanelOpen && !showStartNewProjectModal && !canvasBgPickerOpen
                ? onTapCanvas
                : undefined
            }
            onLongPressThread={
              !myMaterialsOpen && !myEditPanelOpen && !showStartNewProjectModal && !canvasBgPickerOpen
                ? onLongPressThread
                : undefined
            }
            onWrapStart={closeDeletePanel}
            selectedThreadIndex={selectedThreadIndexForDelete}
          />
          <div className="create-canvas-bg-strip">
            <h2 className="create-canvas-bg-strip-title">Play with background</h2>
            <div className="create-canvas-bg-strip-row">
              <button
                type="button"
                className={`create-canvas-bg-swatch create-canvas-bg-swatch-picker ${!isCanvasBgOnlyFromPresets(canvasBackgroundHex) ? 'create-canvas-bg-swatch-selected' : ''}`}
                aria-label="Open colour picker for canvas background"
                onClick={() => {
                  setCanvasBgPickerValue(hexToPickedColour(canvasBackgroundHex));
                  setCanvasBgPickerOpen(true);
                }}
              />
              {CANVAS_BACKGROUND_PRESETS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={`create-canvas-bg-swatch ${canvasBgMatchesPreset(canvasBackgroundHex, hex) ? 'create-canvas-bg-swatch-selected' : ''}`}
                  style={{ background: hex }}
                  aria-label={`Set canvas background ${hex}`}
                  onClick={() => commitCanvasBackgroundHex(hex)}
                />
              ))}
            </div>
          </div>
          {blankCanvasThinPen && (
            <div className="create-canvas-eraser-wrap">
              <button
                type="button"
                className={`create-canvas-eraser-btn ${freehandEraserActive ? 'create-canvas-eraser-btn-active' : ''}`}
                aria-pressed={freehandEraserActive}
                onClick={() => setFreehandEraserActive((v) => !v)}
              >
                Eraser
              </button>
            </div>
          )}
          {canvasBgPickerOpen && (
            <div className="create-canvas-bg-picker-host">
              <ColourWheelPicker
                value={canvasBgPickerValue}
                onChange={setCanvasBgPickerValue}
                onClose={() => {
                  commitCanvasBackgroundHex(canvasBgPickerValueRef.current.hex);
                  setCanvasBgPickerOpen(false);
                }}
              />
            </div>
          )}
          {/* Materials 弹框：canvas 左下方（新建线条用） */}
          {showMainPanel && (
            <div className="materials-panel">
              <button
                type="button"
                className="materials-panel-dismiss"
                onClick={() => setMaterialsOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
              <section className="materials-section">
                <span className="materials-label">Texture</span>
                <div className="materials-swatches materials-swatches-texture">
                  {TEXTURE_SWATCHES.map((t) => (
                    <div key={t.id} className="materials-texture-item">
                      <button
                        type="button"
                        className={`materials-swatch materials-swatch-texture ${t.id === 'none' ? 'materials-swatch-texture-none' : ''} ${selectedTexture === t.id ? 'materials-swatch-selected' : ''}`}
                        aria-label={TEXTURE_LABELS[t.id]}
                        onClick={() => {
                          if (t.id === 'none') {
                            setSelectedTexture('none');
                            commitStiffness.current = softnessToStiffness(softness);
                            return;
                          }
                          const defaultSoft = (1 - (MATERIAL_TEXTURE_PRESETS[t.id]?.stiffness ?? 0.6)) * 100;
                          setSelectedTexture(t.id);
                          setThickness(35);
                          setOpacity(100);
                          setSoftness(defaultSoft);
                          commitStiffness.current = softnessToStiffness(defaultSoft);
                        }}
                      >
                        <TextureSwatchIcon id={t.id} />
                      </button>
                      <div className="materials-texture-label">{TEXTURE_LABELS[t.id]}</div>
                    </div>
                  ))}
                </div>
              </section>
              <section className="materials-section">
                <span className="materials-label">Colour</span>
                <div className="materials-swatches">
                  <button
                    type="button"
                    className="materials-swatch materials-swatch-colour materials-swatch-colour-picker"
                    aria-label="picker"
                    onClick={() => setColourPickerOpen(true)}
                  />
                  {recentColourSwatches.map((entry) => (
                    <button
                      key={swatchEntryKey(entry)}
                      type="button"
                      className={`materials-swatch materials-swatch-colour ${isMainSwatchSelected(entry, selectedColour, selectedGradientColour) ? 'materials-swatch-selected' : ''}`}
                      style={swatchBackgroundStyle(entry)}
                      aria-label={entry.kind === 'solid' ? entry.hex : `${entry.start} ${entry.end}`}
                      onClick={() => {
                        if (entry.kind === 'solid') {
                          const pc = hexToPickedColour(entry.hex);
                          setSelectedColour(pc);
                          setSelectedGradientColour(pc);
                          return;
                        }
                        setSelectedColour(hexToPickedColour(entry.start));
                        setSelectedGradientColour(hexToPickedColour(entry.end));
                      }}
                    />
                  ))}
                </div>
              </section>
              <section className="materials-section materials-section-row">
                <span className="materials-label">Thickness</span>
                <div className="materials-slider-wrap">
                  <input
                    type="range"
                    className="materials-slider"
                    min={0}
                    max={100}
                    value={thickness}
                    style={{ '--value': `${thickness}%` } as React.CSSProperties}
                    onChange={(e) => setThickness(Number(e.target.value))}
                  />
                </div>
              </section>
              <section className="materials-section materials-section-row">
                <span className="materials-label">Opacity</span>
                <div className="materials-slider-wrap">
                  <input
                    type="range"
                    className="materials-slider materials-slider-opacity"
                    min={0}
                    max={100}
                    value={opacity}
                    style={{ '--value': `${opacity}%` } as React.CSSProperties}
                    onChange={(e) => setOpacity(Number(e.target.value))}
                  />
                </div>
              </section>
              <section className="materials-section materials-section-row">
                <span className="materials-label">Softness</span>
                <div className="materials-slider-wrap">
                  <input
                    type="range"
                    className="materials-slider"
                    min={0}
                    max={100}
                    value={softness}
                    style={{ '--value': `${softness}%` } as React.CSSProperties}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setSoftness(v);
                      commitStiffness.current = softnessToStiffness(v);
                    }}
                  />
                </div>
              </section>
              <div className="materials-actions">
                <button type="button" className="materials-btn materials-btn-cancel" onClick={() => setMaterialsOpen(false)}>
                  Done
                </button>
              </div>
              {colourPickerOpen && (
                <ColourWheelPicker
                  value={selectedColour}
                  onChange={setSelectedColour}
                  gradient={{
                    value: selectedGradientColour,
                    onChange: setSelectedGradientColour,
                  }}
                  onClose={() => {
                    const s = selectedColourRef.current;
                    const g = selectedGradientColourRef.current;
                    setRecentColourSwatches((prev) =>
                      pushRecentSwatch(committedSwatchFromPicker(s.hex, g.hex), prev),
                    );
                    setColourPickerOpen(false);
                  }}
                />
              )}
            </div>
          )}

          {/* 选中线的 Materials 弹框（浮在被选线下方），按钮为 cancel/delete */}
          {isDeletePanel && editThreadParams && selectedThreadClientPos && selectedThreadIndexForDelete != null && selectedThreadClientBottomY != null && (
            <div
              ref={deletePanelRef}
              className={`materials-panel materials-panel-delete-thread ${deletePanelDragging ? 'materials-panel-delete-thread-dragging' : ''}`}
              style={{
                position: 'fixed',
                bottom: 'auto',
                left:
                  deletePanelPos?.left ??
                  Math.max(
                    8,
                    Math.min(window.innerWidth - MATERIAL_PANEL_WIDTH - 8, selectedThreadClientPos.x - MATERIAL_PANEL_WIDTH / 2),
                  ),
                // Ensure the popup starts below the thread's lowest point (expanded path maxY).
                top:
                  deletePanelPos?.top ??
                  Math.max(8, Math.min(window.innerHeight - 420, selectedThreadClientBottomY + EDIT_PANEL_OFFSET_Y)),
              }}
            >
              <div
                className="materials-panel-drag-handle"
                role="button"
                tabIndex={0}
                aria-label="拖动编辑框位置"
                onPointerDown={handleDeletePanelDragStart}
                onPointerMove={handleDeletePanelDragMove}
                onPointerUp={handleDeletePanelDragEnd}
                onPointerCancel={handleDeletePanelDragEnd}
              />
              <button
                type="button"
                className="materials-panel-dismiss"
                onClick={closeDeletePanel}
                aria-label="关闭"
              >
                ×
              </button>

              <section className="materials-section">
                <span className="materials-label">Texture</span>
                <div className="materials-swatches materials-swatches-texture">
                  {TEXTURE_SWATCHES.map((t) => (
                    <div key={t.id} className="materials-texture-item">
                      <button
                        type="button"
                        className={`materials-swatch materials-swatch-texture ${t.id === 'none' ? 'materials-swatch-texture-none' : ''} ${editThreadParams.textureId === t.id ? 'materials-swatch-selected' : ''}`}
                        aria-label={TEXTURE_LABELS[t.id]}
                        onClick={() =>
                          setEditThreadParams((p) => {
                            if (!p) return p;
                            if (t.id === 'none') {
                              return { ...p, textureId: 'none' };
                            }
                            if (p.textureId === 'none') {
                              const defaultStiffness = MATERIAL_TEXTURE_PRESETS[t.id]?.stiffness ?? 0.6;
                              return { ...p, textureId: t.id, thickness: 35, opacity: 100, stiffness: defaultStiffness };
                            }
                            return { ...p, textureId: t.id };
                          })
                        }
                      >
                        <TextureSwatchIcon id={t.id} />
                      </button>
                      <div className="materials-texture-label">{TEXTURE_LABELS[t.id]}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="materials-section">
                <span className="materials-label">Colour</span>
                <div className="materials-swatches">
                  <button
                    type="button"
                    className="materials-swatch materials-swatch-colour materials-swatch-colour-picker"
                    aria-label="picker"
                    onClick={() => setColourPickerOpen(true)}
                  />
                  {recentColourSwatches.map((entry) => (
                    <button
                      key={swatchEntryKey(entry)}
                      type="button"
                      className={`materials-swatch materials-swatch-colour ${isEditThreadSwatchSelected(entry, editThreadParams) ? 'materials-swatch-selected' : ''}`}
                      style={swatchBackgroundStyle(entry)}
                      aria-label={entry.kind === 'solid' ? entry.hex : `${entry.start} ${entry.end}`}
                      onClick={() =>
                        setEditThreadParams((p) => {
                          if (!p) return p;
                          if (entry.kind === 'solid') {
                            return { ...p, colorHex: entry.hex, gradientColorHex: undefined };
                          }
                          return { ...p, colorHex: entry.start, gradientColorHex: entry.end };
                        })
                      }
                    />
                  ))}
                </div>
              </section>

              <section className="materials-section materials-section-row">
                <span className="materials-label">Thickness</span>
                <div className="materials-slider-wrap">
                  <input
                    type="range"
                    className="materials-slider"
                    min={0}
                    max={100}
                    value={editThreadParams.thickness}
                    style={{
                      '--value': `${editThreadParams.thickness}%`,
                    } as React.CSSProperties}
                    onChange={(e) => setEditThreadParams((p) => (p ? { ...p, thickness: Number(e.target.value) } : p))}
                  />
                </div>
              </section>

              <section className="materials-section materials-section-row">
                <span className="materials-label">Opacity</span>
                <div className="materials-slider-wrap">
                  <input
                    type="range"
                    className="materials-slider materials-slider-opacity"
                    min={0}
                    max={100}
                    value={editThreadParams.opacity}
                    style={{
                      '--value': `${editThreadParams.opacity}%`,
                    } as React.CSSProperties}
                    onChange={(e) => setEditThreadParams((p) => (p ? { ...p, opacity: Number(e.target.value) } : p))}
                  />
                </div>
              </section>

              <section className="materials-section materials-section-row">
                <span className="materials-label">Softness</span>
                <div className="materials-slider-wrap">
                  <input
                    type="range"
                    className="materials-slider"
                    min={0}
                    max={100}
                    value={Math.round((1 - editThreadParams.stiffness) * 100)}
                    style={{
                      '--value': `${Math.round((1 - editThreadParams.stiffness) * 100)}%`,
                    } as React.CSSProperties}
                    onChange={(e) =>
                      setEditThreadParams((p) =>
                        p ? { ...p, stiffness: 1 - Number(e.target.value) / 100 } : p
                      )
                    }
                  />
                </div>
              </section>

              <section className="materials-section materials-section-row thread-layer-section">
                <span className="materials-label">Layer</span>
                <div className="thread-layer-actions">
                  <span
                    className="thread-layer-level"
                    aria-label={`Current layer ${currentThreadLayerLabel}`}
                    title={`Current layer ${currentThreadLayerLabel}`}
                  >
                    {currentThreadLayerLabel}
                  </span>
                  <button
                    type="button"
                    className="thread-layer-icon-btn thread-layer-icon-btn--rot-ccw"
                    aria-label="Send to back"
                    title="Send to back"
                    disabled={selectedThreadIndexForDelete <= 0}
                    onClick={sendEditThreadToBottom}
                  >
                    ⇤
                  </button>
                  <button
                    type="button"
                    className="thread-layer-icon-btn"
                    aria-label="Move down one layer"
                    title="Move down one layer"
                    disabled={selectedThreadIndexForDelete <= 0}
                    onClick={sendEditThreadBackward}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="thread-layer-icon-btn"
                    aria-label="Move up one layer"
                    title="Move up one layer"
                    disabled={selectedThreadIndexForDelete >= layerReorderThreadCount - 1}
                    onClick={bringEditThreadForward}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="thread-layer-icon-btn thread-layer-icon-btn--rot-ccw"
                    aria-label="Bring to front"
                    title="Bring to front"
                    disabled={selectedThreadIndexForDelete >= layerReorderThreadCount - 1}
                    onClick={bringEditThreadToTop}
                  >
                    ⇥
                  </button>
                </div>
              </section>

              <div className="materials-actions delete-thread-actions">
                <button
                  type="button"
                  className="materials-btn materials-btn-cancel"
                  onClick={addMaterialFromSelectedThread}
                >
                  Add to My materials
                </button>
                <button type="button" className="materials-btn materials-btn-delete" onClick={deleteSelectedThread}>
                  Delete
                </button>
              </div>

              {colourPickerOpen && (
                <ColourWheelPicker
                  value={hexToPickedColour(editThreadParams.colorHex)}
                  onChange={(v) => setEditThreadParams((p) => (p ? { ...p, colorHex: v.hex } : p))}
                  gradient={{
                    value: hexToPickedColour(editThreadParams.gradientColorHex ?? editThreadParams.colorHex),
                    onChange: (v) => setEditThreadParams((p) => (p ? { ...p, gradientColorHex: v.hex } : p)),
                  }}
                  onClose={() => {
                    const p = editThreadParamsRef.current;
                    if (p) {
                      setRecentColourSwatches((prev) =>
                        pushRecentSwatch(committedSwatchFromPicker(p.colorHex, p.gradientColorHex ?? p.colorHex), prev),
                      );
                    }
                    setColourPickerOpen(false);
                  }}
                />
              )}
            </div>
          )}
        </main>
        {myMaterialsOpen && !myEditPanelOpen && (
          <div className="try-my-materials-panel">
            <button
              type="button"
              className="materials-panel-dismiss"
              onClick={() => setMyMaterialsOpen(false)}
              aria-label="关闭"
            >
              ×
            </button>
            <h2 className="try-my-materials-title">My materials</h2>
            <div className="try-my-materials-thumbnails">
              {savedBrushes.map((brush) => (
                <button
                  key={brush.id}
                  type="button"
                  className={`try-my-materials-thumb ${brush.id === effectiveSelectedId ? 'try-my-materials-thumb-selected' : ''}`}
                  title={brush.name}
                  aria-label={brush.name}
                  onClick={() => handleSelectBrush(brush)}
                >
                  <span className="try-my-materials-thumb-texture">
                    <TextureSwatchIcon id={brush.textureId} />
                  </span>
                  <span className="try-my-materials-thumb-tint" style={{ background: brush.strokeStyle }} aria-hidden />
                </button>
              ))}
            </div>
            <div className="try-my-materials-actions">
              <button
                type="button"
                className="try-my-materials-btn try-my-materials-add"
                onClick={() => {
                  if (effectiveSelectedId) {
                    const selectedBrush = savedBrushes.find((b) => b.id === effectiveSelectedId);
                    if (selectedBrush) handleSelectBrush(selectedBrush);
                  }
                  setMyMaterialsOpen(false);
                  setMyEditPanelOpen(false);
                  setEditingBrushId(null);
                }}
              >
                Apply
              </button>
              <button
                type="button"
                className="try-my-materials-btn try-my-materials-edit"
                onClick={() => {
                  if (effectiveSelectedId) {
                    setEditingBrushId(effectiveSelectedId);
                    setMyEditPanelOpen(true);
                  }
                }}
              >
                Edit
              </button>
            </div>
          </div>
        )}

        {myEditPanelOpen && editingBrush && (
          <div className="try-edit-materials-wrap">
            <div className="try-edit-materials-panel">
              <div className="try-edit-materials-panel-header">
                <button
                  type="button"
                  className="try-edit-materials-dismiss"
                  onClick={() => {
                    setMyEditPanelOpen(false);
                    setEditingBrushId(null);
                  }}
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>

              <div className="try-edit-line-preview">
                <EditLinePreviewCanvas
                  points={editingBrush.points}
                  textureId={editTextureId}
                  strokeStyle={editColour.hex}
                  gradientStrokeStyle={normalizeGradientHex(editColour.hex, editGradientColour.hex)}
                  lineWidth={
                    (MATERIAL_TEXTURE_PRESETS[editTextureId]?.lineWidth ?? 3) *
                    (0.5 + Math.max(0, Math.min(1, editThickness / 100)) * 1.5)
                  }
                  opacity01={Math.max(0.1, Math.min(1, editOpacity / 100))}
                  stiffness01={1 - Math.max(0, Math.min(1, editSoftness / 100))}
                />
              </div>

              <MaterialEditNameRow
                key={editingBrushId ?? 'none'}
                committedName={editingBrush.name}
                commitFallback="Untitled"
                onCommit={(normalized) => {
                  if (!editingBrushId) return;
                  const updated = updateBrush(editingBrushId, { name: normalized });
                  if (updated) setSavedBrushesVersion((v) => v + 1);
                }}
              />

              <section className="materials-section">
                <span className="materials-label">Texture</span>
                <div className="materials-swatches materials-swatches-texture">
                  {TEXTURE_SWATCHES.map((t) => (
                    <div key={t.id} className="materials-texture-item">
                      <button
                        type="button"
                        className={`materials-swatch materials-swatch-texture ${t.id === 'none' ? 'materials-swatch-texture-none' : ''} ${editTextureId === t.id ? 'materials-swatch-selected' : ''}`}
                        aria-label={TEXTURE_LABELS[t.id]}
                        onClick={() => {
                          if (t.id === 'none') {
                            setEditTextureId('none');
                            return;
                          }
                          setEditTextureId(t.id);
                          setEditThickness(35);
                          setEditOpacity(100);
                          const defaultSoft = (1 - (MATERIAL_TEXTURE_PRESETS[t.id]?.stiffness ?? 0.6)) * 100;
                          setEditSoftness(defaultSoft);
                        }}
                      >
                        <TextureSwatchIcon id={t.id} />
                      </button>
                      <div className="materials-texture-label">{TEXTURE_LABELS[t.id]}</div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="materials-section">
                <span className="materials-label">Colour</span>
                <div className="materials-swatches">
                  <button
                    type="button"
                    className="materials-swatch materials-swatch-colour materials-swatch-colour-picker"
                    aria-label="picker"
                    onClick={() => setEditColourPickerOpen(true)}
                  />
                  {recentColourSwatches.map((entry) => (
                    <button
                      key={swatchEntryKey(entry)}
                      type="button"
                      className={`materials-swatch materials-swatch-colour ${isMainSwatchSelected(entry, editColour, editGradientColour) ? 'materials-swatch-selected' : ''}`}
                      style={swatchBackgroundStyle(entry)}
                      aria-label={entry.kind === 'solid' ? entry.hex : `${entry.start} ${entry.end}`}
                      onClick={() => {
                        if (entry.kind === 'solid') {
                          const pc = hexToPickedColour(entry.hex);
                          setEditColour(pc);
                          setEditGradientColour(pc);
                          return;
                        }
                        setEditColour(hexToPickedColour(entry.start));
                        setEditGradientColour(hexToPickedColour(entry.end));
                      }}
                    />
                  ))}
                </div>
              </section>

              <section className="materials-section materials-section-row">
                <span className="materials-label">Thickness</span>
                <div className="materials-slider-wrap">
                  <input
                    type="range"
                    className="materials-slider"
                    min={0}
                    max={100}
                    value={editThickness}
                    style={{ '--value': `${editThickness}%` } as React.CSSProperties}
                    onChange={(e) => setEditThickness(Number(e.target.value))}
                  />
                </div>
              </section>

              <section className="materials-section materials-section-row">
                <span className="materials-label">Opacity</span>
                <div className="materials-slider-wrap">
                  <input
                    type="range"
                    className="materials-slider materials-slider-opacity"
                    min={0}
                    max={100}
                    value={editOpacity}
                    style={{ '--value': `${editOpacity}%` } as React.CSSProperties}
                    onChange={(e) => setEditOpacity(Number(e.target.value))}
                  />
                </div>
              </section>

              <section className="materials-section materials-section-row">
                <span className="materials-label">Softness</span>
                <div className="materials-slider-wrap">
                  <input
                    type="range"
                    className="materials-slider"
                    min={0}
                    max={100}
                    value={editSoftness}
                    style={{ '--value': `${editSoftness}%` } as React.CSSProperties}
                    onChange={(e) => setEditSoftness(Number(e.target.value))}
                  />
                </div>
              </section>

              <div className="try-edit-materials-actions">
                <button type="button" className="try-edit-btn" onClick={handleMyEditDelete}>
                  Delete
                </button>
                <button type="button" className="try-edit-btn try-edit-save" onClick={handleMyEditSave}>
                  Save
                </button>
              </div>

              {editColourPickerOpen && (
                <ColourWheelPicker
                  value={editColour}
                  onChange={setEditColour}
                  gradient={{
                    value: editGradientColour,
                    onChange: setEditGradientColour,
                  }}
                  onClose={() => {
                    const c = editColourRef.current;
                    const g = editGradientColourRef.current;
                    setRecentColourSwatches((prev) =>
                      pushRecentSwatch(committedSwatchFromPicker(c.hex, g.hex), prev),
                    );
                    setEditColourPickerOpen(false);
                  }}
                />
              )}
            </div>
          </div>
        )}
        <nav className="create-bottom-bar">
          <button
            type="button"
            className={`bottom-tab ${!myMaterialsOpen && !myEditPanelOpen ? 'bottom-tab-active' : ''}`}
            onClick={() => {
              setMyMaterialsOpen(false);
              setMyEditPanelOpen(false);
              setEditingBrushId(null);
              setMaterialsOpen((v) => !v);
            }}
          >
            Materials
          </button>
          <div className="bottom-tab-divider" />
          <button
            type="button"
            className={`bottom-tab ${myMaterialsOpen || myEditPanelOpen ? 'bottom-tab-active' : ''}`}
            onClick={() => {
              if (myMaterialsOpen) {
                setMyMaterialsOpen(false);
                setMyEditPanelOpen(false);
                setEditingBrushId(null);
              } else {
                setMaterialsOpen(false);
                closeDeletePanel();
                setMyMaterialsOpen(true);
                setMyEditPanelOpen(false);
                setEditingBrushId(null);
              }
            }}
          >
            My materials
          </button>
        </nav>
      </div>
    </div>
  );
}
