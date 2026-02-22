/**
 * Dead-simple Map-based LRU cache with per-entry TTL.
 * Zero dependencies.  Swap for Redis later if you go multi-node.
 */
export class LRUCache {
  constructor(maxSize = 500, ttlMs = 3600_000) {
    this.maxSize = maxSize;
    this.ttlMs   = ttlMs;
    this.map     = new Map();          // insertion-order = LRU order
  }

  /** @returns {any} */
  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // promote to most-recently-used
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      // evict oldest (first key)
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, ts: Date.now() });
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

import crypto from "crypto";

/** Deterministic cache key from an object */
export function cacheKey(prefix, obj) {
  const raw = prefix + ":" + JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 24);
}
