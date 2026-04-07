import { useEffect, useState } from 'react';

function readMemory(): string | null {
  const bridge = (window as unknown as { AndroidBridge?: { getMemoryInfo: () => string } }).AndroidBridge;
  if (bridge?.getMemoryInfo) {
    try {
      const raw = bridge.getMemoryInfo();
      const o = JSON.parse(raw) as {
        usedMb: number;
        totalMb: number;
        maxMb: number;
        pssMb?: number;
        nativePssMb?: number;
      };
      if (typeof o.pssMb === 'number') {
        const native = typeof o.nativePssMb === 'number' ? ` · N ${o.nativePssMb.toFixed(0)} MB` : '';
        return `PSS ${o.pssMb.toFixed(0)} MB${native}`;
      }
      return `J ${o.usedMb.toFixed(1)} / ${o.totalMb.toFixed(0)} MB`;
    } catch {
      return null;
    }
  }
  const perf = performance as unknown as {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  };
  if (perf.memory) {
    const used = (perf.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
    const total = (perf.memory.totalJSHeapSize / (1024 * 1024)).toFixed(0);
    return `${used} / ${total} MB`;
  }
  return null;
}

function readGpuStats(): string | null {
  const s = (window as unknown as {
    __loomStats?: {
      filterCreated: number; filterDestroyed: number; filterLive: number;
      geometryCreated: number; geometryDestroyed: number; geometryLive: number;
      pendingCount: number; queueCount: number;
    }
  }).__loomStats;
  if (!s) return null;
  // F/G live = created - destroyed (should stay roughly constant once drawing stops).
  // P = items in the 2-frame delay buffer (expected ~3 frames worth × resources/frame).
  // Q = items queued for incremental destroy (should stay near 0 if budget is sufficient).
  return `F ${s.filterLive}(+${s.filterCreated}-${s.filterDestroyed}) G ${s.geometryLive}(+${s.geometryCreated}-${s.geometryDestroyed}) P${s.pendingCount} Q${s.queueCount}`;
}

/** 左下角不起眼的内存占用指示器 */
export function MemoryIndicator() {
  const [info, setInfo] = useState<string | null>(null);
  const [gpu, setGpu] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      setInfo(readMemory());
      setGpu(readGpuStats());
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  if (!info && !gpu) return null;

  return (
    <div className="memory-indicator" aria-live="polite">
      {info}
      {gpu ? <span style={{ opacity: 0.7, marginLeft: 6 }}>{gpu}</span> : null}
    </div>
  );
}
