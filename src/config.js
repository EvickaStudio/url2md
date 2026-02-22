import os from "os";

function csv(v) {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const c = {
  port:               Number(process.env.PORT) || 3000,
  workers:            Number(process.env.WORKERS) || 1,
  maxConcurrency:     Number(process.env.MAX_CONCURRENCY) || Math.max(2, os.cpus()?.length ?? 4),
  maxTimeoutMs:       Math.min(Number(process.env.MAX_TIMEOUT_MS) || 30000, 60000),
  trustProxy:         process.env.TRUST_PROXY || "loopback",

  apiKeys:            csv(process.env.API_KEYS),

  searxngUrl:         (process.env.SEARXNG_URL || "http://searxng:8080").replace(/\/+$/, ""),
  searxngTimeoutMs:   Number(process.env.SEARXNG_TIMEOUT_MS) || 10000,

  cacheMaxItems:      Number(process.env.CACHE_MAX_ITEMS) || 500,
  cacheTtlMs:         Number(process.env.CACHE_TTL_MS) || 3600000,

  proxyList:          csv(process.env.PROXY_LIST),
  browserMaxRequests: Number(process.env.BROWSER_MAX_REQUESTS) || 100,

  enableMetrics:      process.env.ENABLE_METRICS === "1",
};

export default c;
