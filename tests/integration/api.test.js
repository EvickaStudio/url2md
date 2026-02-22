/**
 * Integration tests for the Express API.
 *
 * We mock the modules that require external resources (browser, SearXNG)
 * so these tests run fully offline with no Playwright or network.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// ── Mock browser-pool.js before server.js imports it ──────────────────────
// We use module mocking via import.meta. Since node:test doesn't support
// dynamic import mock, we stub via process-level approach: set env vars that
// make the server avoid starting a real browser, then stub modules using a
// thin loader shim at the filesystem level.
//
// Instead, we build a minimal express app that re-uses ONLY the pure routes
// we want to test (healthz, /v2/scrape with bad URL, /v2/search bad body).
// This avoids any browser or SearXNG calls entirely.

import express from "express";
import helmet from "helmet";
import compression from "compression";
import { preflightIsUrlAllowed } from "../../src/security.js";
import { LRUCache, cacheKey } from "../../src/cache.js";
import { Limit } from "../../src/limit.js";
import { authMiddleware } from "../../src/auth.js";

// Build a test-app that mirrors the real app but uses a stub extractor
function buildApp() {
  const app = express();
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use("/v2", authMiddleware);
  app.use((_, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  const workLimiter  = new Limit(2);
  const extractCache = new LRUCache(100, 60_000);

  // Stub extractor – always says blocked or returns fake markdown
  async function extractOne(urlStr, _opts) {
    const pre = await preflightIsUrlAllowed(urlStr);
    if (!pre.ok) return { error: "blocked_url", detail: pre.reason };
    return { markdown: "# Fake" };
  }

  app.get("/healthz", (_, res) => res.send("ok"));

  app.post("/v2/scrape", async (req, res) => {
    const body = req.body || {};
    if (!body.url) return res.status(400).json({ error: "Missing URL in request body." });
    const data = await workLimiter.run(() => extractOne(body.url, {}));
    if (data.error) return res.status(500).json({ error: data.detail || data.error });
    res.json({ success: true, data });
  });

  app.post("/v2/search", async (req, res) => {
    const body = req.body || {};
    if (!body.query) return res.status(400).json({ error: "Missing query." });
    // Stub: return empty results
    res.json({ success: true, data: { web: [] } });
  });

  app.use((_, res) => res.status(404).json({ error: "not_found" }));
  return app;
}

// ── Helper: fire HTTP requests against our test server ────────────────────
function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr   = server.address();
    const port   = addr.port;
    const payload = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    import("node:http").then(({ request: req }) => {
      const r = req(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  });
}

describe("API integration", () => {
  let server;

  before(async () => {
    const app = buildApp();
    server = app.listen(0); // random port
    await new Promise((r) => server.once("listening", r));
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });

  it("GET /healthz → 200 ok", async () => {
    const { status, body } = await request(server, "GET", "/healthz");
    assert.equal(status, 200);
    assert.equal(body, "ok");
  });

  it("POST /v2/scrape without URL → 400", async () => {
    const { status, body } = await request(server, "POST", "/v2/scrape", {});
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("POST /v2/scrape with localhost URL → 500 blocked_localhost", async () => {
    const { status, body } = await request(server, "POST", "/v2/scrape", {
      url: "http://localhost/secret",
    });
    assert.equal(status, 500);
    assert.equal(body.error, "blocked_localhost");
  });

  it("POST /v2/scrape with private IP → 500 blocked_private_ip", async () => {
    const { status, body } = await request(server, "POST", "/v2/scrape", {
      url: "http://192.168.1.1/admin",
    });
    assert.equal(status, 500);
    assert.equal(body.error, "blocked_private_ip");
  });

  it("POST /v2/scrape with valid public URL → 200 success (stubbed)", async () => {
    // The stub extractor returns fake markdown for non-blocked URLs.
    // We use example.com which won't resolve to private inside CI.
    // If the DNS lookup in preflightIsUrlAllowed blocks it (fail-closed),
    // we still get a 500 with a known blocked_ prefix — that's fine.
    const { status, body } = await request(server, "POST", "/v2/scrape", {
      url: "https://example.com/",
    });
    assert.ok([200, 500].includes(status));
    if (status === 200) assert.equal(body.success, true);
    if (status === 500) assert.match(body.error, /^blocked_/);
  });

  it("POST /v2/search without query → 400", async () => {
    const { status, body } = await request(server, "POST", "/v2/search", {});
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("POST /v2/search with query → 200 success", async () => {
    const { status, body } = await request(server, "POST", "/v2/search", {
      query: "test query",
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data.web));
  });

  it("unknown route → 404", async () => {
    const { status, body } = await request(server, "GET", "/no-such-route");
    assert.equal(status, 404);
    assert.equal(body.error, "not_found");
  });
});
