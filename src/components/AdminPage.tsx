import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoomCanvas, type LoomCanvasHandle } from './LoomCanvas';
import { composeCanvasWithStoryBubbles, nextExportFrame } from '../creationExportCompose';
import type { SavedCreation } from '../savedCreation';
import { getSavedCreationsForAdmin } from '../savedCreation';
import type { MaterialTextureId } from '../rendering/materialTextures';
import { getUserDisplayName, normalizeUserDisplayName, setUserDisplayName as persistUserDisplayName } from '../userDisplayName';
import './AdminPage.css';

const SUBJECT_ID_CANONICAL_STORAGE_KEY = 'loom-subject-id-v1';
const SUBJECT_ID_LEGACY_KEYS = ['loom-subject-id', 'subjectId', 'participantId'];

function normalizeSubjectId(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function tryReadFromLocalStorage(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (!v) return null;
    const trimmed = normalizeSubjectId(v);
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function findSubjectIdInLocalStorage(): { value: string; keyUsed: string | null } {
  // 1) 先查已知/遗留 key（如果你项目里已有某个 key，这里尽量命中）。
  for (const key of SUBJECT_ID_LEGACY_KEYS) {
    const v = tryReadFromLocalStorage(key);
    if (v) return { value: v, keyUsed: key };
  }

  // 2) 再查 canonical key。
  const canonical = tryReadFromLocalStorage(SUBJECT_ID_CANONICAL_STORAGE_KEY);
  if (canonical) return { value: canonical, keyUsed: SUBJECT_ID_CANONICAL_STORAGE_KEY };

  // 3) 最后兜底：尝试从其他可能命名里猜（避免你说的“已存在于 localStorage”但 key 不在源码里）。
  try {
    for (const key of Object.keys(localStorage)) {
      const k = key.toLowerCase();
      if (
        k.includes('subject')
        || k.includes('participant')
        || key.includes('受试')
        || key.includes('编号')
      ) {
        const v = tryReadFromLocalStorage(key);
        if (v) return { value: v, keyUsed: key };
      }
    }
  } catch {
    // ignore
  }

  return { value: '', keyUsed: null };
}

function persistSubjectIdToLocalStorage(subjectId: string, keyUsed: string | null): string | null {
  const normalized = normalizeSubjectId(subjectId);
  const nextKey = keyUsed ?? SUBJECT_ID_CANONICAL_STORAGE_KEY;
  try {
    if (!normalized) {
      localStorage.removeItem(nextKey);
      return keyUsed;
    }
    localStorage.setItem(nextKey, normalized);
    return nextKey;
  } catch {
    return keyUsed;
  }
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 200);
}

type AndroidBridgeLike = {
  releaseMemory?: () => void;
  clearAllStorage?: () => void;
  getMemoryInfo?: () => string;
  savePngToGallery?: (base64Data: string, filename: string) => string;
};

async function saveCanvasToAndroidGalleryIfPossible(filename: string, canvas: HTMLCanvasElement): Promise<boolean> {
  const bridge = (window as unknown as { AndroidBridge?: AndroidBridgeLike }).AndroidBridge;
  if (!bridge?.savePngToGallery) return false;

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (!b) reject(new Error('canvas.toBlob 失败'));
        else resolve(b);
      },
      'image/png',
      1,
    );
  });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('读取图片数据失败'));
    };
    reader.onerror = () => reject(new Error('读取图片数据失败'));
    reader.readAsDataURL(blob);
  });

  const raw = bridge.savePngToGallery(dataUrl, sanitizeFilename(filename));
  let parsed: { ok?: boolean; message?: string } | null = null;
  try {
    parsed = JSON.parse(raw) as { ok?: boolean; message?: string };
  } catch {
    parsed = null;
  }
  if (!parsed?.ok) {
    throw new Error(parsed?.message || '保存到安卓相册失败');
  }
  return true;
}

async function safeDownloadPng(filename: string, canvas: HTMLCanvasElement): Promise<void> {
  const safeName = sanitizeFilename(filename);
  if (!canvas) throw new Error('canvas 为空');

  const savedToGallery = await saveCanvasToAndroidGalleryIfPossible(safeName, canvas);
  if (savedToGallery) return;

  await new Promise<void>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('canvas.toBlob 失败'));
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = safeName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        resolve();
      },
      'image/png',
      1,
    );
  });
}

async function exportCreationToPngObjectUrl(
  loomHostEl: HTMLDivElement | null,
  loomRef: RefObject<LoomCanvasHandle | null>,
  creation: SavedCreation,
): Promise<string> {
  const ok = await tryLoadCreationIntoLoom(loomRef, creation);
  if (!ok) throw new Error('loom 未准备好，无法加载已保存 creation');

  // sag/rope 在 ticker 中更新，等更多帧让画面稳定（缩略图不需要特别高分辨率）
  for (let i = 0; i < 18; i += 1) await nextExportFrame();

  let canvas =
    loomRef.current?.getExportSnapshotCanvas() ??
    (loomHostEl?.querySelector('canvas') as HTMLCanvasElement | null);
  if (!canvas) throw new Error('未找到 loom 导出位图');

  // 有时离屏布局会在后续帧才完成，把 canvas 的宽高等到非 0 再导出。
  for (let i = 0; i < 10 && (canvas.width === 0 || canvas.height === 0); i += 1) {
    await nextExportFrame();
    canvas =
      loomRef.current?.getExportSnapshotCanvas() ??
      (loomHostEl?.querySelector('canvas') as HTMLCanvasElement | null);
    if (!canvas) throw new Error('未找到 loom 导出位图');
  }
  if (canvas.width === 0 || canvas.height === 0) {
    throw new Error(`canvas 尺寸异常：${canvas.width}x${canvas.height}`);
  }

  const composed = composeCanvasWithStoryBubbles(canvas, loomRef.current, creation);
  const blob = await new Promise<Blob>((resolve, reject) => {
    composed.toBlob(
      (b) => {
        if (!b) reject(new Error('canvas.toBlob 失败'));
        else resolve(b);
      },
      'image/png',
      1,
    );
  });

  return URL.createObjectURL(blob);
}

async function tryLoadCreationIntoLoom(loomRef: RefObject<LoomCanvasHandle | null>, creation: SavedCreation) {
  // LoomCanvas 内部的 wrap/sag 初始化是异步的：这里轮询直到 tryLoadCreation 返回 true。
  for (let i = 0; i < 240; i += 1) {
    const ok = loomRef.current?.tryLoadCreation(creation);
    if (ok) return true;
    await nextExportFrame();
  }
  return false;
}

async function exportCreationToPng(
  loomHostEl: HTMLDivElement | null,
  loomRef: RefObject<LoomCanvasHandle | null>,
  creation: SavedCreation,
  filename: string,
) {
  const ok = await tryLoadCreationIntoLoom(loomRef, creation);
  if (!ok) throw new Error('loom 未准备好，无法加载已保存 creation');

  // sag/rope 在 ticker 中更新，等更多帧让画面稳定
  for (let i = 0; i < 24; i += 1) await nextExportFrame();

  let canvas =
    loomRef.current?.getExportSnapshotCanvas() ??
    (loomHostEl?.querySelector('canvas') as HTMLCanvasElement | null);
  if (!canvas) throw new Error('未找到 loom 导出位图');

  // 有时离屏布局会在后续帧才完成，把 canvas 的宽高等到非 0 再导出。
  for (let i = 0; i < 10 && (canvas.width === 0 || canvas.height === 0); i += 1) {
    await nextExportFrame();
    canvas =
      loomRef.current?.getExportSnapshotCanvas() ??
      (loomHostEl?.querySelector('canvas') as HTMLCanvasElement | null);
    if (!canvas) throw new Error('未找到 loom 导出位图');
  }
  if (canvas.width === 0 || canvas.height === 0) {
    throw new Error(`canvas 尺寸异常：${canvas.width}x${canvas.height}`);
  }

  const composed = composeCanvasWithStoryBubbles(canvas, loomRef.current, creation);
  await safeDownloadPng(filename, composed);
  return true;
}

export function AdminPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [isGeneratingThumbnails, setIsGeneratingThumbnails] = useState(false);
  const [creationsCount, setCreationsCount] = useState(0);
  const [creationThumbObjectUrls, setCreationThumbObjectUrls] = useState<string[]>([]);

  const loomHostRef = useRef<HTMLDivElement | null>(null);
  const loomRef = useRef<LoomCanvasHandle | null>(null);

  const [subjectId, setSubjectId] = useState('');
  const [userDisplayName, setUserDisplayNameState] = useState('');
  const subjectIdStorageKeyRef = useRef<string | null>(null);
  const [memoryInfo, setMemoryInfo] = useState<string | null>(null);
  const creationThumbObjectUrlsRef = useRef<string[]>([]);

  // 给 LoomCanvas 提供“保存时的 UI 参数”，保证导出画面与当时的整体创作一致。
  const [exportTextureId, setExportTextureId] = useState<MaterialTextureId>('none');
  const [exportColorHex, setExportColorHex] = useState<string | undefined>(undefined);
  const [exportThickness, setExportThickness] = useState<number | undefined>(undefined); // 0..100
  const [exportOpacity, setExportOpacity] = useState<number | undefined>(undefined); // 0..100
  const [exportSoftness, setExportSoftness] = useState<number | undefined>(undefined); // 0..100

  useEffect(() => {
    const found = findSubjectIdInLocalStorage();
    setSubjectId(found.value);
    subjectIdStorageKeyRef.current = found.keyUsed;
    setUserDisplayNameState(getUserDisplayName());
  }, []);

  // 轮询显示当前内存占用
  useEffect(() => {
    function readMemory(): string | null {
      const bridge = (window as unknown as { AndroidBridge?: AndroidBridgeLike }).AndroidBridge;
      if (bridge?.getMemoryInfo) {
        try {
          const raw = bridge.getMemoryInfo();
          const o = JSON.parse(raw) as { usedMb: number; totalMb: number; maxMb: number };
          return `应用堆内存：${o.usedMb.toFixed(1)} MB / ${o.totalMb.toFixed(1)} MB（最大 ${o.maxMb.toFixed(0)} MB）`;
        } catch {
          return null;
        }
      }
      const perf = performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } };
      if (perf.memory) {
        const used = (perf.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
        const total = (perf.memory.totalJSHeapSize / (1024 * 1024)).toFixed(1);
        const limit = (perf.memory.jsHeapSizeLimit / (1024 * 1024)).toFixed(0);
        return `JS 堆：${used} MB / ${total} MB（上限 ${limit} MB）`;
      }
      return null;
    }

    const tick = () => setMemoryInfo(readMemory());
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);

  function handleSaveSubjectId() {
    try {
      const nextKey = persistSubjectIdToLocalStorage(subjectId, subjectIdStorageKeyRef.current);
      subjectIdStorageKeyRef.current = nextKey;
      setStatus('受试者编号已保存。');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : '保存失败');
    }
  }

  function handleSaveUserDisplayName() {
    try {
      persistUserDisplayName(userDisplayName);
      setUserDisplayNameState(getUserDisplayName());
      setStatus('用户名已保存。');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : '保存失败');
    }
  }

  function revokeThumbObjectUrls(urls: string[]) {
    for (const u of urls) {
      if (!u.startsWith('blob:')) continue;
      try {
        URL.revokeObjectURL(u);
      } catch {
        // ignore
      }
    }
  }

  // 在 admin 页面下方展示“当前已有”的整体创作 PNG 预览（缩略图）
  useEffect(() => {
    let cancelled = false;

    async function generate() {
      const creations = getSavedCreationsForAdmin();
      setCreationsCount(creations.length);
      if (creations.length === 0) return;

      setIsGeneratingThumbnails(true);
      revokeThumbObjectUrls(creationThumbObjectUrlsRef.current);
      creationThumbObjectUrlsRef.current = [];
      setCreationThumbObjectUrls([]);

      try {
        const urls: string[] = [];
        for (let i = 0; i < creations.length; i += 1) {
          if (cancelled) break;

          const creation = creations[i];

          if (creation.cachedDetailBubblesPngDataUrl) {
            urls.push(creation.cachedDetailBubblesPngDataUrl);
            continue;
          }

          // 用保存的 UI 还原整体创作的材质/粗细/透明度/柔软度
          setExportTextureId(creation.ui?.textureId ?? 'none');
          setExportColorHex(creation.ui?.colorHex);
          setExportThickness(creation.ui?.thickness);
          setExportOpacity(creation.ui?.opacity);
          setExportSoftness(creation.ui?.softness);

          // 等 LoomCanvas props 同步与渲染稳定
          await nextExportFrame();
          await nextExportFrame();

          const url = await exportCreationToPngObjectUrl(loomHostRef.current, loomRef, creation);
          urls.push(url);
        }

        if (!cancelled) {
          creationThumbObjectUrlsRef.current = urls;
          setCreationThumbObjectUrls(urls);
        } else {
          revokeThumbObjectUrls(urls);
        }
      } catch (e) {
        if (!cancelled) {
          setStatus(e instanceof Error ? e.message : '生成预览失败');
        }
      } finally {
        if (!cancelled) setIsGeneratingThumbnails(false);
      }
    }

    generate();
    return () => {
      cancelled = true;
      revokeThumbObjectUrls(creationThumbObjectUrlsRef.current);
      creationThumbObjectUrlsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleReleaseMemory() {
    // Android WebView：通过 JS 桥接调用原生清理（clearCache + reload），效果最明显
    const bridge = (window as unknown as { AndroidBridge?: AndroidBridgeLike }).AndroidBridge;
    if (bridge?.releaseMemory) {
      try {
        bridge.releaseMemory();
        // 原生会执行 reload，页面会刷新，此处无需 setStatus
      } catch {
        setStatus('调用原生释放内存失败');
      }
      return;
    }

    // 非 WebView 环境：仅做 Web 侧清理
    try {
      const urlCount = creationThumbObjectUrlsRef.current.length;
      revokeThumbObjectUrls(creationThumbObjectUrlsRef.current);
      creationThumbObjectUrlsRef.current = [];
      setCreationThumbObjectUrls([]);

      const canvases = document.querySelectorAll('canvas');
      let releasedCount = 0;
      canvases.forEach((canvas) => {
        const gl =
          (canvas.getContext('webgl') as WebGLRenderingContext | null) ||
          (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
        if (gl) {
          const ext = gl.getExtension('WEBGL_lose_context');
          if (ext) {
            ext.loseContext();
            releasedCount += 1;
          }
        }
      });

      if (typeof (window as unknown as { gc?: () => void }).gc === 'function') {
        (window as unknown as { gc: () => void }).gc();
      }

      const parts: string[] = [];
      if (urlCount > 0) parts.push(`撤销 ${urlCount} 个对象 URL`);
      if (releasedCount > 0) parts.push(`释放 ${releasedCount} 个 WebGL 上下文`);
      let msg = parts.length > 0 ? `已释放内存：${parts.join('，')}。` : '已释放内存。';
      if (releasedCount > 0) msg += ' 若导出异常请刷新页面。';
      setStatus(msg);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : '释放内存失败');
    }
  }

  function handleClear() {
    try {
      const ok1 = window.confirm('确定清空所有数据吗？包括 localStorage、WebView 缓存、IndexedDB 等。此操作不可撤销。');
      if (!ok1) return;
      const ok2 = window.confirm('请再次确认：仍要清空所有数据吗？');
      if (!ok2) return;

      // Web 侧：localStorage、sessionStorage
      localStorage.clear();
      sessionStorage.clear();

      // 尝试清除 IndexedDB（若存在）
      if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
        indexedDB.databases().then((dbs) => {
          dbs.forEach((db) => {
            if (db.name) indexedDB.deleteDatabase(db.name);
          });
        }).catch(() => { /* 忽略 */ });
      }

      // Android WebView：通过桥接清空 HTTP 缓存、Web Storage、IndexedDB、WebSQL 等
      const bridge = (window as unknown as { AndroidBridge?: AndroidBridgeLike }).AndroidBridge;
      if (bridge?.clearAllStorage) {
        bridge.clearAllStorage();
      }

      revokeThumbObjectUrls(creationThumbObjectUrlsRef.current);
      creationThumbObjectUrlsRef.current = [];
      setCreationThumbObjectUrls([]);
      setCreationsCount(0);
      setStatus('已清空所有数据（含 WebView 缓存）。');
      setSubjectId('');
      setUserDisplayNameState('');
      subjectIdStorageKeyRef.current = null;
    } catch (e) {
      setStatus(e instanceof Error ? e.message : '清空失败');
    }
  }

  async function handleExportCanvasImages() {
    if (isWorking || isGeneratingThumbnails) return;
    setIsWorking(true);
    setStatus(null);

    try {
      const subjectIdForExport = normalizeSubjectId(subjectId);
      const subjectIdPrefix = subjectIdForExport ? `subject-${subjectIdForExport}-` : 'subject-unknown-';

      const creations = getSavedCreationsForAdmin();
      if (creations.length === 0) {
        setStatus('没有可导出的整体创作（请先在 Create 页点击保存）。');
        return;
      }

      setStatus(`正在导出 ${creations.length} 个整体创作（PNG）...`);
      for (let i = 0; i < creations.length; i += 1) {
        const creation = creations[i];
        setStatus(`正在导出第 ${i + 1}/${creations.length} 张...`);

        // 用保存的 UI 还原整体创作的材质/粗细/透明度/柔软度
        setExportTextureId(creation.ui?.textureId ?? 'none');
        setExportColorHex(creation.ui?.colorHex);
        setExportThickness(creation.ui?.thickness);
        setExportOpacity(creation.ui?.opacity);
        setExportSoftness(creation.ui?.softness);

        // 等 LoomCanvas 完成 props 同步与渲染稳定
        await nextExportFrame();
        await nextExportFrame();

        const iso = new Date(creation.savedAt).toISOString().replace(/[:]/g, '-');
        const filename = `${subjectIdPrefix}creation-${i + 1}-${iso}.png`;
        await exportCreationToPng(loomHostRef.current, loomRef, creation, filename);
      }

      setStatus('导出完成。');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : '导出失败');
    } finally {
      setIsWorking(false);
    }
  }

  return (
    <div className="admin-page">
      <button
        type="button"
        className="admin-home-nav-btn"
        onClick={() => navigate('/home')}
        disabled={isWorking || isGeneratingThumbnails}
      >
        进入 Home
      </button>

      {/* 仅用于离屏导出 PNG，不对用户可见 */}
      <div ref={loomHostRef} className="admin-loom-export-host" aria-hidden>
        <LoomCanvas
          ref={loomRef}
          textureId={exportTextureId}
          color={exportColorHex}
          thickness={exportThickness}
          opacity={exportOpacity}
          softness={exportSoftness}
        />
      </div>

      <div className="admin-content">
        <h1 className="admin-title">Admin</h1>

        {memoryInfo ? (
          <div className="admin-memory" aria-live="polite">
            {memoryInfo}
          </div>
        ) : null}

        <div className="admin-subject">
          <label className="admin-label" htmlFor="admin-subject-id-input">
            受试者编号
          </label>
          <div className="admin-subject-row">
            <input
              id="admin-subject-id-input"
              className="admin-input"
              type="text"
              inputMode="text"
              autoComplete="off"
              placeholder="例如：001 / A-01"
              value={subjectId}
              disabled={isWorking}
              onChange={(e) => {
                setSubjectId(normalizeSubjectId(e.target.value));
              }}
            />
            <button
              type="button"
              className="admin-subject-save-btn"
              onClick={handleSaveSubjectId}
              disabled={isWorking || isGeneratingThumbnails}
            >
              保存
            </button>
          </div>
          <div className="admin-hint">用于导出文件名；清空会一并清除。</div>
        </div>

        <div className="admin-subject">
          <label className="admin-label" htmlFor="admin-user-display-name-input">
            用户名（首页标题）
          </label>
          <div className="admin-subject-row">
            <input
              id="admin-user-display-name-input"
              className="admin-input"
              type="text"
              inputMode="text"
              autoComplete="name"
              placeholder="例如：Alex"
              value={userDisplayName}
              disabled={isWorking}
              onChange={(e) => {
                setUserDisplayNameState(normalizeUserDisplayName(e.target.value));
              }}
            />
            <button
              type="button"
              className="admin-subject-save-btn"
              onClick={handleSaveUserDisplayName}
              disabled={isWorking || isGeneratingThumbnails}
            >
              保存
            </button>
          </div>
          <div className="admin-hint">保存后首页会显示为：Hey, 用户名, time to craft…</div>
        </div>

        <div className="admin-actions">
          <button
            type="button"
            className="admin-btn"
            onClick={handleReleaseMemory}
            disabled={isWorking || isGeneratingThumbnails}
          >
            释放内存
          </button>
          <button
            type="button"
            className="admin-btn admin-btn-danger"
            onClick={handleClear}
            disabled={isWorking || isGeneratingThumbnails}
          >
            清空所有数据（含 WebView 缓存）
          </button>
          <button
            type="button"
            className="admin-btn"
            onClick={handleExportCanvasImages}
            disabled={isWorking || isGeneratingThumbnails}
          >
            导出所有整体创作（PNG）
          </button>
        </div>

        <div className="admin-creations-preview" aria-label="整体创作 PNG 预览">
          {isGeneratingThumbnails ? (
            <div className="admin-thumb-loading">生成预览中...</div>
          ) : creationThumbObjectUrls.length > 0 ? (
            <div className="admin-thumbs-scroll">
              {creationThumbObjectUrls.map((src, idx) => (
                <div className="admin-thumb-card" key={`${idx}`}>
                  <img className="admin-thumb-img" src={src} alt={`整体创作 ${idx + 1}`} />
                </div>
              ))}
            </div>
          ) : creationsCount === 0 ? (
            <div className="admin-thumb-empty">当前没有保存的整体创作（请先在 Create 页点击保存）。</div>
          ) : null}
        </div>

        {status ? <div className="admin-status">{status}</div> : null}
      </div>
    </div>
  );
}

