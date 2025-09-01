# url2md service

Convert a url -> html -> markdown

## Features

- Playwright-based fetch with content extraction (Readability)
- Sanitization tailored for LLMs (remove links/media/attrs, keep structure)
- OpenAPI docs at `/docs` and raw spec at `/openapi.json`
- Optional Prometheus metrics at `/metrics` (enable with `ENABLE_METRICS=1`)
- Security hardening: SSRF safeguards, secure headers
- Concurrency limiter for stable throughput

## Docker (build and run)

Build:

```bash
docker build -t url2md:local .
```

Run:

```bash
docker run --rm -p 3000:3000 --ipc=host --shm-size=1g --name url2md url2md:local
```

Custom port:

```bash
docker run --rm -e PORT=8080 -p 8080:8080 url2md:local
```

## Health check and test

```bash
# liveness
curl http://127.0.0.1:3000/healthz

# markdown response (default when Accept: text/markdown)
curl -H 'Accept: text/markdown' \
  'http://127.0.0.1:3000/v1/url-to-markdown?url=https://example.com&timeoutMs=20000'

# json response
curl -H 'Accept: application/json' \
  'http://127.0.0.1:3000/v1/url-to-markdown?url=https://example.com&format=json&timeoutMs=20000'
```

Notes:
- JSON responses include `meta.processingMs` (server-side processing time in milliseconds).

Docs and metrics:

```bash
open http://127.0.0.1:3000/docs          # Swagger UI
curl  http://127.0.0.1:3000/openapi.json  # raw OpenAPI
# metrics require ENABLE_METRICS=1
ENABLE_METRICS=1 curl http://127.0.0.1:3000/metrics
```

## Development (local, no Docker)

```bash
bun i
# Install browsers once for local runs
npx playwright install chromium

# start the service
bun run start
# PORT=3001 bun run start   # to run on a custom port
```

### Configuration (env vars)

- `PORT`: HTTP port (default 3000)
- `MAX_CONCURRENCY`: Max concurrent conversions (default: CPU cores)
- `MAX_TIMEOUT_MS`: Max per-request timeout cap (default 30000, max 60000)
- `TRUST_PROXY`: Express trust proxy setting (default `loopback`)
- `WORKERS`: Number of cluster workers (default 1)
- `USER_AGENT`: Override browser user agent
- `ENABLE_METRICS`: Expose `/metrics` and collect Prometheus metrics (default 0)
