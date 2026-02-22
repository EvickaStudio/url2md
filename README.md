# url2md API

Self-hosted web scraping and search API.  
**Scrape** any URL to clean LLM-ready Markdown, **search** the web via SearXNG, or do **both in one call**.

## Quick Start

```bash
# 1. copy env template and fill in your values
cp .env.example .env
# generate a strong SearXNG secret key
echo "SEARXNG_SECRET_KEY=$(openssl rand -hex 32)" >> .env

# 2. launch the full stack
docker compose up -d --build

# 3. wait ~15s for SearXNG engines to initialise, then test
curl http://localhost:3000/healthz            # → ok
curl http://localhost:3000/health/deep        # → { status: "healthy", ... }
```

## API Reference

Interactive docs: **http://localhost:3000/docs**

### POST /v2/scrape

Scrape a single URL and extract content as clean Markdown.

```bash
curl -X POST http://localhost:3000/v2/scrape \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com",
    "formats": ["markdown"],
    "onlyMainContent": true
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "markdown": "# Example Domain\n\nThis domain is for use in illustrative examples...",
    "metadata": {
      "title": "Example Domain",
      "description": "...",
      "language": "en",
      "sourceURL": "https://example.com",
      "statusCode": 200,
      "siteName": "Example",
      "image": "https://example.com/og.jpg",
      "favicon": "https://example.com/favicon.ico"
    }
  }
}
```

The `markdown` field contains the **LLM-ready extracted content** of the page.  
The `metadata` object provides display info (title, description, image, favicon) for rendering tool-call results in your app.

### POST /v2/search

Search the web via SearXNG. By default returns **snippets only** (fast). Add `scrapeOptions.formats` to also extract content from each result.

#### Snippets only (no scraping)

```bash
curl -X POST http://localhost:3000/v2/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "EvickaStudio",
    "limit": 5
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "web": [
      {
        "url": "https://github.com/EvickaStudio",
        "title": "EvickaStudio (Erik) · GitHub",
        "description": "I am a Computer Science & Software Engineering student...",
        "position": 1,
        "category": "web"
      }
    ]
  }
}
```

#### Search + scrape (extract content from each result)

```bash
curl -X POST http://localhost:3000/v2/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "how does RLHF work",
    "limit": 5,
    "scrapeOptions": {
      "formats": ["markdown", "links"]
    }
  }'
```

Response — each result now includes `markdown` and `links`:
```json
{
  "success": true,
  "data": {
    "web": [
      {
        "url": "https://...",
        "title": "RLHF Explained",
        "description": "Reinforcement Learning from Human Feedback...",
        "position": 1,
        "category": "web",
        "markdown": "# RLHF Explained\n\n...",
        "links": ["https://...", "https://..."]
      }
    ]
  }
}
```

## Authentication

Set `API_KEYS` to enable:

```bash
API_KEYS=sk-key1,sk-key2 docker compose up -d
```

```bash
curl -H 'Authorization: Bearer sk-key1' http://localhost:3000/v2/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"test"}'
```

## Proxy Support

Pass a comma-separated list of proxy URLs. They are rotated round-robin per extraction:

```env
PROXY_LIST=http://user:pass@proxy1:8080,socks5://proxy2:1080
```

## Architecture

```
Client → [API Gateway: auth, cache, validation]
              ├── POST /v2/search  → SearXNG + Playwright → Markdown per result
              └── POST /v2/scrape  → Playwright (stealth) → Readability → Turndown
```

## Anti-Detection

- Chromium with `--disable-blink-features=AutomationControlled`
- Fast-fetch fallback for static pages (no browser needed)
- `navigator.webdriver` patched, fake `window.chrome`
- Randomised fingerprints per request (UA, viewport, timezone, locale)
- Cookie consent auto-dismiss
- Tracker/ad domain blocking
- Optional proxy rotation

## Development (no Docker)

```bash
npm install
npx playwright install chromium

# start SearXNG separately or point to an existing instance
SEARXNG_URL=http://localhost:8888 npm start
```

## Load Testing

```bash
# scrape endpoint (default)
./load_test.sh -e scrape -c 5 -n 25

# search endpoint
./load_test.sh -e search -q "AI news" -n 10

# see all options
./load_test.sh --help
```
