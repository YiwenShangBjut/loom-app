import { memo, useCallback, useEffect, useRef } from 'react';
import { buildCreationCachedExportDataUrls } from '../creationCachedExport';
import { patchCurrentProjectExportCaches } from '../savedCreation';
import type { SavedCreation } from '../savedCreation';
import { LoomCanvas, type LoomCanvasHandle } from './LoomCanvas';

/** Dispatched after draft flush when leaving Create; handled by a persistent off-screen LoomCanvas. */
export const CREATION_EXPORT_QUEUE_EVENT = 'loom-creation-export-queue';

export function queueCreationExportForCache(creation: SavedCreation): void {
  window.dispatchEvent(new CustomEvent(CREATION_EXPORT_QUEUE_EVENT, { detail: { creation } }));
}

/**
 * Renders a hidden LoomCanvas used only to build My Creation PNG caches after navigation.
 * Must stay mounted while routes change so leaving Create does not mutate the visible canvas.
 */
function CreationExportWorkerInner() {
  const loomRef = useRef<LoomCanvasHandle>(null);
  const queueRef = useRef<SavedCreation[]>([]);
  const drainingRef = useRef(false);

  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const creation = queueRef.current.shift()!;

        let loom = loomRef.current;
        for (let i = 0; i < 60 && !loom; i += 1) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          loom = loomRef.current;
        }
        if (!loom) continue;

        const bg = creation.ui?.canvasBackgroundHex ?? '#ffffff';
        loom.setCanvasBackgroundHex(bg);
        const shape = creation.ui?.loomShape === 'triangle' ? 'triangle' : 'circle';
        loom.setLoomShape(shape, true);

        try {
          const urls = await buildCreationCachedExportDataUrls(loom, creation);
          if (urls) {
            patchCurrentProjectExportCaches({
              cachedCardPreviewPngDataUrl: urls.cardPreview,
              cachedDetailFlatPngDataUrl: urls.detailFlat,
              cachedDetailBubblesPngDataUrl: urls.detailBubbles,
            });
          }
        } catch {
          // ignore GPU / quota failures
        }
      }
    } finally {
      drainingRef.current = false;
      if (queueRef.current.length > 0) {
        queueMicrotask(() => {
          void drainQueue();
        });
      }
    }
  }, []);

  useEffect(() => {
    const onQueued = (e: Event) => {
      const ce = e as CustomEvent<{ creation: SavedCreation }>;
      const c = ce.detail?.creation;
      if (!c?.threads?.length) return;
      queueRef.current.push(c);
      void drainQueue();
    };
    window.addEventListener(CREATION_EXPORT_QUEUE_EVENT, onQueued);
    return () => window.removeEventListener(CREATION_EXPORT_QUEUE_EVENT, onQueued);
  }, [drainQueue]);

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: -9999,
        top: 0,
        width: 800,
        height: 720,
        overflow: 'hidden',
        pointerEvents: 'none',
        opacity: 0,
      }}
    >
      <LoomCanvas
        ref={loomRef}
        readOnly
        materialEnabled={false}
        paused={false}
        skipIdleOnInit
        alwaysIdle={false}
        canvasBackground="#ffffff"
      />
    </div>
  );
}

export const CreationExportWorker = memo(CreationExportWorkerInner);
