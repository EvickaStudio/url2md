import express from "express";
import pino from "pino";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import swaggerUi from "swagger-ui-express";
import client from "prom-client";
import { urlToMarkdown, getBrowser } from "./src/extract.js";
import { preflightIsUrlAllowed, safeParseUrl } from "./src/security.js";
import { Limit } from "./src/limit.js";
import os from "os";
import cluster from "node:cluster";
import { performance } from "node:perf_hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const log = pino();
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY) || Math.max(2, (os.cpus()?.length ?? 4));
const MAX_TIMEOUT_MS = Math.min(Number(process.env.MAX_TIMEOUT_MS) || 30000, 60000);
const TRUST_PROXY = process.env.TRUST_PROXY || "loopback";
const WORKERS = Number(process.env.WORKERS) || 1;
const ENABLE_METRICS = process.env.ENABLE_METRICS === "1";

// trust proxy for proper rate-limit and logging behind LB
app.set("trust proxy", TRUST_PROXY);

// security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// gzip responses
app.use(compression());

// rate limiting
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// metrics (optional)
let httpDuration = { startTimer: () => () => {} };
if (ENABLE_METRICS) {
  client.collectDefaultMetrics();
  httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "code"],
    buckets: [0.1, 0.3, 0.5, 1, 2, 3, 5, 10],
  });
  app.get("/metrics", async (_, res) => {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  });
}

const workLimiter = new Limit(MAX_CONCURRENCY);

// Optional: add headers common to all responses
app.use((_, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// simple health check
app.get("/healthz", (_, res) => res.status(200).send("ok"));

// docs: openapi + swagger UI
const openapiPath = path.join(__dirname, "openapi.json");
let openapiDoc = null;
try {
  if (fs.existsSync(openapiPath)) {
    openapiDoc = JSON.parse(fs.readFileSync(openapiPath, "utf-8"));
  }
} catch (e) {
  log.warn({ e }, "Failed to load OpenAPI spec");
}
app.get("/openapi.json", (_, res) => {
  if (!openapiDoc) return res.status(404).json({ error: "openapi_not_found" });
  res.json(openapiDoc);
});
if (openapiDoc) {
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiDoc));
}

// convert url to markdown
app.get("/v1/url-to-markdown", async (req, res) => {
  const endTimer = httpDuration.startTimer({ method: req.method, route: "/v1/url-to-markdown" });
  const { url, format, timeoutMs } = req.query;

  if (!url) {
    endTimer({ code: 400 });
    return res.status(400).json({ error: "missing url" });
  }

  // preflight security checks
  try {
    const pre = await preflightIsUrlAllowed(String(url));
    if (!pre.ok) {
      endTimer({ code: 400 });
      return res.status(400).json({ error: "blocked_url", reason: pre.reason });
    }
  } catch (e) {
    // ignore and continue
  }

  const t = Math.min(Number(timeoutMs) || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);

  try {
    const t0 = performance.now();
    const data = await workLimiter.run(() =>
      urlToMarkdown(String(url), {
        timeoutMs: t,
      })
    );
    const processingMs = Math.round(performance.now() - t0);
    if (data && data.meta && Number.isFinite(processingMs)) {
      data.meta.processingMs = processingMs;
    }

    res.setHeader("X-Extracted-At", data.meta.extractedAt);
    res.setHeader("X-Source-Url", data.url);

    if (format === "json" || req.get("accept")?.includes("application/json")) {
      endTimer({ code: 200 });
      res.json(data);
    } else {
      endTimer({ code: 200 });
      res.type("text/markdown").send(data.markdown);
      log.info({ url, format, timeoutMs: t }, "conversion successful");
    }
  } catch (err) {
    log.error({ err, url }, "conversion failed");
    endTimer({ code: 502 });
    res
      .status(502)
      .json({ error: "conversion_failed", detail: String(err.message || err) });
  }
});

let server;
if (cluster.isPrimary && WORKERS > 1) {
  log.info({ workers: WORKERS }, "Starting cluster");
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on("exit", (worker, code, signal) => {
    log.error({ worker: worker.process.pid, code, signal }, "Worker exited, restarting");
    setTimeout(() => cluster.fork(), 500);
  });
} else {
  server = app.listen(PORT, async () => {
    await getBrowser();
    log.info(`url2md listening on :${PORT}`);
  });
}

// timeouts
if (server) {
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
}

// graceful shutdown
async function shutdown() {
  try {
    log.info("Shutting down...");
    if (server) {
      server.close(() => {
        log.info("HTTP server closed");
      });
    }
    if (server) {
      const b = await getBrowser();
      await b.close();
    }
    process.exit(0);
  } catch (e) {
    log.error({ e }, "Error during shutdown");
    process.exit(1);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("unhandledRejection", (err) => {
  log.error({ err }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  log.error({ err }, "uncaughtException");
});
