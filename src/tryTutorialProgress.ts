const SUBJECT_ID_CANONICAL_STORAGE_KEY = 'loom-subject-id-v1';
const SUBJECT_ID_LEGACY_KEYS = ['loom-subject-id', 'subjectId', 'participantId'];

const TRY_TUTORIAL_COMPLETED_STORAGE_KEY = 'loom-try-tutorial-completed-by-subject-v1';

function normalizeSubjectId(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function safeParseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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

function findSubjectIdInLocalStorage(): { value: string } {
  // 1) 先查已知/遗留 key（如果你项目里已有某个 key，这里尽量命中）。
  for (const key of SUBJECT_ID_LEGACY_KEYS) {
    const v = tryReadFromLocalStorage(key);
    if (v) return { value: v };
  }

  // 2) 再查 canonical key。
  const canonical = tryReadFromLocalStorage(SUBJECT_ID_CANONICAL_STORAGE_KEY);
  if (canonical) return { value: canonical };

  // 3) 最后兜底：尝试从其他可能命名里猜（避免你说的“已存在于 localStorage”但 key 不在源码里）。
  try {
    for (const key of Object.keys(localStorage)) {
      const k = key.toLowerCase();
      if (k.includes('subject') || k.includes('participant') || key.includes('受试') || key.includes('编号')) {
        const v = tryReadFromLocalStorage(key);
        if (v) return { value: v };
      }
    }
  } catch {
    // ignore
  }

  return { value: '' };
}

export function getCurrentSubjectId(): string {
  return findSubjectIdInLocalStorage().value;
}

type TryTutorialCompletedBySubject = Record<string, { completedAt: number }>;

function readCompletedBySubject(): TryTutorialCompletedBySubject {
  const parsed = safeParseJson<TryTutorialCompletedBySubject>(localStorage.getItem(TRY_TUTORIAL_COMPLETED_STORAGE_KEY));
  if (!parsed || typeof parsed !== 'object') return {};
  return parsed;
}

function writeCompletedBySubject(next: TryTutorialCompletedBySubject): void {
  localStorage.setItem(TRY_TUTORIAL_COMPLETED_STORAGE_KEY, JSON.stringify(next));
}

export function isTryTutorialCompleted(subjectId: string): boolean {
  if (!subjectId) return false;
  try {
    const completed = readCompletedBySubject();
    return Boolean(completed[subjectId]?.completedAt);
  } catch {
    return false;
  }
}

export function markTryTutorialCompleted(subjectId: string): void {
  if (!subjectId) return;
  try {
    const completed = readCompletedBySubject();
    completed[subjectId] = { completedAt: Date.now() };
    writeCompletedBySubject(completed);
  } catch {
    // ignore write failures
  }
}

export function markTryTutorialCompletedForCurrentSubject(): void {
  const subjectId = getCurrentSubjectId();
  if (!subjectId) return;
  markTryTutorialCompleted(subjectId);
}

