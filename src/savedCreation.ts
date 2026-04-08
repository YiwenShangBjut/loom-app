import type { MaterialTextureId } from './rendering/materialTextures';
import type { LoomShape, Point } from './physics/types';

/** 与 `creationCachedExport` 卡片导出一致；变更时递增以废弃旧 `cachedCardPreviewPngDataUrl` */
export const CARD_PREVIEW_LAYOUT_VERSION = 16;

export interface SavedCreationThread {
  /**
   * Ordered anchor IDs that form the original wrap path.
   * WrapController will map these IDs back to the current LoomRenderer anchors.
   */
  anchorIds: number[];
  /**
   * Freehand stroke in loom content space (when user drew on empty canvas).
   * When present with length ≥ 2 and no usable anchor path, load as a doodle thread.
   */
  polyline?: Array<{ x: number; y: number }>;
  /** Free end in content space when the thread leaves the last anchor into empty hoop interior. */
  openTail?: { x: number; y: number };
  /**
   * Normalized free end in content space (0..1 relative to current loom view size).
   * Prefer this on restore so open tails stay aligned after canvas resize.
   */
  openTailNorm?: { x: number; y: number };
  /**
   * Loom-local normalized free end: ((x-cx)/rimR, (y-cy)/rimR).
   * More stable than viewport normalization when aspect ratio changes.
   */
  openTailLoomNorm?: { x: number; y: number };
  textureId: MaterialTextureId;
  lineWidth: number;
  /** Pixi tint number (0xRRGGBB). */
  color: number;
  /** Optional end tint for along-path gradient. */
  gradientColor?: number;
  /** 0..1 */
  opacity: number;
  /** 0..1 (lower = softer/more sag) */
  stiffness: number;
}

export interface SavedCreation {
  version: 1;
  savedAt: number;
  /** Optional title from detail “Name it”. */
  displayName?: string;
  threads: SavedCreationThread[];
  /**
   * Optional names for each thread. Used in "Stories Behind Materials" to show
   * labels for custom-named lines. Default "Line N" names are omitted from display.
   */
  threadNames?: string[];
  /**
   * UI context (optional). Not required to render, but useful if later we want
   * to restore sliders for new strokes.
   */
  ui?: {
    textureId?: MaterialTextureId;
    colorHex?: string;
    gradientColorHex?: string;
    thickness?: number;
    opacity?: number; // 0..100
    softness?: number; // 0..100
    /** Create 页 Pixi 画布背景 #rrggbb */
    canvasBackgroundHex?: string;
    /** Create 页织环形状（与 anchor 拓扑一致；缺省为 circle） */
    loomShape?: LoomShape;
  };
  /** 仅织机 peg 创作；My Creation 卡片栈 / Gallery 预览 */
  cachedCardPreviewPngDataUrl?: string;
  /** 织机 + loom 外材质涂鸦（不含 Freehand 细笔）；详情页第一张 */
  cachedDetailFlatPngDataUrl?: string;
  /** 全部笔迹 + 故事气泡；详情页第二张 */
  cachedDetailBubblesPngDataUrl?: string;
  /** 与 {@link CARD_PREVIEW_LAYOUT_VERSION} 一致时才使用 `cachedCardPreviewPngDataUrl` */
  cardPreviewLayoutVersion?: number;
}

type SavedCreationEntry = {
  projectId: string;
  creation: SavedCreation;
};

const HISTORY_STORAGE_KEY = 'loom-saved-creation-history-v1';
const CURRENT_PROJECT_ID_STORAGE_KEY = 'loom-saved-creation-current-project-id-v1';

// Legacy (pre-history) key: keep for migration.
const LEGACY_LAST_STORAGE_KEY = 'loom-saved-creation-last';
export const SAVED_CREATIONS_UPDATED_EVENT = 'loom-saved-creations-updated';

const createProjectId = () => `p-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isProbablySavedCreation(x: unknown): x is SavedCreation {
  if (!x || typeof x !== 'object') return false;
  const o = x as any;
  return o.version === 1 && typeof o.savedAt === 'number' && Array.isArray(o.threads);
}

function readHistoryEntries(): SavedCreationEntry[] {
  const parsed = safeParseJson<unknown>(localStorage.getItem(HISTORY_STORAGE_KEY));
  if (!parsed) return [];
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((e) => {
      if (!e || typeof e !== 'object') return null;
      const oe: any = e;
      if (typeof oe.projectId !== 'string') return null;
      if (!isProbablySavedCreation(oe.creation)) return null;
      return { projectId: oe.projectId, creation: oe.creation };
    })
    .filter(Boolean) as SavedCreationEntry[];
}

function writeHistoryEntries(entries: SavedCreationEntry[]): void {
  localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(entries));
}

function notifySavedCreationsUpdated(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SAVED_CREATIONS_UPDATED_EVENT));
}

function getOrInitCurrentProjectId(): string {
  const existing = localStorage.getItem(CURRENT_PROJECT_ID_STORAGE_KEY);
  if (existing && existing.trim()) return existing;
  const created = createProjectId();
  localStorage.setItem(CURRENT_PROJECT_ID_STORAGE_KEY, created);
  return created;
}

/** 旧版单字段 `exportPreviewPngDataUrl`（含气泡）→ `cachedDetailBubblesPngDataUrl` */
export function migrateLegacyExportPreviewFields(c: SavedCreation): SavedCreation {
  const leg = c as SavedCreation & { exportPreviewPngDataUrl?: string };
  if (
    typeof leg.exportPreviewPngDataUrl === 'string' &&
    leg.exportPreviewPngDataUrl.length > 0 &&
    !leg.cachedDetailBubblesPngDataUrl
  ) {
    return { ...leg, cachedDetailBubblesPngDataUrl: leg.exportPreviewPngDataUrl };
  }
  return c;
}

function migrateLegacyLastIfNeeded(): void {
  const history = readHistoryEntries();
  if (history.length > 0) return;

  const legacyRaw = localStorage.getItem(LEGACY_LAST_STORAGE_KEY);
  const legacyParsed = safeParseJson<unknown>(legacyRaw);
  if (!isProbablySavedCreation(legacyParsed)) return;

  const currentProjectId = getOrInitCurrentProjectId();
  writeHistoryEntries([{ projectId: currentProjectId, creation: legacyParsed }]);
}

export function saveLastCreation(creation: Omit<SavedCreation, 'version' | 'savedAt'>): SavedCreation {
  const projectId = getOrInitCurrentProjectId();
  const history = readHistoryEntries();

  const prevCreation =
    history.length > 0 && history[history.length - 1].projectId === projectId
      ? history[history.length - 1].creation
      : null;

  const threadsEmpty = !creation.threads || creation.threads.length === 0;
  const cachedCardPreviewPngDataUrl = threadsEmpty
    ? undefined
    : creation.cachedCardPreviewPngDataUrl ?? prevCreation?.cachedCardPreviewPngDataUrl;
  const cachedDetailFlatPngDataUrl = threadsEmpty
    ? undefined
    : creation.cachedDetailFlatPngDataUrl ?? prevCreation?.cachedDetailFlatPngDataUrl;
  const cachedDetailBubblesPngDataUrl = threadsEmpty
    ? undefined
    : creation.cachedDetailBubblesPngDataUrl ?? prevCreation?.cachedDetailBubblesPngDataUrl;
  const cardPreviewLayoutVersion = threadsEmpty
    ? undefined
    : creation.cardPreviewLayoutVersion ?? prevCreation?.cardPreviewLayoutVersion;

  const withMeta: SavedCreation = {
    version: 1,
    savedAt: Date.now(),
    ...creation,
    cachedCardPreviewPngDataUrl,
    cachedDetailFlatPngDataUrl,
    cachedDetailBubblesPngDataUrl,
    cardPreviewLayoutVersion,
  };

  if (history.length > 0 && history[history.length - 1].projectId === projectId) {
    history[history.length - 1] = { projectId, creation: withMeta };
    writeHistoryEntries(history);
    notifySavedCreationsUpdated();
    return withMeta;
  }

  history.push({ projectId, creation: withMeta });
  writeHistoryEntries(history);
  notifySavedCreationsUpdated();
  return withMeta;
}

/**
 * Write all three cached PNGs for the latest history entry (same project), without bumping savedAt.
 */
export function patchCurrentProjectExportCaches(urls: {
  cachedCardPreviewPngDataUrl: string;
  cachedDetailFlatPngDataUrl: string;
  cachedDetailBubblesPngDataUrl: string;
}): void {
  try {
    migrateLegacyLastIfNeeded();
    const projectId = getOrInitCurrentProjectId();
    const history = readHistoryEntries();
    if (history.length === 0) return;
    const last = history[history.length - 1];
    if (last.projectId !== projectId) return;

    const threads = last.creation.threads;
    if (!threads || threads.length === 0) {
      last.creation = {
        ...last.creation,
        cachedCardPreviewPngDataUrl: undefined,
        cachedDetailFlatPngDataUrl: undefined,
        cachedDetailBubblesPngDataUrl: undefined,
        cardPreviewLayoutVersion: undefined,
      };
      writeHistoryEntries(history);
      notifySavedCreationsUpdated();
      return;
    }

    last.creation = {
      ...last.creation,
      cachedCardPreviewPngDataUrl: urls.cachedCardPreviewPngDataUrl,
      cachedDetailFlatPngDataUrl: urls.cachedDetailFlatPngDataUrl,
      cachedDetailBubblesPngDataUrl: urls.cachedDetailBubblesPngDataUrl,
      cardPreviewLayoutVersion: CARD_PREVIEW_LAYOUT_VERSION,
    };
    writeHistoryEntries(history);
    notifySavedCreationsUpdated();
  } catch {
    // e.g. quota exceeded
  }
}

export function getLastCreation(): SavedCreation | null {
  try {
    migrateLegacyLastIfNeeded();
    const history = readHistoryEntries();
    if (history.length === 0) return null;
    return migrateLegacyExportPreviewFields(history[history.length - 1].creation);
  } catch {
    return null;
  }
}

/**
 * Called when user clicks "Start a new project" (previous project ends).
 * Next `saveLastCreation()` will create/append a new history entry.
 */
export function startNewProject(): void {
  // Always switch to a new projectId; we only add an entry when user actually clicks Save.
  const created = createProjectId();
  localStorage.setItem(CURRENT_PROJECT_ID_STORAGE_KEY, created);
}

/**
 * Get creations for all projects that have at least one "Save" clicked.
 * For each project we keep only the latest saved snapshot.
 */
export function getSavedCreationsForAdmin(): SavedCreation[] {
  try {
    migrateLegacyLastIfNeeded();
    const history = readHistoryEntries();
    return history.map((e) => migrateLegacyExportPreviewFields(e.creation));
  } catch {
    return [];
  }
}

/** Update `displayName` for the history entry matching `savedAt`. Returns the updated creation, or null if not found. */
export function updateSavedCreationDisplayName(savedAt: number, displayName: string): SavedCreation | null {
  try {
    migrateLegacyLastIfNeeded();
    const history = readHistoryEntries();
    const trimmed = displayName.trim();
    let updated: SavedCreation | null = null;
    const next = history.map((e) => {
      if (e.creation.savedAt !== savedAt) return e;
      const creation: SavedCreation = {
        ...e.creation,
        displayName: trimmed.length > 0 ? trimmed : undefined,
      };
      updated = creation;
      return { ...e, creation };
    });
    if (!updated) return null;
    writeHistoryEntries(next);
    notifySavedCreationsUpdated();
    return migrateLegacyExportPreviewFields(updated);
  } catch {
    return null;
  }
}

/**
 * Convert tint number back to `#rrggbb`.
 * Note: we don't currently store this in the saved thread itself.
 */
export function tintToHex(tint: number): string {
  const n = Math.max(0, Math.min(0xffffff, Math.round(tint)));
  return '#' + n.toString(16).padStart(6, '0');
}

/**
 * Convert hex to tint number (0xRRGGBB).
 */
export function hexToTint(hex: string): number {
  const s = hex.replace(/^#/, '');
  if (s.length !== 6) return 0xe8d5b7;
  return parseInt(s, 16);
}

export function isProbablyPointArray(x: unknown): x is Point[] {
  return Array.isArray(x) && x.every((p) => typeof p === 'object' && p != null && 'x' in p && 'y' in p);
}

/** Thread indices with a user-defined name (default `Line N` excluded). Used for material story labels. */
export function getCustomNamedThreadIndices(creation: SavedCreation): number[] {
  const threadNames =
    creation.threadNames ??
    (Array.isArray(creation.threads) ? creation.threads.map((_, i) => `Line ${i + 1}`) : []);
  const out: number[] = [];
  for (let i = 0; i < threadNames.length; i++) {
    const name = threadNames[i] ?? '';
    if (!/^Line \d+$/.test(name)) out.push(i);
  }
  return out;
}

