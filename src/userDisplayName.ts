const STORAGE_KEY = 'loom-user-display-name-v1';

export function normalizeUserDisplayName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function getUserDisplayName(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return '';
    return normalizeUserDisplayName(v);
  } catch {
    return '';
  }
}

export function setUserDisplayName(raw: string): void {
  const normalized = normalizeUserDisplayName(raw);
  try {
    if (!normalized) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, normalized);
    }
  } catch {
    // ignore
  }
}
