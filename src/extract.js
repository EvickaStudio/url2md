import { chromium } from "playwright";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { shouldBlockRequestUrl } from "./security.js";

// preserve structure and code fences, strip links/media
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// keep only text content
turndown.addRule("stripLinks", {
  filter: (node) => node.nodeName === "A",
  replacement: (content) => content,
});

// remove media elements
turndown.addRule("stripMedia", {
  filter: (node) =>
    ["IMG", "PICTURE", "SOURCE", "VIDEO", "AUDIO", "IFRAME"].includes(
      node.nodeName
    ),
  replacement: () => "",
});

const UA =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

let _browser;

export async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}

// sanitize DOM content for LLMs: remove links/media, keep structure, strip attrs
function sanitizeForLLM(html, baseUrl) {
  const dom = new JSDOM("<!doctype html><body></body>", { url: baseUrl });
  const { document } = dom.window;
  document.body.innerHTML = html;
  const root = document.body;

  const unwrap = (el) => el.replaceWith(...el.childNodes);

  // unwrap anchors (keep text only)
  for (const a of root.querySelectorAll("a")) unwrap(a);

  // drop media/interactive/boilerplate elements entirely
  root
    .querySelectorAll(
      [
        "img",
        "picture",
        "source",
        "video",
        "audio",
        "iframe",
        "embed",
        "object",
        "canvas",
        "svg",
        "script",
        "style",
        "noscript",
        "form",
        "button",
        "input",
        "select",
        "textarea",
        "link",
        "nav",
        "header",
        "footer",
        "aside",
        "[aria-live]",
      ].join(", ")
    )
    .forEach((el) => el.remove());

  // preserve figcaptions but remove figures otherwise
  for (const fig of root.querySelectorAll("figure")) {
    const cap = fig.querySelector("figcaption");
    if (cap) {
      fig.replaceWith(...cap.childNodes);
    } else {
      fig.remove();
    }
  }
  for (const fc of root.querySelectorAll("figcaption")) {
    const p = document.createElement("p");
    p.innerHTML = fc.innerHTML;
    fc.replaceWith(p);
  }

  // whitelist structural tags; unwrap everything else
  const allowed = new Set([
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "P",
    "UL",
    "OL",
    "LI",
    "PRE",
    "CODE",
    "BLOCKQUOTE",
    "TABLE",
    "THEAD",
    "TBODY",
    "TFOOT",
    "TR",
    "TH",
    "TD",
    "EM",
    "I",
    "STRONG",
    "B",
    "HR",
    "BR",
  ]);
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!allowed.has(el.tagName)) unwrap(el);
  }

  // strip all attributes to eliminate embedded URLs/styles/classes
  for (const el of root.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      el.removeAttribute(attr.name);
    }
  }

  return root.innerHTML;
}

export async function urlToMarkdown(targetUrl, opts = {}) {
  if (!/^https?:\/\//i.test(targetUrl)) throw new Error("Invalid URL");
  const timeout = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 25000;

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.8", DNT: "1" },
  });
  const page = await context.newPage();

  // block SSRF/private targets and heavy resource types
  await page.route("**/*", (route) => {
    const req = route.request();
    const t = req.resourceType();
    const url = req.url();
    if (shouldBlockRequestUrl(url)) return route.abort();
    if (["image", "font", "media", "stylesheet"].includes(t)) return route.abort();
    return route.continue();
  });

  page.setDefaultTimeout(timeout);

  let response;
  try {
    response = await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout,
    });

    // soft network idle to allow late content without hanging indefinitely
    try {
      await page.waitForLoadState("networkidle", { timeout: 3000 });
    } catch {}

    // try to catch main content quickly
    try {
      await page.waitForSelector("article, main, [role='main']", {
        state: "attached",
        timeout: 5000,
      });
    } catch {}

    // trigger lazy-load scrolling
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let last = 0;
        const step = () => {
          window.scrollBy(0, 1200);
          const h = document.documentElement.scrollHeight;
          if (h !== last) {
            last = h;
            setTimeout(step, 200);
          } else {
            resolve();
          }
        };
        step();
      });
    });

    try {
      await page.waitForLoadState("networkidle", { timeout: 1500 });
    } catch {}

    const finalUrl = page.url();

    // no pdfs
    const ct =
      response?.headers()?.["content-type"] ||
      response?.headers()?.["Content-Type"] ||
      "";
    if (/\bapplication\/pdf\b/i.test(ct)) {
      throw new Error("Unsupported content-type: application/pdf");
    }

    const html = await page.content();

    const withoutInlineStyles = html.replace(/<style[\s\S]*?<\/style>/gi, "");
    const withoutCssLinks = withoutInlineStyles.replace(
      /<link[^>]*rel=["']?stylesheet["']?[^>]*>/gi,
      ""
    );
    const strippedHtml = withoutCssLinks.replace(
      /\sstyle=(?:"[^"]*"|'[^']*')/gi,
      ""
    );

    const vconsole = new VirtualConsole();
    vconsole.on("error", () => {});

    const dom = new JSDOM(strippedHtml, {
      url: finalUrl,
      pretendToBeVisual: true,
      virtualConsole: vconsole,
    });

    const reader = new Readability(dom.window.document);
    let article = reader.parse();

    // retry with looser thresholds if nothing was found
    if (!article) {
      const altReader = new Readability(dom.window.document, {
        charThreshold: 200,
        nbTopCandidates: 10,
      });
      article = altReader.parse();
    }

    const contentHtml = article?.content || html;
    const sanitizedHtml = sanitizeForLLM(contentHtml, finalUrl);

    let markdown = turndown.turndown(sanitizedHtml);
    // tighten whitespace
    markdown = markdown
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return {
      url: finalUrl,
      title: article?.title ?? "",
      markdown,
      meta: {
        byline: article?.byline ?? null,
        length: markdown.length,
        excerpt: article?.excerpt ?? null,
        siteName: article?.siteName ?? null,
        dir: article?.dir ?? null,
        extractedAt: new Date().toISOString(),
      },
    };
  } finally {
    await context.close();
  }
}
