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

## LLM Integration

url2md is designed to be a self-hosted drop-in replacement for cloud scraping services (Firecrawl, Jina, Browserless) in AI/LLM pipelines. It exposes a simple HTTP API that works naturally as a **tool call** in any LLM framework.

### As a tool/function call (OpenAI-style)

Define the API endpoints as tools and let the model call them directly:

```python
import requests

tools = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web and return results with full content extracted as Markdown. Use for finding up-to-date information.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "limit": {"type": "integer", "description": "Number of results (1-20)", "default": 5},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "scrape_url",
            "description": "Fetch a specific URL and return its content as clean Markdown. Use when you have a direct URL to read.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "URL to scrape"},
                },
                "required": ["url"],
            },
        },
    },
]

def web_search(query: str, limit: int = 5) -> dict:
    r = requests.post("http://localhost:3000/v2/search", json={
        "query": query,
        "limit": limit,
        "scrapeOptions": {"formats": ["markdown"]},
    })
    return r.json()

def scrape_url(url: str) -> dict:
    r = requests.post("http://localhost:3000/v2/scrape", json={
        "url": url,
        "formats": ["markdown"],
        "onlyMainContent": True,
    })
    return r.json()

# (Add your client.chat.completions.create dispatch loop here)
```

### LangChain tools

```python
from langchain_core.tools import tool
import requests

@tool
def web_search(query: str) -> str:
    """Search the web. Returns Markdown content from the top results."""
    r = requests.post("http://localhost:3000/v2/search", json={
        "query": query, "limit": 5,
        "scrapeOptions": {"formats": ["markdown"]},
    }).json()
    results = r.get("data", {}).get("web", [])
    return "\n\n---\n\n".join(
        f"**{res['title']}** ({res['url']})\n\n{res.get('markdown', res.get('description', ''))}"
        for res in results
    )

@tool
def read_url(url: str) -> str:
    """Read and extract the content of a URL as clean Markdown."""
    r = requests.post("http://localhost:3000/v2/scrape", json={
        "url": url, "formats": ["markdown"], "onlyMainContent": True,
    }).json()
    return r.get("data", {}).get("markdown", "Could not extract content.")

# Use with any agent
from langchain.agents import create_tool_calling_agent, AgentExecutor
agent = create_tool_calling_agent(llm, [web_search, read_url], prompt)
agent_executor = AgentExecutor(agent=agent, tools=[web_search, read_url])
result = agent_executor.invoke({"input": "what is url2md?"})
```

### LlamaIndex

```python
from llama_index.core.tools import FunctionTool
import requests

def search(query: str, limit: int = 5) -> str:
    """Search the web and return extracted Markdown content."""
    response = requests.post("http://localhost:3000/v2/search", json={
        "query": query, "limit": limit,
        "scrapeOptions": {"formats": ["markdown"]},
    }).json()
    return "\n\n".join(
        item["title"] + "\n" + item.get("markdown", item.get("description", ""))
        for item in response.get("data", {}).get("web", [])
    )

search_tool = FunctionTool.from_defaults(fn=search)
```

### TypeScript / Vercel AI SDK

```typescript
import { tool } from "ai";
import { z } from "zod";

const BASE = process.env.URL2MD_URL ?? "http://localhost:3000";
const HEADERS = {
  "Content-Type": "application/json",
  ...(process.env.URL2MD_API_KEY ? { "Authorization": `Bearer ${process.env.URL2MD_API_KEY}` } : {}),
};

export const webSearch = tool({
  description: "Search the web and return results as Markdown. Use for current events or specific facts.",
  // Use `parameters` for AI SDK v4 and below, `inputSchema` for v5+
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  execute: async ({ query, limit }) => {
    const res = await fetch(`${BASE}/v2/search`, {
      method: "POST", headers: HEADERS,
      body: JSON.stringify({ query, limit, scrapeOptions: { formats: ["markdown"] } }),
    });
    const { data } = await res.json();
    return (data?.web ?? []).map((r: any) => `# ${r.title}\n${r.url}\n\n${r.markdown ?? r.description}`).join("\n\n---\n\n");
  },
});

export const scrapeUrl = tool({
  description: "Read the contents of a specific URL as clean Markdown.",
  // Use `parameters` for AI SDK v4 and below, `inputSchema` for v5+
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    const res = await fetch(`${BASE}/v2/scrape`, {
      method: "POST", headers: HEADERS,
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    const { data } = await res.json();
    return data?.markdown ?? "Could not extract content.";
  },
});
```

### Replacing Firecrawl / Jina

url2md uses a compatible request shape. Swap the base URL and optionally set an API key:

```python
# Before (Firecrawl)
import requests
r = requests.post("https://api.firecrawl.dev/v1/scrape",
    headers={"Authorization": "Bearer fc-..."},
    json={"url": "https://example.com", "formats": ["markdown"]})

# After (url2md — self-hosted, no usage limits)
r = requests.post("http://your-server:3000/v2/scrape",
    headers={"Authorization": "Bearer your-api-key"},  # optional
    json={"url": "https://example.com", "formats": ["markdown"]})
```

### Environment variables for client apps

```env
URL2MD_URL=http://localhost:3000
URL2MD_API_KEY=                   # leave blank if API_KEYS is not set
```

