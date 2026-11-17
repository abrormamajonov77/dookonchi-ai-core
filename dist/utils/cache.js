"use strict";
/**
 * MODUL 6: Lightweight In-Memory TTL Cache (60s TTL + 30-min periodic GC)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.suppliersListCache = exports.userStatusCache = exports.MemoryTtlCache = void 0;
exports.getSuppliersCacheKey = getSuppliersCacheKey;
exports.invalidateCache = invalidateCache;
const DEFAULT_TTL_MS = 60 * 1000; // 60 seconds
class MemoryTtlCache {
    store = new Map();
    ttlMs;
    constructor(ttlMs = DEFAULT_TTL_MS) {
        this.ttlMs = ttlMs;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }
    set(key, value, customTtlMs) {
        this.store.set(key, {
            value,
            expiresAt: Date.now() + (customTtlMs ?? this.ttlMs),
        });
    }
    delete(key) {
        this.store.delete(key);
    }
    deleteByPrefix(prefix) {
        for (const k of this.store.keys()) {
            if (k.startsWith(prefix)) {
                this.store.delete(k);
            }
        }
    }
    clear() {
        this.store.clear();
    }
    sweepExpired() {
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
    get size() {
        return this.store.size;
    }
}
exports.MemoryTtlCache = MemoryTtlCache;
exports.userStatusCache = new MemoryTtlCache(DEFAULT_TTL_MS);
exports.suppliersListCache = new MemoryTtlCache(DEFAULT_TTL_MS);
function getSuppliersCacheKey(ownerId) {
    return `suppliersListCache:${String(ownerId).trim()}`;
}
function invalidateCache(ownerId) {
    if (ownerId !== undefined && ownerId !== null) {
        const id = String(ownerId).trim();
        exports.userStatusCache.delete(id);
        exports.suppliersListCache.delete(getSuppliersCacheKey(id));
        exports.suppliersListCache.deleteByPrefix(`suppliersListCache:${id}`);
    }
    else {
        exports.userStatusCache.clear();
        exports.suppliersListCache.clear();
    }
}
// Periodic 30-minute memory cleanup (GC) so Render RAM never fills up
const gcTimer = setInterval(() => {
    exports.userStatusCache.sweepExpired();
    exports.suppliersListCache.sweepExpired();
}, 30 * 60 * 1000);
gcTimer.unref();
