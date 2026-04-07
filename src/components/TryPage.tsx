import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TextureSwatchIcon } from './TextureSwatchIcons';
import { ColourWheelPicker, type PickedColour } from './ColourWheelPicker';
import type { MaterialTextureId } from '../rendering/materialTextures';
import { TryCanvas, type FirstCreationData, type TryCanvasHandle } from './TryCanvas';
import { saveBrush, getSavedBrushes, updateBrush, deleteBrush } from '../savedBrushes';
import { MATERIAL_TEXTURE_PRESETS } from '../rendering/materialTextures';
import './CreatePage.css';
import './TryPage.css';
import { markTryTutorialCompletedForCurrentSubject } from '../tryTutorialProgress';
import { MaterialEditNameRow } from './MaterialEditNameRow';
import { EditLinePreviewCanvas } from './EditLinePreviewCanvas';

const MATERIAL_PANEL_WIDTH = 260;
const STEP3B_LONG_PRESS_MS = 700;
/** Try 页 materials 弹框：softness 默认 10%（0=stiff，100=soft） */
const TRY_MATERIALS_DEFAULT_SOFTNESS = 10;

type TutorialPhase = 'intro' | 'step1' | 'step2' | 'step3' | 'step3b' | 'step4' | 'step5';

const iconSize = 14;

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

/** 6 个默认色板：取色器第三个环（ringIndex=2, s=0.70, v=0.75）的 6 个色相，每隔 60° 区分最大 */
const DEFAULT_COLOUR_SWATCHES = ['#bf3939', '#bfbf39', '#39bf39', '#39bfbf', '#3939bf', '#bf39bf'];

function pushRecentHex(nextHex: string, recent: string[], max = 6): string[] {
  const hex = nextHex.toLowerCase();
  const cleaned = recent.map((h) => h.toLowerCase()).filter((h) => h !== hex);
  return [hex, ...cleaned].slice(0, max);
}

function hexToPickedColour(hex: string): PickedColour {
  const s = hex.replace(/^#/, '');
  if (s.length !== 6) {
    return { hex: '#7dd3d0', rgb: { r: 125, g: 211, b: 208 }, hsv: { h: 180, s: 0.41, v: 0.83 }, sectorIndex: 6, ringIndex: 2 };
  }
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return { hex, rgb: { r, g, b }, hsv: { h: 180, s: 0.41, v: 0.83 }, sectorIndex: 0, ringIndex: 2 };
}

function IconBack() {
  return (
    <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M19 12H5" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

export function TryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const tryCanvasRef = useRef<TryCanvasHandle>(null);
  const [tutorialPhase, setTutorialPhase] = useState<TutorialPhase>('intro');
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [showFinalTutorialOverlay, setShowFinalTutorialOverlay] = useState(false);
  const [selectedTexture, setSelectedTexture] = useState<MaterialTextureId>('none');
  const [selectedColour, setSelectedColour] = useState<PickedColour>({
    hex: '#7dd3d0',
    rgb: { r: 125, g: 211, b: 208 },
    hsv: { h: 180, s: 0.41, v: 0.83 },
    sectorIndex: 6,
    ringIndex: 2,
  });
  const [colourPickerOpen, setColourPickerOpen] = useState(false);
  const [recentColourHexes, setRecentColourHexes] = useState<string[]>(DEFAULT_COLOUR_SWATCHES);
  const [thickness, setThickness] = useState(35);
  const [opacity, setOpacity] = useState(100);
  // 0..100：0 = stiff, 100 = soft（与 Create/LoomCanvas 中一致）
  const [softness, setSoftness] = useState(() => TRY_MATERIALS_DEFAULT_SOFTNESS);
  const strokeStyle = useMemo(() => selectedColour.hex, [selectedColour.hex]);
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [canvasResetKey, setCanvasResetKey] = useState(0);
  const [selectedBrushId, setSelectedBrushId] = useState<string | null>(null);
  const [editPanelOpen, setEditPanelOpen] = useState(false);
  const [savedBrushIdStep3b, setSavedBrushIdStep3b] = useState<string | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  /** 每条线结算次数：用于首条 step3 祝贺文案 vs 后续「再试一次」短文案 */
  const tryStrokeCompletionCountRef = useRef(0);
  /** 当前祝贺弹层对应的自动保存笔刷；点 Try again 时删除 */
  const tryPromptAutoSavedBrushIdRef = useRef<string | null>(null);
  /** 与 tryStrokeCompletionCountRef 同步用于渲染长/短祝贺（首条 step3 线为长文案） */
  const promptIsLongCongratsRef = useRef(false);
  const [step3bPanelPos, setStep3bPanelPos] = useState<{ left: number; top: number } | null>(null);
  const [step3bPanelDragging, setStep3bPanelDragging] = useState(false);
  const step3bPanelRef = useRef<HTMLDivElement | null>(null);
  const step3bPanelDragStateRef = useRef<{
    startClientX: number;
    startClientY: number;
    startLeft: number;
    startTop: number;
    pointerId: number;
  } | null>(null);
  const prevBodyStylesRef = useRef<{ userSelect: string; touchAction: string } | null>(null);
  const [showStep5AddPrompt, setShowStep5AddPrompt] = useState(true);
  const [step3bLongPressing, setStep3bLongPressing] = useState(false);
  const prevMaterialsOpenRef = useRef(materialsOpen);
  const [savedBrushesTick, setSavedBrushesTick] = useState(0);
  const [editingBrushId, setEditingBrushId] = useState<string | null>(null);
  const [editTextureId, setEditTextureId] = useState<MaterialTextureId>('none');
  const [editColour, setEditColour] = useState<PickedColour>({
    hex: '#7dd3d0',
    rgb: { r: 125, g: 211, b: 208 },
    hsv: { h: 180, s: 0.41, v: 0.83 },
    sectorIndex: 6,
    ringIndex: 2,
  });
  const [editThickness, setEditThickness] = useState(35);
  const [editOpacity, setEditOpacity] = useState(100);
  const [editSoftness, setEditSoftness] = useState(() => TRY_MATERIALS_DEFAULT_SOFTNESS);
  const [editColourPickerOpen, setEditColourPickerOpen] = useState(false);
  const selectedHex = useMemo(() => selectedColour.hex.toLowerCase(), [selectedColour.hex]);
  const editSelectedHex = useMemo(() => editColour.hex.toLowerCase(), [editColour.hex]);

  const savedBrushes = useMemo(() => {
    void savedBrushesTick;
    return getSavedBrushes();
  }, [savedBrushesTick]);
  const defaultSelectedId = savedBrushes[0]?.id ?? null;
  const effectiveSelectedId =
    selectedBrushId && savedBrushes.some((b) => b.id === selectedBrushId)
      ? selectedBrushId
      : defaultSelectedId;

  const editingBrush = editingBrushId ? savedBrushes.find((b) => b.id === editingBrushId) : null;

  const myMaterialsPanelRef = useRef<HTMLDivElement | null>(null);
  const [step5HintBottomPx, setStep5HintBottomPx] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const startStep5 = Boolean((location.state as any)?.startStep5);
    if (!startStep5) return;

    setTutorialPhase('step5');
    setShowStep5AddPrompt(true);
    setMaterialsOpen(false);
    setEditPanelOpen(false);
    setEditingBrushId(null);
    setShowNamePrompt(false);
    setShowFinalTutorialOverlay(false);
  }, [location.state]);

  // Try 最后一步：用户点击「Get Started」时记为完成教程并进入 create。
  const finalizeTryTutorialAndNavigateToCreate = useCallback(() => {
    markTryTutorialCompletedForCurrentSubject();
    navigate('/create');
  }, [navigate]);

  // Step5：提示词需始终悬浮在 “My materials” 小弹窗上方，
  // 因此 hint 的 bottom 必须跟随弹窗实际高度动态变化。
  useLayoutEffect(() => {
    const shouldShowStep5Hint = tutorialPhase === 'step5' && showStep5AddPrompt && !materialsOpen && !editPanelOpen;
    if (!shouldShowStep5Hint) {
      setStep5HintBottomPx(null);
      return;
    }

    const el = myMaterialsPanelRef.current;
    if (!el) return;

    const compute = () => {
      const rect = el.getBoundingClientRect();
      // distance from viewport bottom
      const panelBottom = window.innerHeight - rect.bottom;
      const GAP_PX = 10; // hint 与弹窗之间的空隙
      setStep5HintBottomPx(panelBottom + rect.height + GAP_PX);
    };

    compute();
    const onResize = () => compute();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [tutorialPhase, showStep5AddPrompt, materialsOpen, editPanelOpen, savedBrushes.length]);

  useEffect(() => {
    if (!editPanelOpen || !editingBrushId) return;
    const brush = getSavedBrushes().find((b) => b.id === editingBrushId);
    if (brush) {
      setEditTextureId(brush.textureId);
      setEditColour(hexToPickedColour(brush.strokeStyle));
      setEditThickness(brush.thickness);
      setEditOpacity(brush.opacity);
      setEditSoftness(brush.softness ?? TRY_MATERIALS_DEFAULT_SOFTNESS);
    }
  }, [editPanelOpen, editingBrushId]);

  // step3b 编辑框初始位置：居中、画布下方
  useEffect(() => {
    if (tutorialPhase === 'step3b' && editPanelOpen) {
      const left = Math.max(8, Math.min(window.innerWidth - MATERIAL_PANEL_WIDTH - 8, (window.innerWidth - MATERIAL_PANEL_WIDTH) / 2));
      const top = Math.max(8, Math.min(window.innerHeight - 420, window.innerHeight * 0.35));
      setStep3bPanelPos({ left, top });
    } else if (tutorialPhase !== 'step3b') {
      setStep3bPanelPos(null);
    }
  }, [tutorialPhase, editPanelOpen]);

  const handleStep3bPanelDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const pos = step3bPanelPos ?? { left: (window.innerWidth - MATERIAL_PANEL_WIDTH) / 2, top: window.innerHeight * 0.35 };
      e.preventDefault();
      e.stopPropagation();
      prevBodyStylesRef.current = {
        userSelect: document.body.style.userSelect,
        touchAction: document.body.style.touchAction,
      };
      document.body.style.userSelect = 'none';
      document.body.style.touchAction = 'none';
      step3bPanelDragStateRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        startLeft: pos.left,
        startTop: pos.top,
        pointerId: e.pointerId,
      };
      setStep3bPanelDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [step3bPanelPos]
  );

  const handleStep3bPanelDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = step3bPanelDragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    e.preventDefault();
    const dx = e.clientX - s.startClientX;
    const dy = e.clientY - s.startClientY;
    const panelH = step3bPanelRef.current?.offsetHeight ?? 420;
    const left = Math.max(8, Math.min(window.innerWidth - MATERIAL_PANEL_WIDTH - 8, s.startLeft + dx));
    const top = Math.max(8, Math.min(window.innerHeight - panelH - 8, s.startTop + dy));
    setStep3bPanelPos({ left, top });
  }, []);

  const handleStep3bPanelDragEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const s = step3bPanelDragStateRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    step3bPanelDragStateRef.current = null;
    setStep3bPanelDragging(false);
    const prev = prevBodyStylesRef.current;
    prevBodyStylesRef.current = null;
    document.body.style.userSelect = prev?.userSelect ?? '';
    document.body.style.touchAction = prev?.touchAction ?? '';
  }, []);

  const tryEditOverrides = useMemo(
    () =>
      tutorialPhase === 'step3b' && editPanelOpen && editingBrush
        ? {
            textureId: editTextureId,
            strokeStyle: editColour.hex,
            thickness: editThickness,
            opacity: editOpacity,
            softness: editSoftness,
          }
        : undefined,
    [
      tutorialPhase,
      editPanelOpen,
      editingBrush,
      editTextureId,
      editColour.hex,
      editThickness,
      editOpacity,
      editSoftness,
    ]
  );

  const trySelectedCommittedIndex = tutorialPhase === 'step3b' && step3bLongPressing ? 0 : null;

  const onTryFirstCreationComplete = useCallback(
    (data: FirstCreationData) => {
      const wasStep3 = tutorialPhase === 'step3';

      if (tutorialPhase === 'step5') {
        saveBrush({
          name: 'Untitled',
          points: data.points,
          textureId: data.textureId,
          strokeStyle: data.strokeStyle,
          lineWidth: data.lineWidth,
          thickness: data.thickness,
          softness,
          opacity,
        });
        setSavedBrushesTick((t) => t + 1);
        setCanvasResetKey((k) => k + 1);
        setShowStep5AddPrompt(true);
        return;
      }

      tryStrokeCompletionCountRef.current += 1;
      const saved = saveBrush({
        name: 'Untitled',
        points: data.points,
        textureId: data.textureId,
        strokeStyle: data.strokeStyle,
        lineWidth: data.lineWidth,
        thickness: data.thickness,
        softness,
        opacity,
      });
      tryPromptAutoSavedBrushIdRef.current = saved.id;
      promptIsLongCongratsRef.current = wasStep3 && tryStrokeCompletionCountRef.current === 1;
      setSavedBrushesTick((t) => t + 1);
      if (wasStep3) {
        setSavedBrushIdStep3b(saved.id);
      }
      setShowNamePrompt(true);
    },
    [tutorialPhase, softness, opacity],
  );

  const prevTutorialPhaseRef = useRef(tutorialPhase);
  useEffect(() => {
    const prevPhase = prevTutorialPhaseRef.current;
    prevTutorialPhaseRef.current = tutorialPhase;
    if (tutorialPhase === 'step5' && prevPhase !== 'step5') {
      setShowStep5AddPrompt(true);
    }
    if (tutorialPhase === 'step5' && prevMaterialsOpenRef.current && !materialsOpen) {
      setShowStep5AddPrompt(false);
    }
    prevMaterialsOpenRef.current = materialsOpen;
  }, [tutorialPhase, materialsOpen]);

  function completeStep3b() {
    setCanvasResetKey((k) => k + 1);
    setEditPanelOpen(false);
    setEditingBrushId(null);
    setSavedBrushIdStep3b(null);
    setShowNamePrompt(false);
    tryPromptAutoSavedBrushIdRef.current = null;
    setTutorialPhase('step4');
  }

  function handleTryCreationPromptAgain() {
    const bid = tryPromptAutoSavedBrushIdRef.current;
    if (bid) {
      deleteBrush(bid);
      tryPromptAutoSavedBrushIdRef.current = null;
      setSavedBrushesTick((t) => t + 1);
    }
    setSavedBrushIdStep3b(null);
    setShowNamePrompt(false);
    setCanvasResetKey((k) => k + 1);
    if (tutorialPhase === 'step3' || tutorialPhase === 'step3b') {
      setTutorialPhase('step2');
      setMaterialsOpen(true);
    }
    // step5：仅清空线条并关闭弹层，保持 step5（与原先 Try again 一致）
  }

  function handleTryCreationPromptNextStep() {
    if (tutorialPhase !== 'step3') return;
    setShowNamePrompt(false);
    setTutorialPhase('step3b');
  }

  function handleEditSave() {
    if (!editingBrushId || !editingBrush) return;
    const brushNow = getSavedBrushes().find((b) => b.id === editingBrushId) ?? editingBrush;
    const lineWidth =
      (MATERIAL_TEXTURE_PRESETS[editTextureId]?.lineWidth ?? 3) *
      (0.5 + Math.max(0, Math.min(1, editThickness / 100)) * 1.5);
    const updated = updateBrush(editingBrushId, {
      name: brushNow.name,
      textureId: editTextureId,
      strokeStyle: editColour.hex,
      lineWidth,
      thickness: editThickness,
      softness: editSoftness,
      opacity: editOpacity,
    });
    if (updated && editingBrushId === effectiveSelectedId) {
      setSelectedTexture(updated.textureId);
      setSelectedColour(hexToPickedColour(updated.strokeStyle));
      setThickness(updated.thickness);
      setOpacity(updated.opacity);
      setSoftness(updated.softness ?? TRY_MATERIALS_DEFAULT_SOFTNESS);
    }
    setEditPanelOpen(false);
    setEditingBrushId(null);

    if (tutorialPhase === 'step3b') {
      completeStep3b();
      return;
    }

    // 结束 Try 页面教程：进入 Create 最后一个教程阶段（全屏遮罩弹窗）
    if (tutorialPhase === 'step5') {
      setShowNamePrompt(false);
      tryPromptAutoSavedBrushIdRef.current = null;
      setShowStep5AddPrompt(false);
      setMaterialsOpen(false);
      setShowFinalTutorialOverlay(true);
    }
  }

  function handleEditDelete() {
    if (!editingBrushId) return;
    const ok = deleteBrush(editingBrushId);
    if (!ok) return;

    // 关闭编辑弹窗
    setEditPanelOpen(false);
    setEditingBrushId(null);

    if (tutorialPhase === 'step3b') {
      // 在 step3b 删除仅视为“放弃当前材料”，不推进教程到下一步；
      // 回到可重新绘制首条线的状态。
      setCanvasResetKey((k) => k + 1);
      setSavedBrushIdStep3b(null);
      tryPromptAutoSavedBrushIdRef.current = null;
      setShowNamePrompt(false);
      setTutorialPhase('step3');
      return;
    }

    // 同步当前选中材料到“剩余列表的第一项”，避免 TryCanvas 继续渲染已删除材料
    const remaining = getSavedBrushes();
    if (remaining.length === 0) {
      setSelectedBrushId(null);
      setSelectedTexture('none');
      setSelectedColour(hexToPickedColour('#7dd3d0'));
      setThickness(35);
      setOpacity(100);
      setSoftness(TRY_MATERIALS_DEFAULT_SOFTNESS);
      return;
    }

    const next = remaining[0];
    setSelectedBrushId(next.id);
    setSelectedTexture(next.textureId);
    setSelectedColour(hexToPickedColour(next.strokeStyle));
    setThickness(next.thickness);
    setOpacity(next.opacity);
    setSoftness(next.softness ?? TRY_MATERIALS_DEFAULT_SOFTNESS);
  }

  return (
    <div className="create-page try-page">
      {/* 初始化：居中文案 + 两个按钮 */}
      {tutorialPhase === 'intro' && (
        <div className="try-intro-overlay">
          <div className="try-intro-content">
            <p className="try-intro-text">
              Would you like to try it out first, or start creating straight away?
            </p>
            <div className="try-intro-buttons">
              <button
                type="button"
                className="try-intro-btn try-intro-btn-left"
                onClick={() => setTutorialPhase('step1')}
              >
                Start creation
              </button>
              <button
                type="button"
                className="try-intro-btn try-intro-btn-right"
                onClick={() => setTutorialPhase('step1')}
              >
                Give a try
              </button>
            </div>
          </div>
        </div>
      )}

      {showFinalTutorialOverlay && (
        <div className="try-final-tutorial-overlay" role="dialog" aria-modal="true">
          <div className="try-final-tutorial-content">
            <p className="try-final-tutorial-text">
              Brilliant! You already know how to use materials to create menstrual data.
              <br />
              Now let&apos;s start recording for real!
            </p>
            <div className="try-final-tutorial-actions">
              <button
                type="button"
                className="try-final-tutorial-btn try-final-tutorial-btn-primary"
                onClick={finalizeTryTutorialAndNavigateToCreate}
              >
                Get Started
              </button>
            </div>
          </div>
        </div>
      )}

      {tutorialPhase === 'step1' && (
        <div className="try-step1-hint" aria-live="polite">
          <p className="try-step1-text">
            No problem! Now, you can customise your own materials via the material library. Let&apos;s give it a go!
          </p>
          <div className="try-step1-arrow-wrap" aria-hidden>
            <img
              src="./curved-arrow-down.svg"
              className="try-step1-arrow"
              alt=""
              width="64"
              height="96"
            />
          </div>
        </div>
      )}

      <header className="create-topbar">
        <div className="topbar-row">
          <button type="button" className="icon-btn" aria-label="返回" onClick={() => navigate('/')}>
            <IconBack />
          </button>
          <h1 className="topbar-title">Create</h1>
        </div>
      </header>

      <div className="create-canvas-wrapper">
        <main className="create-canvas-area">
          <TryCanvas
            ref={tryCanvasRef}
            enabled={
              !showFinalTutorialOverlay &&
              (tutorialPhase === 'step3' || tutorialPhase === 'step3b' || (tutorialPhase === 'step5' && !materialsOpen))
            }
            panOnly={showNamePrompt || (tutorialPhase === 'step3b' && editPanelOpen)}
            editOverrides={tryEditOverrides}
            textureId={selectedTexture}
            strokeStyle={strokeStyle}
            thickness={thickness}
            opacity01={Math.max(0.1, Math.min(1, 1 - opacity / 100))}
            softness01={Math.max(0, Math.min(1, softness / 100))}
            clearTrigger={canvasResetKey}
            selectedCommittedIndex={trySelectedCommittedIndex}
            onFirstCreationComplete={onTryFirstCreationComplete}
          />
          {tutorialPhase === 'step3b' && !editPanelOpen && (
            <div
              className="try-step3b-overlay"
              onPointerDown={(e) => {
                if (e.button !== 0 && e.pointerType === 'mouse') return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                longPressTriggeredRef.current = false;
                setStep3bLongPressing(false);
                if (longPressTimerRef.current) {
                  clearTimeout(longPressTimerRef.current);
                  longPressTimerRef.current = null;
                }
                longPressTimerRef.current = setTimeout(() => {
                  longPressTimerRef.current = null;
                  const targetBrushId = savedBrushIdStep3b ?? effectiveSelectedId ?? defaultSelectedId;
                  if (!targetBrushId) return;
                  // 长按达到阈值后立刻触发反馈 + 打开编辑框（不等待松手）。
                  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
                    navigator.vibrate(18);
                  }
                  longPressTriggeredRef.current = true;
                  setStep3bLongPressing(true);
                  setEditingBrushId(targetBrushId);
                  setEditPanelOpen(true);
                }, STEP3B_LONG_PRESS_MS);
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
                if (!longPressTriggeredRef.current && longPressTimerRef.current) {
                  clearTimeout(longPressTimerRef.current);
                  longPressTimerRef.current = null;
                }
              }}
              onPointerCancel={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }
                setStep3bLongPressing(false);
                longPressTriggeredRef.current = false;
                if (longPressTimerRef.current) {
                  clearTimeout(longPressTimerRef.current);
                  longPressTimerRef.current = null;
                }
              }}
              onPointerLeave={() => {
                // 不在 leave 时立即取消，避免用户手指/触控笔轻微抖动导致长按难以触发。
              }}
            >
              {!showNamePrompt && (
                <p className="try-step3b-hint">
                  Want to edit the material? Give it a long press!
                </p>
              )}
            </div>
          )}
          {showNamePrompt && !(tutorialPhase === 'step3b' && editPanelOpen) && (
            <div className="try-creation-name-prompt">
              <p className="try-creation-name-text">
                {promptIsLongCongratsRef.current
                  ? 'Congratulations on finishing your first creation! Give it another go?'
                  : 'Give it another go?'}
              </p>
              <div className="try-creation-name-actions">
                <button type="button" className="try-creation-name-start-over" onClick={handleTryCreationPromptAgain}>
                  Try again
                </button>
                {tutorialPhase === 'step3' && (
                  <button type="button" className="try-creation-name-save" onClick={handleTryCreationPromptNextStep}>
                    Next step
                  </button>
                )}
              </div>
              {tutorialPhase === 'step3b' && !editPanelOpen && (
                <p className="try-creation-name-longpress-hint">
                  Want to edit the material? Give it a long press!
                </p>
              )}
            </div>
          )}
          {materialsOpen && (
            <div className="try-materials-wrap">
              <p className="try-materials-step2-hint">
                Try selecting different materials and colours, or experiment with adjusting them!
              </p>
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
                            return;
                          }
                          setSelectedTexture(t.id);
                          setThickness(35);
                          setOpacity(100);
                          setSoftness(TRY_MATERIALS_DEFAULT_SOFTNESS);
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
                  {recentColourHexes.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      className={`materials-swatch materials-swatch-colour ${selectedHex === hex.toLowerCase() ? 'materials-swatch-selected' : ''}`}
                      style={{ background: hex }}
                      aria-label={hex}
                      onClick={() => setSelectedColour((prev) => ({ ...prev, hex }))}
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
                    onChange={(e) => setSoftness(Number(e.target.value))}
                  />
                </div>
              </section>
              <div className="materials-actions">
                <button
                  type="button"
                  className="materials-btn materials-btn-cancel"
                  onClick={() => {
                    setMaterialsOpen(false);
                    if (tutorialPhase === 'step2') setTutorialPhase('step3');
                  }}
                >
                  Done
                </button>
              </div>

              {colourPickerOpen && (
                <ColourWheelPicker
                  value={selectedColour}
                  onChange={setSelectedColour}
                  onClose={() => {
                    setRecentColourHexes((prev) => pushRecentHex(selectedColour.hex, prev));
                    setColourPickerOpen(false);
                  }}
                />
              )}
              </div>
            </div>
          )}
          {editPanelOpen && editingBrush && tutorialPhase === 'step3b' && (
            <p className="try-step3b-view-hint">
              Try dragging or zooming the canvas to bring your line back into view!
            </p>
          )}
        </main>
        {tutorialPhase === 'step4' && (
          <div className="try-step4-hint" aria-live="polite">
            <p className="try-step4-text">
              Brilliant! Now, simply click on &apos;My Materials&apos; to view your very own materials!
            </p>
            <div className="try-step4-arrow-wrap" aria-hidden>
              <img
                src="./curved-arrow-right.svg"
                className="try-step4-arrow"
                alt=""
                width="28"
                height="48"
              />
            </div>
          </div>
        )}
        {editPanelOpen && editingBrush && tutorialPhase === 'step3b' && (
          <>
          <div
            ref={step3bPanelRef}
            className={`materials-panel materials-panel-delete-thread ${step3bPanelDragging ? 'materials-panel-delete-thread-dragging' : ''}`}
            style={{
              position: 'fixed',
              bottom: 'auto',
              left: step3bPanelPos?.left ?? (window.innerWidth - MATERIAL_PANEL_WIDTH) / 2,
              top: step3bPanelPos?.top ?? window.innerHeight * 0.35,
            }}
          >
            <div
              className="materials-panel-drag-handle"
              role="button"
              tabIndex={0}
              aria-label="拖动编辑框位置"
              onPointerDown={handleStep3bPanelDragStart}
              onPointerMove={handleStep3bPanelDragMove}
              onPointerUp={handleStep3bPanelDragEnd}
              onPointerCancel={handleStep3bPanelDragEnd}
            />
            <button
              type="button"
              className="materials-panel-dismiss"
              onClick={completeStep3b}
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
                        setEditSoftness(TRY_MATERIALS_DEFAULT_SOFTNESS);
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
                {recentColourHexes.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    className={`materials-swatch materials-swatch-colour ${editSelectedHex === hex.toLowerCase() ? 'materials-swatch-selected' : ''}`}
                    style={{ background: hex }}
                    aria-label={hex}
                    onClick={() => setEditColour(hexToPickedColour(hex))}
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
            <div className="try-edit-materials-actions delete-thread-actions">
              <button
                type="button"
                className="try-edit-btn"
                onClick={handleEditDelete}
              >
                Delete
              </button>
              <button type="button" className="try-edit-btn try-edit-save" onClick={handleEditSave}>
                Add to my materials
              </button>
            </div>
            {editColourPickerOpen && (
              <ColourWheelPicker
                value={editColour}
                onChange={setEditColour}
                onClose={() => {
                  setRecentColourHexes((prev) => pushRecentHex(editColour.hex, prev));
                  setEditColourPickerOpen(false);
                }}
              />
            )}
          </div>
          </>
        )}
        {editPanelOpen && editingBrush && tutorialPhase !== 'step3b' && (
          <div className="try-edit-materials-wrap">
            <p className="try-edit-materials-hint">
              Got a new idea? Try re-adjusting the materials you&apos;ve added!
            </p>
            <div className="try-edit-materials-panel">
              <div className="try-edit-materials-panel-header">
                <button
                  type="button"
                  className="try-edit-materials-dismiss"
                  onClick={() => { setEditPanelOpen(false); setEditingBrushId(null); }}
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
                  lineWidth={(MATERIAL_TEXTURE_PRESETS[editTextureId]?.lineWidth ?? 3) * (0.5 + Math.max(0, Math.min(1, editThickness / 100)) * 1.5)}
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
                  const u = updateBrush(editingBrushId, { name: normalized });
                  if (u) setSavedBrushesTick((t) => t + 1);
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
                          setEditSoftness(TRY_MATERIALS_DEFAULT_SOFTNESS);
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
                  {recentColourHexes.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      className={`materials-swatch materials-swatch-colour ${editSelectedHex === hex.toLowerCase() ? 'materials-swatch-selected' : ''}`}
                      style={{ background: hex }}
                      aria-label={hex}
                      onClick={() => setEditColour(hexToPickedColour(hex))}
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
                <button
                  type="button"
                  className="try-edit-btn"
                  onClick={handleEditDelete}
                >
                  Delete
                </button>
                <button type="button" className="try-edit-btn try-edit-save" onClick={handleEditSave}>
                  Save
                </button>
              </div>
              {editColourPickerOpen && (
                <ColourWheelPicker
                  value={editColour}
                  onChange={setEditColour}
                  onClose={() => {
                    setRecentColourHexes((prev) => pushRecentHex(editColour.hex, prev));
                    setEditColourPickerOpen(false);
                  }}
                />
              )}
            </div>
          </div>
        )}
        {tutorialPhase === 'step5' && showStep5AddPrompt && !materialsOpen && !editPanelOpen && (
          <>
            <div
              className="try-step5-hint"
              aria-live="polite"
              style={step5HintBottomPx != null ? { bottom: `${step5HintBottomPx}px` } : undefined}
            >
              <p className="try-step5-text">
                You can also add your own material library, or edit existing ones. Would you like to give it a try?
              </p>
            </div>
            <div className="try-my-materials-panel" ref={myMaterialsPanelRef}>
              <button
                type="button"
                className="materials-panel-dismiss"
                onClick={() => {
                  setShowStep5AddPrompt(false);
                }}
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
                    onClick={() => {
                      setSelectedBrushId(brush.id);
                      setSelectedTexture(brush.textureId);
                      setSelectedColour(hexToPickedColour(brush.strokeStyle));
                      setThickness(brush.thickness);
                      setOpacity(brush.opacity);
                      setSoftness(brush.softness ?? TRY_MATERIALS_DEFAULT_SOFTNESS);
                    }}
                  >
                    <span className="try-my-materials-thumb-texture">
                      <TextureSwatchIcon id={brush.textureId} />
                    </span>
                    <span
                      className="try-my-materials-thumb-tint"
                      style={{ background: brush.strokeStyle }}
                      aria-hidden
                    />
                  </button>
                ))}
              </div>
              <div className="try-my-materials-actions">
                <button
                  type="button"
                  className="try-my-materials-btn try-my-materials-add"
                  onClick={() => setMaterialsOpen(true)}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="try-my-materials-btn try-my-materials-edit"
                  onClick={() => {
                    if (effectiveSelectedId) {
                      setEditingBrushId(effectiveSelectedId);
                      setEditPanelOpen(true);
                    }
                  }}
                >
                  Edit
                </button>
              </div>
            </div>
          </>
        )}
        <nav className="create-bottom-bar">
          <button
            type="button"
            className={`bottom-tab ${tutorialPhase !== 'step5' ? 'bottom-tab-active' : ''}`}
            onClick={() => {
              if (showNamePrompt) return;
              if (tutorialPhase === 'step1') {
                setTutorialPhase('step2');
                setMaterialsOpen(true);
              } else {
                setMaterialsOpen((v) => !v);
              }
            }}
          >
            Materials
          </button>
          <div className="bottom-tab-divider" />
          <button
            type="button"
            className={`bottom-tab ${tutorialPhase === 'step5' ? 'bottom-tab-active' : ''}`}
            id="try-my-materials-tab"
            onClick={() => {
              if (showNamePrompt) return;
              if (tutorialPhase === 'step1' || tutorialPhase === 'step2' || tutorialPhase === 'step3' || tutorialPhase === 'step4') {
                setTutorialPhase('step5');
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
