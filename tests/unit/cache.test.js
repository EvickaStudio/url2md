import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { LRUCache, cacheKey } from "../../src/cache.js";

describe("LRUCache", () => {
  it("returns undefined for missing keys", () => {
    const c = new LRUCache(10, 60_000);
    assert.equal(c.get("nope"), undefined);
  });

  it("stores and retrieves a value", () => {
    const c = new LRUCache(10, 60_000);
    c.set("k", 42);
    assert.equal(c.get("k"), 42);
  });

  it("evicts when over maxSize", () => {
    const c = new LRUCache(2, 60_000);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3); // should evict "a" (oldest)
    assert.equal(c.get("a"), undefined);
    assert.equal(c.get("b"), 2);
    assert.equal(c.get("c"), 3);
  });

  it("expired entries return undefined", async () => {
    const c = new LRUCache(10, 50); // 50 ms TTL
    c.set("x", "hello");
    assert.equal(c.get("x"), "hello");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.get("x"), undefined);
  });

  it("has() returns false for expired entry", async () => {
    const c = new LRUCache(10, 50);
    c.set("y", true);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.has("y"), false);
  });

  it("size reflects stored items", () => {
    const c = new LRUCache(10, 60_000);
    assert.equal(c.size, 0);
    c.set("a", 1);
    c.set("b", 2);
    assert.equal(c.size, 2);
  });

  it("clear() empties the cache", () => {
    const c = new LRUCache(10, 60_000);
    c.set("a", 1);
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.get("a"), undefined);
  });

  it("updates value when key is re-set", () => {
    const c = new LRUCache(10, 60_000);
    c.set("k", "old");
    c.set("k", "new");
    assert.equal(c.get("k"), "new");
  });
});

describe("cacheKey", () => {
  it("returns a 24-char hex string", () => {
    const k = cacheKey("pf", { url: "https://example.com" });
    assert.match(k, /^[0-9a-f]{24}$/);
  });

  it("is deterministic — same inputs give same key", () => {
    const a = cacheKey("pf", { url: "https://x.com", n: 5 });
    const b = cacheKey("pf", { url: "https://x.com", n: 5 });
    assert.equal(a, b);
  });

  it("differs when prefix differs", () => {
    const a = cacheKey("search", { q: "test" });
    const b = cacheKey("extract", { q: "test" });
    assert.notEqual(a, b);
  });

  it("is order-independent for object keys", () => {
    const a = cacheKey("p", { z: 1, a: 2 });
    const b = cacheKey("p", { a: 2, z: 1 });
    assert.equal(a, b);
  });
});
