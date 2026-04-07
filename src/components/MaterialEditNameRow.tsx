import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './TryPage.css';

const NOTE_MAX_VISUAL_LINES = 2;

/** Legacy placeholder name from older builds — treat as unnamed in UI. */
function isEffectivelyNamed(committedName: string): boolean {
  const t = committedName.trim();
  return t.length > 0 && t.toLowerCase() !== 'unknown';
}

function draftForUnnamedState(committedName: string): string {
  const t = committedName.trim();
  if (!t || t.toLowerCase() === 'unknown') return '';
  return committedName;
}

export type MaterialEditNameRowProps = {
  /** Stored name (may be blank). */
  committedName: string;
  onCommit: (normalized: string) => void;
  /** If the user clears everything while editing an existing name. */
  commitFallback?: string;
  maxLength?: number;
};

export function MaterialEditNameRow({
  committedName,
  onCommit,
  commitFallback = '',
  maxLength = 50,
}: MaterialEditNameRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(committedName);
  const [buttonOnSecondRow, setButtonOnSecondRow] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasCommittedName = isEffectivelyNamed(committedName);

  useEffect(() => {
    if (!hasCommittedName) {
      setDraft(draftForUnnamedState(committedName));
      return;
    }
    if (!isEditing) {
      setDraft(committedName);
    }
  }, [committedName, hasCommittedName, isEditing]);

  const showInput = !hasCommittedName || isEditing;
  /** Unnamed + empty: only the input row, no Save (blur / Enter do not submit empty). */
  const showActionButton = hasCommittedName || draft.trim().length > 0;
  const showSaveAction = !hasCommittedName || isEditing;

  useLayoutEffect(() => {
    if (!showInput) return;
    const el = textareaRef.current;
    if (!el) return;

    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 18;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 8;
    const maxH = lineHeight * NOTE_MAX_VISUAL_LINES + padY;
    const singleLineThreshold = lineHeight + padY + 2;

    el.style.height = '0px';
    const naturalScroll = el.scrollHeight;
    el.style.height = `${Math.min(naturalScroll, maxH)}px`;

    setButtonOnSecondRow(naturalScroll > singleLineThreshold);
  }, [draft, showInput, isEditing, hasCommittedName]);

  function save() {
    const trimmed = draft.trim().slice(0, maxLength);
    if (!hasCommittedName) {
      if (!trimmed) {
        if (committedName.trim().toLowerCase() === 'unknown') {
          onCommit('');
        }
        return;
      }
      onCommit(trimmed);
      setIsEditing(false);
      return;
    }
    const normalized = trimmed || commitFallback;
    onCommit(normalized);
    setIsEditing(false);
  }

  const displayText = committedName.trim();

  return (
    <section className="materials-section material-edit-note-section">
      <span className="materials-label">Note</span>
      <div
        className={`try-edit-name-row${buttonOnSecondRow && showInput && showActionButton ? ' try-edit-name-row--stacked' : ''}`}
      >
        {showInput ? (
          <textarea
            ref={textareaRef}
            className="try-edit-name-input"
            value={draft}
            maxLength={maxLength}
            rows={1}
            spellCheck={false}
            placeholder=""
            autoComplete="off"
            onChange={(e) => {
              const v = e.target.value.replace(/[\r\n]+/g, ' ').slice(0, maxLength);
              setDraft(v);
            }}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                if (!hasCommittedName) {
                  setDraft(draftForUnnamedState(committedName));
                } else {
                  setDraft(committedName);
                  setIsEditing(false);
                }
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              }
            }}
            autoFocus={!hasCommittedName}
          />
        ) : (
          <span className="try-edit-name-text">{displayText}</span>
        )}
        {showActionButton && (
          <button
            type="button"
            className={`try-edit-name-edit-btn${showSaveAction ? ' try-edit-name-save-btn' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              if (showSaveAction) {
                save();
                return;
              }
              setDraft(committedName);
              setIsEditing(true);
            }}
          >
            {showSaveAction ? 'Save' : 'Edit'}
          </button>
        )}
      </div>
    </section>
  );
}
