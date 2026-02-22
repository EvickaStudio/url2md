import express from "express";
import pino from "pino";
import helmet from "helmet";
import compression from "compression";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import swaggerUi from "swagger-ui-express";
import client from "prom-client";
import cluster from "node:cluster";
import { performance } from "node:perf_hooks";

import cfg from "./src/config.js";
import { urlToMarkdown } from "./src/extract.js";
import { searxngSearch } from "./src/search.js";
import { preflightIsUrlAllowed } from "./src/security.js";
import { Limit } from "./src/limit.js";
import { LRUCache, cacheKey } from "./src/cache.js";
import { authMiddleware } from "./src/auth.js";
import { getBrowser, closeBrowser } from "./src/browser-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const log  = pino();

app.set("trust proxy", cfg.trustProxy);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());
app.use(express.json({ limit: "1mb" }));

app.use("/v2", authMiddleware);

app.use((_, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

let httpHistogram = { startTimer: () => () => {} };
if (cfg.enableMetrics) {
  client.collectDefaultMetrics();
  httpHistogram = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests",
    labelNames: ["method", "route", "code"],
    buckets: [0.1, 0.3, 0.5, 1, 2, 3, 5, 10, 15, 30],
  });
  app.get("/metrics", async (_, res) => {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  });
}

const workLimiter  = new Limit(cfg.maxConcurrency);
const extractCache = new LRUCache(cfg.cacheMaxItems, cfg.cacheTtlMs);

app.get("/healthz", (_, res) => res.send("ok"));

app.get("/health/deep", async (_, res) => {
  const checks = {};
  try { await getBrowser(); checks.browser = "ok"; }
  catch (e) { checks.browser = `error: ${e.message}`; }
  try {
    const r = await fetch(`${cfg.searxngUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
    checks.searxng = r.ok ? "ok" : `status ${r.status}`;
  } catch (e) { checks.searxng = `error: ${e.message}`; }

  const allOk = Object.values(checks).every((v) => v === "ok");
  res.status(allOk ? 200 : 503).json({ status: allOk ? "healthy" : "degraded", checks });
});

const openapiPath = path.join(__dirname, "openapi.json");
let openapiDoc = null;
try { openapiDoc = JSON.parse(fs.readFileSync(openapiPath, "utf-8")); } catch {}
app.get("/openapi.json", (_, res) => {
  openapiDoc ? res.json(openapiDoc) : res.status(404).json({ error: "not_found" });
});
if (openapiDoc) app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDoc));


async function extractOne(urlStr, opts) {
  const pre = await preflightIsUrlAllowed(urlStr);
  if (!pre.ok) return { error: "blocked_url", detail: pre.reason };

  const key = cacheKey("extract", { 
    url: urlStr, 
    f: (opts.formats || []).join(","), 
    omc: opts.onlyMainContent 
  });
  const cached = extractCache.get(key);
  if (cached) return cached;

  try {
    const data = await workLimiter.run(() => urlToMarkdown(urlStr, opts));
    extractCache.set(key, data);
    return data;
  } catch (err) {
    return { error: "extraction_failed", detail: err.message };
  }
}

app.post("/v2/scrape", async (req, res) => {
  const end = httpHistogram.startTimer({ method: "POST", route: "/v2/scrape" });
  try {
    const body = req.body || {};
    const url = body.url;
    if (!url) {
      end({ code: 400 });
      return res.status(400).json({ error: "Missing URL in request body." });
    }

    const opts = {
      timeoutMs: cfg.maxTimeoutMs,
      formats: body.formats || ["markdown"],
      onlyMainContent: body.onlyMainContent !== false,
    };

    const data = await extractOne(url, opts);
    
    if (data.error) {
      const clientError = ["blocked_url", "invalid_url", "unsupported_protocol"].includes(data.error);
      const code = clientError ? 422 : 500;
      end({ code });
      return res.status(code).json({ error: data.error, detail: data.detail });
    }

    end({ code: 200 });
    res.json({ success: true, data });
  } catch (err) {
    log.error({ err }, "scrape failed");
    end({ code: 500 });
    res.status(500).json({ error: "An unexpected error occurred on the server." });
  }
});

app.post("/v2/search", async (req, res) => {
  const end = httpHistogram.startTimer({ method: "POST", route: "/v2/search" });
  try {
    const body = req.body || {};
    if (!body.query) {
      end({ code: 400 });
      return res.status(400).json({ error: "Missing query." });
    }

    const _parsedLimit = Number(body.limit);
    const limit = Number.isFinite(_parsedLimit) && _parsedLimit > 0
      ? Math.min(Math.floor(_parsedLimit), 20)
      : 10;
    const scrapeOpts = body.scrapeOptions || {};
    const extractOpts = {
      timeoutMs: cfg.maxTimeoutMs,
      formats: scrapeOpts.formats || [],
      onlyMainContent: scrapeOpts.onlyMainContent !== false,
    };

    let engines = [];
    if (body.sources && Array.isArray(body.sources)) {
      engines = body.sources.filter(s => s !== "web");
    }

    const searchData = await searxngSearch({
      query: body.query,
      numResults: limit,
      engines: engines.length ? engines : undefined,
    });

    const shouldScrape = extractOpts.formats.length > 0;

    const urls = searchData.results.map((r) => r.url);
    const extractions = shouldScrape
      ? await Promise.all(urls.map((u) => extractOne(u, extractOpts)))
      : [];

    const webResults = searchData.results.map((sr, i) => {
      const resObj = {
        url: sr.url,
        title: sr.title,
        description: sr.snippet,
        position: i + 1,
        category: "web",
      };
      
      const ex = extractions[i];
      if (ex && !ex.error) {
        if (ex.markdown) resObj.markdown = ex.markdown;
        if (ex.html) resObj.html = ex.html;
        if (ex.rawHtml) resObj.rawHtml = ex.rawHtml;
        if (ex.links) resObj.links = ex.links;
      }
      return resObj;
    });

    end({ code: 200 });
    res.json({
      success: true,
      data: {
        web: webResults
      }
    });

  } catch (err) {
    log.error({ err }, "search failed");
    end({ code: 500 });
    res.status(500).json({ error: "An unexpected error occurred on the server." });
  }
});

app.use((_, res) => res.status(404).json({ error: "not_found" }));

let server;
if (cluster.isPrimary && cfg.workers > 1) {
  log.info({ workers: cfg.workers }, "Starting cluster");
  for (let i = 0; i < cfg.workers; i++) cluster.fork();
  cluster.on("exit", (w, code, signal) => {
    log.error({ pid: w.process.pid, code, signal }, "Worker exited → restarting");
    setTimeout(() => cluster.fork(), 500);
  });
} else {
  server = app.listen(cfg.port, async () => {
    await getBrowser();
    log.info(`url2md listening on :${cfg.port}  (concurrency=${cfg.maxConcurrency})`);
  });

  if (server) {
    server.requestTimeout  = 65_000;
    server.headersTimeout  = 70_000;
    server.keepAliveTimeout = 30_000;
  }
}

async function shutdown() {
  log.info("Shutting down…");
  if (server) server.close();
  await closeBrowser();
  process.exit(0);
}
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (err) => log.error({ err }, "unhandledRejection"));
process.on("uncaughtException",  (err) => { log.error({ err }, "uncaughtException"); process.exit(1); });
