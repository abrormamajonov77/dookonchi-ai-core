/**
 * MODUL 6: Lightweight In-Memory TTL Cache (60s TTL + 30-min periodic GC)
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60 * 1000; // 60 seconds
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_ENTRIES = 5000;

export class MemoryTtlCache<T = any> {
  private store = new Map<string, CacheEntry<T>>();
  private ttlMs: number;
  private maxEntries: number;

  constructor(ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T, customTtlMs?: number): void {
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      this.sweepExpired();
      if (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (customTtlMs ?? this.ttlMs),
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  deleteByPrefix(prefix: string): void {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  sweepExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this.store.entries()) {
      if (now > v.expiresAt) {
        this.store.delete(k);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.store.size;
  }
}

export const userStatusCache = new MemoryTtlCache<any>(DEFAULT_TTL_MS, 5000);
export const suppliersListCache = new MemoryTtlCache<any[]>(DEFAULT_TTL_MS, 5000);
export const sessionCache = new MemoryTtlCache<any>(SESSION_TTL_MS, 5000);

export function getSuppliersCacheKey(ownerId: string): string {
  return `suppliersListCache:${String(ownerId).trim()}`;
}

export function invalidateCache(ownerId?: string | number | bigint): void {
  if (ownerId !== undefined && ownerId !== null) {
    const id = String(ownerId).trim();
    userStatusCache.delete(id);
    suppliersListCache.delete(getSuppliersCacheKey(id));
    suppliersListCache.deleteByPrefix(`suppliersListCache:${id}`);
  } else {
    userStatusCache.clear();
    suppliersListCache.clear();
  }
}

// Periodic 30-minute memory cleanup (GC) so Render RAM never fills up
const gcTimer = setInterval(() => {
  userStatusCache.sweepExpired();
  suppliersListCache.sweepExpired();
  sessionCache.sweepExpired();
}, 30 * 60 * 1000);
gcTimer.unref();
