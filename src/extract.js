import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { shouldBlockRequestUrl } from "./security.js";
import { createStealthContext } from "./browser-pool.js";
import { DISMISS_OVERLAYS_SCRIPT } from "./stealth.js";
import cfg from "./config.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});

turndown.addRule("stripMedia", {
  filter: (node) =>
    ["IMG", "PICTURE", "SOURCE", "VIDEO", "AUDIO", "IFRAME", "SVG", "CANVAS"].includes(node.nodeName),
  replacement: () => "",
});

turndown.addRule("tableCell", {
  filter: ["th", "td"],
  replacement: (content, node) => {
    const trimmed = content.trim().replace(/\n/g, " ") || " ";
    return ` ${trimmed} |`;
  },
});

const BLOCKED_TYPES = new Set([
  "image", "font", "media", "stylesheet", "texttrack", "eventsource",
  "websocket", "manifest", "other",
]);

const TRACKING_RE =
  /google-analytics|googletagmanager|doubleclick|facebook\.net|fbcdn|analytics|hotjar|segment\.io|sentry\.io|newrelic|datadome|cloudflareinsights/i;

function sanitizeForLLM(html, baseUrl) {
  const dom = new JSDOM("<!doctype html><body></body>", { url: baseUrl });
  const { document } = dom.window;
  document.body.innerHTML = html;
  const root = document.body;

  const unwrap = (el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  };

  // Resolve relative hrefs to absolute before stripping attributes
  for (const a of [...root.querySelectorAll("a")]) {
    const href = a.getAttribute("href");
    if (href) {
      try { a.setAttribute("href", new URL(href, baseUrl).href); }
      catch { /* keep original */ }
    }
  }

  root
    .querySelectorAll(
      "img,picture,source,video,audio,iframe,embed,object,canvas,svg," +
      "script,style,noscript,form,button,input,select,textarea,link," +
      "nav,header,footer,aside,[aria-live],[role='banner']," +
      "[role='navigation'],[role='contentinfo'],[class*='sidebar']," +
      "[class*='ad-'],[class*='advertisement'],[id*='ad-']," +
      "[class*='social'],[class*='share'],[class*='related']"
    )
    .forEach((el) => el.remove());

  for (const fig of [...root.querySelectorAll("figure")]) {
    const cap = fig.querySelector("figcaption");
    if (cap) {
      const p = document.createElement("p");
      p.innerHTML = cap.innerHTML;
      fig.replaceWith(p);
    } else {
      fig.remove();
    }
  }

  const allowed = new Set([
    "H1","H2","H3","H4","H5","H6","P","UL","OL","LI","A",
    "PRE","CODE","BLOCKQUOTE","TABLE","THEAD","TBODY","TFOOT",
    "TR","TH","TD","EM","I","STRONG","B","HR","BR","DL","DT","DD",
    "SUP","SUB","ABBR","MARK","DEL","INS","DETAILS","SUMMARY",
  ]);
  for (const el of [...root.querySelectorAll("*")]) {
    if (!allowed.has(el.tagName)) unwrap(el);
  }

  // Strip all attributes except href on <a>
  for (const el of root.querySelectorAll("*")) {
    const keep = el.tagName === "A" ? el.getAttribute("href") : null;
    for (const attr of [...el.attributes]) el.removeAttribute(attr.name);
    if (keep) el.setAttribute("href", keep);
  }

  return root.innerHTML;
}

function getPageMetadata(document, url, statusCode, article) {
  // Build a lookup of all meta tags for selective extraction
  const rawMeta = {};
  for (const tag of [...document.querySelectorAll("meta")]) {
    const name = tag.getAttribute("name") || tag.getAttribute("property") || tag.getAttribute("itemprop");
    const content = tag.getAttribute("content");
    if (name && content) rawMeta[name.toLowerCase()] = content;
  }

  const meta = {
    title:       article?.title || rawMeta["og:title"] || document.title || "",
    description: article?.excerpt || rawMeta["og:description"] || rawMeta["description"] || "",
    language:    document.documentElement?.lang || rawMeta["og:locale"] || "",
    sourceURL:   url,
    statusCode:  statusCode || 200,
  };

  // Only pull in fields that are genuinely useful for LLM context / tool-call display
  if (rawMeta["author"])       meta.author      = rawMeta["author"];
  if (rawMeta["generator"])    meta.generator   = rawMeta["generator"];
  if (rawMeta["keywords"])     meta.keywords    = rawMeta["keywords"];
  if (rawMeta["og:site_name"]) meta.siteName    = rawMeta["og:site_name"];
  if (rawMeta["og:type"])      meta.ogType      = rawMeta["og:type"];
  if (rawMeta["og:url"])       meta.ogUrl       = rawMeta["og:url"];
  if (rawMeta["og:image"])     meta.image       = rawMeta["og:image"];
  if (rawMeta["article:published_time"]) meta.publishedTime = rawMeta["article:published_time"];
  if (rawMeta["article:modified_time"])  meta.modifiedTime  = rawMeta["article:modified_time"];

  // Canonical URL
  const canonical = document.querySelector("link[rel='canonical']");
  if (canonical?.getAttribute("href")) meta.canonicalURL = canonical.getAttribute("href");

  // Favicon
  const iconNode = document.querySelector("link[rel='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']");
  if (iconNode) {
    const href = iconNode.getAttribute("href");
    if (href) {
      try { meta.favicon = new URL(href, url).href; }
      catch { meta.favicon = href; }
    }
  }

  return meta;
}

let _proxyIdx = 0;

function extractLinks(document, baseUrl) {
  const seen = new Set();
  const links = [];
  for (const a of document.querySelectorAll("a[href]")) {
    try {
      const href = new URL(a.getAttribute("href"), baseUrl).href;
      if (!seen.has(href) && /^https?:/.test(href)) {
        seen.add(href);
        links.push(href);
      }
    } catch { /* skip invalid */ }
  }
  return links;
}
function nextProxy() {
  if (cfg.proxyList.length === 0) return undefined;
  const p = cfg.proxyList[_proxyIdx % cfg.proxyList.length];
  _proxyIdx++;
  return p;
}

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
];

async function tryFastFetch(url, timeoutMs) {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(Math.min(timeoutMs, 5000)),
      headers: {
        "User-Agent": UA_POOL[Math.floor(Math.random() * UA_POOL.length)],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return null;
    const html = await resp.text();
    if (html.length < 2000) return null;
    return { html, finalUrl: resp.url, statusCode: resp.status };
  } catch {
    return null;
  }
}

export async function urlToMarkdown(targetUrl, opts = {}) {
  if (!/^https?:\/\//i.test(targetUrl)) throw new Error("Invalid URL");
  const timeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 25_000;
  const maxLength = Number.isFinite(opts.maxLength) ? opts.maxLength : 0;

  // ── Fast-path fetch (avoid starting browser for simpler static pages) ──
  const fast = await tryFastFetch(targetUrl, timeout);
  if (fast) {
    const cleaned = fast.html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<link[^>]*rel=["']?stylesheet["']?[^>]*>/gi, "")
      .replace(/\sstyle=(?:"[^"]*"|'[^']*')/gi, "");

    const vconsole = new VirtualConsole();
    vconsole.on("error", () => {});

    const dom = new JSDOM(cleaned, { url: fast.finalUrl, pretendToBeVisual: true, virtualConsole: vconsole });
    let article = new Readability(dom.window.document).parse();

    if (!article) {
      const dom2 = new JSDOM(cleaned, { url: fast.finalUrl, pretendToBeVisual: true, virtualConsole: vconsole });
      article = new Readability(dom2.window.document, {
        charThreshold: 100,
        nbTopCandidates: 15,
      }).parse();
    }

    if (article) {
      const finalHtml = (opts.onlyMainContent !== false && article) ? article.content : cleaned;
      const sanitizedHtml = sanitizeForLLM(finalHtml, fast.finalUrl);
      let markdown = turndown.turndown(sanitizedHtml);
      markdown = markdown
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
        
      if (maxLength > 0 && markdown.length > maxLength) {
        markdown = markdown.slice(0, maxLength) + "\n\n[…truncated]";
      }

      const resultData = {
        markdown,
        metadata: getPageMetadata(dom.window.document, fast.finalUrl, fast.statusCode, article)
      };
      
      if (opts.formats && opts.formats.includes("html")) resultData.html = sanitizedHtml;
      if (opts.formats && opts.formats.includes("rawHtml")) resultData.rawHtml = fast.html;
      if (opts.formats && opts.formats.includes("links")) resultData.links = extractLinks(dom.window.document, fast.finalUrl);

      return resultData;
    }
  }

  // ── Playwright fallback ──
  const { context, profile } = await createStealthContext(nextProxy());

  try {
    const page = await context.newPage();

    await page.route("**/*", (route) => {
      const req = route.request();
      const url = req.url();
      const type = req.resourceType();

      if (shouldBlockRequestUrl(url))          return route.abort("blockedbyclient");
      if (BLOCKED_TYPES.has(type))             return route.abort("blockedbyclient");
      if (TRACKING_RE.test(url))               return route.abort("blockedbyclient");

      return route.continue();
    });

    page.setDefaultTimeout(timeout);

    let response;
    try {
      response = await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout,
      });
    } catch (err) {
      throw new Error(`Navigation failed: ${err.message}`);
    }

    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});

    await page.evaluate(DISMISS_OVERLAYS_SCRIPT).catch(() => {});

    await page.waitForSelector("article, main, [role='main'], .post-content, .entry-content, #content", {
      state: "attached",
      timeout: 3000,
    }).catch(() => {});

    const ct = response?.headers()?.["content-type"] || "";
    if (/application\/pdf/i.test(ct)) {
      throw new Error("Unsupported content-type: application/pdf");
    }

    const finalUrl = page.url();
    const html = await page.content();

    const cleaned = html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<link[^>]*rel=["']?stylesheet["']?[^>]*>/gi, "")
      .replace(/\sstyle=(?:"[^"]*"|'[^']*')/gi, "");

    const vconsole = new VirtualConsole();
    vconsole.on("error", () => {});

    const dom = new JSDOM(cleaned, {
      url: finalUrl,
      pretendToBeVisual: true,
      virtualConsole: vconsole,
    });

    let article = new Readability(dom.window.document).parse();

    if (!article) {
      const dom2 = new JSDOM(cleaned, { url: finalUrl, pretendToBeVisual: true, virtualConsole: vconsole });
      article = new Readability(dom2.window.document, {
        charThreshold: 100,
        nbTopCandidates: 15,
      }).parse();
    }

    const contentHtml = (opts.onlyMainContent !== false && article) ? article.content : cleaned;
    const sanitizedHtml = sanitizeForLLM(contentHtml, finalUrl);

    let markdown = turndown.turndown(sanitizedHtml);
    markdown = markdown
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (maxLength > 0 && markdown.length > maxLength) {
      markdown = markdown.slice(0, maxLength) + "\n\n[…truncated]";
    }

    const resultData = {
      markdown,
      metadata: getPageMetadata(dom.window.document, finalUrl, response?.status(), article)
    };

    if (opts.formats && opts.formats.includes("html")) resultData.html = sanitizedHtml;
    if (opts.formats && opts.formats.includes("rawHtml")) resultData.rawHtml = html;
    if (opts.formats && opts.formats.includes("links")) resultData.links = extractLinks(dom.window.document, finalUrl);

    return resultData;
  } finally {
    await context.close().catch(() => {});
  }
}
